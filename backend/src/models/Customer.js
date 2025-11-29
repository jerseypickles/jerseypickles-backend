// backend/src/models/Customer.js (VERSIÓN COMPLETA CON BOUNCE MANAGEMENT FIXED)
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
  
  // Código de descuento del popup
  popupDiscountCode: {
    type: String,
    sparse: true
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
  
  // ✅ Estado del email para bounce management
  emailStatus: {
    type: String,
    enum: ['active', 'bounced', 'unsubscribed', 'complained'],
    default: 'active',
    index: true
  },
  
  // ✅ Información detallada de bounces
  bounceInfo: {
    isBounced: { type: Boolean, default: false, index: true },
    bounceType: { 
      type: String, 
      enum: ['hard', 'soft', null], 
      default: null 
    },
    bounceCount: { type: Number, default: 0 },
    lastBounceDate: Date,
    bounceReason: String,
    bouncedCampaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign'
    }
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
    enum: [
      'shopify', 
      'csv-import', 
      'website-popup', 
      'website-popup-v2', 
      'website-popup-v3',
      'manual',
      'black-friday-banner',
      'product-page-bf-widget',
      'website-popup-bf-live'
    ],
    default: 'shopify'
  },
  
  // Metadata de Shopify
  shopifyData: mongoose.Schema.Types.Mixed,
  
}, {
  timestamps: true,
  collection: 'customers'
});

// ==================== ÍNDICES ====================

// Índices existentes
customerSchema.index({ totalSpent: -1, ordersCount: -1 });
customerSchema.index({ createdAt: -1 });
customerSchema.index({ acceptsMarketing: 1, 'emailStats.sent': 1 });
customerSchema.index({ popupDiscountCode: 1 });
customerSchema.index({ source: 1 });

// ✅ Índices para bounce management
customerSchema.index({ emailStatus: 1, 'bounceInfo.isBounced': 1 });
customerSchema.index({ 'bounceInfo.bounceType': 1 });
customerSchema.index({ 'bounceInfo.lastBounceDate': -1 });

// ==================== VIRTUALS ====================

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

// ✅ FIXED: Marcar customer como bounced
customerSchema.methods.markAsBounced = async function(bounceType = 'soft', reason = '', campaignId = null) {
  console.log(`\n🔴 Marcando bounce: ${this.email}`);
  console.log(`   Tipo recibido: ${bounceType}`);
  console.log(`   Bounce count actual: ${this.bounceInfo.bounceCount || 0}`);
  
  // Inicializar bounceInfo si no existe
  if (!this.bounceInfo) {
    this.bounceInfo = {
      isBounced: false,
      bounceType: null,
      bounceCount: 0,
      lastBounceDate: null,
      bounceReason: null,
      bouncedCampaignId: null
    };
  }
  
  // Incrementar contador
  this.bounceInfo.bounceCount = (this.bounceInfo.bounceCount || 0) + 1;
  this.bounceInfo.lastBounceDate = new Date();
  this.bounceInfo.bounceReason = reason;
  this.bounceInfo.bounceType = bounceType;
  
  if (campaignId) {
    this.bounceInfo.bouncedCampaignId = campaignId;
  }
  
  // ✅ CRÍTICO: SIEMPRE marcar isBounced = true
  this.bounceInfo.isBounced = true;
  
  // ✅ CRÍTICO: SIEMPRE actualizar emailStatus
  this.emailStatus = 'bounced';
  
  console.log(`   → isBounced: ${this.bounceInfo.isBounced}`);
  console.log(`   → emailStatus: ${this.emailStatus}`);
  console.log(`   → bounceType: ${this.bounceInfo.bounceType}`);
  console.log(`   → bounceCount: ${this.bounceInfo.bounceCount}`);
  
  // Convertir soft a hard después de 3 bounces
  if (bounceType === 'soft' && this.bounceInfo.bounceCount >= 3) {
    console.log(`   ⚠️  CONVIRTIENDO a hard bounce (3+ soft bounces)`);
    this.bounceInfo.bounceType = 'hard';
  }
  
  // Guardar ANTES de remover de listas
  await this.save();
  console.log(`✅ Customer guardado: ${this.email}`);
  
  // Auto-remove de listas SOLO si es hard bounce
  if (this.bounceInfo.bounceType === 'hard') {
    try {
      // Verificar si el modelo List está registrado
      const listModelExists = mongoose.modelNames().includes('List');
      
      if (listModelExists) {
        const List = mongoose.model('List');
        const listsWithMember = await List.find({ members: this._id });
        
        console.log(`   🗑️  Removiendo de ${listsWithMember.length} lista(s)`);
        
        for (const list of listsWithMember) {
          await list.removeMember(this._id);
        }
        
        console.log(`   ✅ Removido de todas las listas (hard bounce)`);
      } else {
        console.log(`   ℹ️  Modelo List no disponible (skip auto-remove)`);
      }
    } catch (error) {
      console.log(`   ⚠️  Error removiendo de listas: ${error.message}`);
    }
  } else {
    console.log(`   ℹ️  Soft bounce - permanece en listas`);
    console.log(`   ℹ️  Se convertirá a hard en bounce #3\n`);
  }
  
  return this;
};

