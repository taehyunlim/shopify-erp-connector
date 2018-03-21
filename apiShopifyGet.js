
// Dependencies
var request = require('request');
var fs = require('fs');
var path = require('path');
var j2c = require('json-2-csv'); // https://www.npmjs.com/package/json-2-csv
var j2x = require('json2xls'); //https://www.npmjs.com/package/json2xls
var RateLimiter = require('limiter').RateLimiter;
var flatten = require('flat');
var moment = require('moment');
var limiter = new RateLimiter(1, 500);

// Import local config files
var config = require('./config.js');

// Shopify API Credential
var apikey = config.shopify_api_key_dev;
var password = config.shopify_api_pw_dev;
var shopname = config.shopify_shopname_dev;

// Database setup
var mongoose = require('mongoose');
// var models = require('./Models/OrderSchema.js')
var db = mongoose.connection;
var databaseName = 'zsdb_test';
var dbURI = 'mongodb://localhost:27017/' + databaseName;
mongoose.Promise = global.Promise;

// Global variables
var baseurl = 'https://' + apikey + ':' + password + '@' + shopname + '.myshopify.com';
var timestring = moment().format("YYYYMMDD_HHmm");
var incomingPathName = './Export/';
var incomingFileName = `ShopifyAPI_Orders_{$timestring}.csv`;
// var importPathName ='../SageInbound_current/NewOrder/';
var importPathName = './Export/';
var importFileName = `OE_NewOrder_{$timestring}_ZINUS.csv`;
var lastDocumentNo = '';

// System log
var sysLogFile = 'systemLog.txt';
var sysLogInitial = '\r\n@' + timestring + ' >>> ' + __filename + '\r\n'
const systemLog = (log) => {
	fs.appendFileSync(sysLogFile, sysLogInitial + log);
}

// Rounding for discount calcuation
function truncateToCent(value) {
	return Number(Math.floor(value * 100) / 100);
}

var promiseGetOrders = new Promise((resolve, reject) => {
	request(
		{
			url: baseurl + '/admin/orders.json?financial_status=paid&limit=200',
			json: true,
		}, function (error, response, body) {
			if (error) {
				reject (error);
			}
			else {
				resolve(body);
			}
		}
	)
})

promiseGetOrders.then((body)=>{
	console.log("successful");
	return (body.orders[0]["id"])
}, (error) => {
	console.log(error);
}).then((id)=>{
	console.log(id);
})