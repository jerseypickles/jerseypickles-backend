// backend/src/models/SmsCampaign.js
// 📱 SMS Campaign Model - Marketing Campaigns via SMS
const mongoose = require('mongoose');

const smsCampaignSchema = new mongoose.Schema({
  // ==================== BASIC INFO ====================
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  description: {
    type: String,
    trim: true
  },
  
  // ==================== MESSAGE CONTENT ====================
  message: {
    type: String,
    required: true,
    maxlength: 1600  // ~10 segments max
  },
  
  // Calculated on save
  messageLength: {
    type: Number,
    default: 0
  },
  
  segments: {
    type: Number,
    default: 1  // 160 chars = 1 segment, 306 = 2, 459 = 3, etc.
  },
  
  // Optional: Campaign-specific discount code
  discountCode: {
    type: String,
    uppercase: true,
    trim: true
  },
  
  discountPercent: {
    type: Number,
    min: 0,
    max: 100
  },
  
  // Optional: Tracking link
  trackingUrl: {
    type: String  // Short URL for click tracking
  },
  
  // ==================== STATUS ====================
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled', 'failed'],
    default: 'draft',
    index: true
  },
  
  // ==================== SCHEDULING ====================
  scheduledAt: {
    type: Date,
    index: true
  },
  
  startedAt: {
    type: Date
  },
  
  completedAt: {
    type: Date
  },
  
  // ==================== AUDIENCE TARGETING ====================
  audienceType: {
    type: String,
    enum: [
      'all_delivered',      // All with delivered welcome SMS
      'not_converted',      // Haven't purchased yet
      'converted',          // Already purchased (for repeat buyers)
      'recent_7d',          // Subscribed in last 7 days
      'recent_30d',         // Subscribed in last 30 days
      'inactive_30d',       // No engagement in 30 days
      'custom'              // Custom filter
    ],
    default: 'all_delivered'
  },
  
  // Target country: 'all', 'US', 'CA'
  targetCountry: {
    type: String,
    enum: ['all', 'US', 'CA'],
    default: 'all'
  },

  // Custom audience filter (MongoDB query)
  customFilter: {
    type: mongoose.Schema.Types.Mixed
  },
  
  // Excluded subscribers (manual exclusions)
  excludedSubscribers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsSubscriber'
  }],
  
  // ==================== STATS ====================
  stats: {
    // Audience
    eligible: { type: Number, default: 0 },      // Total eligible subscribers
    
    // Sending
    queued: { type: Number, default: 0 },        // In queue
    sent: { type: Number, default: 0 },          // Sent to Telnyx
    delivered: { type: Number, default: 0 },     // Confirmed delivered
    failed: { type: Number, default: 0 },        // Failed to send/deliver
    
    // Engagement
    clicked: { type: Number, default: 0 },       // Clicked tracking link
    converted: { type: Number, default: 0 },     // Made a purchase
    unsubscribed: { type: Number, default: 0 },  // Opted out after this
    
    // Financial
    totalRevenue: { type: Number, default: 0 },  // Revenue attributed
    totalCost: { type: Number, default: 0 },     // SMS cost
    
    // Rates (calculated)
    deliveryRate: { type: Number, default: 0 },  // delivered / sent
    clickRate: { type: Number, default: 0 },     // clicked / delivered
    conversionRate: { type: Number, default: 0 }, // converted / delivered
    roi: { type: Number, default: 0 }            // (revenue - cost) / cost
  },
  
  // ==================== TEST SMS ====================
  testSentTo: [{
    phone: String,
    sentAt: Date,
    status: String,
    messageId: String
  }],
  
  // ==================== METADATA ====================
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  tags: [{
    type: String,
    trim: true
  }],
  
  notes: String

}, {
  timestamps: true
});

// ==================== INDEXES ====================
smsCampaignSchema.index({ status: 1, scheduledAt: 1 });
smsCampaignSchema.index({ createdAt: -1 });
smsCampaignSchema.index({ 'stats.totalRevenue': -1 });

// ==================== PRE-SAVE: Calculate segments ====================
smsCampaignSchema.pre('save', function(next) {
  if (this.isModified('message')) {
    this.messageLength = this.message?.length || 0;
    
    // GSM-7 encoding: 160 chars for 1 segment, 153 per segment after
    // Unicode: 70 chars for 1 segment, 67 per segment after
    const hasUnicode = /[^\x00-\x7F]/.test(this.message || '');
    
    if (hasUnicode) {
      // Unicode
      if (this.messageLength <= 70) {
        this.segments = 1;
      } else {
        this.segments = Math.ceil(this.messageLength / 67);
      }
    } else {
      // GSM-7
      if (this.messageLength <= 160) {
        this.segments = 1;
      } else {
        this.segments = Math.ceil(this.messageLength / 153);
      }
    }
  }
  next();
});

