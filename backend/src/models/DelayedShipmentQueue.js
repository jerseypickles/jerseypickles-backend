// backend/src/models/DelayedShipmentQueue.js
// 📦 Delayed Shipment Queue - Track orders waiting for delay SMS
const mongoose = require('mongoose');

const delayedShipmentQueueSchema = new mongoose.Schema({
  // Order info from Shopify
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  orderNumber: {
    type: String,
    required: true
  },

  // Customer info
  customerName: String,
  customerEmail: String,
  phone: String,
  phoneFormatted: String,

  // Order details
  orderTotal: Number,
  orderCreatedAt: {
    type: Date,
    required: true,
    index: true
  },

  // Queue status
  status: {
    type: String,
    enum: ['pending', 'queued', 'sent', 'skipped', 'failed'],
    default: 'pending',
    index: true
  },

  // Timing
  hoursUnfulfilled: {
    type: Number,
    default: 0
  },
  eligibleAt: {
    type: Date,  // When order becomes eligible (order created + 72h)
    index: true
  },
  scheduledSendAt: {
    type: Date   // Next scheduled send time
  },

  // Result
  sentAt: Date,
  messageId: String,
  skipReason: String,
  errorMessage: String,

  // Tracking
  attempts: {
    type: Number,
    default: 0
  },
  lastCheckedAt: Date

}, {
  timestamps: true
});

// ==================== INDEXES ====================
delayedShipmentQueueSchema.index({ status: 1, eligibleAt: 1 });
delayedShipmentQueueSchema.index({ orderCreatedAt: -1 });

// ==================== STATICS ====================

/**
 * Add or update order in queue
 */
delayedShipmentQueueSchema.statics.upsertOrder = async function(order, delayHours = 72) {
  const orderId = order.id?.toString();
  const orderNumber = order.order_number || order.name?.replace('#', '') || orderId;
  const orderCreatedAt = new Date(order.created_at);

  // Calculate when order becomes eligible
  const eligibleAt = new Date(orderCreatedAt.getTime() + (delayHours * 60 * 60 * 1000));

  // Calculate hours unfulfilled
  const hoursUnfulfilled = Math.round((Date.now() - orderCreatedAt.getTime()) / (1000 * 60 * 60));

  // Extract customer info
  const customer = order.customer || {};
  const shippingAddress = order.shipping_address || order.billing_address || {};

  const phone = shippingAddress.phone || customer.phone || order.phone;

  return this.findOneAndUpdate(
    { orderId },
    {
      $set: {
        orderNumber,
        customerName: `${customer.first_name || shippingAddress.first_name || ''} ${customer.last_name || shippingAddress.last_name || ''}`.trim() || 'Customer',
        customerEmail: customer.email || order.email,
        phone: phone,
        phoneFormatted: phone,
        orderTotal: parseFloat(order.total_price) || 0,
        orderCreatedAt,
        eligibleAt,
        hoursUnfulfilled,
        lastCheckedAt: new Date()
      },
      $setOnInsert: {
        status: hoursUnfulfilled >= delayHours ? 'queued' : 'pending',
        attempts: 0
      }
    },
    { upsert: true, new: true }
  );
};

/**
 * Get pending orders ready to send
 */
delayedShipmentQueueSchema.statics.getReadyToSend = async function(limit = 50) {
  return this.find({
    status: { $in: ['pending', 'queued'] },
    eligibleAt: { $lte: new Date() },
    phone: { $exists: true, $ne: null, $ne: '' }
  })
  .sort({ eligibleAt: 1 })
  .limit(limit);
};

/**
 * Mark as sent
 */
delayedShipmentQueueSchema.statics.markSent = async function(orderId, messageId) {
  return this.findOneAndUpdate(
    { orderId },
    {
      $set: {
        status: 'sent',
        sentAt: new Date(),
        messageId
      },
      $inc: { attempts: 1 }
    },
    { new: true }
  );
};

/**
 * Mark as skipped
 */
delayedShipmentQueueSchema.statics.markSkipped = async function(orderId, reason) {
  return this.findOneAndUpdate(
    { orderId },
    {
      $set: {
        status: 'skipped',
        skipReason: reason
      },
      $inc: { attempts: 1 }
    },
    { new: true }
  );
};

/**
 * Mark as failed
 */
delayedShipmentQueueSchema.statics.markFailed = async function(orderId, error) {
  return this.findOneAndUpdate(
    { orderId },
    {
      $set: {
        status: 'failed',
        errorMessage: error
      },
      $inc: { attempts: 1 }
    },
    { new: true }
  );
};

/**
 * Remove fulfilled orders from queue
 */
delayedShipmentQueueSchema.statics.removeByOrderIds = async function(orderIds) {
  return this.deleteMany({
    orderId: { $in: orderIds },
    status: { $in: ['pending', 'queued'] }
  });
};

/**
 * Get queue stats
 */
delayedShipmentQueueSchema.statics.getStats = async function() {
  const now = new Date();

  const [stats, upcoming] = await Promise.all([
    this.aggregate([
      {
        $facet: {
          byStatus: [
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 }
              }
            }
          ],
          avgWaitTime: [
            {
              $match: { status: { $in: ['pending', 'queued'] } }
            },
            {
              $group: {
                _id: null,
                avgHours: { $avg: '$hoursUnfulfilled' }
              }
            }
          ],
          recentSent: [
            {
              $match: { status: 'sent', sentAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
            },
            { $count: 'count' }
          ]
        }
      }
    ]),
    this.find({
      status: { $in: ['pending', 'queued'] },
      eligibleAt: { $lte: now }
    }).countDocuments()
  ]);

  const s = stats[0] || {};
  const byStatus = {};
  (s.byStatus || []).forEach(item => {
    byStatus[item._id] = item.count;
  });

  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    pending: byStatus.pending || 0,
    queued: byStatus.queued || 0,
    sent: byStatus.sent || 0,
    skipped: byStatus.skipped || 0,
    failed: byStatus.failed || 0,
    readyToSend: upcoming,
    avgWaitHours: s.avgWaitTime?.[0]?.avgHours ? Math.round(s.avgWaitTime[0].avgHours) : 0,
    sentLast24h: s.recentSent?.[0]?.count || 0
  };
};

/**
 * Get queue items for frontend
 */
delayedShipmentQueueSchema.statics.getQueueItems = async function(options = {}) {
  const { status = 'all', limit = 50, skip = 0 } = options;

  const query = {};
  if (status !== 'all') {
    query.status = status;
  }

  const [items, total] = await Promise.all([
    this.find(query)
      .sort({ eligibleAt: 1, orderCreatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    this.countDocuments(query)
  ]);

  // Add computed fields
  const now = Date.now();
  const itemsWithComputed = items.map(item => ({
    ...item,
    hoursUntilEligible: item.eligibleAt > now
      ? Math.round((new Date(item.eligibleAt).getTime() - now) / (1000 * 60 * 60))
      : 0,
    isEligible: new Date(item.eligibleAt) <= new Date()
  }));

  return {
    items: itemsWithComputed,
    total,
    hasMore: skip + items.length < total
  };
};

/**
 * Cleanup old completed/skipped items (older than 7 days)
 */
delayedShipmentQueueSchema.statics.cleanup = async function(daysOld = 7) {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

  return this.deleteMany({
    status: { $in: ['sent', 'skipped', 'failed'] },
    updatedAt: { $lt: cutoff }
  });
};

module.exports = mongoose.model('DelayedShipmentQueue', delayedShipmentQueueSchema);
