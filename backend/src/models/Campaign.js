// backend/src/models/Campaign.js
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
  
  // Contenido
  htmlContent: {
    type: String,
    required: true
  },
  previewText: String,
  
  // ==================== NUEVO: TARGET TYPE ====================
  targetType: {
    type: String,
    enum: ['list', 'segment'],
    default: 'segment'
  },
  
  // Segmento objetivo (existente)
  segment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Segment'
  },
  
  // NUEVO: Lista objetivo
  list: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'List'
  },
  // ============================================================
  
  // Estado
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'sending', 'sent', 'paused', 'failed'],
    default: 'draft',
    index: true
  },
  
  // Programación
  scheduledAt: Date,
  sentAt: Date,
  
  // Métricas
  stats: {
    totalRecipients: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    clicked: { type: Number, default: 0 },
    bounced: { type: Number, default: 0 },
    complained: { type: Number, default: 0 },
    unsubscribed: { type: Number, default: 0 },
    
    // Rates
    openRate: { type: Number, default: 0 },
    clickRate: { type: Number, default: 0 },
    bounceRate: { type: Number, default: 0 }
  },
  
  // Configuración
  fromName: {
    type: String,
    default: 'Jersey Pickles'
  },
  fromEmail: {
    type: String,
    default: 'info@jerseypickles.com'
  },
  replyTo: String,
  
  // Tracking
  trackOpens: {
    type: Boolean,
    default: true
  },
  trackClicks: {
    type: Boolean,
    default: true
  },
  
  // Metadata
  tags: [String],
  notes: String
  
}, {
  timestamps: true,
  collection: 'campaigns'
});

// Índices
campaignSchema.index({ status: 1, scheduledAt: 1 });
campaignSchema.index({ createdAt: -1 });
campaignSchema.index({ list: 1 }); // NUEVO
campaignSchema.index({ targetType: 1 }); // NUEVO

// Validación: debe tener o segment o list según targetType
campaignSchema.pre('save', function(next) {
  if (this.targetType === 'list' && !this.list) {
    next(new Error('Debe especificar una lista cuando targetType es "list"'));
  } else if (this.targetType === 'segment' && !this.segment) {
    next(new Error('Debe especificar un segmento cuando targetType es "segment"'));
  } else {
    next();
  }
});

// ==================== MÉTODOS DE INSTANCIA ====================

// Método para actualizar rates calculados
campaignSchema.methods.updateRates = function() {
  if (this.stats.delivered > 0) {
    this.stats.openRate = parseFloat(((this.stats.opened / this.stats.delivered) * 100).toFixed(2));
    this.stats.clickRate = parseFloat(((this.stats.clicked / this.stats.delivered) * 100).toFixed(2));
  }
  
  if (this.stats.sent > 0) {
    this.stats.bounceRate = parseFloat(((this.stats.bounced / this.stats.sent) * 100).toFixed(2));
  }
};

// ==================== MÉTODOS ESTÁTICOS ====================

// Actualizar estadísticas desde eventos (llamado desde tracking)
campaignSchema.statics.updateStats = async function(campaignId, eventType) {
  try {
    const statField = `stats.${eventType}`;
    await this.findByIdAndUpdate(campaignId, {
      $inc: { [statField]: 1 }
    });
    
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