// ✅ Resetear bounce info (para casos especiales)
customerSchema.methods.resetBounceInfo = async function() {
  this.emailStatus = 'active';
  this.bounceInfo = {
    isBounced: false,
    bounceType: null,
    bounceCount: 0,
    lastBounceDate: null,
    bounceReason: null,
    bouncedCampaignId: null
  };
  
  await this.save();
  console.log(`✅ Bounce info reseteado para: ${this.email}`);
  return this;
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

// ✅ Obtener todos los customers bounced
customerSchema.statics.getBounced = async function(options = {}) {
  const query = {
    'bounceInfo.isBounced': true
  };
  
  if (options.bounceType) {
    query['bounceInfo.bounceType'] = options.bounceType;
  }
  
  if (options.since) {
    query['bounceInfo.lastBounceDate'] = { $gte: options.since };
  }
  
  if (options.campaignId) {
    query['bounceInfo.bouncedCampaignId'] = options.campaignId;
  }
  
  return this.find(query)
    .select('email firstName lastName bounceInfo emailStatus createdAt')
    .sort({ 'bounceInfo.lastBounceDate': -1 })
    .limit(options.limit || 1000);
};

// ✅ Obtener estadísticas globales de bounces
customerSchema.statics.getBounceStats = async function() {
  const [stats] = await this.aggregate([
    {
      $facet: {
        overview: [
          {
            $group: {
              _id: null,
              totalCustomers: { $sum: 1 },
              totalBounced: {
                $sum: { $cond: ['$bounceInfo.isBounced', 1, 0] }
              },
              hardBounces: {
                $sum: { 
                  $cond: [
                    { $eq: ['$bounceInfo.bounceType', 'hard'] },
                    1,
                    0
                  ]
                }
              },
              softBounces: {
                $sum: { 
                  $cond: [
                    { $eq: ['$bounceInfo.bounceType', 'soft'] },
                    1,
                    0
                  ]
                }
              },
              avgBounceCount: { $avg: '$bounceInfo.bounceCount' }
            }
          }
        ],
        byStatus: [
          {
            $group: {
              _id: '$emailStatus',
              count: { $sum: 1 }
            }
          }
        ],
        recentBounces: [
          {
            $match: {
              'bounceInfo.isBounced': true,
              'bounceInfo.lastBounceDate': { 
                $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) 
              }
            }
          },
          {
            $group: {
              _id: null,
              last7Days: { $sum: 1 }
            }
          }
        ]
      }
    }
  ]);
  
  const overview = stats?.overview[0] || {
    totalCustomers: 0,
    totalBounced: 0,
    hardBounces: 0,
    softBounces: 0,
    avgBounceCount: 0
  };
  
  const byStatus = stats?.byStatus || [];
  const recentBounces = stats?.recentBounces[0] || { last7Days: 0 };
  
  return {
    ...overview,
    bounceRate: overview.totalCustomers > 0 
      ? ((overview.totalBounced / overview.totalCustomers) * 100).toFixed(2)
      : 0,
    byStatus,
    recentBounces: recentBounces.last7Days
  };
};

// ✅ Obtener customers con soft bounces cercanos a convertirse en hard
customerSchema.statics.getAtRiskCustomers = async function() {
  return this.find({
    'bounceInfo.bounceType': 'soft',
    'bounceInfo.bounceCount': { $gte: 2 },
    'bounceInfo.isBounced': true,
    emailStatus: 'bounced'
  })
  .select('email firstName lastName bounceInfo')
  .sort({ 'bounceInfo.bounceCount': -1 })
  .limit(100);
};

// ✅ Limpiar bounces antiguos (para mantenimiento)
customerSchema.statics.cleanOldBounces = async function(daysOld = 90) {
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  
  const result = await this.updateMany(
    {
      'bounceInfo.isBounced': true,
      'bounceInfo.lastBounceDate': { $lt: cutoffDate }
    },
    {
      $set: {
        emailStatus: 'active',
        'bounceInfo.isBounced': false,
        'bounceInfo.bounceType': null,
        'bounceInfo.bounceCount': 0
      }
    }
  );
  
  console.log(`🧹 Limpiados ${result.modifiedCount} bounces de más de ${daysOld} días`);
  return result;
};

module.exports = mongoose.model('Customer', customerSchema);