
// Dependencies
const fs = require('fs');
const path = require('path');
const request = require('request');
const XLSX = require('xlsx')
const flatten = require('flat');
const moment = require('moment');
const Bottleneck = require("bottleneck");
const limiter = new Bottleneck({maxConcurrent: 3, minTime: 500});

// Import local config files
const config = require('./config.js');

// Shopify API Credential
const apikey = config.shopify_api_key_dev;
const password = config.shopify_api_pw_dev;
const shopname = config.shopify_shopname_dev;

// Database setup
const mongoose = require('mongoose');
const models = require('./Models/OrderSchema.js')
const db = mongoose.connection;
const databaseName = 'zsdb_test';
const dbURI = `mongodb://localhost:27017/${databaseName}`;
mongoose.Promise = global.Promise;

// Global variables
const baseurl = `https://${apikey}:${password}@${shopname}.myshopify.com`;
const dateString = moment().format("YYYYMMDD");
const dateTimeString = moment().format("YYYYMMDD_HHmm");
const savePathName = `./OrderImport/${dateString}`;
const saveFileName = `ShopifyAPI_Orders_${dateTimeString}.xlsx`;
const importFileName = `OE_NewOrder_${dateTimeString}}_ZINUS.xlsx`;
const currentFileName = path.basename(__filename);

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

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
	systemLog('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

// Recall last imported orderId
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
		}).then(() => {
			db.close();
		}).catch(error => { systemLog(error) })
	})

});

// Resolve the recallPromise
recallPromise.then(result => {
	systemLog(result);
})

// const promiseGetOrders = new Promise((resolve, reject) => {
// 	request(
// 		{
// 			url: baseurl + '/admin/orders.json',
// 			json: true,
// 		}, function (error, response, body) {
// 			if (error) {
// 				reject (error);
// 			}
// 			else {
// 				resolve(body);
// 			}
// 		}
// 	)
// })

// promiseGetOrders
// .then((body) => {
// 	systemLog(`successfully received ${body.orders[0]["id"]}`);
// 	systemLog(truncateToCent(body.orders[0]["subtotal_price"]));
// 	return (body.orders);
// })
// .catch( (error) => {
// 	systemLog(error);
// })
// .then( (orders) => {
// 	const orderArray = copyOrder(orders);
// 	return (orderArray);
// })
// .catch((error) => {
// 	systemLog(error);
// })
// .then( (orderArray) => {
// 	systemLog(orderArray);
// })


// function copyOrder(orderDataArray) {
// 	const orderArray = [];
// 	orderDataArray.map(orderDataObject => {
// 		// const order = {};
// 		const { id: shopifyOrderId } = orderDataObject;
// 		orderArray.push(shopifyOrderId);
// 	})
// 	return(orderArray);
// }