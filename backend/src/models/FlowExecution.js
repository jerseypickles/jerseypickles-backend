// backend/src/models/FlowExecution.js (ACTUALIZADO - CON COPIA DE STEPS)
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
  
  // ✅ NUEVO: Copia de los steps del flow al momento de iniciar
  // Esto evita que cambios en el flow afecten ejecuciones en progreso
  steps: [{
    type: {
      type: String,
      enum: ['send_email', 'wait', 'condition', 'add_tag', 'create_discount']
    },
    config: mongoose.Schema.Types.Mixed,
    order: Number
  }],
  
  // Estado actual
  status: {
    type: String,
    enum: ['active', 'waiting', 'completed', 'failed', 'cancelled'],
    default: 'active'
  },
  
  currentStep: { type: Number, default: 0 },
  
  // Para delays
  resumeAt: Date,
  
  // Log de ejecución
  stepResults: [{
    stepIndex: Number,
    stepType: String,
    executedAt: Date,
    result: mongoose.Schema.Types.Mixed,
    error: String,
    duration: Number // ms que tomó ejecutar
  }],
  
  // ✅ NUEVO: Tracking de emails enviados en esta ejecución
  emailsSent: [{
    resendId: String,
    subject: String,
    sentAt: Date,
    opened: { type: Boolean, default: false },
    openedAt: Date,
    clicked: { type: Boolean, default: false },
    clickedAt: Date
  }],
  
  // Revenue attribution
  attributedOrders: [{
    orderId: mongoose.Schema.Types.ObjectId,
    shopifyOrderId: String,
    amount: Number,
    date: Date
  }],
  
  attributedRevenue: { type: Number, default: 0 },
  
  // Datos del trigger original
  triggerData: mongoose.Schema.Types.Mixed,
  
  // Timestamps
  startedAt: { type: Date, default: Date.now },
  completedAt: Date,
  
  // ✅ NUEVO: Metadata para debugging
  metadata: {
    flowVersion: Number, // Versión del flow cuando se inició
    source: String,      // 'webhook', 'manual', 'test'
    testMode: { type: Boolean, default: false }
  }
  
}, {
  timestamps: true
});

// Índices importantes
flowExecutionSchema.index({ flow: 1, customer: 1 });
flowExecutionSchema.index({ status: 1, resumeAt: 1 });
flowExecutionSchema.index({ flow: 1, status: 1 });
flowExecutionSchema.index({ customer: 1, status: 1 });

// ✅ Método para obtener el step actual
flowExecutionSchema.methods.getCurrentStep = function() {
  return this.steps[this.currentStep] || null;
};

// ✅ Método para insertar steps (para branches de conditions)
flowExecutionSchema.methods.insertStepsAfterCurrent = function(newSteps) {
  const insertIndex = this.currentStep + 1;
  this.steps.splice(insertIndex, 0, ...newSteps);
  // Re-ordenar
  this.steps.forEach((step, i) => {
    step.order = i;
  });
};

// ✅ Virtual para calcular duración total
flowExecutionSchema.virtual('totalDuration').get(function() {
  if (!this.completedAt) return null;
  return this.completedAt - this.startedAt;
});

module.exports = mongoose.model('FlowExecution', flowExecutionSchema);