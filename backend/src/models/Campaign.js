// backend/src/models/Campaign.js (ACTUALIZADO CON REVENUE + UNSUBSCRIBE)
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
  
  // STATS CON REVENUE + UNSUBSCRIBE
  stats: {
    totalRecipients: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    clicked: { type: Number, default: 0 },
    bounced: { type: Number, default: 0 },
    complained: { type: Number, default: 0 },
    unsubscribed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    
    // REVENUE METRICS
    purchased: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    averageOrderValue: { type: Number, default: 0 },
    
    // Rates
    openRate: { type: Number, default: 0 },
    clickRate: { type: Number, default: 0 },
    bounceRate: { type: Number, default: 0 },
    unsubscribeRate: { type: Number, default: 0 },  // 🆕 UNSUBSCRIBE RATE
    conversionRate: { type: Number, default: 0 },
    revenuePerEmail: { type: Number, default: 0 }
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

// ==================== ÍNDICES ====================
campaignSchema.index({ status: 1, scheduledAt: 1 });
campaignSchema.index({ createdAt: -1 });
campaignSchema.index({ list: 1 });
campaignSchema.index({ targetType: 1 });

// ==================== PRE-SAVE VALIDATION ====================
campaignSchema.pre('save', function(next) {
  if (this.targetType === 'list' && !this.list) {
    next(new Error('Must specify a list when targetType is "list"'));
  } else if (this.targetType === 'segment' && !this.segment) {
    next(new Error('Must specify a segment when targetType is "segment"'));
  } else {
    next();
  }
});

// ==================== MÉTODOS DE INSTANCIA ====================

/**
 * Actualiza todos los rates calculados
 */
campaignSchema.methods.updateRates = function() {
  // Open & Click rates (basados en delivered)
  if (this.stats.delivered > 0) {
    this.stats.openRate = parseFloat(((this.stats.opened / this.stats.delivered) * 100).toFixed(2));
    this.stats.clickRate = parseFloat(((this.stats.clicked / this.stats.delivered) * 100).toFixed(2));
    this.stats.conversionRate = parseFloat(((this.stats.purchased / this.stats.delivered) * 100).toFixed(2));
  }
  
  // Bounce & Unsubscribe rates (basados en sent)
  if (this.stats.sent > 0) {
    this.stats.bounceRate = parseFloat(((this.stats.bounced / this.stats.sent) * 100).toFixed(2));
    this.stats.unsubscribeRate = parseFloat(((this.stats.unsubscribed / this.stats.sent) * 100).toFixed(2));
    this.stats.revenuePerEmail = parseFloat((this.stats.totalRevenue / this.stats.sent).toFixed(2));
  }
  
  // Average Order Value
  if (this.stats.purchased > 0) {
    this.stats.averageOrderValue = parseFloat((this.stats.totalRevenue / this.stats.purchased).toFixed(2));
  }
};

// ==================== MÉTODOS ESTÁTICOS ====================

/**
 * Actualiza stats de una campaña
 * @param {string} campaignId - ID de la campaña
 * @param {string} eventType - Tipo de evento (sent, delivered, opened, clicked, bounced, unsubscribed, purchased, etc.)
 * @param {number} revenueAmount - Monto de revenue (solo para purchased)
 */
campaignSchema.statics.updateStats = async function(campaignId, eventType, revenueAmount = 0) {
  try {
    // Validar eventType
    const validEvents = [
      'sent', 
      'delivered', 
      'opened', 
      'clicked', 
      'bounced', 
      'complained',
      'unsubscribed',  // ✅ Incluido
      'skipped',
      'purchased'
    ];
    
    if (!validEvents.includes(eventType)) {
      console.warn(`⚠️ Invalid event type for campaign stats: ${eventType}`);
      return null;
    }
    
    const updateData = {
      $inc: { [`stats.${eventType}`]: 1 }
    };
    
    // Si es una compra, actualizar revenue
    if (eventType === 'purchased' && revenueAmount > 0) {
      updateData.$inc['stats.totalRevenue'] = revenueAmount;
    }
    
    await this.findByIdAndUpdate(campaignId, updateData);
    
    // Recalcular rates
    const campaign = await this.findById(campaignId);
    if (campaign) {
      campaign.updateRates();
      await campaign.save();
    }
    
    return campaign;
    
  } catch (error) {
    console.error('Error updating campaign stats:', error);
    throw error;
  }
};

/**
 * Obtener estadísticas detalladas de una campaña
 */
campaignSchema.statics.getDetailedStats = async function(campaignId) {
  const campaign = await this.findById(campaignId)
    .populate('segment', 'name customerCount')
    .populate('list', 'name memberCount');
  
  if (!campaign) return null;
  
  // Asegurar que los rates estén actualizados
  campaign.updateRates();
  
  return {
    campaign: {
      _id: campaign._id,
      name: campaign.name,
      subject: campaign.subject,
      status: campaign.status,
      sentAt: campaign.sentAt,
      targetType: campaign.targetType,
      segment: campaign.segment,
      list: campaign.list
    },
    stats: campaign.stats,
    rates: {
      deliveryRate: campaign.stats.sent > 0 
        ? parseFloat(((campaign.stats.delivered / campaign.stats.sent) * 100).toFixed(2))
        : 0,
      openRate: campaign.stats.openRate,
      clickRate: campaign.stats.clickRate,
      bounceRate: campaign.stats.bounceRate,
      unsubscribeRate: campaign.stats.unsubscribeRate,
      conversionRate: campaign.stats.conversionRate,
      clickToOpenRate: campaign.stats.opened > 0
        ? parseFloat(((campaign.stats.clicked / campaign.stats.opened) * 100).toFixed(2))
        : 0
    },
    revenue: {
      total: campaign.stats.totalRevenue,
      orders: campaign.stats.purchased,
      averageOrderValue: campaign.stats.averageOrderValue,
      revenuePerEmail: campaign.stats.revenuePerEmail
    }
  };
};

/**
 * Obtener campañas con alto unsubscribe rate
 */
campaignSchema.statics.getHighUnsubscribeCampaigns = async function(threshold = 1) {
  return this.find({
    status: 'sent',
    'stats.unsubscribeRate': { $gte: threshold }
  })
  .select('name subject sentAt stats.sent stats.unsubscribed stats.unsubscribeRate')
  .sort({ 'stats.unsubscribeRate': -1 })
  .limit(20);
};

/**
 * Obtener resumen global de unsubscribes
 */
campaignSchema.statics.getUnsubscribesSummary = async function() {
  const result = await this.aggregate([
    { $match: { status: 'sent' } },
    {
      $group: {
        _id: null,
        totalCampaigns: { $sum: 1 },
        totalSent: { $sum: '$stats.sent' },
        totalUnsubscribed: { $sum: '$stats.unsubscribed' },
        avgUnsubscribeRate: { $avg: '$stats.unsubscribeRate' }
      }
    }
  ]);
  
  const summary = result[0] || {
    totalCampaigns: 0,
    totalSent: 0,
    totalUnsubscribed: 0,
    avgUnsubscribeRate: 0
  };
  
  return {
    ...summary,
    globalUnsubscribeRate: summary.totalSent > 0
      ? parseFloat(((summary.totalUnsubscribed / summary.totalSent) * 100).toFixed(2))
      : 0
  };
};

module.exports = mongoose.model('Campaign', campaignSchema);