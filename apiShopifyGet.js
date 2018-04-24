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
const databaseName = 'zsdb_test';
const dbURI = `mongodb://localhost:27017/${databaseName}`;
mongoose.Promise = global.Promise;
// Set Mongoose models as constant variables 
const openOrder = models.OpenOrders,
	closedOrder = models.ClosedOrders,
	pendingOrder = models.PendingOrders;

// API & File System Write Related
const baseurl = `https://${apikey}:${password}@${shopname}.myshopify.com`;
const dateString = moment().format("YYYYMMDD");
const dateTimeString = moment().format("YYYYMMDD_HHmm");
const savePathName = `./OrderImport/${dateString}`;
const saveFileName = `ShopifyAPI_Orders_${dateTimeString}.xlsx`;
const importFileName = `OE_NewOrder_${dateTimeString}_ZINUS.xlsx`;
const currentFileName = path.basename(__filename);

// Discount Related
const jsonQuery = require('json-query');
const dev_zinusapiUrl = 'http://52.160.69.254:3001/discount/map';
// const zinusapiUrl = 'http://52.160.69.254:3000/discount/map';
var dcResult;
/* =================================================== */


/* ================ UTILITY FUNCTIONS ================ */
// Uniform timestamp
const timestamp = (timeObject) => {
	return moment(timeObject).format("YYYYMMDD_HHmm");
}

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

// Rounding for cent calcuation
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
	let db = mongoose.connection;
	mongoose.connect(dbURI)
	.catch(error => systemLog(error))
	.then(() => {
		// Create a promise object that resolves with the latest Shopify order id, if any
		return new Promise((resolve, reject) => {
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
						else { resolve(0) }
					})
				}
			})
		});
	}).then((latestOrderId) => {
		// Resolve parent promise (recallPromise) with the recalled latest order id
		resolve(latestOrderId);
	}).catch(error => systemLog(error))
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
						reject(`No order received since lastestOrderId: ${latestOrderId}`);
					} else {
						systemLog(`ORDERS ARRAY LENGTH: ${body.orders.length}`);
						resolve(body.orders);
					}
				} else {
					reject(`Response returned with exception body: \r\n${JSON.stringify(body)}`);
				}
			} else if (!error && response.statusCode !== 200) {
				reject(`Response returned with Status Code: ${response.statusCode}`);
			}
		})
	});
	
}

// A promise to send request to Zinus API server
const getDiscountPromise = new Promise((resolve, reject) => {
	request({
		url: dev_zinusapiUrl,
		json: true,
	}, function (error, response, body) {
		if (error) throw error;
		if (!error && response.statusCode === 200) {
			if (body.dclist) {
				if (body.dclist.length === 0) {
					reject(`No dclist received`);
				} else {
					systemLog(`Dicount ARRAY LENGTH: ${body.dclist.length}`);
					resolve(body);
				}
			} else {
				reject(`Response returned with exception body: \r\n${JSON.stringify(body)}`);
			}
		} else if (!error && response.statusCode !== 200) {
			reject(`Response returned with Status Code: ${response.statusCode}`);
		}
	})
});
 
// Output columns
let excelCols = ['order_index', 'id', 'order_number', 'contact_email', 'created_at', 'total_price', 'total_line_items_price', 'subtotal_price', 'total_tax', 'total_discounts'];

// Below columns need data transformation: transformOrderExcel
excelCols = excelCols.concat(['zinus_po', 'discount_code_0', 'shipping_address_name', 'shipping_address_address_1', 'shipping_address_address_2', 'shipping_address_city', 'shipping_address_state', 'shipping_address_zip', 'shipping_address_country', 'shipping_address_phone','order_recycling_fee', 'line_items_index', 'line_items_sku', 'line_items_product_id', 'line_items_variant_id', 'line_items_quantity', 'line_items_price', 'line_items_discount_price', 'line_items_discount_rate', 'line_items_unit_price', 'line_items_tax_price', 'line_items_tax_rate']);

// OMP columns
OMPCols = ['ISACONTROLNO', 'DOCUMENTNO', 'ISAID', 'SHIPTO', 'SHPNAME', 'SHPADDR1', 'SHPADDR2', 'SHPADDR3', 'SHPADDR4', 'SHPCITY', 'SHIPSTATE', 'SHPZIP', 'SHPCOUNTRY', 'SHPPHONE', 'SHPEMAIL', 'PONUMBER', 'REFERENCE', 'ORDDATE', 'TD503', 'TD505', 'TD512', 'EXPDATE', 'DELVBYDATE', 'WHCODE', 'STATUS', 'OPTORD01', 'OPTORD02', 'OPTORD03', 'OPTORD04', 'OPTORD05', 'OPTORD06', 'OPTORD07', 'OPTORD08', 'OPTORD09', 'OPTORD10', 'OPTORD11', 'OPTORD12', 'OPTORD13', 'OPTORD14', 'OPTORD15', 'LINENUM', 'ITEM', 'QTYORDERED', 'ORDUNIT', 'UNITPRICE', 'OPTITM01', 'OPTITM02', 'OPTITM03', 'OPTITM04', 'OPTITM05', 'OPTITM06', 'OPTITM07', 'OPTITM08', 'OPTITM09', 'OPTITM10', 'IMPORTTIME', 'REASONCODE'];

