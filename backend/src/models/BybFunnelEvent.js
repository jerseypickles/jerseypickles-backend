// backend/src/models/BybFunnelEvent.js
// Model for Build Your Box funnel tracking events

const mongoose = require('mongoose');

const bybFunnelEventSchema = new mongoose.Schema({
  // Session identifier (anonymous until checkout)
  sessionId: {
    type: String,
    required: true,
    index: true
  },

  // Customer info (if available)
  customerId: {
    type: String,
    index: true
  },

  // Funnel step
  // step_0: Landing (viewed BYB page)
  // step_1: Type Selected (Quart/Half Gallon)
  // step_2: Size Selected (4, 6, 8, 12 jars)
  // step_3: Adding Products (started selecting products)
  // step_4: Products Complete (filled all slots)
  // step_5: Extra Olive (shown upsell - Quart only)
  // step_6: Review (viewing cart/summary)
  // step_7: Checkout Started
  // step_8: Purchase Complete
  step: {
    type: String,
    required: true,
    enum: [
      'step_0_landing',
      'step_1_type_selected',
      'step_2_size_selected',
      'step_3_adding_products',
      'step_4_products_complete',
      'step_5_extra_olive_shown',
      'step_5_extra_olive_accepted',
      'step_5_extra_olive_declined',
      'step_6_review',
      'step_7_checkout_started',
      'step_8_purchase_complete'
    ],
    index: true
  },

  // Step metadata
  metadata: {
    // Type selection
    jarType: String, // 'QUART' or 'HALF_GALLON'

    // Size selection
    jarCount: Number, // 4, 6, 8, 12 (Quart) or 2, 4, 6 (Half Gallon)
    boxPrice: Number,

    // Products
    productsSelected: [{
      name: String,
      quantity: Number
    }],
    totalProducts: Number,

    // Extra Olive
    extraOliveShown: Boolean,
    extraOliveAccepted: Boolean,

    // Checkout
    cartTotal: Number,
    orderId: String,
    orderNumber: String
  },

  // Time tracking
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },

  // Time spent on previous step (in seconds)
  timeOnPreviousStep: Number,

  // Device info
  deviceInfo: {
    userAgent: String,
    isMobile: Boolean,
    screenWidth: Number
  },

  // UTM tracking
  utmParams: {
    source: String,
    medium: String,
    campaign: String
  },

  // Page URL when event fired
  pageUrl: String,

  // Referrer
  referrer: String
}, {
  timestamps: true
});

// Index for funnel analysis
bybFunnelEventSchema.index({ sessionId: 1, timestamp: 1 });
bybFunnelEventSchema.index({ step: 1, timestamp: 1 });
bybFunnelEventSchema.index({ 'metadata.jarType': 1, step: 1 });

// Static method to get funnel stats
bybFunnelEventSchema.statics.getFunnelStats = async function(startDate, endDate) {
  const match = {};
  if (startDate || endDate) {
    match.timestamp = {};
    if (startDate) match.timestamp.$gte = startDate;
    if (endDate) match.timestamp.$lte = endDate;
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: '$step',
        count: { $sum: 1 },
        uniqueSessions: { $addToSet: '$sessionId' }
      }
    },
    {
      $project: {
        step: '$_id',
        totalEvents: '$count',
        uniqueSessions: { $size: '$uniqueSessions' }
      }
    },
    { $sort: { step: 1 } }
  ];

  return this.aggregate(pipeline);
};

// Static method to get session journey
bybFunnelEventSchema.statics.getSessionJourney = async function(sessionId) {
  return this.find({ sessionId })
    .sort({ timestamp: 1 })
    .lean();
};

// Static method to find abandoned sessions
bybFunnelEventSchema.statics.getAbandonedSessions = async function(startDate, endDate, lastStep = 'step_3_adding_products') {
  const match = {
    step: lastStep
  };

  if (startDate || endDate) {
    match.timestamp = {};
    if (startDate) match.timestamp.$gte = startDate;
    if (endDate) match.timestamp.$lte = endDate;
  }

  // Find sessions that reached lastStep but never reached purchase
  const sessionsAtStep = await this.distinct('sessionId', match);

  const completedSessions = await this.distinct('sessionId', {
    sessionId: { $in: sessionsAtStep },
    step: 'step_8_purchase_complete'
  });

  const abandonedSessions = sessionsAtStep.filter(
    s => !completedSessions.includes(s)
  );

  return abandonedSessions;
};

module.exports = mongoose.model('BybFunnelEvent', bybFunnelEventSchema);
