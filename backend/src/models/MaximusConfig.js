// backend/src/models/MaximusConfig.js
// 🏛️ Maximus - Agent Configuration & State (Singleton)

const mongoose = require('mongoose');

const maximusConfigSchema = new mongoose.Schema({
  // Agent state
  active: { type: Boolean, default: false },
  creativeAgentReady: { type: Boolean, default: false },

  // Lists to send to
  lists: [{
    listId: { type: mongoose.Schema.Types.ObjectId, ref: 'List' },
    name: { type: String }
  }],

  // Constraints
  maxCampaignsPerWeek: { type: Number, default: 8 },
  maxCampaignsPerDay: { type: Number, default: 2 },
  minHoursBetweenSameDay: { type: Number, default: 3 },
  sendWindowStart: { type: Number, default: 11 }, // 11 AM
  sendWindowEnd: { type: Number, default: 19 },   // 7 PM
  timezone: { type: String, default: 'America/New_York' },

  // Learning state
  learning: {
    phase: { type: String, enum: ['initial', 'learning', 'optimized'], default: 'initial' },
    campaignsAnalyzed: { type: Number, default: 0 },
    // Best slots discovered
    bestDays: [{
      day: { type: String },
      score: { type: Number },
      avgOpenRate: { type: Number },
      avgClickRate: { type: Number }
    }],
    bestHours: [{
      hour: { type: Number },
      score: { type: Number },
      avgOpenRate: { type: Number },
      avgClickRate: { type: Number }
    }],
    bestList: {
      listId: { type: mongoose.Schema.Types.ObjectId, ref: 'List' },
      name: { type: String },
      avgOpenRate: { type: Number }
    },
    // Days Maximus decided to rest this week
    restDays: [{ type: String }],
    lastLearningUpdate: { type: Date }
  },

  // Accumulated intelligence (Claude writes, Claude reads)
  memory: {
    insights: [{ type: String }],       // Max 15 — patterns, lessons learned
    lastUpdated: { type: Date }
  },

  // Model config — split by task so heavy creative work gets Opus and
  // cheap metrics-summary work gets Sonnet/Haiku.
  model: { type: String, default: 'claude-opus-4-7' },              // makeDecision + generateWeeklyPlan
  modelForAnalysis: { type: String, default: 'claude-sonnet-4-6' }, // analyzeCampaignWithClaude

  // Pending proposal (awaiting human approval)
  pendingProposal: {
    active: { type: Boolean, default: false },
    createdAt: { type: Date },
    scheduledAt: { type: Date },
    decision: {
      campaignType: { type: String, enum: ['promotional', 'content', 'product_spotlight', 'recipe', 'pairing', 'customer_love'], default: 'promotional' },
      subjectLine: String,
      previewText: String,
      headline: String,
      product: String,
      productName: String,
      // Optional duo — Maximus picks a complementary bank product to feature alongside.
      secondaryProduct: String,
      secondaryProductName: String,
      contentAngle: String,
      storyBody: String,
      pullQuote: String,
      discountPercent: Number,
      discountCode: String,
      // Type-specific payloads
      recipe: {
        dishName: String,
        prepTime: String,
        ingredients: [String],
        steps: [String]
      },
      pairing: {
        leftItem: { name: String, description: String, imageUrl: String },
        rightItem: { name: String, description: String, imageUrl: String },
        pairingNote: String
      },
      customerLove: {
        quotes: [{ text: String, author: String, location: String, rating: Number }]
      },
      listId: { type: mongoose.Schema.Types.ObjectId, ref: 'List' },
      listName: String,
      sendHour: Number,
      reasoning: {
        whyThisSubject: String,
        whyThisProduct: String,
        whyThisList: String,
        whyThisTime: String
      }
    },
    imageUrl: String,
    htmlContent: String,
    discountCreated: { type: Boolean, default: false },
    // Dual-engine creatives — admin picks one at approval time. imageUrl mirrors the picked one.
    creatives: [{
      engine: { type: String, enum: ['gemini', 'gpt'] },
      model: String,
      imageUrl: String,
      cloudinaryId: String,
      generationTime: Number
    }],
    selectedEngine: { type: String, enum: ['gemini', 'gpt', null], default: null }
  },

  // Pending weekly plan (awaiting human approval)
  pendingWeeklyPlan: {
    active: { type: Boolean, default: false },
    generating: { type: Boolean, default: false },
    createdAt: { type: Date },
    weekLabel: String,
    campaigns: [{
      day: String,
      scheduledAt: Date,
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      campaignType: { type: String, enum: ['promotional', 'content', 'product_spotlight', 'recipe', 'pairing', 'customer_love'] },
      subjectLine: String,
      previewText: String,
      headline: String,
      product: String,
      productName: String,
      // Optional duo — Maximus picks a complementary bank product to feature alongside.
      secondaryProduct: String,
      secondaryProductName: String,
      contentAngle: String,
      storyBody: String,
      pullQuote: String,
      discountPercent: Number,
      discountCode: String,
      recipe: {
        dishName: String,
        prepTime: String,
        ingredients: [String],
        steps: [String]
      },
      pairing: {
        leftItem: { name: String, description: String, imageUrl: String },
        rightItem: { name: String, description: String, imageUrl: String },
        pairingNote: String
      },
      customerLove: {
        quotes: [{ text: String, author: String, location: String, rating: Number }]
      },
      listId: { type: mongoose.Schema.Types.ObjectId, ref: 'List' },
      listName: String,
      sendHour: Number,
      imageUrl: String,
      htmlContent: String,
      creatives: [{
        engine: { type: String, enum: ['gemini', 'gpt'] },
        model: String,
        imageUrl: String,
        cloudinaryId: String,
        generationTime: Number
      }],
      selectedEngine: { type: String, enum: ['gemini', 'gpt', null], default: null },
      reasoning: {
        whyThisType: String,
        whyThisSubject: String,
        whyThisProduct: String,
        whyThisList: String,
        whyThisTime: String
      }
    }]
  },

  // Stats
  stats: {
    totalCampaignsSent: { type: Number, default: 0 },
    totalEmailsSent: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    avgOpenRate: { type: Number, default: 0 },
    avgClickRate: { type: Number, default: 0 },
    lastCampaignAt: { type: Date }
  }
}, {
  timestamps: true
});

// Singleton - always get or create the single config
maximusConfigSchema.statics.getConfig = async function () {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({
      active: false,
      lists: [],
      learning: { phase: 'initial' }
    });
  }
  return config;
};

// Check if Maximus can send today
maximusConfigSchema.methods.canSendToday = function () {
  if (!this.active || !this.creativeAgentReady) return false;

  const now = new Date();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const today = dayNames[now.getDay()];

  // Check if today is a rest day
  if (this.learning.restDays && this.learning.restDays.includes(today)) {
    return false;
  }

  return true;
};

// Check if within send window
maximusConfigSchema.methods.isWithinSendWindow = function () {
  const now = new Date();
  const options = { timeZone: this.timezone, hour: 'numeric', hour12: false };
  const currentHour = parseInt(now.toLocaleString('en-US', options));
  return currentHour >= this.sendWindowStart && currentHour < this.sendWindowEnd;
};

// Get optimal send time based on learning
maximusConfigSchema.methods.getOptimalSendHour = function () {
  if (this.learning.bestHours && this.learning.bestHours.length > 0) {
    // Return the best performing hour
    return this.learning.bestHours[0].hour;
  }

  // During initial/learning phase, pick a random hour in the window
  const min = this.sendWindowStart;
  const max = this.sendWindowEnd - 1;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

module.exports = mongoose.model('MaximusConfig', maximusConfigSchema);
