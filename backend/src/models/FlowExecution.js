// backend/src/models/FlowExecution.js
const mongoose = require('mongoose');

const flowExecutionSchema = new mongoose.Schema({
  flow: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Flow',
    required: true
  },
  
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  
  // Estado actual
  status: {
    type: String,
    enum: ['active', 'waiting', 'completed', 'failed'],
    default: 'active'
  },
  
  currentStep: { type: Number, default: 0 },
  
  // Para delays
  resumeAt: Date,
  
  // Log de ejecución
  stepResults: [{
    stepIndex: Number,
    executedAt: Date,
    result: mongoose.Schema.Types.Mixed,
    error: String
  }],
  
  // Revenue attribution
  attributedOrders: [{
    orderId: mongoose.Schema.Types.ObjectId,
    amount: Number,
    date: Date
  }],
  
  // Datos del trigger original
  triggerData: mongoose.Schema.Types.Mixed
  
}, {
  timestamps: true
});

// Índices importantes
flowExecutionSchema.index({ flow: 1, customer: 1 });
flowExecutionSchema.index({ status: 1, resumeAt: 1 });

module.exports = mongoose.model('FlowExecution', flowExecutionSchema);