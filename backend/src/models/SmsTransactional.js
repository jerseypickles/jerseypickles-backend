// backend/src/models/SmsTransactional.js
// 📱 SMS Transactional Log - Order confirmations, shipping, delivery notifications
const mongoose = require('mongoose');

const smsTransactionalSchema = new mongoose.Schema({
  // Trigger type
  triggerType: {
    type: String,
    enum: ['order_confirmation', 'shipping_notification', 'delivery_confirmation'],
    required: true,
    index: true
  },

  // Customer info
  phone: {
    type: String,
    required: true,
    index: true
  },
  phoneFormatted: String,
  customerName: String,
  customerEmail: String,
  customerId: String,

  // Order info
  shopifyOrderId: {
    type: String,
    required: true,
    index: true
  },
  orderNumber: String,
  orderName: String, // #1234
  orderTotal: Number,

  // Shipping info (for shipping/delivery triggers)
  trackingNumber: String,
  trackingUrl: String,
  trackingCompany: String,
  fulfillmentId: String,

  // Message
  message: {
    type: String,
    required: true
  },
  messageLength: Number,

  // Telnyx info
  telnyxMessageId: String,
  status: {
    type: String,
    enum: ['pending', 'queued', 'sent', 'delivered', 'failed', 'undelivered'],
    default: 'pending',
    index: true
  },
  statusUpdatedAt: Date,
  error: String,

  // Opt-in verification
  optInVerified: {
    type: Boolean,
    default: false
  },
  smsSubscriberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsSubscriber'
  },

  // Timestamps
  sentAt: Date,
  deliveredAt: Date

}, {
  timestamps: true
});

// Indexes
smsTransactionalSchema.index({ createdAt: -1 });
smsTransactionalSchema.index({ triggerType: 1, status: 1 });
smsTransactionalSchema.index({ shopifyOrderId: 1, triggerType: 1 });

// Prevent duplicate sends
smsTransactionalSchema.index(
  { shopifyOrderId: 1, triggerType: 1, fulfillmentId: 1 },
  { unique: true, sparse: true }
);

// Static: Get stats by trigger type
smsTransactionalSchema.statics.getStatsByTrigger = async function(days = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const stats = await this.aggregate([
    { $match: { createdAt: { $gte: startDate } } },
    {
      $group: {
        _id: '$triggerType',
        total: { $sum: 1 },
        sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }
      }
    }
  ]);

  return stats.reduce((acc, s) => {
    acc[s._id] = {
      total: s.total,
      sent: s.sent,
      delivered: s.delivered,
      failed: s.failed,
      deliveryRate: s.total > 0 ? ((s.delivered / s.total) * 100).toFixed(1) : '0'
    };
    return acc;
  }, {});
};

// Static: Check if already sent
smsTransactionalSchema.statics.alreadySent = async function(orderId, triggerType, fulfillmentId = null) {
  const query = {
    shopifyOrderId: orderId,
    triggerType: triggerType,
    status: { $in: ['sent', 'delivered', 'queued'] }
  };

  if (fulfillmentId) {
    query.fulfillmentId = fulfillmentId;
  }

  const existing = await this.findOne(query);
  return !!existing;
};

// Static: Get recent by phone
smsTransactionalSchema.statics.getRecentByPhone = function(phone, limit = 10) {
  return this.find({ phone })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

module.exports = mongoose.model('SmsTransactional', smsTransactionalSchema);
