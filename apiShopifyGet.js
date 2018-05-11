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
/* const apikey = config.shopify_api_key_dev;
const password = config.shopify_api_pw_dev;
const shopname = config.shopify_shopname_dev; */
const apikey = config.shopify_api_key_prod;
const password = config.shopify_api_pw_prod;
const shopname = config.shopify_shopname_prod;

// Database Setup
const mongoose = require('mongoose');
const models = require('./Models/OrderSchema.js')
const databaseName = 'zsdb';
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
const savePathNameRef = `./OrderImport/${dateString}`;
const saveFileNameRef = `ShopifyAPI_Orders_${dateTimeString}.xlsx`;
const savePathNameOMP = '../SageInbound_current/NewOrder/.';
const saveFileNameOMP = `.OE_NewOrder_${dateTimeString}_ZINUS.xlsx`;
const currentFileName = path.basename(__filename);

// Discount Related
const jsonQuery = require('json-query');
//const dev_zinusapiUrl = 'http://52.160.69.254:3001/discount/map';
const zinusapiUrl = 'http://52.160.69.254:3000/discount/map';
var dcResult;
/* =================================================== */


/* ================ UTILITY FUNCTIONS ================ */
// Uniform timestamp
const timestamp = (timeObject, addDay = 0) => {
	return moment(timeObject).add(addDay, 'day').format("YYYYMMDD_HHmm");
}

// System log (Saved under [./savePathNameRef/dateString/])
const sysLogFile = `systemLog_${dateTimeString}.txt`;
const sysLogBody = `\r\n@${dateTimeString}[${currentFileName}] >>> `;
const systemLog = (log) => {
	// DEV NOTE: Dev mode only
	console.log(log);
	fs.appendFileSync(`./${savePathNameRef}/${sysLogFile}`, sysLogBody + log);
}

// Initialize savePathNameRef directory
(function() {
	if (!fs.existsSync('./OrderImport')) {
		fs.mkdirSync('./OrderImport');
	}
	if (!fs.existsSync(savePathNameRef)) {
		fs.mkdirSync(savePathNameRef);
	}
}());

// Rounding for cent calcuation
const truncateToCent = (value) => {
	return Number(Math.floor(value * 100) / 100);
}
// Rounding for cent calcuation (Tax only)
const roundToCent = (value) => {
	return Number(Math.round(value * 100) / 100);
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
	}).catch(error => reject(error))
});

// A promise to send request to Shopify API server
const getOrdersPromise = (latestOrderId) => {
	return new Promise((resolve, reject) => {
		request({
			url: baseurl + `/admin/orders.json?limit=250&since_id=${latestOrderId}`,
			// url: baseurl + `/admin/orders.json?limit=250&status=any&since_id=493102432318`, 
			json: true,
		}, function (error, response, body) {
			if (error) throw error;
			if (!error && response.statusCode === 200) {
				if (body.orders) {
					if (body.orders.length === 0) {
						reject(`[API] No order received since lastestOrderId: ${latestOrderId}`);
					} else {
						systemLog(`[API] ORDERS ARRAY LENGTH: ${body.orders.length}`);
						resolve(body.orders);
					}
				} else {
					reject(`[API] Response returned with exception body: \r\n${JSON.stringify(body)}`);
				}
			} else if (!error && response.statusCode !== 200) {
				reject(`[API] Response returned with Status Code: ${response.statusCode}`);
			}
		})
	});

}

// A promise to send request to Zinus API server
const getDiscountPromise = new Promise((resolve, reject) => {
	request({
		url: zinusapiUrl,
		json: true,
	}, function (error, response, body) {
		if (error) throw error;
		if (!error && response.statusCode === 200) {
			if (body.dclist) {
				if (body.dclist.length === 0) {
					reject(`[API] No dclist received`);
				} else {
					systemLog(`[API] Dicount ARRAY LENGTH: ${body.dclist.length}`);
					resolve(body);
				}
			} else {
				reject(`[API] Response returned with exception body: \r\n${JSON.stringify(body)}`);
			}
		} else if (!error && response.statusCode !== 200) {
			reject(`[API] Response returned with Status Code: ${response.statusCode}`);
		}
	})
});

// Excel columns (for Reference)
let excelCols = ['order_index', 'id', 'order_number', 'contact_email', 'created_at', 'total_price', 'total_line_items_price', 'subtotal_price', 'total_tax', 'total_discounts'];

// Below columns need data transformation: transformOrderExcel
excelCols = excelCols.concat(['zinus_po', 'discount_code_0', 'order_recycling_fee', 'line_items_index', 'line_items_sku', 'line_items_product_id', 'line_items_variant_id', 'line_items_quantity', 'line_items_price', 'line_items_discount_price', 'line_items_discount_rate', 'line_items_unit_price', 'line_items_tax_price', 'line_items_tax_rate']);