// Globally scoped order index
let order_index = 0;

//  Transform order data for OMP fields (Map to be included in the source code)
const transformOrderExcel = (orders) => {
	ordersArray = [];
	for (let i = 0; i < orders.length; i++) {
		let order = orders[i];
		// Assign Zinus PO, which is Order # prefixed by "ZC"
		order['zinus_po'] = "ZC" + order.order_number;
		// Handle discount coupon code
		order['discount_code_0'] = (order.discount_codes.length > 0) ? order.discount_codes[0]['code'] : '';
		// Handle shipping address object
		order['shipping_address_name'] = order.shipping_address.name;
		order['shipping_address_address_1'] = order.shipping_address.address1;
		order['shipping_address_address_2'] = order.shipping_address.address2;
		order['shipping_address_city'] = order.shipping_address.city;
		order['shipping_address_state'] = order.shipping_address.province;
		order['shipping_address_zip'] = order.shipping_address.zip;
		order['shipping_address_country'] = order.shipping_address.country;
		order['shipping_address_phone'] = order.shipping_address.phone;
		// Handle Recycling Fees
		order['order_recycling_fee'] = (order.shipping_lines[0]) ? order.shipping_lines[0].discounted_price : 0;
		var dicount_code = (order.discount_codes.length > 0) ? order.discount_codes[0]['code'] : '';
		// Handle line item object
		let line_items = order['line_items']
		for (let j = 0; j < line_items.length; j++) {
			// Increment the globally scoped Order Index 
			order_index++;
			// Handle nested tax object
			let line_items_tax_price = 0,
				line_items_tax_rate = 0;
			if (line_items[j].tax_lines.length > 0) {
				let line_items_tax_lines = line_items[j].tax_lines;
				line_items_tax_price = truncateToCent(line_items_tax_lines.reduce((sum, e) => sum + parseFloat(e["price"]), 0));
				line_items_tax_rate = line_items_tax_lines.reduce((sum, e) => sum + parseFloat(e["rate"]), 0);
			};

			// Discount Map Search
			//systemLog('dicount_code: '+ dicount_code);
			let dc_percent = 0;
			if(dicount_code != null && dicount_code != ""){
				//systemLog('product_id: '+ line_items[j].product_id);
				//systemLog('variant_id: '+ line_items[j].variant_id);
				let dc_qry1 = jsonQuery(['dclist[* title=? & products~? | variants~?].value', dicount_code, line_items[j].product_id, line_items[j].variant_id],{data:dcResult});
				if(dc_qry1.value != null && dc_qry1.value.length > 0){	//
					dc_percent = parseInt(dc_qry1.value);
					systemLog('DC_VALUE: '+ JSON.stringify(dc_percent));
				}
			}
			let dc_price = (dc_percent/100) * parseFloat(line_items[j].price);
			let dc_uprice = parseFloat(line_items[j].price) + dc_price;

			// Clone an order object and push to the ordersArray
			let orderCopy = Object.assign({
				'line_items_index': j+1,
				'line_items_sku': line_items[j].sku,
				'line_items_product_id': line_items[j].product_id,
				'line_items_variant_id': line_items[j].variant_id,
				'line_items_quantity': line_items[j].quantity,
				'line_items_price': line_items[j].price,
				'line_items_tax_price': line_items_tax_price,
				'line_items_tax_rate': line_items_tax_rate,
				'line_items_discount_rate': dc_percent, // PLACEHOLDER FOR PRICERULE API
				'line_items_discount_price': dc_price, // PLACEHOLDER FOR PRICERULE API
				'line_items_unit_price': dc_uprice, // PLACEHOLDER FOR PRICERULE API
				'order_index': order_index
			}, order);
			ordersArray.push(orderCopy);
		}
	}
	return ordersArray;
}
// version test
// Delcare a stream object for ExcelWriter and specify data cols & rows
let excelStreamColsArray = excelCols.map((val) => {
	let acc = {};
	acc.name = val;
	acc.key = val;
	return acc;
})

let ExcelWriteStream = new ExcelWriter({
	sheets: [{
		key: 'OE_NewOrder',
		headers: excelStreamColsArray
	}]
});

