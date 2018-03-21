
// Dependencies
var request = require('request');
var fs = require('fs');
var path = require('path');
var parse = require('csv-parse');
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
var models = require('./models/OrderSchema.js')
var db = mongoose.connection;
var databaseName = 'zsdb';
var dbURI = 'mongodb://localhost:27017/' + databaseName;
mongoose.Promise = global.Promise;

// Global variables
var baseurl = 'https://' + apikey + ':' + password + '@' + shopname + '.myshopify.com';
var timestring = moment().format("YYYYMMDD_HHmm");
var incomingPathName = './Orders/' //'ShopifyAPI_Orders_' + timestring +'.csv';
var incomingFileName = 'ShopifyAPI_Orders_';
var importPathName = '../SageInbound_current/NewOrder/.' //'OE_NewOrder_' + timestring + '_ZINUS.csv';
var importFileName = 'OE_NewOrder_';
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
