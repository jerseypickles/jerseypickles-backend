// backend/src/models/Customer.js
const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  shopifyId: {
    type: String,
    unique: true,
    sparse: true, 
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  firstName: String,
  lastName: String,
  phone: String,
  
  // Métricas de compra
  ordersCount: {
    type: Number,
    default: 0,
    index: true
  },
  totalSpent: {
    type: Number,
    default: 0,
    index: true
  },
  averageOrderValue: {
    type: Number,
    default: 0
  },
  
  // Fechas importantes
  lastOrderDate: Date,
  lastCartActivity: Date,
  
  // Marketing
  acceptsMarketing: {
    type: Boolean,
    default: false,
    index: true
  },
  tags: [String],
  
  // ✅ NUEVO: Código de descuento del popup
  popupDiscountCode: {
    type: String,
    sparse: true,
    index: true
  },
  
  // Segmentación
  segments: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Segment'
  }],
  
  // Tracking con revenue
  emailStats: {
    sent: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    clicked: { type: Number, default: 0 },
    bounced: { type: Number, default: 0 },
    purchased: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    lastOpenedAt: Date,
    lastClickedAt: Date
  },
  
  // Ubicación
  address: {
    city: String,
    province: String,
    country: String,
    zip: String
  },
  
  // Source de donde vino el cliente
  source: {
    type: String,
    enum: ['shopify', 'csv-import', 'website-popup', 'website-popup-v2', 'manual'],
    default: 'shopify'
  },
  
  // Metadata de Shopify
  shopifyData: mongoose.Schema.Types.Mixed,
  
}, {
  timestamps: true,
  collection: 'customers'
});

// Índices compuestos para búsquedas comunes
customerSchema.index({ totalSpent: -1, ordersCount: -1 });
customerSchema.index({ createdAt: -1 });
customerSchema.index({ acceptsMarketing: 1, 'emailStats.sent': 1 });
customerSchema.index({ popupDiscountCode: 1 });
customerSchema.index({ source: 1 });

// Virtual para nombre completo
customerSchema.virtual('fullName').get(function() {
  return `${this.firstName || ''} ${this.lastName || ''}`.trim();
});

// ==================== MÉTODOS DE INSTANCIA ====================

// Método para calcular segmentos
customerSchema.methods.updateSegments = async function() {
  const Segment = mongoose.model('Segment');
  const segments = await Segment.find({ isActive: true });
  
  const matchingSegments = [];
  for (const segment of segments) {
    if (await this.matchesSegment(segment)) {
      matchingSegments.push(segment._id);
    }
  }
  
  this.segments = matchingSegments;
  await this.save();
};

// Método para verificar si cumple un segmento
customerSchema.methods.matchesSegment = function(segment) {
  // TODO: Implementar lógica de evaluación de condiciones
  return false;
};

// ==================== MÉTODOS ESTÁTICOS ====================

// Actualizar estadísticas de email con revenue
customerSchema.statics.updateEmailStats = async function(customerId, eventType, revenueAmount = 0) {
  try {
    const updates = {
      $inc: {}
    };
    
    // Incrementar contador según tipo de evento
    if (eventType === 'sent') {
      updates.$inc['emailStats.sent'] = 1;
    } else if (eventType === 'opened') {
      updates.$inc['emailStats.opened'] = 1;
      updates.$set = { 'emailStats.lastOpenedAt': new Date() };
    } else if (eventType === 'clicked') {
      updates.$inc['emailStats.clicked'] = 1;
      updates.$set = { 'emailStats.lastClickedAt': new Date() };
    } else if (eventType === 'bounced') {
      updates.$inc['emailStats.bounced'] = 1;
    } else if (eventType === 'purchased') {
      updates.$inc['emailStats.purchased'] = 1;
      if (revenueAmount > 0) {
        updates.$inc['emailStats.totalRevenue'] = revenueAmount;
      }
    }
    
    await this.findByIdAndUpdate(customerId, updates);
    
  } catch (error) {
    console.error('Error actualizando email stats del cliente:', error);
    throw error;
  }
};

module.exports = mongoose.model('Customer', customerSchema);