// OMP columns
const excelColsOMP = ['ISACONTROLNO', 'DOCUMENTNO', 'ISAID', 'SHIPTO', 'SHPNAME', 'SHPADDR1', 'SHPADDR2', 'SHPADDR3', 'SHPADDR4', 'SHPCITY', 'SHPSTATE', 'SHPZIP', 'SHPCOUNTRY', 'SHPPHONE', 'SHPEMAIL', 'PONUMBER', 'REFERENCE', 'ORDDATE', 'TD503', 'TD505', 'TD512', 'EXPDATE', 'DELVBYDATE', 'WHCODE', 'STATUS', 'OPTORD01', 'OPTORD02', 'OPTORD03', 'OPTORD04', 'OPTORD05', 'OPTORD06', 'OPTORD07', 'OPTORD08', 'OPTORD09', 'OPTORD10', 'OPTORD11', 'OPTORD12', 'OPTORD13', 'OPTORD14', 'OPTORD15', 'LINENUM', 'ITEM', 'QTYORDERED', 'ORDUNIT', 'UNITPRICE', 'OPTITM01', 'OPTITM02', 'OPTITM03', 'OPTITM04', 'OPTITM05', 'OPTITM06', 'OPTITM07', 'OPTITM08', 'OPTITM09', 'OPTITM10'];

// Globally scoped order index
let order_index = 0;

