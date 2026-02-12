// backend/src/models/SmsCampaignTimeReport.js
// 🧠 SMS Campaign Time Report - Performance analysis by send time
const mongoose = require('mongoose');

const smsCampaignTimeReportSchema = new mongoose.Schema({
  // ==================== CAMPAIGN REFERENCE ====================
  campaign: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsCampaign',
    required: true,
    unique: true,
    index: true
  },

  campaignName: {
    type: String,
    required: true
  },

  // ==================== SEND TIMING ====================
  sentAt: {
    type: Date,
    required: true,
    index: true
  },

  sentAtHour: {
    type: Number, // 0-23
    required: true,
    min: 0,
    max: 23,
    index: true
  },

  sentAtDay: {
    type: String, // monday, tuesday, etc.
    enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    required: true,
    index: true
  },

  sentAtDayOfWeek: {
    type: Number, // 0=Sunday, 6=Saturday
    min: 0,
    max: 6
  },

  isWeekend: {
    type: Boolean,
    default: false
  },

  // ==================== AUDIENCE ====================
  audienceType: String,
  audienceSize: {
    type: Number,
    default: 0
  },

  targetCountry: String,

  // ==================== PERFORMANCE METRICS ====================
  performance: {
    delivered: { type: Number, default: 0 },
    deliveryRate: { type: Number, default: 0 },
    totalClicks: { type: Number, default: 0 },
    uniqueClicks: { type: Number, default: 0 },
    clickRate: { type: Number, default: 0 },
    conversions: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
    revenuePerSms: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    roi: { type: Number, default: 0 },
    unsubscribes: { type: Number, default: 0 },
    unsubRate: { type: Number, default: 0 }
  },

  // ==================== RESPONSE SPEED ====================
  responseSpeed: {
    avgMinutesToClick: { type: Number, default: 0 },
    medianMinutesToClick: { type: Number, default: 0 },
    avgMinutesToConvert: { type: Number, default: 0 },
    medianMinutesToConvert: { type: Number, default: 0 },
    clicksWithin30min: { type: Number, default: 0 },
    clicksWithin1hr: { type: Number, default: 0 },
    clicksWithin3hr: { type: Number, default: 0 },
    conversionsWithin1hr: { type: Number, default: 0 },
    conversionsWithin3hr: { type: Number, default: 0 },
    conversionsWithin24hr: { type: Number, default: 0 },
    peakClickHour: { type: Number, default: -1 },   // hour 0-23 with most clicks
    peakConversionHour: { type: Number, default: -1 }
  },

  // ==================== CONTEXT ====================
  context: {
    discountPercent: Number,
    dynamicDiscount: { type: Boolean, default: false },
    dynamicRange: {
      min: Number,
      max: Number
    },
    season: {
      type: String,
      enum: ['spring', 'summer', 'fall', 'winter']
    },
    isHoliday: { type: Boolean, default: false },
    holidayName: String,
    messageLength: Number,
    segments: Number
  },

  // ==================== AI ANALYSIS ====================
  aiAnalysis: {
    overallScore: { type: Number, min: 0, max: 10 },
    timingScore: { type: Number, min: 0, max: 10 },
    engagementScore: { type: Number, min: 0, max: 10 },
    summary: String,
    recommendation: String,
    comparedToAvg: {
      clickRateVsAvg: String,    // e.g. "+15%"
      conversionRateVsAvg: String,
      revenueVsAvg: String
    }
  },

  // ==================== STATUS ====================
  status: {
    type: String,
    enum: ['pending', 'compiled', 'analyzed'],
    default: 'pending',
    index: true
  },

  compiledAt: Date,
  analyzedAt: Date

}, {
  timestamps: true
});

// ==================== INDEXES ====================
smsCampaignTimeReportSchema.index({ sentAtHour: 1, sentAtDay: 1 });
smsCampaignTimeReportSchema.index({ 'performance.conversionRate': -1 });
smsCampaignTimeReportSchema.index({ 'aiAnalysis.overallScore': -1 });
smsCampaignTimeReportSchema.index({ status: 1, createdAt: -1 });

// ==================== STATICS ====================

/**
 * Get performance grouped by hour of day
 */