// Map each order object to promise object in the promisesArray
const ExcelStreamPromiseArray = (ordersExcel) => {
	const promisesArray = ordersExcel.map((order) => {
		// Break down each order object property to its corresponding column
		let excelInput = {};
		excelCols.map((prop) => {
			excelInput[prop] = order[prop];
		});
		// Add excelInput obejct to the write stream
		ExcelWriteStream.addData('OE_NewOrder', excelInput);
	});
	return promisesArray;
}

// Property names for order data within MongoDB document colleciton (OpenOrders)
const mongoProps = ['shopify_order_id', 'status', 'date_ordered_shopify', 'date_ordered_sage', 'date_received', 'date_imported', 'date_fulfilled', 'date_posted', 'shopify_po', 'zinus_po', 'sage_order_number', 'm_tracking_no', 'tracking_no', 'company', 'wh_code', 'cancelled', 'posted', 'closed'];

// Transform order data for MongoDB 
const transformOrderMongo = ((orders) => {
	return orders.map((order) => {
		let entry = {};
		entry['shopify_order_id'] = order.id;
		entry['status'] = 'received';
		entry['date_ordered_shopify'] = timestamp(order.created_at);
		entry['date_ordered_sage'] = '';
		entry['date_received'] = dateTimeString;
		entry['date_imported'] = '';
		entry['date_fulfilled'] = '';
		entry['date_posted'] = '';
		entry['shopify_po'] = String(order.order_number);
		entry['zinus_po'] = 'ZC' + String(order.order_number);
		entry['sage_order_number'] = '';
		entry['m_tracking_no'] = '';
		entry['tracking_no'] = '';
		entry['company'] = '';
		entry['wh_code'] = '';
		entry['cancelled'] = false;
		entry['posted'] = false;
		entry['closed'] = false;
		return entry;
	})
}) 

// Insert transformed orders to MongoDB using Mongoose ORM
const dbInsert = ((ordersMongo) => {
	return new Promise((resolve, reject) => {
		// Initialize a bulk operation using Mongoose bulk object
		let bulk = openOrder.collection.initializeOrderedBulkOp();
		let bulkCounter = 0;
		// Run a bulk upsert operation
		for (let i = 0; i < ordersMongo.length; i++) {
			let order = ordersMongo[i];
			let query = { shopify_order_id: order.shopify_order_id };
			bulk.find(query).upsert().updateOne(order);
			bulkCounter++;
			// Exit condition
			if (bulkCounter === ordersMongo.length) {
				bulk.execute((error, result) => {
					if (error) throw (err);
					resolve(result);
				});
			}
		}
	}).then((result) => {
		if (result["ok"] === 1) {
			systemLog(`[MongoDB] Successfully performed bulk operation with ${result["nUpserted"]} upserted; ${result["nMatched"]} matched; ${result["nModified"]} modified`);
		} else {
			systemLog(JSON.stringify(result));
		}
	}).catch(error => systemLog(error));
})

/* =================================================== */


/* ================ EXECUTE FUNCTIONS ================ */
// Resolve the recallPromise
/* recallPromise.then(latestOrderId => {
	systemLog(`LATEST ORDER ID: ${latestOrderId}`);
	return getOrdersPromise(latestOrderId); */
Promise.all([getDiscountPromise, recallPromise]).then(function (values) {
	//systemLog(`DISCOUNT: ${values[0]}`);
	dcResult = values[0];
	//dclistArray = values[1];
	systemLog(`LATEST ORDER ID: ${values[1]}`);
	return getOrdersPromise(values[1]);	
}).then(orders => {	
	// Transform orders for MongoDB
	const ordersMongo = transformOrderMongo(orders);
	// Insert order entry to MongoDB
	dbInsert(ordersMongo);

	// Transform orders for Excel
	const ordersExcel = transformOrderExcel(orders);
	// Return an array of promises from ExcelWriter
	return ExcelStreamPromiseArray(ordersExcel);
}).then((promisesArray) => {
	Promise.all(promisesArray)
		.then(() => { return ExcelWriteStream.save(); })
		.then((stream) => { 
			stream.pipe(fs.createWriteStream(`./${savePathName}/${importFileName}`)) 
		})
		.then(() => systemLog(`[Excel] ExcelWriteStream successfually saved at: ${savePathName}`))
}).then(() => {
	// Close connection
	systemLog("Closing MongoDB connection with a resolved promise.");
	mongoose.disconnect();
}).catch(error => { 
	systemLog(error);
	// Close connection
	systemLog("Closing MongoDB connection with a rejected promise.");
	mongoose.disconnect();
});

/* =================================================== */