//  Transform order data for OMP fields (Map to be included in the source code)
const transformOrderExcel = (orders) => {
	ordersArray = [];
	for (let i = 0; i < orders.length; i++) {
		let order = orders[i];
		// Assign Zinus PO, which is Order # prefixed by "ZC"
		order['zinus_po'] = "ZC" + order.order_number;
		// Order total price cannot be 0 (in case of 100% coupon): 1 cent will be added in which case
		let order_total_price = (parseFloat(order.total_price) < 0.01) ? 0.01 : order.total_price;
		// Two-Letter State code for Washington DC
		let shipState = (order.shipping_address.province === 'District of Columbia') ? 'DC' : order.shipping_address.province;
		// Handle Recycling Fees (Order level)
		let orderRecyclingFee = (order.shipping_lines[0]) ? parseFloat(order.shipping_lines[0].discounted_price) : 0;
		order['order_recycling_fee'] = orderRecyclingFee;
		// Handle discount coupon code: Hardcoded to take in the fixed 0th code only
		let discount_code = (order.discount_codes.length > 0) ? order.discount_codes[0]['code'] : '';
		// Retrieve order level discount (Test purpose only - NOT to be used for invoicing)
		let orderDiscFixed = (order.discount_codes[0] && order.discount_codes[0].type === 'fixed_amount') ? order.discount_codes[0].amount : 0;
		let orderDiscPercent = (order.discount_codes[0] && order.discount_codes[0].type === 'percentage') ? order.discount_codes[0].amount : 0;

		// Handle line item object
		let line_items = order['line_items']
		for (let j = 0; j < line_items.length; j++) {
			let lnItm = line_items[j];
			// Increment the globally scoped Order Index
			order_index++;
			// Pre-tax unit price
			let line_items_unit_pre_tax = parseFloat(lnItm.pre_tax_price / lnItm.quantity);
			// Handle nested tax object
			let line_items_tax_price = 0,
				line_items_tax_rate = 0;
			if (lnItm.tax_lines.length > 0) {
				let line_items_tax_lines = lnItm.tax_lines;
				line_items_tax_rate = line_items_tax_lines.reduce((sum, e) => sum + parseFloat(e["rate"]), 0);
				line_items_tax_price = line_items_tax_lines.reduce((sum, e) => sum + parseFloat(e["price"]), 0);
			};
			// Handle recylcing fee by line item
			let line_items_recycling_fee = 0;
			if (orderRecyclingFee > 0) {
				// If shipping_lines[0].title contains "x" then parse the last letter (e.g. RecylceFee CA x2 => 2); Otherwise, set to 1.
				let multiplier_parsed = (order.shipping_lines[0].title.indexOf('x') > -1) ? parseInt(order.shipping_lines[0].title.slice(-1)) : 1;
				// Only apply if the line item is a mattress
				let line_items_title = lnItm.title.toLowerCase();
				if (line_items_title.indexOf("mattress") > -1 || line_items_title.indexOf("box spring") > -1) {
					line_items_recycling_fee = truncateToCent(orderRecyclingFee / multiplier_parsed * lnItm.quantity);
				}
			}

			// Discount Map Search
			let dc_percent = 0;
			let dc_qry1;
			if(discount_code != null && discount_code.startsWith("ZIN15")){
				dc_qry1 = jsonQuery(['dclist[* title~? & products~?].value', "Welcome15", lnItm.product_id],{data:dcResult});
				if(dc_qry1.value != null && dc_qry1.value.length > 0){
					dc_percent = parseInt(dc_qry1.value[0]);
				}
			}else if(discount_code != null && discount_code != ""){
				dc_qry1 = jsonQuery(['dclist[* title=? & products~? | variants~?].value', discount_code, lnItm.product_id, lnItm.variant_id],{data:dcResult});
				if(dc_qry1.value != null && dc_qry1.value.length > 0){	//
					dc_percent = parseInt(dc_qry1.value);
				}
			}
			let dc_price = Math.abs((dc_percent/100) * parseFloat(lnItm.price));
			let dc_uprice = (parseFloat(lnItm.price) - dc_price);
			dc_price_toFixed = (dc_price).toFixed(2);

			// Clone an order object and push to the ordersArray
			let orderCopy = Object.assign({
				'line_items_index': j+1,
				'line_items_sku': lnItm.sku,
				'line_items_product_id': lnItm.product_id,
				'line_items_variant_id': lnItm.variant_id,
				'line_items_quantity': lnItm.quantity,
				'line_items_price': lnItm.price,
				'line_items_tax_price': line_items_tax_price,
				'line_items_tax_rate': line_items_tax_rate,
				'line_items_discount_rate': dc_percent, // PLACEHOLDER FOR PRICERULE API
				'line_items_discount_price': dc_price_toFixed, // PLACEHOLDER FOR PRICERULE API
				'line_items_unit_price': dc_uprice, // PLACEHOLDER FOR PRICERULE API
				'order_index': order_index,
				'discount_code_0': discount_code,
				// OMP Excel Columns (Total 55) below
				'ISACONTROLNO': order.id, // Shopify Order ID
				'DOCUMENTNO': 1,
				'ISAID': 'ZINUS.COM',
				'SHIPTO': '', // BLANK
				'SHPNAME': order.shipping_address.name,
				'SHPADDR1': order.shipping_address.address1,
				'SHPADDR2': order.shipping_address.address2,
				'SHPADDR3': '',
				'SHPADDR4': '',
				'SHPCITY': order.shipping_address.city,
				'SHPSTATE': shipState,
				'SHPZIP': order.shipping_address.zip,
				'SHPCOUNTRY': order.shipping_address.country,
				'SHPPHONE': order.shipping_address.phone,
				'SHPEMAIL': order.email,
				'PONUMBER': 'ZC' + order.order_number,
				'REFERENCE': '',
				'ORDDATE': moment(order.created_at).format("MM/DD/YYYY"),
				'TD503': '',
				'TD505': '',
				'TD512': '',
				'EXPDATE': moment(order.created_at).add(5, 'day').format("YYYYMMDD"),
				'DELVBYDATE': moment(order.created_at).add(10, 'day').format("YYYYMMDD"),
				'WHCODE': '',
				'STATUS': 0,
				'OPTORD01': order.order_number,
				'OPTORD02': order_total_price.toString(), // Order total price cannot be 0 (in case of 100% coupon): 1 cent will be added in which case
				'OPTORD03': order.subtotal_price, // Order subtotal excludes tax and recycling fee
				'OPTORD04': order.total_tax, // Aggregate tax amount (line items and city/county/state levels)
				'OPTORD05': moment(order.created_at).format("MM/DD/YYYY"),
				'OPTORD06': '',
				'OPTORD07': '',
				'OPTORD08': order.total_discounts,
				'OPTORD09': 'FedEx Ground',
				'OPTORD10': discount_code,
				'OPTORD11': orderRecyclingFee, // Aggregate of recylcing fees (line items)
				'OPTORD12': '',
				'OPTORD13': '',
				'OPTORD14': '',
				'OPTORD15': '',
				'LINENUM': j+1, // Line Item Index
				'ITEM': lnItm.sku,
				'QTYORDERED': lnItm.quantity,
				'ORDUNIT': 'ea',
				'UNITPRICE': line_items_unit_pre_tax, // Unit price (before tax), per qty
				'OPTITM01': line_items_tax_price, // Tax price by line item, qty aggregated
				'OPTITM02': line_items_recycling_fee, // Recylcing fee by line item, qty aggregated
				'OPTITM03': dc_price_toFixed, // Discount price, asbsoulte value
				'OPTITM04': lnItm.pre_tax_price, // Subtotal by line item, qty aggregated
				'OPTITM05': lnItm.price, // Original price
				'OPTITM06': '',
				'OPTITM07': '',
				'OPTITM08': '',
				'OPTITM09': '',
				'OPTITM10': '',
			}, order);
			ordersArray.push(orderCopy);
		}
	}
	return ordersArray;
}

