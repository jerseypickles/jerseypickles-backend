// backend/src/models/VulcanConfig.js
// 🔨 Vulcan - Segmentation Agent Configuration & State (Singleton)
// Named after the Roman god of fire and forge — Vulcan builds & maintains segments

const mongoose = require('mongoose');

const segmentStatsSchema = new mongoose.Schema({
  key: { type: String, required: true },      // 'vip' | 'active' | 'at_risk' | etc
  name: { type: String, required: true },
  description: { type: String },
  listId: { type: mongoose.Schema.Types.ObjectId, ref: 'List' },
  memberCount: { type: Number, default: 0 },
  previousCount: { type: Number, default: 0 },
  lastUpdated: { type: Date },
  active: { type: Boolean, default: true }
}, { _id: false });

const vulcanConfigSchema = new mongoose.Schema({
  // Agent state
  active: { type: Boolean, default: true },

  // Segment definitions (7 core segments)
  segments: {
    type: [segmentStatsSchema],
    default: () => [
      {
        key: 'vip',
        name: 'VIP — Top Spenders',
        description: 'Top 10% of customers by total revenue. Lifetime value matters most.',
        memberCount: 0,
        active: true
      },
      {
        key: 'active',
        name: 'Active Buyers',
        description: 'Customers who purchased in the last 30 days.',
        memberCount: 0,
        active: true
      },
      {
        key: 'new_customers',
        name: 'New Customers',
        description: 'First purchase in the last 30 days.',
        memberCount: 0,
        active: true
      },
      {
        key: 'at_risk',
        name: 'At Risk',
        description: 'Previously active buyers who have not purchased in 45-90 days.',
        memberCount: 0,
        active: true
      },
      {
        key: 'dormant',
        name: 'Dormant',
        description: 'Past customers with no purchase in 90+ days.',
        memberCount: 0,
        active: true
      },
      {
        key: 'hot_leads',
        name: 'Hot Leads',
        description: 'Clicked an email in the last 14 days but never purchased.',
        memberCount: 0,
        active: true
      },
      {
        key: 'engaged_no_purchase',
        name: 'Engaged, No Purchase',
        description: 'Opens emails regularly but has never made a purchase.',
        memberCount: 0,
        active: true
      }
    ]
  },

  // Run history
  lastRunAt: { type: Date },
  lastRunDurationMs: { type: Number },
  totalRuns: { type: Number, default: 0 },

  // Claude insights (written after each run)
  lastInsight: { type: String },
  insightHistory: [{
    insight: String,
    createdAt: { type: Date, default: Date.now }
  }],

  // Model config
  model: { type: String, default: 'claude-sonnet-4-6' }
}, {
  timestamps: true
});

// Singleton
vulcanConfigSchema.statics.getConfig = async function () {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({ active: true });
  }
  return config;
};

module.exports = mongoose.model('VulcanConfig', vulcanConfigSchema);
