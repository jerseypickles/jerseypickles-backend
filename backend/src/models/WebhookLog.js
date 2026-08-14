// backend/src/models/WebhookLog.js
// 📡 Webhook Log Model - Track all incoming webhooks for debugging
const mongoose = require('mongoose');

const webhookLogSchema = new mongoose.Schema({
  // Webhook identification
  topic: {
    type: String,
    required: true,
    index: true
    // e.g., 'customers/create', 'checkouts/create', 'orders/create', 'carts/update', 'resend/email.delivered'
  },
  
  source: {
    type: String,
    enum: ['shopify', 'klaviyo', 'resend', 'manual', 'test', 'other'],
    default: 'shopify'
  },
  
  // Processing status
  status: {
    type: String,
    enum: ['received', 'processing', 'processed', 'failed', 'ignored'],
    default: 'received',
    index: true
  },
  
  // Shopify IDs for quick lookup
  shopifyId: {
    type: String,
    index: true
    // Customer ID, Order ID, Checkout ID, etc.
  },
  
  // Email for customer-related webhooks
  email: {
    type: String,
    index: true
  },
  
  // The raw payload received.
  // Solo se persiste cuando el webhook FALLA (ver logWebhook/markFailed).
  // En los que salen bien no aporta nada: el 99.5% termina en 'processed',
  // y para los topics orders/* el mismo objeto ya se guarda en
  // Order.shopifyData. Guardarlo siempre hacía crecer esta colección
  // ~107 MB/día (llegó a 19.3 GB = 71% de toda la base).
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },
  
  // Headers received (for debugging)
  headers: {
    shopifyTopic: String,
    shopifyHmac: String,
    shopifyShopDomain: String,
    shopifyApiVersion: String,
    shopifyWebhookId: String
  },
  
  // Processing details
  processing: {
    startedAt: Date,
    completedAt: Date,
    duration: Number, // milliseconds
    
    // What actions were triggered
    actionsTriggered: [{
      type: { type: String }, // 'flow_triggered', 'customer_created', 'email_sent', etc.
      details: mongoose.Schema.Types.Mixed,
      success: Boolean,
      error: String
    }],
    
    // Flows that were triggered
    flowsTriggered: [{
      flowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Flow' },
      flowName: String,
      executionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FlowExecution' }
    }]
  },
  
  // Error tracking
  error: {
    message: String,
    stack: String,
    code: String
  },
  
  // Request metadata
  metadata: {
    ip: String,
    userAgent: String,
    contentLength: Number,
    receivedAt: { type: Date, default: Date.now }
  },
  
  // For abandoned cart tracking
  cartDetails: {
    token: String,
    totalPrice: Number,
    itemCount: Number,
    customerEmail: String,
    abandonedAt: Date,
    recoveredAt: Date,
    isRecovered: { type: Boolean, default: false }
  }
  
}, {
  timestamps: true
});

// Indexes for efficient querying
webhookLogSchema.index({ createdAt: -1 });
webhookLogSchema.index({ topic: 1, createdAt: -1 });
webhookLogSchema.index({ status: 1, createdAt: -1 });
webhookLogSchema.index({ 'cartDetails.token': 1 });

// Static method to log a webhook
webhookLogSchema.statics.logWebhook = async function(data) {
  const log = new this({
    topic: data.topic,
    source: data.source || 'shopify',
    // Arrancamos ya en 'processing': markProcessing() ya no escribe.
    status: 'processing',
    shopifyId: data.shopifyId,
    email: data.email,
    // payload: NO se persiste de entrada. Se guarda solo si falla.
    headers: data.headers,
    metadata: data.metadata,
    cartDetails: data.cartDetails,
    processing: { startedAt: new Date() }
  });

  // El payload viaja en memoria por si markFailed() lo necesita.
  // No enumerable para que no lo agarre toObject()/JSON.stringify.
  Object.defineProperty(log, '_rawPayload', {
    value: data.payload,
    enumerable: false,
    writable: true,
    configurable: true
  });

  await log.save();
  return log;
};

// Method to mark as processing
// Antes hacía un save() aquí: una escritura entera por webhook solo para
// dejar el estado 'processing' durante los ~180 ms que dura el proceso.
// Nadie consulta ese estado intermedio, así que ahora solo toca memoria —
// logWebhook() ya arranca el registro en 'processing'. Se mantiene el método
// (lo llaman 14 sitios) para no tocar los controladores.
webhookLogSchema.methods.markProcessing = async function() {
  this.status = 'processing';
  this.processing = this.processing || {};
  this.processing.startedAt = this.processing.startedAt || new Date();
};

// Method to mark as processed
webhookLogSchema.methods.markProcessed = async function(actions = [], flows = []) {
  this.status = 'processed';
  this.processing = this.processing || {};
  this.processing.completedAt = new Date();
  this.processing.duration = this.processing.startedAt 
    ? new Date() - this.processing.startedAt 
    : 0;
  this.processing.actionsTriggered = actions;
  this.processing.flowsTriggered = flows;
  await this.save();
};

// Method to mark as failed
webhookLogSchema.methods.markFailed = async function(error) {
  this.status = 'failed';
  // Aquí SÍ guardamos el payload: es el único caso donde sirve para depurar.
  if (this._rawPayload !== undefined && this.payload === undefined) {
    this.payload = this._rawPayload;
  }
  this.error = {
    message: error.message,
    stack: error.stack,
    code: error.code
  };
  this.processing = this.processing || {};
  this.processing.completedAt = new Date();
  await this.save();
};

// Static method to get recent webhooks
webhookLogSchema.statics.getRecent = async function(options = {}) {
  const {
    limit = 50,
    topic = null,
    status = null,
    since = null
  } = options;
  
  const query = {};
  
  if (topic) query.topic = topic;
  if (status) query.status = status;
  if (since) query.createdAt = { $gte: since };
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// Static method to get webhook stats
webhookLogSchema.statics.getStats = async function(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  const stats = await this.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: {
          topic: '$topic',
          status: '$status'
        },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.topic',
        total: { $sum: '$count' },
        statuses: {
          $push: {
            status: '$_id.status',
            count: '$count'
          }
        }
      }
    },
    { $sort: { total: -1 } }
  ]);
  
  return stats;
};

module.exports = mongoose.model('WebhookLog', webhookLogSchema);