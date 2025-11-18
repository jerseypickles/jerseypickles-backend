// backend/src/models/Order.js
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  shopifyId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  orderNumber: String,
  
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    index: true
  },
  
  // Información financiera
  totalPrice: {
    type: Number,
    required: true
  },
  subtotalPrice: Number,
  totalTax: Number,
  totalShipping: Number,
  totalDiscounts: Number,
  currency: {
    type: String,
    default: 'USD'
  },
  
  // Productos
  lineItems: [{
    productId: String,
    variantId: String,
    title: String,
    quantity: Number,
    price: Number,
    sku: String
  }],
  
  // Estado
  financialStatus: String,
  fulfillmentStatus: String,
  
  // Información adicional
  discountCodes: [String],
  tags: [String],
  
  // Fechas
  orderDate: {
    type: Date,
    index: true
  },
  
  // Metadata de Shopify
  shopifyData: mongoose.Schema.Types.Mixed
  
}, {
  timestamps: true,
  collection: 'orders'
});

// Índices para análisis
orderSchema.index({ orderDate: -1 });
orderSchema.index({ customer: 1, orderDate: -1 });
orderSchema.index({ totalPrice: -1 });

module.exports = mongoose.model('Order', orderSchema);