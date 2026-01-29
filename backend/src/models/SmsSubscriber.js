// backend/src/models/SmsSubscriber.js
const mongoose = require('mongoose');

const smsSubscriberSchema = new mongoose.Schema({
  // ==================== CORE FIELDS ====================
  phone: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  phoneFormatted: {
    type: String  // Display format: +1 (551) 400-9394
  },
  
  status: {
    type: String,
    enum: ['active', 'unsubscribed', 'bounced', 'invalid'],
    default: 'active',
    index: true
  },
  
  // ==================== SOURCE & ATTRIBUTION ====================
  source: {
    type: String,
    enum: ['popup', 'checkout', 'manual', 'import', 'landing_page', 'website-popup-sms', 'api', 'test'],
    default: 'popup',
    index: true
  },
  
  // ==================== DISCOUNT CODE ====================
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
  
  shopifyPriceRuleId: {
    type: String
  },
  
  shopifyDiscountCodeId: {
    type: String
  },
  
  // ==================== WELCOME SMS STATUS ====================
  welcomeSmsSent: {
    type: Boolean,
    default: false
  },
  
  welcomeSmsSentAt: {
    type: Date
  },
  
  welcomeSmsMessageId: {
    type: String
  },
  
  welcomeSmsStatus: {
    type: String,
    enum: ['pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'delivery_failed', 'delivery_unconfirmed'],
    default: 'pending',
    index: true
  },
  
  welcomeSmsError: {
    type: String
  },
  
  // ==================== CONVERSION TRACKING ====================
  converted: {
    type: Boolean,
    default: false,
    index: true
  },
  
  conversionData: {
    orderId: String,
    orderNumber: String,
    orderTotal: Number,
    subtotal: Number,
    discountAmount: Number,
    currency: { type: String, default: 'USD' },
    convertedAt: Date,
    timeToConvert: Number,  // Minutes from SMS sent to purchase
    itemCount: Number,
    products: [{
      productId: String,
      variantId: String,
      title: String,
      quantity: Number,
      price: Number
    }],
    customerEmail: String,
    shippingAddress: {
      city: String,
      province: String,
      country: String,
      zip: String
    }
  },
  
  // ==================== ENGAGEMENT METRICS ====================
  totalSmsSent: {
    type: Number,
    default: 0
  },
  
  totalSmsDelivered: {
    type: Number,
    default: 0
  },
  
  totalSmsFailed: {
    type: Number,
    default: 0
  },
  
  lastSmsAt: {
    type: Date
  },
  
  lastEngagedAt: {
    type: Date
  },
  
  // ==================== CUSTOMER LINK ====================
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    index: true
  },
  
  shopifyCustomerId: {
    type: String,
    index: true
  },
  
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  
  firstName: String,
  lastName: String,
  
  // ==================== OPT-OUT TRACKING ====================
  unsubscribedAt: {
    type: Date
  },
  
  unsubscribeReason: {
    type: String,
    enum: ['user_request', 'stop_keyword', 'bounced', 'admin', 'spam_complaint'],
  },
  
  // ==================== CARRIER INFO ====================
  carrier: String,
  lineType: {
    type: String,
    enum: ['mobile', 'landline', 'voip', 'unknown']
  },
  
  // ==================== METADATA ====================
  ipAddress: String,
  userAgent: String,
  
  tags: [{
    type: String
  }],
  
  notes: String

}, {
  timestamps: true  // createdAt, updatedAt
});

// ==================== INDEXES ====================
smsSubscriberSchema.index({ createdAt: -1 });
smsSubscriberSchema.index({ converted: 1, createdAt: -1 });
smsSubscriberSchema.index({ status: 1, createdAt: -1 });
smsSubscriberSchema.index({ welcomeSmsStatus: 1 });
smsSubscriberSchema.index({ 'conversionData.convertedAt': -1 });

// ==================== VIRTUAL: Full Name ====================
smsSubscriberSchema.virtual('fullName').get(function() {
  if (this.firstName && this.lastName) {
    return `${this.firstName} ${this.lastName}`;
  }
  return this.firstName || this.lastName || null;
});

// ==================== METHODS ====================

/**
 * Mark as converted with order data
 */
