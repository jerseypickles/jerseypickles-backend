// backend/src/models/MaximusCampaignLog.js
// 🏛️ Maximus - Campaign Log & Learning Data

const mongoose = require('mongoose');

const maximusCampaignLogSchema = new mongoose.Schema({
  // Campaign reference
  campaign: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true
  },

  // What Maximus decided
  subjectLine: { type: String, required: true },
  previewText: { type: String, required: true },
  list: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'List',
    required: true
  },
  listName: { type: String },

  // When Maximus sent it
  sentAt: { type: Date, required: true },
  sentDay: { type: String, enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
  sentHour: { type: Number, min: 0, max: 23 },

  // Performance metrics (updated after sending)
  metrics: {
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    clicked: { type: Number, default: 0 },
    converted: { type: Number, default: 0 },
    bounced: { type: Number, default: 0 },
    unsubscribed: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
    openRate: { type: Number, default: 0 },
    clickRate: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 }
  },

  // Metrics last updated
  metricsUpdatedAt: { type: Date },

  // Learning phase flag
  isLearningPhase: { type: Boolean, default: true },

  // Week number (for tracking weekly limits)
  weekNumber: { type: Number },
  weekYear: { type: Number },

  // Maximus reasoning
  reasoning: {
    whyThisSubject: { type: String },
    whyThisList: { type: String },
    whyThisTime: { type: String }
  }
}, {
  timestamps: true
});

// Indexes
maximusCampaignLogSchema.index({ sentAt: -1 });
maximusCampaignLogSchema.index({ weekNumber: 1, weekYear: 1 });
maximusCampaignLogSchema.index({ sentDay: 1, sentHour: 1 });
maximusCampaignLogSchema.index({ list: 1 });

// Get campaigns sent this week
maximusCampaignLogSchema.statics.getCampaignsThisWeek = function () {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  return this.find({
    sentAt: { $gte: startOfWeek }
  }).sort({ sentAt: -1 });
};

// Get performance by day of week
maximusCampaignLogSchema.statics.getPerformanceByDay = function () {
  return this.aggregate([
    { $match: { 'metrics.sent': { $gt: 0 } } },
    {
      $group: {
        _id: '$sentDay',
        campaigns: { $sum: 1 },
        avgOpenRate: { $avg: '$metrics.openRate' },
        avgClickRate: { $avg: '$metrics.clickRate' },
        avgConversionRate: { $avg: '$metrics.conversionRate' },
        totalRevenue: { $sum: '$metrics.revenue' }
      }
    },
    { $sort: { avgOpenRate: -1 } }
  ]);
};

// Get performance by hour
maximusCampaignLogSchema.statics.getPerformanceByHour = function () {
  return this.aggregate([
    { $match: { 'metrics.sent': { $gt: 0 } } },
    {
      $group: {
        _id: '$sentHour',
        campaigns: { $sum: 1 },
        avgOpenRate: { $avg: '$metrics.openRate' },
        avgClickRate: { $avg: '$metrics.clickRate' },
        avgConversionRate: { $avg: '$metrics.conversionRate' },
        totalRevenue: { $sum: '$metrics.revenue' }
      }
    },
    { $sort: { avgOpenRate: -1 } }
  ]);
};

// Get performance by list
maximusCampaignLogSchema.statics.getPerformanceByList = function () {
  return this.aggregate([
    { $match: { 'metrics.sent': { $gt: 0 } } },
    {
      $group: {
        _id: '$list',
        listName: { $first: '$listName' },
        campaigns: { $sum: 1 },
        avgOpenRate: { $avg: '$metrics.openRate' },
        avgClickRate: { $avg: '$metrics.clickRate' },
        avgConversionRate: { $avg: '$metrics.conversionRate' },
        totalRevenue: { $sum: '$metrics.revenue' }
      }
    }
  ]);
};

// Get learning summary
maximusCampaignLogSchema.statics.getLearningSummary = function () {
  return this.aggregate([
    { $match: { 'metrics.sent': { $gt: 0 } } },
    {
      $group: {
        _id: null,
        totalCampaigns: { $sum: 1 },
        avgOpenRate: { $avg: '$metrics.openRate' },
        avgClickRate: { $avg: '$metrics.clickRate' },
        avgConversionRate: { $avg: '$metrics.conversionRate' },
        totalRevenue: { $sum: '$metrics.revenue' },
        bestOpenRate: { $max: '$metrics.openRate' },
        bestClickRate: { $max: '$metrics.clickRate' }
      }
    }
  ]);
};

module.exports = mongoose.model('MaximusCampaignLog', maximusCampaignLogSchema);
