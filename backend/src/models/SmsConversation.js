// backend/src/models/SmsConversation.js
// 📱 SMS Conversation Model - Track all inbound/outbound messages
const mongoose = require('mongoose');

const smsConversationSchema = new mongoose.Schema({
  // ==================== MESSAGE INFO ====================
  direction: {
    type: String,
    enum: ['inbound', 'outbound'],
    required: true,
    index: true
  },

  // Phone numbers
  from: {
    type: String,
    required: true,
    index: true
  },

  to: {
    type: String,
    required: true,
    index: true
  },

  // Our phone number (for easy filtering)
  phone: {
    type: String,
    required: true,
    index: true // The subscriber's phone
  },

  // Message content
  message: {
    type: String,
    required: true
  },

  // ==================== TELNYX INFO ====================
  messageId: {
    type: String,
    index: true
  },

  status: {
    type: String,
    enum: ['pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'received'],
    default: 'pending'
  },

  cost: {
    type: Number,
    default: 0
  },

  carrier: String,

  // ==================== RELATIONSHIPS ====================
  subscriber: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsSubscriber',
    index: true
  },

  // Type of message
  messageType: {
    type: String,
    enum: [
      'welcome',           // First SMS with 15% code
      'second_chance',     // Second SMS with 25-30% code
      'campaign',          // Marketing campaign
      'transactional',     // Order confirmation, shipping, etc.
      'opt_out',           // STOP message from customer
      'opt_in',            // START message from customer
      'help',              // HELP request
      'reply',             // General reply from customer
      'other'
    ],
    default: 'other'
  },

  // Campaign reference (if applicable)
  campaign: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsCampaign'
  },

  // Discount code (if applicable)
  discountCode: String,
  discountPercent: Number,

  // ==================== METADATA ====================
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },

  // Error info
  errorCode: String,
  errorMessage: String

}, {
  timestamps: true
});

// ==================== INDEXES ====================
smsConversationSchema.index({ createdAt: -1 });
smsConversationSchema.index({ phone: 1, createdAt: -1 });
smsConversationSchema.index({ direction: 1, createdAt: -1 });
smsConversationSchema.index({ messageType: 1, createdAt: -1 });

// ==================== STATICS ====================

/**
 * Get recent conversations with pagination
 */
smsConversationSchema.statics.getRecent = async function(options = {}) {
  const {
    limit = 50,
    page = 1,
    direction = null,
    phone = null,
    messageType = null
  } = options;

  const query = {};

  if (direction) query.direction = direction;
  if (phone) query.phone = phone;
  if (messageType) query.messageType = messageType;

  const skip = (page - 1) * limit;

  const [messages, total] = await Promise.all([
    this.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('subscriber', 'phone phoneFormatted firstName lastName status')
      .lean(),
    this.countDocuments(query)
  ]);

  return {
    messages,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

/**
 * Get conversation thread for a specific phone
 */
smsConversationSchema.statics.getThread = async function(phone, limit = 50) {
  return this.find({ phone })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

/**
 * Get message stats
 */
smsConversationSchema.statics.getStats = async function(days = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await this.aggregate([
    { $match: { createdAt: { $gte: startDate } } },
    {
      $group: {
        _id: '$direction',
        count: { $sum: 1 },
        totalCost: { $sum: '$cost' }
      }
    }
  ]);

  const stats = {
    inbound: { count: 0, cost: 0 },
    outbound: { count: 0, cost: 0 }
  };

  result.forEach(r => {
    if (r._id === 'inbound') {
      stats.inbound = { count: r.count, cost: r.totalCost };
    } else if (r._id === 'outbound') {
      stats.outbound = { count: r.count, cost: r.totalCost };
    }
  });

  stats.total = stats.inbound.count + stats.outbound.count;
  stats.totalCost = stats.inbound.cost + stats.outbound.cost;

  return stats;
};

/**
 * Log an outbound message
 */
smsConversationSchema.statics.logOutbound = async function(data) {
  return this.create({
    direction: 'outbound',
    from: data.from || process.env.TELNYX_FROM_NUMBER,
    to: data.to,
    phone: data.to, // Subscriber's phone
    message: data.message,
    messageId: data.messageId,
    status: data.status || 'sent',
    messageType: data.messageType || 'other',
    subscriber: data.subscriberId,
    campaign: data.campaignId,
    discountCode: data.discountCode,
    discountPercent: data.discountPercent,
    cost: data.cost,
    metadata: data.metadata
  });
};

/**
 * Log an inbound message
 */
smsConversationSchema.statics.logInbound = async function(data) {
  // Determine message type based on content
  let messageType = 'reply';
  const text = (data.message || '').toLowerCase().trim();

  if (['stop', 'unsubscribe', 'cancel', 'quit', 'end'].includes(text)) {
    messageType = 'opt_out';
  } else if (['start', 'subscribe', 'yes', 'unstop'].includes(text)) {
    messageType = 'opt_in';
  } else if (text === 'help') {
    messageType = 'help';
  }

  return this.create({
    direction: 'inbound',
    from: data.from,
    to: data.to || process.env.TELNYX_FROM_NUMBER,
    phone: data.from, // Subscriber's phone
    message: data.message,
    messageId: data.messageId,
    status: 'received',
    messageType: messageType,
    subscriber: data.subscriberId,
    metadata: data.metadata
  });
};

module.exports = mongoose.model('SmsConversation', smsConversationSchema);
