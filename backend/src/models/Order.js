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
  
  // ============================================================
  // 🆕 ATTRIBUTION - Para vincular órdenes a campañas/flows
  // ============================================================
  attribution: {
    // Campaña que generó esta orden
    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      index: true
    },
    // Flow que generó esta orden (si aplica)
    flow: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Flow',
      index: true
    },
    // Fuente de la atribución
    source: {
      type: String,
      enum: ['email_click', 'discount_code', 'utm', 'cookie', 'manual', 'unknown'],
      default: 'unknown'
    },
    // Fecha del click que llevó a la compra
    clickedAt: Date,
    // UTM params si los hay
    utmSource: String,
    utmMedium: String,
    utmCampaign: String,
    // Código de descuento usado (si aplica)
    discountCode: String,
    // Ventana de atribución (días desde el click)
    attributionWindow: {
      type: Number,
      default: 7
    }
  },
  
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

// ============================================================
// ÍNDICES
// ============================================================
orderSchema.index({ orderDate: -1 });
orderSchema.index({ customer: 1, orderDate: -1 });
orderSchema.index({ totalPrice: -1 });
orderSchema.index({ discountCodes: 1 });
orderSchema.index({ 'attribution.campaign': 1 });  // 🆕 Para búsquedas por campaña
orderSchema.index({ 'attribution.flow': 1 });       // 🆕 Para búsquedas por flow
orderSchema.index({ 'attribution.source': 1 });     // 🆕 Para análisis por fuente

// ============================================================
// MÉTODOS ESTÁTICOS
// ============================================================

/**
 * Obtener órdenes atribuidas a una campaña
 */
orderSchema.statics.getByCampaign = async function(campaignId, options = {}) {
  const { limit = 100, sort = { orderDate: -1 } } = options;
  
  return this.find({ 'attribution.campaign': campaignId })
    .populate('customer', 'email firstName lastName')
    .sort(sort)
    .limit(limit);
};

/**
 * Obtener revenue total de una campaña
 */
orderSchema.statics.getCampaignRevenue = async function(campaignId) {
  const result = await this.aggregate([
    { $match: { 'attribution.campaign': new mongoose.Types.ObjectId(campaignId) } },
    { 
      $group: {
        _id: null,
        totalRevenue: { $sum: '$totalPrice' },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: '$totalPrice' }
      }
    }
  ]);
  
  return result[0] || { totalRevenue: 0, orderCount: 0, avgOrderValue: 0 };
};

/**
 * Obtener top productos de una campaña
 */
orderSchema.statics.getTopProductsByCampaign = async function(campaignId, limit = 10) {
  const result = await this.aggregate([
    { $match: { 'attribution.campaign': new mongoose.Types.ObjectId(campaignId) } },
    { $unwind: '$lineItems' },
    {
      $group: {
        _id: '$lineItems.title',
        quantity: { $sum: '$lineItems.quantity' },
        revenue: { $sum: { $multiply: ['$lineItems.price', '$lineItems.quantity'] } }
      }
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        title: '$_id',
        quantity: 1,
        revenue: 1
      }
    }
  ]);
  
  return result;
};

/**
 * Atribuir una orden a una campaña
 */
orderSchema.statics.attributeToCampaign = async function(orderId, campaignId, source = 'email_click') {
  return this.findByIdAndUpdate(orderId, {
    'attribution.campaign': campaignId,
    'attribution.source': source,
    'attribution.clickedAt': new Date()
  }, { new: true });
};

module.exports = mongoose.model('Order', orderSchema);