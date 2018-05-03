/* ================ GLOBAL VARIABLES ================ */
// Dependencies
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const Request = require('tedious').Request;
const TYPES = require('tedious').TYPES;
const Connection = require('tedious').Connection;

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
const dateStringQuery = moment().subtract(7, 'day').format("MM/DD/YYYY");
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
			reject("Query returned no rows");
		} else {
			let rowOrders = transformRows(rows)
			resolve(rowOrders);
		}
	});
	// Add a parameter to the query
	request.addParameter('dateReleased', TYPES.Date, dateStringQuery);
	// Initiate connection
	connection.on('connect', function(err) {
		if (err) return systemLog("SQL Connection Error: " + err);
		connection.execSql(request);
	})
});

// Transform returned rows into MongoDB queryable objects
const transformRows = ((rows) => {
	let rowOrders = [];
	rows.forEach((row) => {
		let entry = {};
		entry['zinus_po'] = row['PONUMBER'].value;
		entry['sage_order_number'] = row['ORDNUMBER'].value;
		entry['wh_code'] = row['LOCATION'].value;
		entry['company'] = row['COMPANY'].value;
		entry['date_ordered_sage'] = row['ORDDATE'].value;
		entry['tracking_no'] = row['SHIPTRACK'].value;
		if (searchRow(row['HOLDREASON'], "cc") || searchRow(row['HOLDREASON'], "oos")) {
			entry['status'] = row['HOLDREASON'].value;
			if (searchRow(row['HOLDREASON'], "cc")) {
				entry['cancelled'] = true;
				entry['closed'] = true;
			}
		}
		rowOrders.push(entry);
	})
	return rowOrders;
})

// Search string within the row property and return a boolean value
function searchRow(rowProp, string) {
	if (rowProp) {
		return (rowProp.value.toLowerCase().indexOf(string) > -1);
	} else { return false; }
}

// Declare a MongoDB promise
const mongoDbPromise  = ((rowOrders) => {
	return new Promise((resolve, reject) => {
		let db = mongoose.connection;
		mongoose.connect(dbURI)
		.catch(error => systemLog(error))
		.then(() => {
			
		})
		// resolve(rowOrders);
	})
});


function mongodbCb(data) {
	//console.log(data);
	mongoose.connect(dbURI);
	db.on('error', console.error.bind(console, 'connection error:::'));
	db.once('open', () => {
		var openOrder = models.OpenOrders;
		var bulk = openOrder.collection.initializeOrderedBulkOp();
		// To invoke a callback after async functions are run through forEach
		var bulkCounter = 0;
		data.forEach((fulfillObj, index, array) => {
			// Loop through fulfillment object array (arg: data)
			if (fulfillObj.tracking_no.length > 12) {
				var query = { zinus_po: fulfillObj.zinus_po };
				//openOrder.updateMany(query, { $set: { m_tracking_no: fulfillObj.m_tracking_no }})
				bulk.find(query).update({ $set: fulfillObj });
				bulkCounter++;
			} else {
				bulkCounter++;
			}
			// Exit condition
			if (bulkCounter === data.length) {
				bulk.execute((err, result) => {
					if (err) throw err;
					systemLog("nMatched: " + result.nMatched + "; nModified: " + result.nModified);
					processExit();
				});
			}

		}) // END OF forEach LOOP
	}) // END OF db.once()
}

/* =================================================== */


/* ================ EXECUTE FUNCTIONS ================ */
sageDbQueryPromise
.then((rowOrders) => {
	// console.log(rowCount);
	return mongoDbPromise(rowOrders);
	connection.close();
})
.then((result) => {
	systemLog(result);
	connection.close();
})
.catch((error) => {
	systemLog(error);
	connection.close();
})



// Write to MongoDB using Mongoose models
function mongodbCb(data) {
	//console.log(data);
	mongoose.connect(dbURI);
	db.on('error', console.error.bind(console, 'connection error:::'));
	db.once('open', () => {
		var openOrder = models.OpenOrders;
		var bulk = openOrder.collection.initializeOrderedBulkOp();
		// To invoke a callback after async functions are run through forEach
		var bulkCounter = 0;
		data.forEach((fulfillObj, index, array) => {
			// Loop through fulfillment object array (arg: data)
			if (fulfillObj.tracking_no.length > 12) {
				var query = { zinus_po: fulfillObj.zinus_po };
				//openOrder.updateMany(query, { $set: { m_tracking_no: fulfillObj.m_tracking_no }})
				bulk.find(query).update({ $set: fulfillObj });
				bulkCounter++;
			} else {
				bulkCounter++;
			}
			// Exit condition
			if (bulkCounter === data.length) {
				bulk.execute((err, result) => {
					if (err) throw err;
					systemLog("nMatched: " + result.nMatched + "; nModified: " + result.nModified);
					processExit();
				});
			}

    	}) // END OF forEach LOOP
 	}) // END OF db.once()
}

function processExit() {
  db.close();
  process.exit();
}
