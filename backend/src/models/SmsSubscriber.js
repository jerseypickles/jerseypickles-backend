// backend/src/models/SmsSubscriber.js
const mongoose = require('mongoose');

const smsSubscriberSchema = new mongoose.Schema({
  // ==================== IDENTIFICACIÓN ====================
  phone: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  phoneFormatted: {
    type: String  // +1 (908) 555-1234 para display
  },
  
  // ==================== CÓDIGO DE DESCUENTO ====================
  discountCode: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  discountPercent: {
    type: Number,
    default: 15
  },
  discountType: {
    type: String,
    enum: ['percentage', 'fixed_amount'],
    default: 'percentage'
  },
  shopifyPriceRuleId: String,    // ID del price rule en Shopify
  shopifyDiscountId: String,     // ID del discount code en Shopify
  
  // ==================== ESTADO DE SUSCRIPCIÓN ====================
  status: {
    type: String,
    enum: ['pending', 'active', 'unsubscribed', 'invalid'],
    default: 'pending'
  },
  subscribedAt: {
    type: Date,
    default: Date.now
  },
  unsubscribedAt: Date,
  unsubscribeReason: String,
  
  // ==================== ORIGEN ====================
  source: {
    type: String,
    enum: ['popup', 'checkout', 'manual', 'import', 'landing_page', 'website-popup-sms', 'api', 'test'],
    default: 'popup'
  },
  sourceUrl: String,           // URL donde se suscribió
  sourceCampaign: String,      // UTM campaign si aplica
  deviceType: {
    type: String,
    enum: ['mobile', 'desktop', 'tablet', 'unknown'],
    default: 'unknown'
  },
  
  // ==================== SMS TRACKING ====================
  welcomeSmsSent: {
    type: Boolean,
    default: false
  },
  welcomeSmsSentAt: Date,
  welcomeSmsId: String,         // Telnyx message ID
  welcomeSmsStatus: {
    type: String,
    enum: ['pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered'],
    default: 'pending'
  },
  welcomeSmsDeliveredAt: Date,
  welcomeSmsCost: Number,       // Costo en USD
  welcomeSmsError: String,      // Error si falló
  
  // ==================== CARRIER INFO ====================
  carrier: String,              // T-Mobile, Verizon, etc.
  lineType: {
    type: String,
    enum: ['wireless', 'landline', 'voip', 'unknown'],
    default: 'unknown'
  },
  
  // ==================== CONVERSIÓN ====================
  converted: {
    type: Boolean,
    default: false
  },
  conversionData: {
    orderId: String,            // Shopify order ID
    orderNumber: String,        // #1001
    orderTotal: Number,
    discountAmount: Number,     // Cuánto se descontó
    convertedAt: Date,
    timeToConvert: Number,      // Minutos desde SMS hasta compra
    products: [{
      productId: String,
      title: String,
      quantity: Number,
      price: Number
    }]
  },
  
  // ==================== ENGAGEMENT (para futuras campañas) ====================
  totalSmsSent: {
    type: Number,
    default: 0
  },
  totalSmsDelivered: {
    type: Number,
    default: 0
  },
  totalSmsClicked: {
    type: Number,
    default: 0
  },
  totalOrders: {
    type: Number,
    default: 0
  },
  totalRevenue: {
    type: Number,
    default: 0
  },
  lastSmsAt: Date,
  lastOrderAt: Date,
  
  // ==================== HISTORIAL DE SMS ====================
  smsHistory: [{
    messageId: String,          // Telnyx ID
    type: {
      type: String,
      enum: ['welcome', 'campaign', 'abandoned_cart', 'order_update', 'promo'],
      default: 'welcome'
    },
    campaignId: String,
    content: String,            // Texto del SMS (truncado)
    status: String,
    sentAt: Date,
    deliveredAt: Date,
    cost: Number,
    clicked: Boolean,
    clickedAt: Date
  }],
  
  // ==================== CUSTOMER LINK ====================
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    index: true
  },
  shopifyCustomerId: String,
  email: String,                // Si también tienen email
  
  // ==================== COMPLIANCE ====================
  tcpaConsent: {
    type: Boolean,
    default: true
  },
  tcpaConsentAt: Date,
  tcpaConsentIp: String,
  
  // ==================== META ====================
  tags: [String],
  notes: String
  
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ==================== INDEXES ====================
smsSubscriberSchema.index({ status: 1, subscribedAt: -1 });
smsSubscriberSchema.index({ converted: 1 });
smsSubscriberSchema.index({ welcomeSmsStatus: 1 });
smsSubscriberSchema.index({ 'conversionData.orderId': 1 });
smsSubscriberSchema.index({ createdAt: -1 });

// ==================== VIRTUALS ====================
smsSubscriberSchema.virtual('conversionRate').get(function() {
  if (this.totalSmsSent === 0) return 0;
  return (this.totalOrders / this.totalSmsSent * 100).toFixed(2);
});

smsSubscriberSchema.virtual('isDelivered').get(function() {
  return this.welcomeSmsStatus === 'delivered';
});

// ==================== STATICS ====================

// Generar código único tipo JP-XXXX
smsSubscriberSchema.statics.generateDiscountCode = async function() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin I, O, 0, 1 para evitar confusión
  let code;
  let exists = true;
  
  while (exists) {
    code = 'JP-';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    exists = await this.findOne({ discountCode: code });
  }
  
  return code;
};

