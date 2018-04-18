/* ================ GLOBAL VARIABLES ================ */
// Dependencies
const fs = require('fs');
const path = require('path');
const request = require('request');
const XLSX = require('xlsx');
const ExcelWriter = require('node-excel-stream').ExcelWriter; 
const flatten = require('flat');
const moment = require('moment');
const Bottleneck = require("bottleneck");
const limiter = new Bottleneck({maxConcurrent: 3, minTime: 500});

// Shopify API Credential
const config = require('./config.js');
const apikey = config.shopify_api_key_dev;
const password = config.shopify_api_pw_dev;
const shopname = config.shopify_shopname_dev;

// Database Setup
const mongoose = require('mongoose');
const models = require('./Models/OrderSchema.js')
const db = mongoose.connection;
const databaseName = 'zsdb_test';
const dbURI = `mongodb://localhost:27017/${databaseName}`;
mongoose.Promise = global.Promise;

// API & File System Write Related
const baseurl = `https://${apikey}:${password}@${shopname}.myshopify.com`;
const dateString = moment().format("YYYYMMDD");
const dateTimeString = moment().format("YYYYMMDD_HHmm");
const savePathName = `./OrderImport/${dateString}`;
const saveFileName = `ShopifyAPI_Orders_${dateTimeString}.xlsx`;
const importFileName = `OE_NewOrder_${dateTimeString}_ZINUS.xlsx`;
const currentFileName = path.basename(__filename);
/* =================================================== */


/* ================ UTILITY FUNCTIONS ================ */
// System log (Saved under [./savePathName/dateString/])
const sysLogFile = `systemLog_${dateTimeString}.txt`;
const sysLogBody = `\r\n@${dateTimeString}[${currentFileName}] >>> `;
const systemLog = (log) => {
	// DEV NOTE: Dev mode only
	console.log(log);
	fs.appendFileSync(`./${savePathName}/${sysLogFile}`, sysLogBody + log);
}

// Initialize savePathName directory
(function() {
	if (!fs.existsSync(savePathName)) {
		fs.mkdirSync(savePathName);
	}
}());

// Rounding for discount calcuation
const truncateToCent = (value) => {
	return Number(Math.floor(value * 100) / 100);
}

// Unhandled Rejection
process.on('unhandledRejection', (error, p) => {
	systemLog(`Unhandled Rejection at: ${error} \r\n ${p}`);
});
/* =================================================== */


/* ================ DECLARE FUNCTIONS ================ */
// A promise to recall the last imported orderId
const recallPromise = new Promise((resolve, reject) => {

	mongoose.connect(dbURI)
	.catch(error => systemLog(error) )
	.then(() => {
		const openOrder = models.OpenOrders,
					closedOrder = models.ClosedOrders,
					pendingOrder = models.PendingOrders;
		// Create a promise object that resolves with the latest Shopify order id, if any
		const dbPromise = new Promise((resolve, reject) => {
			////// DEV NOTE: CHANGE QUERY TO SORTY BY date_ordered_shopify AFTER REFORMATTING ITS STRING VALUE AT IMPORT //////
			let query = { "date_received": -1, "shopify_po": -1, "date_ordered_shopify": -1 };
			// First check if there are any open orders
			openOrder.find().sort(query).limit(1).lean().exec((err, result) => {
				if (err) throw err;
				// CASE 1: There is an open order --> Resolve the latest open order id
				if (result[0]) { resolve(result[0].shopify_order_id) } 
				// CASE 2: There is no 	open order --> Check if there are any closed orders
				else { 
					closedOrder.find().sort(query).limit(1).lean().exec((err, result) => {
						if (err) throw err
						// CASE 2-1: There is a closed order --> Resolve the latest closed order id
						if (result[0]) { resolve(result[0].shopify_order_id) }
						// CASE 2-2: There is no closed order --> Resolve with a base value (shopify_order_id = 0)
						else { resolve(null)	}
					})
				}
			})
		});
		// Resolve dbPromise with the recalled latest order id
		dbPromise.then((latestOrderId) => {
			resolve(latestOrderId);
			db.close();			
		}).catch(error => { systemLog(error) })
	})

});

// A promise to send request to Shopify API server
const getOrdersPromise = (latestOrderId) => {

	return new Promise((resolve, reject) => {
		request({
			url: baseurl + `/admin/orders.json?since_id=${latestOrderId}`,
			// url: baseurl + `/admin/orders.json?since_id=9999999999999`,
			json: true,
		}, function (error, response, body) {
			if (error) throw error;
			if (!error && response.statusCode === 200) {
				if (body.orders) {
					if (body.orders.length === 0) {
						systemLog(`No order received since lastestOrderId: ${latestOrderId}`);
					} else {
						systemLog(`ORDERS ARRAY LENGTH: ${body.orders.length}`);
						resolve(body.orders);
					}
				} else {
					systemLog(`Response returned with exception body: \r\n${JSON.stringify(body)}`);
				}
			} else if (!error && response.statusCode !== 200) {
				systemLog(`Response returned with Status Code: ${response.statusCode}`);
			}
		})
	});

}

