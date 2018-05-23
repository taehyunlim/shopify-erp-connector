/* ================ GLOBAL VARIABLES ================ */
// Dependencies
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const Request = require('tedious').Request;
const TYPES = require('tedious').TYPES;
const Connection = require('tedious').Connection;
const request = require('request');

// Throttling
const Bottleneck = require('bottleneck');
const limiter = new Bottleneck({
	maxConcurrent: 1,
	minTime: 100
});

// Shopify API Credential
const config = require('./config.js');
/* const apikey = config.shopify_api_key_dev;
const password = config.shopify_api_pw_dev;
const shopname = config.shopify_shopname_dev; */
const apikey = config.shopify_api_key_prod;
const password = config.shopify_api_pw_prod;
const shopname = config.shopify_shopname_prod;

// API & File System Write Related
const baseurl = `https://${apikey}:${password}@${shopname}.myshopify.com`;
const dateString = moment().format("YYYYMMDD");
const dateTimeString = moment().format("YYYYMMDD_HHmm");
const dateStringQuery = moment().subtract(3, 'day').format("MM/DD/YYYY");
const savePathNameRef = `./OrderImport/${dateString}`;
const saveFileNameRef = `ShopifyAPI_Orders_${dateTimeString}.xlsx`;
const savePathNameOMP = '../SageInbound_current/NewOrder/.';
const saveFileNameOMP = `.OE_NewOrder_${dateTimeString}_ZINUS.xlsx`;
const currentFileName = path.basename(__filename);

// MongoDB setup
const mongoose = require('mongoose');
const models = require('./Models/OrderSchema.js')
const databaseName = 'zsdb';
const dbURI = 'mongodb://localhost:27017/' + databaseName;
mongoose.Promise = global.Promise;
// Set Mongoose models as constant variables
const openOrder = models.OpenOrders,
	closedOrder = models.ClosedOrders,
	pendingOrder = models.PendingOrders;

// MSSQL Access & Config 
const dbun = config.dbun;
const dbpw = config.dbpw;
const dbsvr = config.dbsvr;
const dbconfig = {
	userName: dbun,
	password: dbpw,
	server: dbsvr,
	options: {
		rowCollectionOnDone: true,
		useColumnNames: true,
		rowCollectionOnRequestCompletion: true
	}
};
const connection = new Connection(dbconfig);