smsSubscriberSchema.methods.markConverted = async function(orderData) {
  this.converted = true;
  this.conversionData = {
    orderId: orderData.orderId,
    orderNumber: orderData.orderNumber,
    orderTotal: orderData.orderTotal,
    subtotal: orderData.subtotal,
    discountAmount: orderData.discountAmount,
    currency: orderData.currency || 'USD',
    convertedAt: orderData.convertedAt || new Date(),
    timeToConvert: orderData.timeToConvert,
    itemCount: orderData.itemCount,
    products: orderData.products,
    customerEmail: orderData.customerEmail,
    shippingAddress: orderData.shippingAddress
  };
  return this.save();
};

/**
 * Unsubscribe the subscriber
 */
smsSubscriberSchema.methods.unsubscribe = async function(reason = 'user_request') {
  this.status = 'unsubscribed';
  this.unsubscribedAt = new Date();
  this.unsubscribeReason = reason;
  return this.save();
};

/**
 * Resubscribe (after STOP then START)
 */
smsSubscriberSchema.methods.resubscribe = async function() {
  this.status = 'active';
  this.unsubscribedAt = null;
  this.unsubscribeReason = null;
  return this.save();
};

/**
 * Update SMS delivery status
 */
smsSubscriberSchema.methods.updateSmsStatus = async function(status, messageId = null, error = null) {
  this.welcomeSmsStatus = status;
  if (messageId) this.welcomeSmsMessageId = messageId;
  if (error) this.welcomeSmsError = error;
  
  if (status === 'sent' || status === 'delivered') {
    this.welcomeSmsSent = true;
    this.welcomeSmsSentAt = this.welcomeSmsSentAt || new Date();
    this.totalSmsDelivered = (this.totalSmsDelivered || 0) + 1;
  } else if (status === 'failed' || status === 'delivery_failed') {
    this.totalSmsFailed = (this.totalSmsFailed || 0) + 1;
  }
  
  this.totalSmsSent = (this.totalSmsSent || 0) + 1;
  this.lastSmsAt = new Date();
  
  return this.save();
};

// ==================== STATICS ====================

/**
 * Find by phone number (normalized)
 */
smsSubscriberSchema.statics.findByPhone = async function(phone) {
  // Normalize phone to E.164
  const normalized = phone.replace(/\D/g, '');
  const e164 = normalized.startsWith('1') && normalized.length === 11
    ? `+${normalized}`
    : `+1${normalized}`;
  
  return this.findOne({ 
    $or: [
      { phone: e164 },
      { phone: normalized },
      { phone: `+${normalized}` }
    ]
  });
};

/**
 * Find by discount code
 */
smsSubscriberSchema.statics.findByDiscountCode = async function(code) {
  return this.findOne({ 
    discountCode: code.toUpperCase().trim() 
  });
};

/**
 * Get conversion stats
 */
smsSubscriberSchema.statics.getStats = async function() {
  const total = await this.countDocuments();
  const active = await this.countDocuments({ status: 'active' });
  const converted = await this.countDocuments({ converted: true });
  const unsubscribed = await this.countDocuments({ status: 'unsubscribed' });
  
  const revenueAgg = await this.aggregate([
    { $match: { converted: true } },
    { $group: {
      _id: null,
      totalRevenue: { $sum: '$conversionData.orderTotal' },
      totalDiscount: { $sum: '$conversionData.discountAmount' },
      avgOrderValue: { $avg: '$conversionData.orderTotal' }
    }}
  ]);
  
  const revenue = revenueAgg[0] || { totalRevenue: 0, totalDiscount: 0, avgOrderValue: 0 };
  
  return {
    total,
    active,
    converted,
    unsubscribed,
    conversionRate: total > 0 ? ((converted / total) * 100).toFixed(2) + '%' : '0%',
    totalRevenue: revenue.totalRevenue?.toFixed(2) || '0.00',
    totalDiscount: revenue.totalDiscount?.toFixed(2) || '0.00',
    avgOrderValue: revenue.avgOrderValue?.toFixed(2) || '0.00'
  };
};

// Export model
module.exports = mongoose.model('SmsSubscriber', smsSubscriberSchema);