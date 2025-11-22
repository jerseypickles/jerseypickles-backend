// backend/src/models/EmailEvent.js (COMPLETO + OPTIMIZADO)
const mongoose = require('mongoose');

if (mongoose.models.EmailEvent) {
  delete mongoose.models.EmailEvent;
}

const emailEventSchema = new mongoose.Schema({
  campaign: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
    index: true
  },
  flow: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Flow',
    required: false,
    index: true
  },
  flowExecution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FlowExecution',
    required: false
  },
  customer: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
    index: true
  },
  
  eventType: {
    type: String,
    enum: ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'delayed', 'purchased'],
    required: true,
    index: true
  },
  
  email: {
    type: String,
    required: true,
    index: true
  },
  
  source: {
    type: String,
    enum: ['custom', 'resend', 'shopify', 'klaviyo', 'manual'],
    default: 'custom',
    index: true
  },
  
  // Para clicks
  clickedUrl: String,
  
  // Para bounces
  bounceReason: String,
  bounceType: String,
  
  // Revenue tracking
  revenue: {
    orderValue: { type: Number, default: 0 },
    orderId: String,
    orderNumber: String,
    currency: { type: String, default: 'USD' },
    products: [{
      productId: String,
      title: String,
      quantity: Number,
      price: Number
    }]
  },
  
  // Metadata adicional
  userAgent: String,
  ipAddress: String,
  resendId: String, // Legacy - mantener por compatibilidad
  
  metadata: {
    resendEventId: {
      type: String,
      sparse: true
    },
    klaviyoEventId: String,
    timestamp: String,
    rawTags: mongoose.Schema.Types.Mixed,
    attributionMethod: String,
    financialStatus: String,
    discountCodes: [String]
  },
  
  eventDate: {
    type: Date,
    default: Date.now,
    index: true
  }
  
}, {
  timestamps: true,
  collection: 'email_events'
});

// ==================== ÍNDICES OPTIMIZADOS ====================

// 1. ✅ CRÍTICO: Deduplicación de webhooks Resend (previene duplicados)
emailEventSchema.index(
  { 'metadata.resendEventId': 1, eventType: 1 },
  { 
    name: 'resend_deduplication_idx',
    background: true,
    sparse: true,
    unique: true  // ← Garantiza unicidad a nivel de DB
  }
);

// 2. Campaign analytics y stats
emailEventSchema.index(
  { campaign: 1, eventType: 1 },
  { 
    name: 'campaign_events_idx',
    background: true 
  }
);

// 3. Customer timeline y stats
emailEventSchema.index(
  { customer: 1, eventDate: -1 },
  { 
    name: 'customer_timeline_idx',
    background: true 
  }
);

// 4. Last click attribution (7-day window)
emailEventSchema.index(
  { customer: 1, eventType: 1, eventDate: -1 },
  { 
    name: 'customer_last_click_idx',
    background: true 
  }
);

// 5. Campaign + Customer analytics
emailEventSchema.index(
  { campaign: 1, customer: 1, eventType: 1, eventDate: -1 },
  { 
    name: 'campaign_customer_events_idx',
    background: true 
  }
);

// 6. Flow analytics y stats
emailEventSchema.index(
  { flow: 1, eventType: 1, eventDate: -1 },
  { 
    name: 'flow_events_idx',
    background: true 
  }
);

// 7. Flow execution tracking
emailEventSchema.index(
  { flowExecution: 1, eventType: 1 },
  { 
    name: 'flow_execution_idx',
    background: true 
  }
);

// 8. Revenue tracking
emailEventSchema.index(
  { 'revenue.orderId': 1 },
  { 
    name: 'revenue_order_idx',
    background: true,
    sparse: true
  }
);

// 9. Email search y reporting
emailEventSchema.index(
  { email: 1, eventDate: -1 },
  { 
    name: 'email_timeline_idx',
    background: true 
  }
);

// 10. Source filtering (para comparar Resend vs Shopify)
emailEventSchema.index(
  { source: 1, eventType: 1, eventDate: -1 },
  { 
    name: 'source_events_idx',
    background: true 
  }
);

