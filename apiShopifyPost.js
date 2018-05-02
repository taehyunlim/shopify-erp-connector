/* ================ GLOBAL VARIABLES ================ */

// Dependencies
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const Request = require('tedious').Request;
const TYPES = require('tedious').TYPES;
const Connection = require('tedious').Connection;

// Database setup
const mongoose = require('mongoose');
const models = require('./Models/OrderSchema.js')
const db = mongoose.connection;
const databaseName = 'zsdb';
const dbURI = 'mongodb://localhost:27017/' + databaseName;
mongoose.Promise = global.Promise;

// Shopify API Credential
const config = require('./config.js');
/* const apikey = config.shopify_api_key_dev;
const password = config.shopify_api_pw_dev;
const shopname = config.shopify_shopname_dev; */
const apikey = config.shopify_api_key_prod;
const password = config.shopify_api_pw_prod;
const shopname = config.shopify_shopname_prod;

// DB Access Key
const dbun = config.dbun;
const dbpw = config.dbpw;
const dbsvr = config.dbsvr;


// Global variables
const baseurl = `https://${apikey}:${password}@${shopname}.myshopify.com`;
const dateString = moment().format("YYYYMMDD");
const dateTimeString = moment().format("YYYYMMDD_HHmm");
const timestring_query = moment().subtract(7, 'day').format("MM/DD/YYYY");
const savePathNameRef = `./OrderImport/${dateString}`;
const saveFileNameRef = `ShopifyAPI_Orders_${dateTimeString}.xlsx`;
const savePathNameOMP = '../SageInbound_current/NewOrder/.';
const saveFileNameOMP = `.OE_NewOrder_${dateTimeString}_ZINUS.xlsx`;
const currentFileName = path.basename(__filename);

// SQL QUERY
var sqlQueryOEORDH = "SELECT RTRIM(OEORDH.PONUMBER) AS PONUMBER, RTRIM(OEORDH.ORDNUMBER) AS ORDNUMBER, RTRIM(OEORDH.LOCATION) AS LOCATION, RTRIM(OEORDH.CUSTOMER) AS COMPANY, RTRIM(OEORDH1.SHIPTRACK) + ',' AS SHIPTRACK, RTRIM(OEORDH.ORDDATE) AS ORDDATE, RTRIM(OEORDH.ONHOLD) AS ONHOLD, RTRIM(OEORDH1.HOLDREASON) AS HOLDREASON FROM [ZISCOM].[dbo].OEORDH OEORDH LEFT JOIN [ZISCOM].[dbo].OEORDH1 OEORDH1 ON OEORDH.ORDUNIQ = OEORDH1.ORDUNIQ WHERE (((OEORDH.CUSTOMER)='ZINUS.COM') AND ( CONVERT(DATETIME, RTRIM(OEORDH.ORDDATE)) >= CONVERT(DATETIME, @dateReleased) ) ) AND RTRIM(OEORDH1.SHIPTRACK) <> ''";

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


var dbconfig = {
    userName: dbun,
    password: dbpw,
    server: dbsvr,
    options: {
      rowCollectionOnDone: true,
      useColumnNames: true,
      rowCollectionOnRequestCompletion: true
    }
};

console.log(JSON.stringify(dbconfig));

var connection = new Connection(dbconfig);

connection.on('connect', function(err) {
// If no error, then good to proceed.
	if (err) return console.error("Connection error! " + err);
    //console.log("Connected");
    executeStatement(sqlQueryOEORDH, requestCallback);
});

function executeStatement(query, cb) {
    request = new Request(query, cb);
    request.addParameter('dateReleased', TYPES.Date, timestring_query);
    console.log('Starting query date: ' + timestring_query);
    systemLog('Starting query date: ' + timestring_query);
    connection.execSql(request);
}

function requestCallback(err, rowCount, rows) {
  if (err) throw err;
    console.log(rows.length);
  // Exit process if no fulfillment returned
  if (rowCount === 0) {
    console.log("Query returned no new fulfillments");
    systemLog("Query returned no new fulfillments")
    processExit();
  }
  var fulfillObjList = [];
  rows.forEach((row) => {
    var tmpObj = {};
    // Array of needed columns
    var cols = ['zinus_po', 'sage_order_number', 'wh_code', 'company', 'date_ordered_sage',  'tracking_no', 'status'];
    // Array of all available columns
    var oldCols = ['PONUMBER', 'ORDNUMBER', 'LOCATION', 'COMPANY', 'ORDDATE', 'SHIPTRACK', 'ONHOLD', 'HOLDREASON', 'INVNUM', 'REFERENCE'];

    Object.keys(row).forEach((key) => {
			//console.log(key + " ::: " + row[key].value);
			tmpObj[key] = row[key].value;
			tmpObj[cols[0]] = tmpObj[oldCols[0]]; //zinus_po = PONUMBER
			tmpObj[cols[1]] = tmpObj[oldCols[1]]; //sage_order_number = ORDNUMBER
			tmpObj[cols[2]] = tmpObj[oldCols[2]]; //wh_code = LOCATION
			tmpObj[cols[3]] = tmpObj[oldCols[3]]; //company = COMPANY
			tmpObj[cols[4]] = moment(tmpObj[oldCols[4]]).format("YYYYMMDD_HHmm"); //date_orderd: YUJI TO UPDATE
			// Tracking Number
			if (tmpObj[oldCols[5]] !== ',') {
				tmpObj[cols[5]] = tmpObj[oldCols[5]]; //tracking_no
			} else {
				tmpObj[cols[5]] = '';
			}
			// If onhold
			if (tmpObj['ONHOLD'] === '1') {
				tmpObj[cols[6]] = tmpObj['HOLDREASON'];
			} else {
				tmpObj[cols[6]] = '';
			}
		})
    // Delete old columns
    for (var i = 0; i < oldCols.length; i++) {
      delete tmpObj[oldCols[i]];
    }
    // Save the object in the  array
    fulfillObjList.push(tmpObj);
  })
  console.log(fulfillObjList);
  mongodbCb(fulfillObjList);
  //j2c.json2csv(fulfillObjList, j2cCallback)
}


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