smsCampaignTimeReportSchema.statics.getPerformanceByHour = async function() {
  return this.aggregate([
    { $match: { status: { $in: ['compiled', 'analyzed'] } } },
    {
      $group: {
        _id: '$sentAtHour',
        campaigns: { $sum: 1 },
        avgClickRate: { $avg: '$performance.clickRate' },
        avgConversionRate: { $avg: '$performance.conversionRate' },
        avgRevenue: { $avg: '$performance.revenue' },
        avgRevenuePerSms: { $avg: '$performance.revenuePerSms' },
        totalRevenue: { $sum: '$performance.revenue' },
        avgDeliveryRate: { $avg: '$performance.deliveryRate' },
        avgUnsubRate: { $avg: '$performance.unsubRate' },
        avgMinutesToClick: { $avg: '$responseSpeed.avgMinutesToClick' },
        avgMinutesToConvert: { $avg: '$responseSpeed.avgMinutesToConvert' }
      }
    },
    { $sort: { _id: 1 } }
  ]);
};

/**
 * Get performance grouped by day of week
 */
smsCampaignTimeReportSchema.statics.getPerformanceByDay = async function() {
  return this.aggregate([
    { $match: { status: { $in: ['compiled', 'analyzed'] } } },
    {
      $group: {
        _id: '$sentAtDay',
        campaigns: { $sum: 1 },
        avgClickRate: { $avg: '$performance.clickRate' },
        avgConversionRate: { $avg: '$performance.conversionRate' },
        avgRevenue: { $avg: '$performance.revenue' },
        totalRevenue: { $sum: '$performance.revenue' },
        avgDeliveryRate: { $avg: '$performance.deliveryRate' }
      }
    }
  ]);
};

/**
 * Get heatmap data: hour x day performance matrix
 */
smsCampaignTimeReportSchema.statics.getHeatmapData = async function() {
  return this.aggregate([
    { $match: { status: { $in: ['compiled', 'analyzed'] } } },
    {
      $group: {
        _id: { hour: '$sentAtHour', day: '$sentAtDay' },
        campaigns: { $sum: 1 },
        avgConversionRate: { $avg: '$performance.conversionRate' },
        avgClickRate: { $avg: '$performance.clickRate' },
        avgRevenue: { $avg: '$performance.revenue' },
        totalRevenue: { $sum: '$performance.revenue' }
      }
    },
    { $sort: { '_id.hour': 1 } }
  ]);
};

/**
 * Get global averages for comparison
 */
smsCampaignTimeReportSchema.statics.getGlobalAverages = async function() {
  const result = await this.aggregate([
    { $match: { status: { $in: ['compiled', 'analyzed'] } } },
    {
      $group: {
        _id: null,
        totalCampaigns: { $sum: 1 },
        avgClickRate: { $avg: '$performance.clickRate' },
        avgConversionRate: { $avg: '$performance.conversionRate' },
        avgRevenue: { $avg: '$performance.revenue' },
        avgRevenuePerSms: { $avg: '$performance.revenuePerSms' },
        avgDeliveryRate: { $avg: '$performance.deliveryRate' },
        avgUnsubRate: { $avg: '$performance.unsubRate' },
        avgMinutesToClick: { $avg: '$responseSpeed.avgMinutesToClick' },
        avgMinutesToConvert: { $avg: '$responseSpeed.avgMinutesToConvert' },
        avgClicksWithin30min: { $avg: '$responseSpeed.clicksWithin30min' }
      }
    }
  ]);

  return result[0] || {
    totalCampaigns: 0,
    avgClickRate: 0,
    avgConversionRate: 0,
    avgRevenue: 0,
    avgRevenuePerSms: 0,
    avgDeliveryRate: 0,
    avgUnsubRate: 0,
    avgMinutesToClick: 0,
    avgMinutesToConvert: 0,
    avgClicksWithin30min: 0
  };
};

/**
 * Find campaigns pending compilation (sent 4+ hours ago)
 */
smsCampaignTimeReportSchema.statics.findPendingCompilation = async function() {
  return this.find({
    status: 'pending',
    sentAt: { $lte: new Date(Date.now() - 4 * 60 * 60 * 1000) }
  }).populate('campaign');
};

module.exports = mongoose.model('SmsCampaignTimeReport', smsCampaignTimeReportSchema);