// 11. General event date index (para queries genéricas)
emailEventSchema.index(
  { eventDate: -1 },
  { 
    name: 'event_date_idx',
    background: true 
  }
);

// 12. ⚠️ OPCIONAL: TTL Index - Auto-eliminar eventos después de 2 años
// ⚠️ DESCOMENTAR SOLO SI QUIERES AUTO-DELETE
// emailEventSchema.index(
//   { eventDate: 1 },
//   { 
//     name: 'event_ttl_idx',
//     expireAfterSeconds: 63072000, // 2 años = 730 días
//     background: true 
//   }
// );

// ==================== MÉTODOS ESTÁTICOS ====================

emailEventSchema.statics.logEvent = async function(data) {
  try {
    const event = await this.create(data);
    
    // Actualizar stats de Campaign
    if (data.campaign && mongoose.Types.ObjectId.isValid(data.campaign)) {
      try {
        const Campaign = mongoose.model('Campaign');
        await Campaign.updateStats(data.campaign, data.eventType, data.revenue?.orderValue);
      } catch (error) {
        console.log('⚠️  Error actualizando stats de campaña:', error.message);
      }
    }
    
    // Actualizar stats de Customer
    if (data.customer && mongoose.Types.ObjectId.isValid(data.customer)) {
      try {
        const Customer = mongoose.model('Customer');
        await Customer.updateEmailStats(data.customer, data.eventType, data.revenue?.orderValue);
      } catch (error) {
        console.log('⚠️  Error actualizando stats de cliente:', error.message);
      }
    }
    
    // Actualizar stats de Flow
    if (data.flow && mongoose.Types.ObjectId.isValid(data.flow)) {
      try {
        const Flow = mongoose.model('Flow');
        
        const metricMap = {
          'sent': 'emailsSent',
          'delivered': 'delivered',
          'opened': 'opens',
          'clicked': 'clicks',
          'bounced': 'bounced',
          'complained': 'complained'
        };
        
        const metricName = metricMap[data.eventType];
        
        if (metricName) {
          await Flow.findByIdAndUpdate(data.flow, {
            $inc: { [`metrics.${metricName}`]: 1 }
          });
        }
        
        // Revenue para flows
        if (data.eventType === 'purchased' && data.revenue?.orderValue) {
          await Flow.findByIdAndUpdate(data.flow, {
            $inc: { 
              'metrics.totalRevenue': data.revenue.orderValue,
              'metrics.totalOrders': 1
            }
          });
        }
        
      } catch (error) {
        console.log('⚠️  Error actualizando stats de flow:', error.message);
      }
    }
    
    return event;
    
  } catch (error) {
    // Si es error de duplicado (unique index), ignorar silenciosamente
    if (error.code === 11000 && error.message.includes('resend_deduplication_idx')) {
      console.log('⏭️  Evento duplicado detectado y rechazado por índice único');
      return null;
    }
    throw error;
  }
};

// ==================== MÉTODOS DE INSTANCIA ====================

// Verificar si el evento ya existe (útil antes de crear)
emailEventSchema.statics.isDuplicate = async function(resendEventId, eventType) {
  if (!resendEventId) return false;
  
  const existing = await this.findOne({
    'metadata.resendEventId': resendEventId,
    eventType: eventType
  });
  
  return !!existing;
};

// Obtener último click de un customer
emailEventSchema.statics.getLastClick = async function(customerId, days = 7) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  
  return await this.findOne({
    customer: customerId,
    eventType: 'clicked',
    eventDate: { $gte: cutoffDate }
  }).sort({ eventDate: -1 });
};

// Stats de un customer
emailEventSchema.statics.getCustomerStats = async function(customerId) {
  const events = await this.aggregate([
    { $match: { customer: mongoose.Types.ObjectId(customerId) } },
    { 
      $group: { 
        _id: '$eventType',
        count: { $sum: 1 }
      }
    }
  ]);
  
  const stats = {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    bounced: 0,
    complained: 0,
    unsubscribed: 0,
    purchased: 0
  };
  
  events.forEach(e => {
    stats[e._id] = e.count;
  });
  
  return stats;
};

module.exports = mongoose.model('EmailEvent', emailEventSchema);