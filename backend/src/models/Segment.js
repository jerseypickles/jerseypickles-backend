// backend/src/models/Segment.js - ACTUALIZADO
const mongoose = require('mongoose');

const conditionSchema = new mongoose.Schema({
  field: {
    type: String,
    required: true,
    enum: [
      // === Datos de compra ===
      'totalSpent',
      'ordersCount', 
      'averageOrderValue',
      'lastOrderDate',
      
      // === Datos básicos ===
      'createdAt',
      'acceptsMarketing',
      'tags',
      
      // === Ubicación ===
      'city',
      'province', 
      'country',
      
      // === EMAIL ENGAGEMENT (NUEVO) ===
      'emailStats.sent',
      'emailStats.opened',
      'emailStats.clicked',
      'emailStats.bounced',
      'emailStats.purchased',
      'emailStats.totalRevenue',
      
      // === POPUP/SOURCE (NUEVO) ===
      'popupDiscountCode',  // exists/not_exists para saber si vino de popup
      'source',             // shopify, website-popup-*, csv-import, etc.
      'emailStatus',        // active, bounced, unsubscribed, complained
      
      // === BOUNCE INFO (NUEVO) ===
      'bounceInfo.isBounced',
      'bounceInfo.bounceType',
      'bounceInfo.bounceCount'
    ]
  },
  operator: {
    type: String,
    required: true,
    enum: [
      'equals',
      'not_equals',
      'greater_than',
      'less_than',
      'greater_than_or_equals',
      'less_than_or_equals',
      'contains',
      'not_contains',
      'starts_with',
      'ends_with',
      'in_last_days',
      'not_in_last_days',
      'before_date',
      'after_date',
      'is_empty',
      'is_not_empty',
      'exists',        // Para popupDiscountCode
      'not_exists',    // Para popupDiscountCode
      'in',            // Para source: ['website-popup-v3', 'website-popup-christmas-2025']
      'not_in'
    ]
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: function() {
      // No requerido para operadores exists/is_empty
      return !['exists', 'not_exists', 'is_empty', 'is_not_empty'].includes(this.operator);
    }
  },
  logicalOperator: {
    type: String,
    enum: ['AND', 'OR'],
    default: 'AND'
  }
}, { _id: false });

const segmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true
  },
  description: {
    type: String,
    trim: true
  },
  conditions: [conditionSchema],
  
  // Tipo de segmento
  type: {
    type: String,
    enum: ['custom', 'predefined'],
    default: 'custom'
  },
  
  // Categoría para agrupar en UI
  category: {
    type: String,
    enum: ['purchase', 'engagement', 'popup', 'lifecycle', 'cleanup', 'custom'],
    default: 'custom'
  },
  
  // Stats calculados
  customerCount: {
    type: Number,
    default: 0
  },
  lastCalculated: {
    type: Date
  },
  
  // Metadata
  isActive: {
    type: Boolean,
    default: true
  },
  isPredefined: {
    type: Boolean,
    default: false
  },
  
  // Para tracking
  usedInCampaigns: {
    type: Number,
    default: 0
  },
  lastUsedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Índices
segmentSchema.index({ slug: 1 }, { unique: true });
segmentSchema.index({ type: 1 });
segmentSchema.index({ category: 1 });
segmentSchema.index({ isActive: 1 });

// Pre-save: generar slug
segmentSchema.pre('save', function(next) {
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
  next();
});

// Método para recalcular count
segmentSchema.methods.recalculate = async function() {
  const segmentationService = require('../services/segmentationService');
  const count = await segmentationService.getSegmentCustomerCount(this);
  this.customerCount = count;
  this.lastCalculated = new Date();
  await this.save();
  return count;
};

// Método para obtener query de MongoDB
segmentSchema.methods.buildQuery = function() {
  const segmentationService = require('../services/segmentationService');
  return segmentationService.buildQuery(this.conditions);
};

// Static: obtener segmentos activos
segmentSchema.statics.getActive = function() {
  return this.find({ isActive: true }).sort({ category: 1, name: 1 });
};

// Static: obtener por categoría
segmentSchema.statics.getByCategory = function(category) {
  return this.find({ category, isActive: true }).sort({ name: 1 });
};

// Static: obtener predefinidos
segmentSchema.statics.getPredefined = function() {
  return this.find({ isPredefined: true, isActive: true }).sort({ category: 1, name: 1 });
};

module.exports = mongoose.model('Segment', segmentSchema);