// Convert transformed orders to excel sheet (Reference)
const excelWritePromise1 = (ordersExcel, colsExcel) => {
	// Delcare a stream object for ExcelWriter and specify data cols & rows
	let excelStreamColsArray = colsExcel.map((val) => {
		let acc = {};
		acc.name = val;
		acc.key = val;
		return acc;
	});
	let ExcelWriteStreamOMP = new ExcelWriter({
		sheets: [{
			key: 'ShopifyAPI_Orders',
			name: 'ShopifyAPI_Orders',
			headers: excelStreamColsArray
		}]
	});
	// Return a promise
	return new Promise((resolve, reject) => {
		// Create an array of ExcelWriteStream promises
		const promisesArray = ordersExcel.map((order) => {
			// Break down each order object property to its corresponding column
			let excelInput = {};
			colsExcel.map((prop) => {
				excelInput[prop] = order[prop];
			});
			// Add excelInput obejct to the write stream
			ExcelWriteStreamOMP.addData('ShopifyAPI_Orders', excelInput);
		});
		// Fulfill the array of ExcelWriteStream promises
		Promise.all(promisesArray)
			.then(() => { return ExcelWriteStreamOMP.save(); })
			.then((stream) => {
				stream.pipe(fs.createWriteStream(`./${savePathNameRef}/${saveFileNameRef}`))
			})
			.then(() => resolve(`[Excel] ${saveFileNameRef} successfually saved at: ${savePathNameRef}`))
			.catch((error) => reject(error));
	});
}


// Convert transformed orders to excel sheet (OMP)
const excelWritePromise2 = (ordersExcel, colsExcel) => {
	// Delcare a stream object for ExcelWriter and specify data cols & rows
	let excelStreamColsArray = colsExcel.map((val) => {
		let acc = {};
		acc.name = val;
		acc.key = val;
		// Set default 0 for OPTITM01 column (OMP requirement)
		if (val === 'OPTITM01' || val === 'OPTITM02' || val === 'UNITPRICE' || val === 'STATUS') {
			acc.default = 0;
		}
		return acc;
	});
	let ExcelWriteStreamOMP = new ExcelWriter({
		sheets: [{
			key: 'OE_NewOrder',
			name: 'OE_NewOrder',
			headers: excelStreamColsArray
		}]
	});

	// Return a promise
	return new Promise((resolve, reject) => {
		// Create an array of ExcelWriteStream promises
		const promisesArray = ordersExcel.map((order) => {
			// Break down each order object property to its corresponding column
			let excelInput = {};
			colsExcel.map((prop) => {
				excelInput[prop] = order[prop];
			});
			// Add excelInput obejct to the write stream
			ExcelWriteStreamOMP.addData('OE_NewOrder', excelInput);
		});
		// Fulfill the array of ExcelWriteStream promises
		Promise.all(promisesArray)
			.then(() => { return ExcelWriteStreamOMP.save(); })
			.then((stream) => {
				stream.pipe(fs.createWriteStream(`${savePathNameOMP}\\${saveFileNameOMP}`))
			})
			.then(() => resolve(`[Excel] ${saveFileNameOMP} successfually saved at: ${savePathNameOMP}`))
			.catch((error) => reject(error));
	});
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
					if (result["ok"] === 1) {
						resolve(`[MongoDB] Successfully performed bulk operation with ${result["nUpserted"]} upserted; ${result["nMatched"]} matched; ${result["nModified"]} modified`);
					} else {
						reject(`[MongoDB] ${JSON.stringify(result)}`);
					}
				});
			}
		}
	});
})

/* =================================================== */


/* ================ EXECUTE FUNCTIONS ================ */
// Resolve the recallPromise
Promise.all([getDiscountPromise, recallPromise]).then(function (values) {
	//systemLog(`DISCOUNT: ${values[0]}`);
	dcResult = values[0];
	//dclistArray = values[1];
	let lastOrder = values[1];
	systemLog(`LATEST ORDER ID: ${lastOrder}`);
	return getOrdersPromise(lastOrder);
}).then(orders => {
	// Transform orders for MongoDB
	const ordersMongo = transformOrderMongo(orders);
	// Transform orders for Excel
	const ordersExcel = transformOrderExcel(orders);
	// Insert order entry to MongoDB
	const promise1 = dbInsert(ordersMongo);
	// ExcelWriter for Reference output
	const promise2 = excelWritePromise1(ordersExcel, excelCols);
	// ExcelWriter for OMP output
	const promise3 = excelWritePromise2(ordersExcel, excelColsOMP);
	// Fulfill all promises
	return Promise.all([promise1, promise2, promise3]);
}).then((result) => {
	result.map(e => systemLog(e));
	// Close connection
	systemLog("[MongoDB] Closing MongoDB connection with a resolved promise.");
	mongoose.disconnect();
}).catch(error => {
	systemLog(error);
	// Close connection
	systemLog("[MongoDB] Closing MongoDB connection with a rejected promise.");
	mongoose.disconnect();
});

/* =================================================== */
