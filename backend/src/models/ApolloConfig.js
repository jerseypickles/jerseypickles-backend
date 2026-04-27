// backend/src/models/ApolloConfig.js
// 🏛️ Apollo - Creative Agent Configuration & Product Bank

const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, enum: ['pickles', 'olives', 'mushrooms', 'vegetables', 'gift-sets', 'other'], default: 'pickles' },
  bankImageUrl: { type: String, required: true },
  bankImageCloudinaryId: { type: String },
  promptHints: { type: String },
  active: { type: Boolean, default: true }
}, { _id: true });

const apolloConfigSchema = new mongoose.Schema({
  // Agent state
  active: { type: Boolean, default: false },

  // Product bank
  products: [productSchema],

  // OpenAI GPT-Image config (only image engine — Gemini removed 2026-04-27)
  openaiModel: { type: String, default: 'gpt-image-2' },
  aspectRatio: { type: String, default: '9:16' },

  // Cloudinary folder for generated creatives
  cloudinaryFolder: { type: String, default: 'apollo-creatives' },

  // Stats
  stats: {
    totalGenerated: { type: Number, default: 0 },
    lastGeneratedAt: { type: Date },
    averageGenerationTime: { type: Number, default: 0 }
  }
}, {
  timestamps: true
});

// Singleton
apolloConfigSchema.statics.getConfig = async function () {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({
      active: false,
      products: []
    });
  }
  return config;
};

// Get product by slug (trim to handle trailing spaces in DB)
apolloConfigSchema.methods.getProduct = function (slug) {
  const needle = slug.trim().toLowerCase();
  return this.products.find(p => p.slug.trim().toLowerCase() === needle && p.active);
};

// Get all active products
apolloConfigSchema.methods.getActiveProducts = function () {
  return this.products.filter(p => p.active);
};

module.exports = mongoose.model('ApolloConfig', apolloConfigSchema);