// Output columns
const excelCols = ['id', 'order_number', 'total_price', 'total_line_items_price', 'subtotal_price', 'total_tax', 'total_discounts', 'line_items_index', 'sku', 'product_id', 'variant_id', 'quantity', 'price', 'discount_code_0'];

//  Transform order data for OMP fields (Map to be included in the source code)
const transformOrder = (orders) => {
	ordersArray = [];
	for (let i = 0; i < orders.length; i++) {
		let order = orders[i];
		order['discount_code_0'] = (order.discount_codes.length > 0) ? order.discount_codes[0]['code'] : '';
		let line_items = order['line_items']
		for (let j = 0; j < line_items.length; j++) {
			let orderCopy = Object.assign({
				'line_items_index': j+1,
				'sku': line_items[j].sku,
				'product_id': line_items[j].product_id,
				'variant_id': line_items[j].variant_id,
				'quantity': line_items[j].quantity,
				'price': line_items[j].price
			}, order);
			ordersArray.push(orderCopy);
		}
	}
	return ordersArray;
}


// for (let j = 0; j < orders[i]['line_items'].length; j++) {
// 	orders[i]['line_items_index'] = j + 1;
// 	orders.push(orders[i]);
// }

// Delcare a stream object for ExcelWriter and specify data cols & rows
let ExcelWriteStream = new ExcelWriter({
	sheets: [{
		key: 'OE_NewOrder',
		headers: [
			{ name: excelCols[0], key: excelCols[0] },
			{ name: excelCols[1], key: excelCols[1] },
			{ name: excelCols[2], key: excelCols[2] },
			{ name: excelCols[3], key: excelCols[3] },
			{ name: excelCols[4], key: excelCols[4] },
			{ name: excelCols[5], key: excelCols[5] },
			{ name: excelCols[6], key: excelCols[6] },
			{ name: excelCols[7], key: excelCols[7] },
			{ name: excelCols[8], key: excelCols[8] },
			{ name: excelCols[9], key: excelCols[9] },
			{ name: excelCols[10], key: excelCols[10] },
			{ name: excelCols[11], key: excelCols[11] },
			{ name: excelCols[12], key: excelCols[12] },
			{ name: excelCols[13], key: excelCols[13] },
		]
	}]
});

// Map each order object to promise object in the promisesArray
const ExcelStreamPromiseArray = (orders) => {
	const promisesArray = orders.map((e) => {
		// Break down each order object property to its corresponding column
		let excelInput = {
			[excelCols[0]]: e[excelCols[0]],
			[excelCols[1]]: e[excelCols[1]],
			[excelCols[2]]: e[excelCols[2]],
			[excelCols[3]]: e[excelCols[3]],
			[excelCols[4]]: e[excelCols[4]],
			[excelCols[5]]: e[excelCols[5]],
			[excelCols[6]]: e[excelCols[6]],
			[excelCols[7]]: e[excelCols[7]],
			[excelCols[8]]: e[excelCols[8]],
			[excelCols[9]]: e[excelCols[9]],
			[excelCols[10]]: e[excelCols[10]],
			[excelCols[11]]: e[excelCols[11]],
			[excelCols[12]]: e[excelCols[12]],
			[excelCols[13]]: e[excelCols[13]],
		};
		ExcelWriteStream.addData('OE_NewOrder', excelInput);
	});
	return promisesArray;
}
/* =================================================== */




/* ================ EXECUTE FUNCTIONS ================ */
// Resolve the recallPromise
recallPromise.then(latestOrderId => {
	systemLog(`LATEST ORDER ID: ${latestOrderId}`);
	return getOrdersPromise(latestOrderId);
}).then(orders => {	
	// Return an array of promises from ExcelWriter
	return ExcelStreamPromiseArray(transformOrder(orders));
}).then((promisesArray) => {
	Promise.all(promisesArray)
		.then(() => { return ExcelWriteStream.save(); })
		.then((stream) => { 
			stream.pipe(fs.createWriteStream(`./${savePathName}/${importFileName}`)) 
		})
		.then(() => { systemLog(`ExcelWriteStream successfually saved at: ${savePathName}`) });
}).catch(error => { systemLog(error) });



/* =================================================== */



// function copyOrder(orderDataArray) {
// 	const orderArray = [];
// 	orderDataArray.map(orderDataObject => {
// 		// const order = {};
// 		const { id: shopifyOrderId } = orderDataObject;
// 		orderArray.push(shopifyOrderId);
// 	})
// 	return(orderArray);
// }