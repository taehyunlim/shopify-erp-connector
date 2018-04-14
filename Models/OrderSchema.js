var mongoose = require('mongoose');

// Create a schema for orders
var OrderSchemaZSDB = new mongoose.Schema({
  shopify_order_id: {
    type: String,
    unique: true
  },
  doc_no: String,
  status: String,
  date_ordered_shopify: String,
  date_ordered_sage: String,
  date_imported: String,
  date_fulfilled: String,
  date_posted: String,
  date_last_updated: String,
  shopify_po: {
    type: String,
    index: true
  },
  zinus_po: {
    type: String,
    index: true
  },
  sage_order_number: {
    type: String,
    index: true
  },
  m_tracking_no: String,
  tracking_no: String,
  company: String,
  wh_code: String,
  cancelled: Boolean,
  posted: Boolean,
  closed: Boolean
})

var PendingSchemaZSDB = new mongoose.Schema({
  shopify_order_id: {
    type: String,
    unique: true
  },
  shopify_po: {
    type: String,
    index: true
  },

  date_ordered_shopify: String,
  date_expiration: String,
  risk_level: String
})

// Define and export collections based on Mongoose schema
module.exports = {
  OpenOrders: mongoose.model('OpenOrders', OrderSchemaZSDB, 'orders_open'),
  ClosedOrders: mongoose.model('ClosedOrders', OrderSchemaZSDB, 'orders_closed'),
  PendingOrders: mongoose.model('PendingOrders', PendingSchemaZSDB, 'orders_pending')
};