// Stats generales
smsSubscriberSchema.statics.getStats = async function(dateRange = {}) {
  const match = {};
  
  if (dateRange.start || dateRange.end) {
    match.createdAt = {};
    if (dateRange.start) match.createdAt.$gte = new Date(dateRange.start);
    if (dateRange.end) match.createdAt.$lte = new Date(dateRange.end);
  }
  
  const [stats] = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalSubscribers: { $sum: 1 },
        activeSubscribers: {
          $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
        },
        totalSmsSent: { $sum: '$totalSmsSent' },
        totalDelivered: {
          $sum: { $cond: [{ $eq: ['$welcomeSmsStatus', 'delivered'] }, 1, 0] }
        },
        totalConverted: {
          $sum: { $cond: ['$converted', 1, 0] }
        },
        totalRevenue: { $sum: '$totalRevenue' },
        totalSmsCost: { $sum: '$welcomeSmsCost' },
        avgTimeToConvert: {
          $avg: {
            $cond: ['$converted', '$conversionData.timeToConvert', null]
          }
        }
      }
    }
  ]);
  
  if (!stats) {
    return {
      totalSubscribers: 0,
      activeSubscribers: 0,
      totalSmsSent: 0,
      deliveryRate: 0,
      conversionRate: 0,
      totalRevenue: 0,
      totalSmsCost: 0,
      roi: 0,
      avgTimeToConvert: 0
    };
  }
  
  return {
    ...stats,
    deliveryRate: stats.totalSmsSent > 0 
      ? ((stats.totalDelivered / stats.totalSmsSent) * 100).toFixed(1) 
      : 0,
    conversionRate: stats.totalDelivered > 0 
      ? ((stats.totalConverted / stats.totalDelivered) * 100).toFixed(1) 
      : 0,
    roi: stats.totalSmsCost > 0 
      ? ((stats.totalRevenue / stats.totalSmsCost)).toFixed(2) 
      : 0,
    avgTimeToConvert: stats.avgTimeToConvert 
      ? Math.round(stats.avgTimeToConvert) 
      : 0
  };
};

// Stats por día para gráficos
smsSubscriberSchema.statics.getDailyStats = async function(days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  return this.aggregate([
    { $match: { createdAt: { $gte: startDate } } },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
        },
        subscribers: { $sum: 1 },
        delivered: {
          $sum: { $cond: [{ $eq: ['$welcomeSmsStatus', 'delivered'] }, 1, 0] }
        },
        converted: {
          $sum: { $cond: ['$converted', 1, 0] }
        },
        revenue: { $sum: '$totalRevenue' },
        cost: { $sum: '$welcomeSmsCost' }
      }
    },
    { $sort: { _id: 1 } }
  ]);
};

// ==================== METHODS ====================

// Registrar conversión
smsSubscriberSchema.methods.recordConversion = async function(orderData) {
  const timeToConvert = this.welcomeSmsDeliveredAt 
    ? Math.round((new Date() - this.welcomeSmsDeliveredAt) / (1000 * 60))
    : null;
  
  this.converted = true;
  this.conversionData = {
    orderId: orderData.id?.toString(),
    orderNumber: orderData.order_number?.toString(),
    orderTotal: parseFloat(orderData.total_price || 0),
    discountAmount: parseFloat(orderData.total_discounts || 0),
    convertedAt: new Date(),
    timeToConvert,
    products: (orderData.line_items || []).map(item => ({
      productId: item.product_id?.toString(),
      title: item.title,
      quantity: item.quantity,
      price: parseFloat(item.price || 0)
    }))
  };
  
  this.totalOrders += 1;
  this.totalRevenue += this.conversionData.orderTotal;
  this.lastOrderAt = new Date();
  
  return this.save();
};

// Agregar SMS al historial
smsSubscriberSchema.methods.addSmsToHistory = function(smsData) {
  this.smsHistory.push({
    messageId: smsData.messageId,
    type: smsData.type || 'campaign',
    campaignId: smsData.campaignId,
    content: smsData.content?.substring(0, 160),
    status: smsData.status || 'sent',
    sentAt: new Date(),
    cost: smsData.cost
  });
  
  this.totalSmsSent += 1;
  this.lastSmsAt = new Date();
  
  return this.save();
};

// Actualizar status de SMS en historial
smsSubscriberSchema.methods.updateSmsStatus = async function(messageId, status, deliveredAt = null) {
  const sms = this.smsHistory.find(s => s.messageId === messageId);
  if (sms) {
    sms.status = status;
    if (deliveredAt) sms.deliveredAt = deliveredAt;
    if (status === 'delivered') this.totalSmsDelivered += 1;
  }
  return this.save();
};

module.exports = mongoose.model('SmsSubscriber', smsSubscriberSchema);