// ==================== METHODS ====================

/**
 * Build MongoDB query for target audience
 */
smsCampaignSchema.methods.buildAudienceQuery = function() {
  // Base query: active + delivered welcome SMS
  const baseQuery = {
    status: 'active',
    welcomeSmsSent: true,
    welcomeSmsStatus: 'delivered',
    _id: { $nin: this.excludedSubscribers || [] }
  };

  // Apply country filter
  if (this.targetCountry && this.targetCountry !== 'all') {
    baseQuery['location.countryCode'] = this.targetCountry;
  }

  switch (this.audienceType) {
    case 'all_delivered':
      return baseQuery;

    case 'not_converted':
      return { ...baseQuery, converted: false };

    case 'converted':
      return { ...baseQuery, converted: true };

    case 'recent_7d':
      return {
        ...baseQuery,
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      };

    case 'recent_30d':
      return {
        ...baseQuery,
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      };

    case 'inactive_30d':
      return {
        ...baseQuery,
        lastEngagedAt: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      };

    case 'custom':
      return { ...baseQuery, ...(this.customFilter || {}) };

    default:
      return baseQuery;
  }
};

/**
 * Get eligible subscriber count
 */
smsCampaignSchema.methods.getEligibleCount = async function() {
  const SmsSubscriber = mongoose.model('SmsSubscriber');
  const query = this.buildAudienceQuery();
  return SmsSubscriber.countDocuments(query);
};

/**
 * Get eligible subscribers
 */
smsCampaignSchema.methods.getEligibleSubscribers = async function(options = {}) {
  const SmsSubscriber = mongoose.model('SmsSubscriber');
  const query = this.buildAudienceQuery();
  
  let q = SmsSubscriber.find(query).select('phone discountCode');
  
  if (options.limit) q = q.limit(options.limit);
  if (options.skip) q = q.skip(options.skip);
  
  return q.lean();
};

/**
 * Update stats and rates
 */
smsCampaignSchema.methods.updateRates = function() {
  const s = this.stats;
  
  if (s.sent > 0) {
    s.deliveryRate = ((s.delivered / s.sent) * 100).toFixed(1);
  }
  
  if (s.delivered > 0) {
    s.clickRate = ((s.clicked / s.delivered) * 100).toFixed(1);
    s.conversionRate = ((s.converted / s.delivered) * 100).toFixed(1);
  }
  
  if (s.totalCost > 0) {
    s.roi = (((s.totalRevenue - s.totalCost) / s.totalCost) * 100).toFixed(0);
  }
  
  return this;
};

/**
 * Increment a stat
 */
smsCampaignSchema.methods.incrementStat = async function(statName, amount = 1) {
  const update = { $inc: { [`stats.${statName}`]: amount } };
  await this.constructor.findByIdAndUpdate(this._id, update);
  this.stats[statName] = (this.stats[statName] || 0) + amount;
};

/**
 * Add test SMS record
 */
smsCampaignSchema.methods.addTestSms = async function(phone, messageId, status) {
  this.testSentTo.push({
    phone,
    sentAt: new Date(),
    status,
    messageId
  });
  return this.save();
};

// ==================== STATICS ====================

/**
 * Get campaigns due for sending
 */
smsCampaignSchema.statics.getDueForSending = async function() {
  return this.find({
    status: 'scheduled',
    scheduledAt: { $lte: new Date() }
  });
};

/**
 * Get campaign stats summary
 */
smsCampaignSchema.statics.getStatsSummary = async function(days = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  
  const result = await this.aggregate([
    {
      $match: {
        status: 'sent',
        completedAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: null,
        totalCampaigns: { $sum: 1 },
        totalSent: { $sum: '$stats.sent' },
        totalDelivered: { $sum: '$stats.delivered' },
        totalClicked: { $sum: '$stats.clicked' },
        totalConverted: { $sum: '$stats.converted' },
        totalRevenue: { $sum: '$stats.totalRevenue' },
        totalCost: { $sum: '$stats.totalCost' }
      }
    }
  ]);
  
  return result[0] || {
    totalCampaigns: 0,
    totalSent: 0,
    totalDelivered: 0,
    totalClicked: 0,
    totalConverted: 0,
    totalRevenue: 0,
    totalCost: 0
  };
};

module.exports = mongoose.model('SmsCampaign', smsCampaignSchema);