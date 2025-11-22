// backend/src/models/Flow.js
const mongoose = require('mongoose');

const flowSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  description: String,
  
  // TRIGGER - Qué inicia el flow
  trigger: {
    type: {
      type: String,
      enum: [
        'customer_created',      // Webhook de Shopify
        'order_placed',          // Webhook de Shopify  
        'cart_abandoned',        // Necesita implementar
        'popup_signup',          // Ya tienes popup v3
        'customer_tag_added',    // Webhook de Shopify
        'segment_entry',         // Check periódico
        'custom_event'           // Manual
      ],
      required: true
    },
    config: {
      // Para cart_abandoned
      abandonedAfterMinutes: { type: Number, default: 60 },
      
      // Para segment
      segmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Segment' },
      
      // Para tag
      tagName: String
    }
  },
  
  // STEPS - Qué hacer
  steps: [{
    type: {
      type: String,
      enum: [
        'send_email',       // Enviar con Resend
        'wait',             // Delay
        'condition',        // If/else
        'add_tag',          // Shopify API
        'create_discount'   // Shopify API
      ]
    },
    
    config: {
      // Para send_email
      subject: String,
      templateId: String,  // Referencia a tu templateService
      htmlContent: String,
      
      // Para wait
      delayMinutes: Number,
      
      // Para condition
      conditionType: String,  // 'has_purchased', 'tag_exists', 'total_spent_greater'
      conditionValue: mongoose.Schema.Types.Mixed,
      ifTrue: [mongoose.Schema.Types.Mixed],   // Steps si true
      ifFalse: [mongoose.Schema.Types.Mixed],  // Steps si false
      
      // Para add_tag
      tagName: String,
      
      // Para create_discount
      discountCode: String,
      discountType: String,
      discountValue: Number,
      expiresInDays: Number
    },
    
    order: Number
  }],
  
  // ESTADO
  status: {
    type: String,
    enum: ['draft', 'active', 'paused'],
    default: 'draft'
  },
  
  // MÉTRICAS
  metrics: {
    totalTriggered: { type: Number, default: 0 },
    currentlyActive: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    
    // Revenue tracking
    totalRevenue: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 }
  }
  
}, {
  timestamps: true
});

module.exports = mongoose.model('Flow', flowSchema);