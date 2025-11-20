// backend/src/models/EmailEvent.js
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
  customer: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
    index: true
  },
  
  eventType: {
    type: String,
    enum: ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'delayed', 'purchased'], // 🆕 ADDED 'purchased'
    required: true,
    index: true
  },
  
  email: {
    type: String,
    required: true
  },
  
  source: {
    type: String,
    enum: ['custom', 'resend', 'shopify'], // 🆕 ADDED 'shopify'
    default: 'custom',
    index: true
  },
  
  // Para clicks
  clickedUrl: String,
  
  // Para bounces
  bounceReason: String,
  bounceType: String,
  
  // 🆕 REVENUE TRACKING
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
  
  // Metadata
  userAgent: String,
  ipAddress: String,
  resendId: String,
  
  metadata: {
    type: Object,
    default: {}
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

// Índices
emailEventSchema.index({ campaign: 1, eventType: 1 });
emailEventSchema.index({ customer: 1, eventDate: -1 });
emailEventSchema.index({ eventDate: -1 });
emailEventSchema.index({ campaign: 1, customer: 1, eventType: 1, source: 1 });
emailEventSchema.index({ 'revenue.orderId': 1 }); // 🆕

emailEventSchema.statics.logEvent = async function(data) {
  const event = await this.create(data);
  
  if (data.campaign && mongoose.Types.ObjectId.isValid(data.campaign)) {
    try {
      const Campaign = mongoose.model('Campaign');
      await Campaign.updateStats(data.campaign, data.eventType, data.revenue?.orderValue);
    } catch (error) {
      console.log('⚠️  Error actualizando stats de campaña:', error.message);
    }
  }
  
  if (data.customer && mongoose.Types.ObjectId.isValid(data.customer)) {
    try {
      const Customer = mongoose.model('Customer');
      await Customer.updateEmailStats(data.customer, data.eventType, data.revenue?.orderValue);
    } catch (error) {
      console.log('⚠️  Error actualizando stats de cliente:', error.message);
    }
  }
  
  return event;
};

module.exports = mongoose.model('EmailEvent', emailEventSchema);