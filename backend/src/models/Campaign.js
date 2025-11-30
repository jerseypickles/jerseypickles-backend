// backend/src/models/Campaign.js (ACTUALIZADO CON REVENUE)
const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  subject: {
    type: String,
    required: true
  },
  htmlContent: {
    type: String,
    required: true
  },
  previewText: String,
  
  targetType: {
    type: String,
    enum: ['list', 'segment'],
    default: 'segment'
  },
  
  segment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Segment'
  },
  
  list: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'List'
  },
  
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'sending', 'sent', 'paused', 'failed'],
    default: 'draft',
    index: true
  },
  
  scheduledAt: Date,
  sentAt: Date,
  
  // 🆕 REVENUE STATS
  stats: {
    totalRecipients: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    clicked: { type: Number, default: 0 },
    bounced: { type: Number, default: 0 },
    complained: { type: Number, default: 0 },
    unsubscribed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },  // ← AGREGAR ESTO
    
    // 🆕 REVENUE METRICS
    purchased: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    averageOrderValue: { type: Number, default: 0 },
    
    // Rates
    openRate: { type: Number, default: 0 },
    clickRate: { type: Number, default: 0 },
    bounceRate: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 }, // 🆕
    revenuePerEmail: { type: Number, default: 0 } // 🆕
  },
  
  fromName: {
    type: String,
    default: 'Jersey Pickles'
  },
  fromEmail: {
    type: String,
    default: 'info@jerseypickles.com'
  },
  replyTo: String,
  
  trackOpens: {
    type: Boolean,
    default: true
  },
  trackClicks: {
    type: Boolean,
    default: true
  },
  
  tags: [String],
  notes: String
  
}, {
  timestamps: true,
  collection: 'campaigns'
});

campaignSchema.index({ status: 1, scheduledAt: 1 });
campaignSchema.index({ createdAt: -1 });
campaignSchema.index({ list: 1 });
campaignSchema.index({ targetType: 1 });

campaignSchema.pre('save', function(next) {
  if (this.targetType === 'list' && !this.list) {
    next(new Error('Debe especificar una lista cuando targetType es "list"'));
  } else if (this.targetType === 'segment' && !this.segment) {
    next(new Error('Debe especificar un segmento cuando targetType es "segment"'));
  } else {
    next();
  }
});

// 🆕 MÉTODO ACTUALIZADO CON REVENUE
campaignSchema.methods.updateRates = function() {
  if (this.stats.delivered > 0) {
    this.stats.openRate = parseFloat(((this.stats.opened / this.stats.delivered) * 100).toFixed(2));
    this.stats.clickRate = parseFloat(((this.stats.clicked / this.stats.delivered) * 100).toFixed(2));
    this.stats.conversionRate = parseFloat(((this.stats.purchased / this.stats.delivered) * 100).toFixed(2));
  }
  
  if (this.stats.sent > 0) {
    this.stats.bounceRate = parseFloat(((this.stats.bounced / this.stats.sent) * 100).toFixed(2));
    this.stats.revenuePerEmail = parseFloat((this.stats.totalRevenue / this.stats.sent).toFixed(2));
  }
  
  if (this.stats.purchased > 0) {
    this.stats.averageOrderValue = parseFloat((this.stats.totalRevenue / this.stats.purchased).toFixed(2));
  }
};

// 🆕 MÉTODO ESTÁTICO ACTUALIZADO CON REVENUE
campaignSchema.statics.updateStats = async function(campaignId, eventType, revenueAmount = 0) {
  try {
    const updateData = {
      $inc: { [`stats.${eventType}`]: 1 }
    };
    
    // Si es una compra, actualizar revenue
    if (eventType === 'purchased' && revenueAmount > 0) {
      updateData.$inc['stats.totalRevenue'] = revenueAmount;
    }
    
    await this.findByIdAndUpdate(campaignId, updateData);
    
    const campaign = await this.findById(campaignId);
    if (campaign) {
      campaign.updateRates();
      await campaign.save();
    }
    
  } catch (error) {
    console.error('Error actualizando stats de campaña:', error);
    throw error;
  }
};

module.exports = mongoose.model('Campaign', campaignSchema);