// backend/src/models/SmsMessage.js
// 📨 SMS Message Model - Individual SMS tracking for campaigns
const mongoose = require('mongoose');

const smsMessageSchema = new mongoose.Schema({
  // ==================== RELATIONSHIPS ====================
  campaign: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsCampaign',
    required: true,
    index: true
  },
  
  subscriber: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsSubscriber',
    required: true,
    index: true
  },
  
  // ==================== RECIPIENT ====================
  phone: {
    type: String,
    required: true,
    index: true
  },
  
  // ==================== MESSAGE ====================
  message: {
    type: String,
    required: true
  },
  
  segments: {
    type: Number,
    default: 1
  },
  
  // Personalized discount code (if any)
  discountCode: String,
  
  // ==================== TELNYX INFO ====================
  messageId: {
    type: String,
    index: true
  },
  
  // ==================== STATUS ====================
  status: {
    type: String,
    enum: [
      'pending',      // In queue
      'queued',       // Sent to Telnyx, in their queue
      'sending',      // Being sent
      'sent',         // Sent by Telnyx
      'delivered',    // Confirmed delivered
      'failed',       // Failed to send
      'undelivered',  // Sent but not delivered
      'rejected'      // Rejected by carrier
    ],
    default: 'pending',
    index: true
  },
  
  // Error info if failed
  errorCode: String,
  errorMessage: String,
  
  // ==================== TIMESTAMPS ====================
  queuedAt: Date,
  sentAt: Date,
  deliveredAt: Date,
  failedAt: Date,
  
  // ==================== ENGAGEMENT ====================
  clicked: {
    type: Boolean,
    default: false,
    index: true
  },
  
  clickedAt: Date,
  
  clickData: {
    url: String,
    userAgent: String,
    ip: String
  },
  
  // ==================== CONVERSION ====================
  converted: {
    type: Boolean,
    default: false,
    index: true
  },
  
  convertedAt: Date,
  
  conversionData: {
    orderId: String,
    orderNumber: String,
    orderTotal: Number,
    discountAmount: Number
  },
  
  // ==================== COST ====================
  cost: {
    type: Number,
    default: 0
  },
  
  carrier: String,
  
  // ==================== METADATA ====================
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }

}, {
  timestamps: true
});

// ==================== INDEXES ====================
smsMessageSchema.index({ campaign: 1, status: 1 });
smsMessageSchema.index({ campaign: 1, delivered: 1 });
smsMessageSchema.index({ messageId: 1 });
smsMessageSchema.index({ createdAt: -1 });
smsMessageSchema.index({ subscriber: 1, campaign: 1 }, { unique: true }); // Prevent duplicates

// ==================== METHODS ====================

/**
 * Update status from Telnyx webhook
 */
smsMessageSchema.methods.updateFromWebhook = async function(webhookData) {
  const statusMap = {
    'queued': 'queued',
    'sending': 'sending', 
    'sent': 'sent',
    'delivered': 'delivered',
    'delivery_failed': 'failed',
    'undelivered': 'undelivered',
    'failed': 'failed'
  };
  
  const newStatus = statusMap[webhookData.status] || webhookData.status;
  
  this.status = newStatus;
  
  if (newStatus === 'sent') {
    this.sentAt = new Date();
  } else if (newStatus === 'delivered') {
    this.deliveredAt = new Date();
  } else if (newStatus === 'failed' || newStatus === 'undelivered') {
    this.failedAt = new Date();
    this.errorCode = webhookData.errorCode;
    this.errorMessage = webhookData.errorMessage;
  }
  
  if (webhookData.cost) {
    this.cost = webhookData.cost;
  }
  
  if (webhookData.carrier) {
    this.carrier = webhookData.carrier;
  }
  
  return this.save();
};

/**
 * Record click
 */
smsMessageSchema.methods.recordClick = async function(clickInfo = {}) {
  if (this.clicked) return this; // Already recorded
  
  this.clicked = true;
  this.clickedAt = new Date();
  this.clickData = {
    url: clickInfo.url,
    userAgent: clickInfo.userAgent,
    ip: clickInfo.ip
  };
  
  // Update campaign stats
  const SmsCampaign = mongoose.model('SmsCampaign');
  await SmsCampaign.findByIdAndUpdate(this.campaign, {
    $inc: { 'stats.clicked': 1 }
  });
  
  // Update subscriber engagement
  const SmsSubscriber = mongoose.model('SmsSubscriber');
  await SmsSubscriber.findByIdAndUpdate(this.subscriber, {
    lastEngagedAt: new Date()
  });
  
  return this.save();
};

/**
 * Record conversion
 */
smsMessageSchema.methods.recordConversion = async function(orderData) {
  if (this.converted) return this; // Already recorded
  
  this.converted = true;
  this.convertedAt = new Date();
  this.conversionData = {
    orderId: orderData.orderId,
    orderNumber: orderData.orderNumber,
    orderTotal: orderData.orderTotal,
    discountAmount: orderData.discountAmount
  };
  
  // Update campaign stats
  const SmsCampaign = mongoose.model('SmsCampaign');
  await SmsCampaign.findByIdAndUpdate(this.campaign, {
    $inc: { 
      'stats.converted': 1,
      'stats.totalRevenue': orderData.orderTotal || 0
    }
  });
  
  return this.save();
};

// ==================== STATICS ====================

/**
 * Find by Telnyx message ID
 */
smsMessageSchema.statics.findByMessageId = async function(messageId) {
  return this.findOne({ messageId });
};

/**
 * Get campaign message stats
 */
smsMessageSchema.statics.getCampaignStats = async function(campaignId) {
  const result = await this.aggregate([
    { $match: { campaign: new mongoose.Types.ObjectId(campaignId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalCost: { $sum: '$cost' }
      }
    }
  ]);
  
  const stats = {
    pending: 0,
    queued: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    totalCost: 0
  };
  
  result.forEach(r => {
    stats[r._id] = r.count;
    stats.totalCost += r.totalCost || 0;
  });
  
  return stats;
};

/**
 * Get pending messages for a campaign
 */
smsMessageSchema.statics.getPendingForCampaign = async function(campaignId, limit = 100) {
  return this.find({
    campaign: campaignId,
    status: 'pending'
  })
  .limit(limit)
  .lean();
};

/**
 * Check if subscriber already received this campaign
 */
smsMessageSchema.statics.hasReceived = async function(campaignId, subscriberId) {
  const count = await this.countDocuments({
    campaign: campaignId,
    subscriber: subscriberId
  });
  return count > 0;
};

module.exports = mongoose.model('SmsMessage', smsMessageSchema);