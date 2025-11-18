// backend/src/models/EmailEvent.js
const mongoose = require('mongoose');

// 🆕 FORZAR BORRAR MODELO CACHEADO
if (mongoose.models.EmailEvent) {
  delete mongoose.models.EmailEvent;
}

const emailEventSchema = new mongoose.Schema({
  // 🆕 CAMBIAR TIPO: De ObjectId a Mixed (acepta cualquier cosa)
  campaign: {
    type: mongoose.Schema.Types.Mixed, // Acepta ObjectId O String
    required: false,
    index: true
  },
  customer: {
    type: mongoose.Schema.Types.Mixed, // Acepta ObjectId O String
    required: false,
    index: true
  },
  
  // Tipo de evento
  eventType: {
    type: String,
    enum: ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'delayed'],
    required: true,
    index: true
  },
  
  // Datos del evento
  email: {
    type: String,
    required: true
  },
  
  // Identificar origen del evento
  source: {
    type: String,
    enum: ['custom', 'resend'],
    default: 'custom',
    index: true
  },
  
  // Para clicks
  clickedUrl: String,
  
  // Para bounces
  bounceReason: String,
  bounceType: String,
  
  // Metadata
  userAgent: String,
  ipAddress: String,
  
  // ID de Resend
  resendId: String,
  
  // Metadata adicional flexible
  metadata: {
    type: Object,
    default: {}
  },
  
  // Timestamp del evento
  eventDate: {
    type: Date,
    default: Date.now,
    index: true
  }
  
}, {
  timestamps: true,
  collection: 'email_events'
});

// Índices compuestos para queries comunes
emailEventSchema.index({ campaign: 1, eventType: 1 });
emailEventSchema.index({ customer: 1, eventDate: -1 });
emailEventSchema.index({ eventDate: -1 });
emailEventSchema.index({ campaign: 1, customer: 1, eventType: 1, source: 1 });

// Método estático para registrar evento
emailEventSchema.statics.logEvent = async function(data) {
  const event = await this.create(data);
  
  // Actualizar estadísticas si campaign existe y es ObjectId válido
  if (data.campaign && mongoose.Types.ObjectId.isValid(data.campaign)) {
    try {
      const Campaign = mongoose.model('Campaign');
      await Campaign.updateStats(data.campaign, data.eventType);
    } catch (error) {
      console.log('⚠️  Error actualizando stats de campaña:', error.message);
    }
  }
  
  // Actualizar estadísticas si customer existe y es ObjectId válido
  if (data.customer && mongoose.Types.ObjectId.isValid(data.customer)) {
    try {
      const Customer = mongoose.model('Customer');
      await Customer.updateEmailStats(data.customer, data.eventType);
    } catch (error) {
      console.log('⚠️  Error actualizando stats de cliente:', error.message);
    }
  }
  
  return event;
};

module.exports = mongoose.model('EmailEvent', emailEventSchema);