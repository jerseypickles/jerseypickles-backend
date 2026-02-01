// backend/src/models/ShortUrl.js
// 🔗 Short URL Model - URL shortening with click tracking for SMS
const mongoose = require('mongoose');
const crypto = require('crypto');

const shortUrlSchema = new mongoose.Schema({
  // Short code (e.g., "abc123")
  code: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Original URL
  originalUrl: {
    type: String,
    required: true
  },

  // Source type
  sourceType: {
    type: String,
    enum: ['sms_campaign', 'sms_welcome', 'sms_second_chance', 'sms_transactional', 'other'],
    default: 'other',
    index: true
  },

  // Reference IDs (optional, based on source)
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsCampaign',
    index: true
  },

  subscriberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsSubscriber',
    index: true
  },

  messageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsMessage'
  },

  transactionalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsTransactional'
  },

  // Click tracking
  clicks: {
    type: Number,
    default: 0
  },

  uniqueClicks: {
    type: Number,
    default: 0
  },

  clickedIps: [{
    type: String
  }],

  lastClickedAt: Date,

  // Click history (last 100 clicks)
  clickHistory: [{
    timestamp: { type: Date, default: Date.now },
    ip: String,
    userAgent: String,
    referer: String
  }],

  // Conversion tracking
  converted: {
    type: Boolean,
    default: false
  },

  conversionData: {
    orderId: String,
    orderNumber: String,
    orderTotal: Number,
    convertedAt: Date
  },

  // Discount code associated
  discountCode: String,

  // Metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },

  // Expiration (optional)
  expiresAt: Date,

  // Active status
  isActive: {
    type: Boolean,
    default: true
  }

}, {
  timestamps: true
});

// ==================== INDEXES ====================
shortUrlSchema.index({ createdAt: -1 });
shortUrlSchema.index({ campaignId: 1, clicks: -1 });
shortUrlSchema.index({ sourceType: 1, createdAt: -1 });

// ==================== STATICS ====================

/**
 * Generate unique short code
 */
shortUrlSchema.statics.generateCode = async function(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let attempts = 0;
  const maxAttempts = 10;

  do {
    code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    attempts++;

    // Check if code exists
    const existing = await this.findOne({ code });
    if (!existing) break;

  } while (attempts < maxAttempts);

  if (attempts >= maxAttempts) {
    // Use crypto for guaranteed uniqueness
    code = crypto.randomBytes(4).toString('hex');
  }

  return code;
};

/**
 * Create short URL
 */
shortUrlSchema.statics.createShortUrl = async function(options) {
  const {
    originalUrl,
    sourceType = 'other',
    campaignId,
    subscriberId,
    messageId,
    transactionalId,
    discountCode,
    metadata,
    expiresAt
  } = options;

  const code = await this.generateCode();

  const shortUrl = new this({
    code,
    originalUrl,
    sourceType,
    campaignId,
    subscriberId,
    messageId,
    transactionalId,
    discountCode,
    metadata,
    expiresAt
  });

  await shortUrl.save();
  return shortUrl;
};

/**
 * Record click
 */
shortUrlSchema.statics.recordClick = async function(code, clickInfo = {}) {
  const shortUrl = await this.findOne({ code, isActive: true });

  if (!shortUrl) return null;

  // Check expiration
  if (shortUrl.expiresAt && new Date() > shortUrl.expiresAt) {
    return null;
  }

  const ip = clickInfo.ip || 'unknown';
  const isUniqueClick = !shortUrl.clickedIps.includes(ip);

  // Update stats
  shortUrl.clicks += 1;
  if (isUniqueClick) {
    shortUrl.uniqueClicks += 1;
    shortUrl.clickedIps.push(ip);

    // Limit stored IPs to 1000
    if (shortUrl.clickedIps.length > 1000) {
      shortUrl.clickedIps = shortUrl.clickedIps.slice(-1000);
    }
  }

  shortUrl.lastClickedAt = new Date();

  // Add to click history (keep last 100)
  shortUrl.clickHistory.push({
    timestamp: new Date(),
    ip,
    userAgent: clickInfo.userAgent,
    referer: clickInfo.referer
  });

  if (shortUrl.clickHistory.length > 100) {
    shortUrl.clickHistory = shortUrl.clickHistory.slice(-100);
  }

  await shortUrl.save();

  return {
    shortUrl,
    isUniqueClick,
    originalUrl: shortUrl.originalUrl
  };
};

/**
 * Get campaign click stats
 */
shortUrlSchema.statics.getCampaignStats = async function(campaignId) {
  const result = await this.aggregate([
    { $match: { campaignId: new mongoose.Types.ObjectId(campaignId) } },
    {
      $group: {
        _id: null,
        totalClicks: { $sum: '$clicks' },
        uniqueClicks: { $sum: '$uniqueClicks' },
        urlCount: { $sum: 1 },
        converted: { $sum: { $cond: ['$converted', 1, 0] } }
      }
    }
  ]);

  return result[0] || { totalClicks: 0, uniqueClicks: 0, urlCount: 0, converted: 0 };
};

/**
 * Get top clicked URLs for a campaign
 */
shortUrlSchema.statics.getTopUrls = async function(campaignId, limit = 10) {
  return this.find({ campaignId })
    .sort({ clicks: -1 })
    .limit(limit)
    .select('code originalUrl clicks uniqueClicks lastClickedAt')
    .lean();
};

/**
 * Get click timeline for a campaign
 */
shortUrlSchema.statics.getClickTimeline = async function(campaignId, days = 7) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const urls = await this.find({
    campaignId,
    'clickHistory.timestamp': { $gte: startDate }
  }).lean();

  // Aggregate clicks by day
  const timeline = {};

  urls.forEach(url => {
    url.clickHistory.forEach(click => {
      if (new Date(click.timestamp) >= startDate) {
        const day = new Date(click.timestamp).toISOString().split('T')[0];
        timeline[day] = (timeline[day] || 0) + 1;
      }
    });
  });

  return Object.entries(timeline)
    .map(([date, clicks]) => ({ date, clicks }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

module.exports = mongoose.model('ShortUrl', shortUrlSchema);