// Query for MSSQL
const sqlQueryOEORDH = 
`SELECT 
	RTRIM(OEORDH.PONUMBER) AS PONUMBER, 
	RTRIM(OEORDH.ORDNUMBER) AS ORDNUMBER, 
	RTRIM(OEORDH.LOCATION) AS LOCATION, 
	RTRIM(OEORDH.CUSTOMER) AS COMPANY, 
	RTRIM(OEORDH1.SHIPTRACK) + ',' AS SHIPTRACK, 
	RTRIM(OEORDH.ORDDATE) AS ORDDATE, 
	RTRIM(OEORDH.ONHOLD) AS ONHOLD, 
	RTRIM(OEORDH1.HOLDREASON) AS HOLDREASON 
FROM [ZISCOM].[dbo].OEORDH OEORDH 
LEFT JOIN [ZISCOM].[dbo].OEORDH1 OEORDH1 
	ON OEORDH.ORDUNIQ = OEORDH1.ORDUNIQ 
WHERE (
	((OEORDH.CUSTOMER)='ZINUS.COM') 
	AND (CONVERT(DATETIME, RTRIM(OEORDH.ORDDATE)) >= CONVERT(DATETIME, @dateReleased)) 
)`;
// AND RTRIM(OEORDH1.SHIPTRACK) <> ''
// AND(RTRIM(OEORDH.ONHOLD) = '1')
// AND (ORDNUMBER LIKE 'ORD320899%')


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
(function () {
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
// Declare a promise object for the MSSQL DB
const sageDbQueryPromise = new Promise((resolve, reject) => {
	// Declare a request object with a callback to resolve data
	let request = new Request(sqlQueryOEORDH, (err, rowCount, rows) => {
		if (err) throw err;
		if (rowCount === 0) {
			reject("[MSSQL] Query returned no rows");
		} else {
			let rowOrders = transformRows(rows)
			resolve(rowOrders);
		}
	});
	// Add a parameter to the query
	request.addParameter('dateReleased', TYPES.Date, dateStringQuery);
	// Initiate connection
	connection.on('connect', function(err) {
		if (err) return systemLog("[MSSQL] SQL Connection Error: " + err);
		connection.execSql(request);
	})
});

// Transform returned rows into MongoDB queryable objects
const transformRows = ((rows) => {
	// Create an empty array to insert rows into
	let rowOrders = [];
	rows.forEach(row => {
		let trackNo = row['SHIPTRACK'].value;
		let isNew = false;
		let isNewTrack = false;
		if (trackNo && trackNo.length > 10) {
			// If trackNo is found, then insert to rowOrders array
			isNew = true;
			// Remove any exisitng row 
			rowOrders = rowOrders.filter((e) => {
				return e.zinus_po !== row['PONUMBER'].value;
			})
		} else {
			// No trackNo return for the row
			// Declare poExist function that returns a boolean
			function poExist(e) { return e.zinus_po === row['PONUMBER'].value; }
			// Insert only if there is no existing row with the same PO
			if (rowOrders.find(poExist) == null) {
				isNew = true;
			}
		}
		let entry = {};
		entry['zinus_po'] = row['PONUMBER'].value;
		entry['sage_order_number'] = row['ORDNUMBER'].value;
		entry['wh_code'] = row['LOCATION'].value;
		entry['company'] = row['COMPANY'].value;
		entry['date_ordered_sage'] = timestamp(row['ORDDATE'].value);
		entry['date_imported'] = timestamp(row['ORDDATE'].value);
		//entry['date_fulfilled'] = dateTimeString;	
		entry['tracking_no'] = trackNo;
		// If/Then logic for order status update
		if ((searchRow(row['HOLDREASON'], "duplicate") === false) && row['HOLDREASON'].value.length > 1) {
			entry['status'] = row['HOLDREASON'].value;
			if (searchRow(row['HOLDREASON'], "cc")) {
				entry['cancelled'] = true;
				entry['closed'] = true;
			}
		} else if (trackNo.length > 10) {
			entry['status'] = 'fulfilled'
		} else {
			entry['status'] = "imported"
		}
		// Now, push entry to the rowOrders array
		if (isNew) {
			rowOrders.push(entry);
		}
	})
	// Return the array of transformed rows 
	return rowOrders;
})

// Search string within the row property and return a boolean value
function searchRow(rowProp, string) {
	if (rowProp) {
		return (rowProp.value.toLowerCase().indexOf(string) > -1);
	} else { return false; }
}

// Declare a MongoDB promise (Update)
const mongoUpdatePromise = ((rowOrders) => {
	return new Promise((resolve, reject) => {
		mongoose.connect(dbURI)
		.catch(error => systemLog(error))
		.then(() => {
			// Initialize a bulk operation using Mongoose bulk object
			let bulk = openOrder.collection.initializeOrderedBulkOp();
			let bulkCounter = 0;
			// Loop over the rows and find/update each row
			rowOrders.forEach((rowOrder) => {
				let query = { zinus_po: rowOrder.zinus_po };
				bulk.find(query).update({ $set: rowOrder });
				bulkCounter++;
			})
			// Exit bulk operation
			if (bulkCounter === rowOrders.length) {
				bulk.execute((err, result) => {
					if (err) throw err;
					resolve("[MongoDB] nMatched: " + result.nMatched + "; nModified: " + result.nModified);
				});
			}
		}) // End of .then()
	}) // End of new Promise instance
});

// Declare another MongoDB promise (Update fulfillment status)
const mongoUpdateFulfill = ((orderIdArray) => {
	mongoose.connect(dbURI)
		.catch(error => systemLog(error))
		.then(() => {
			// Initialize a bulk operation using Mongoose bulk object
			let bulk = openOrder.collection.initializeOrderedBulkOp();
			let bulkCounter = 0;
			// Loop over the rows and find/update each row
			orderIdArray.forEach((orderId) => {
				let query = { shopify_order_id: parseInt(orderId) };
				bulk.find(query).update({ $set: { closed: true } });
				bulkCounter++;
			})
			// Exit bulk operation
			if (bulkCounter === rowOrders.length) {
				bulk.execute((err, result) => {
					if (err) throw err;
				});
			}
		}) // End of .then()
});


// Declare another MongoDB promise (Read)
const mongoReadPromise = (() => {
	return new Promise((resolve, reject) => {
		openOrder.find({}, (err, data) => {
			if (err) throw err;
			if (data.length === 0) {
				reject("[MongoDB] No open orders found");
			} else {
				systemLog("[MongoDB] Total open orders count: " + data.length);
				resolve(transformFulfillment(data));
			}
		});

	}) // End of new Promise instance
});

const transformFulfillment = (data => {
	let fulfillmentArray = [];
	data.forEach(order => {
		let fulfillment = {};
		let trackingArray = order.tracking_no.replace(" ", "").split(",").filter(v => v != " ").filter(v => v != "");
		fulfillment['orderId'] = order.shopify_order_id;
		fulfillment['requestBody'] = {
			fulfillment: {
				tracking_company: 'FedEx',
				tracking_numbers: trackingArray
			}
		};
		fulfillment['updateBody'] = {
			order: {
				"id": order.shopify_order_id,
				"tags": `sage_ord_num: ${order.sage_order_number}, sage_status: ${order.status}`
			}
		}
		// Dev Only
		// console.log(JSON.stringify(fulfillment));		
		fulfillmentArray.push(fulfillment);
	})
	return fulfillmentArray;	
});

// Put order update promise
const putPostPromise = (updates => {
	return new Promise((resolve, reject) => {
		getOrderTags(updates)
		.then(result => {
			postFulfillPromise(result);
			return putUpdatePromise(result);
		}).then(result => {
			resolve(result);
		}).catch(e => {
			if (e) throw e;
		});
	})
})

// Get Order Tags
const getOrderTags = (updates => {
	return new Promise((resolve, reject) => {
		let requestArray = [];
		updates.forEach(update => {
			let orderId = update.orderId;
			let reqOptions = {
				url: baseurl + '/admin/orders/' + orderId,
				json: true,
				update: update
			}
			requestArray.push(limiter.schedule(getOrderTagsRequest, reqOptions))
		})
		
		Promise.all(requestArray.map(p => p.catch(e => e)))
			.then(results => {
				systemLog("[API] getOrderTagsRequest Promise.all resolved")
				resolve(results)
			}).catch(e => {
				systemLog(e);
				reject("[API] getOrderTagsRequest Promise.all failed resolve");
			});

	})
})

const getOrderTagsRequest = (reqOptions => {
	return new Promise((resolve, reject) => {
		request(reqOptions, (error, response, body) => {
			if (error) throw error;
			let tags = body.order.tags;
			if (tags.length > 0) {
				reqOptions.update.updateBody.order.tags += ", " + body.order.tags;
			}
			resolve(reqOptions.update);
		})
	})
})

// Put Update promise
const putUpdatePromise = (updates => {
	return new Promise((resolve, reject) => {
		let requestArray = [];
		updates.forEach(update => {
			let tagsString = "";
			let orderId = update.orderId;
			let reqOptions = {
				method: 'PUT',
				url: baseurl + '/admin/orders/' + orderId + '.json',
				body: update.updateBody,
				json: true,
				orderId: orderId
			};
			requestArray.push(limiter.schedule(postRequest, reqOptions))
		}) 

		Promise.all(requestArray.map(p => p.catch(e => e)))
			.then(results => {
				systemLog("[API] putUpdatePromise Promise.all resolved")
				resolve(results)
			}).catch(e => {
				systemLog(e);
				reject("[API] putUpdatePromise Promise.all failed to resolve");
			});

	})
})

// Post fulfillment promise
const postFulfillPromise = (fulfillments => {
	return new Promise((resolve, reject) => {
		let requestArray = []
		fulfillments.forEach(fulfillment => {
			let orderId = fulfillment.orderId;
			let reqOptions = {
				method: 'POST',
				url: baseurl + '/admin/orders/' + orderId + '/fulfillments.json',
				body: fulfillment.requestBody,
				json: true,
				orderId: orderId
			};
			// Only call fulfillment API if tracking numbers are present
			if (fulfillment.requestBody.fulfillment.tracking_numbers.length > 0) {
				requestArray.push(limiter.schedule(postRequest, reqOptions));
			}

		});

		Promise.all(requestArray.map(p => p.catch(e => e)))
		.then(results => {
			systemLog("[API] postFulfillmentPromise Promise.all resolved")
			resolve(results)
		}).catch(e => {
			systemLog(e);
			reject("[API] postFulfillmentPromise Promise.all failed to resolve");
		});

	})
})

const postRequest = (options) => {
	return new Promise((resolve, reject) => {
		request(options, (error, response, body) => {
			if (error) throw error;
			let result = {};
			if (options.method === "PUT") {
				result["fulfillment_status"] = body.order.fulfillment_status;
				result["closed_at"] = body.order.closed_at;
				result["cancelled_at"] = body.order.cancelled_at;
			}
			result["orderId"] = options.orderId;		
			// result["fulfillment_status"] = fulfill_stat;
			systemLog(`[API] Method: ${options.method} / OrderId: ${options.orderId} / Status Code: ${response.statusCode} / Options: ${JSON.stringify(options.body)}`);
			resolve(result);
		})
	})
}

const mongoRemovePromise = (data) => {
	return new Promise((resolve, reject) => {
		// Initialize a bulk operation using Mongoose bulk object
		let bulkOpen = openOrder.collection.initializeOrderedBulkOp();
		let bulkClosed = closedOrder.collection.initializeOrderedBulkOp();
		let bulkCounter = 0;
		// forEach loop over the returned result from Shopify
		data.forEach((doc) => {
			let query = { shopify_order_id: parseInt(doc.orderId) };
			if (doc.cancelled_at || doc.closed_at) {
				// Set {closed: true} and etc. if cancelled_at and/or closed_at is truthy
				if (doc.cancelled_at) {
					bulkOpen.find(query).update({ $set: { closed: true, cancelled: true } });
				} else if (doc.closed_at) {
					bulkOpen.find(query).update({ $set: { closed: true, posted: true } });
				}
			}
			bulkCounter++;
		})
		// Exit bulk operation
		if (bulkCounter === data.length) {
			bulkOpen.execute((err, result) => {
				if (err) throw err;
				systemLog("[MongoDB] Set {closed: true}; nMatched: " + result.nMatched + "; nModified: " + result.nModified);
				// Move closed docs from openOrder to closedOrder
				let bulkInsert = closedOrder.collection.initializeUnorderedBulkOp();
				let bulkRemove = openOrder.collection.initializeUnorderedBulkOp();
				openOrder.find({ closed: true }, (err, data) => {
					data.forEach(doc => {
						bulkInsert.insert(doc);
						bulkRemove.find({ _id: doc._id }).removeOne();
					})
					bulkInsert.execute((err, result) => {
						if (err) { 
							systemLog(JSON.stringify(err)); 
						} else {
							systemLog(`[MongoDB] Inserted {closed: true} to {closedOrder}; nInserted: ${result.nInserted}`)
						}
						// Finally, remove exisitng closed orders from openOrder
						bulkRemove.execute((err, result) => {
							if (err) throw err;
							resolve(`[MongoDB] Removed {closed: true} orders from {openOrder}; nRemoved: ${result.nRemoved}`);
						})
					});
				})
				
			});
		}
				
	}) // End of .then()
	
}

/* =================================================== */


/* ================ EXECUTE FUNCTIONS ================ */
sageDbQueryPromise
.then((rowOrders) => {
	// console.log(rowCount);
	return mongoUpdatePromise(rowOrders);
}).then((result) => {
	systemLog(result);
	return mongoReadPromise();
}).then((fulfillments) => {
	return putPostPromise(fulfillments);
}).then((result) => {
	return mongoRemovePromise(result);
}).then((result) => {
	systemLog(result);
	connection.close();
	mongoose.disconnect();
})
.catch((error) => {
	systemLog(error);
	connection.close();
	mongoose.disconnect();
})


