// backend/src/models/EmailEvent.js
const mongoose = require('mongoose');

const emailEventSchema = new mongoose.Schema({
  campaign: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true,
    index: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true,
    index: true
  },
  
  // Tipo de evento
  eventType: {
    type: String,
    enum: ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed'],
    required: true,
    index: true
  },
  
  // Datos del evento
  email: {
    type: String,
    required: true
  },
  
  // Para clicks
  clickedUrl: String,
  
  // Para bounces
  bounceReason: String,
  bounceType: String, // hard o soft
  
  // Metadata
  userAgent: String,
  ipAddress: String,
  
  // ID de Resend
  resendId: String,
  
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

// Método estático para registrar evento
emailEventSchema.statics.logEvent = async function(data) {
  const event = await this.create(data);
  
  // Actualizar estadísticas de la campaña
  const Campaign = mongoose.model('Campaign');
  await Campaign.updateStats(data.campaign, data.eventType);
  
  // Actualizar estadísticas del cliente
  const Customer = mongoose.model('Customer');
  await Customer.updateEmailStats(data.customer, data.eventType);
  
  return event;
};

module.exports = mongoose.model('EmailEvent', emailEventSchema);