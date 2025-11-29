// backend/src/models/EmailSend.js - VERSIÓN COMPLETA CON BATCH OPS
const mongoose = require('mongoose');

/**
 * EmailSend Model - Tracking individual de cada email enviado
 * 
 * PROPÓSITO: Prevenir duplicados con idempotencia a nivel de BD
 * 
 * ÍNDICES ÚNICOS:
 * 1. jobId - Previene que el mismo job se procese dos veces
 * 2. campaignId + recipientEmail - Previene enviar dos veces al mismo destinatario
 */

const emailSendSchema = new mongoose.Schema({
  // ========== IDENTIFICADORES ÚNICOS ==========
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    description: 'Hash determinístico: SHA256(campaignId:email)'
  },
  
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true,
    index: true
  },
  
  recipientEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    index: true
  },
  
  // ========== ESTADO DEL ENVÍO ==========
  status: {
    type: String,
    enum: ['pending', 'processing', 'sending', 'sent', 'delivered', 'failed', 'bounced', 'skipped'],
    default: 'pending',
    index: true,
    description: `
      pending     - Creado, esperando procesamiento
      processing  - Worker lo reclamó
      sending     - Llamando a Resend API
      sent        - Resend aceptó el email
      delivered   - Webhook confirmó entrega
      failed      - Error permanente
      bounced     - Email rebotó
      skipped     - Saltado (bounced/unsubscribed/complained)
    `
  },
  
  // ========== LOCKING PARA ATOMIC OPERATIONS ==========
  lockedBy: {
    type: String,
    default: null,
    description: 'ID del worker que está procesando (worker-PID-jobId)'
  },
  
  lockedAt: {
    type: Date,
    default: null,
    index: true,
    description: 'Timestamp cuando fue bloqueado por un worker'
  },
  
  // ========== TRACKING DE ENVÍO ==========
  sentAt: {
    type: Date,
    default: null
  },
  
  deliveredAt: {
    type: Date,
    default: null
  },
  
  skippedAt: {
    type: Date,
    default: null
  },
  
  // ID del email en Resend para tracking
  externalMessageId: {
    type: String,
    default: null,
    index: true,
    description: 'ID de Resend para tracking de webhooks'
  },
  
  // ========== RETRY LOGIC ==========
  attempts: {
    type: Number,
    default: 0,
    description: 'Número de intentos de envío'
  },
  
  maxAttempts: {
    type: Number,
    default: 3
  },
  
  lastError: {
    type: String,
    default: null
  },
  
  lastAttemptAt: {
    type: Date,
    default: null
  },
  
  // ========== OPTIMISTIC LOCKING ==========
  version: {
    type: Number,
    default: 0,
    description: 'Para detectar conflictos de concurrencia'
  },
  
  // ========== METADATA ==========
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  }
  
}, {
  timestamps: true,
  collection: 'email_sends'
});

// ========== ÍNDICES COMPUESTOS ==========

// CRÍTICO: Previene enviar el mismo email dos veces a la misma persona en la misma campaña
emailSendSchema.index(
  { campaignId: 1, recipientEmail: 1 }, 
  { 
    unique: true,
    name: 'campaign_recipient_unique'
  }
);

// Para queries de recuperación de locks expirados
emailSendSchema.index(
  { status: 1, lockedAt: 1 },
  { name: 'status_locked_recovery' }
);

// Para queries por campaña y estado
emailSendSchema.index(
  { campaignId: 1, status: 1 },
  { name: 'campaign_status_lookup' }
);

// ========== MÉTODOS DE INSTANCIA ==========

/**
 * Verificar si el lock está expirado (más de 5 minutos)
 */
emailSendSchema.methods.isLockExpired = function() {
  if (!this.lockedAt) return true;
  const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
  return Date.now() - this.lockedAt.getTime() > LOCK_TIMEOUT_MS;
};

/**
 * Verificar si puede reintentar
 */
emailSendSchema.methods.canRetry = function() {
  return this.attempts < this.maxAttempts;
};

// ========== MÉTODOS ESTÁTICOS ==========

/**
 * ✅ NUEVO: Batch Create/Update optimizado para campañas
 * 
 * Crea EmailSend records en batch usando bulkWrite
 * Pre-valida duplicados para evitar errores
 * 
 * @param {Array} recipients - Array de { jobId, campaignId, recipientEmail, customerId }
 * @returns {Object} { created, duplicates, errors }
 */
emailSendSchema.statics.bulkCreateOrUpdate = async function(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('recipients debe ser un array no vacío');
  }

  const results = {
    created: 0,
    duplicates: 0,
    errors: 0,
    details: []
  };

  // ========== PASO 1: PRE-VALIDACIÓN EN MEMORIA ==========
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validRecipients = [];
  const seenJobIds = new Set();
  const seenEmailKeys = new Set();

  for (const recipient of recipients) {
    // Validar campos requeridos
    if (!recipient.jobId || !recipient.campaignId || !recipient.recipientEmail) {
      results.errors++;
      results.details.push({
        email: recipient.recipientEmail,
        error: 'Missing required fields',
        type: 'validation'
      });
      continue;
    }

    // Validar formato de email
    if (!emailRegex.test(recipient.recipientEmail)) {
      results.errors++;
      results.details.push({
        email: recipient.recipientEmail,
        error: 'Invalid email format',
        type: 'validation'
      });
      continue;
    }

    // Deduplicar en memoria (mismo jobId)
    if (seenJobIds.has(recipient.jobId)) {
      results.duplicates++;
      results.details.push({
        email: recipient.recipientEmail,
        jobId: recipient.jobId,
        type: 'duplicate_jobId'
      });
      continue;
    }

    // Deduplicar por email+campaña
    const emailKey = `${recipient.campaignId}:${recipient.recipientEmail.toLowerCase().trim()}`;
    if (seenEmailKeys.has(emailKey)) {
      results.duplicates++;
      results.details.push({
        email: recipient.recipientEmail,
        type: 'duplicate_email_campaign'
      });
      continue;
    }

    seenJobIds.add(recipient.jobId);
    seenEmailKeys.add(emailKey);
    validRecipients.push(recipient);
  }

  if (validRecipients.length === 0) {
    return results;
  }

  // ========== PASO 2: BULK WRITE A MONGODB ==========
  const bulkOps = validRecipients.map(recipient => ({
    updateOne: {
      filter: {
        campaignId: recipient.campaignId,
        recipientEmail: recipient.recipientEmail.toLowerCase().trim()
      },
      update: {
        $setOnInsert: {
          jobId: recipient.jobId,
          campaignId: recipient.campaignId,
          recipientEmail: recipient.recipientEmail.toLowerCase().trim(),
          customerId: recipient.customerId || null,
          status: 'pending',
          attempts: 0,
          createdAt: new Date()
        }
      },
      upsert: true
    }
  }));

  try {
    const bulkResult = await this.bulkWrite(bulkOps, {
      ordered: false // Continuar aunque haya errores
    });

    results.created = bulkResult.upsertedCount || 0;

    // Los que no fueron insertados son duplicados en BD
    const notInserted = validRecipients.length - results.created;
    if (notInserted > 0) {
      results.duplicates += notInserted;
    }

  } catch (error) {
    // Manejar errores de duplicados (código 11000)
    if (error.code === 11000 || error.name === 'BulkWriteError') {
      // Algunos se insertaron, otros fallaron por duplicados
      const writeErrors = error.writeErrors || [];
      results.errors += writeErrors.filter(e => e.code !== 11000).length;
      results.duplicates += writeErrors.filter(e => e.code === 11000).length;
    } else {
      throw error;
    }
  }

  return results;
};

/**
 * Atomic claim de un email para procesar
 * Previene que dos workers procesen el mismo email
 */
emailSendSchema.statics.claimForProcessing = async function(jobId, workerId) {
  const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
  const lockTimeout = new Date(Date.now() - LOCK_TIMEOUT_MS);
  
  const claimed = await this.findOneAndUpdate(
    {
      jobId,
      $or: [
        { status: 'pending' },
        { status: 'processing', lockedAt: { $lt: lockTimeout } }, // Recuperar locks expirados
        { status: 'failed', attempts: { $lt: 3 } } // Reintentar fallos
      ]
    },
    {
      $set: {
        status: 'processing',
        lockedBy: workerId,
        lockedAt: new Date(),
        lastAttemptAt: new Date()
      },
      $inc: {
        version: 1,
        attempts: 1
      }
    },
    {
      new: true,
      runValidators: true
    }
  );
  
  return claimed;
};

/**
 * Marcar como enviado exitosamente
 */
emailSendSchema.statics.markAsSent = async function(jobId, workerId, externalMessageId) {
  return await this.findOneAndUpdate(
    {
      jobId,
      lockedBy: workerId,
      status: { $in: ['processing', 'sending'] }
    },
    {
      $set: {
        status: 'sent',
        sentAt: new Date(),
        externalMessageId,
        lockedBy: null,
        lockedAt: null,
        lastError: null
      },
      $inc: { version: 1 }
    },
    { new: true }
  );
};

/**
 * Marcar como fallido
 */
emailSendSchema.statics.markAsFailed = async function(jobId, workerId, errorMessage) {
  const emailSend = await this.findOne({ jobId, lockedBy: workerId });
  
  if (!emailSend) return null;
  
  const finalStatus = emailSend.attempts >= emailSend.maxAttempts ? 'failed' : 'pending';
  
  return await this.findOneAndUpdate(
    {
      jobId,
      lockedBy: workerId
    },
    {
      $set: {
        status: finalStatus,
        lastError: errorMessage,
        lockedBy: null,
        lockedAt: null
      },
      $inc: { version: 1 }
    },
    { new: true }
  );
};

/**
 * Recuperar locks expirados
 */
emailSendSchema.statics.recoverExpiredLocks = async function() {
  const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
  const lockTimeout = new Date(Date.now() - LOCK_TIMEOUT_MS);
  
  const result = await this.updateMany(
    {
      status: 'processing',
      lockedAt: { $lt: lockTimeout }
    },
    {
      $set: {
        status: 'pending',
        lockedBy: null,
        lockedAt: null
      }
    }
  );
  
  return result.modifiedCount;
};

/**
 * Obtener stats por campaña
 */
emailSendSchema.statics.getCampaignStats = async function(campaignId) {
  const pipeline = [
    { $match: { campaignId: new mongoose.Types.ObjectId(campaignId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ];
  
  const results = await this.aggregate(pipeline);
  
  const stats = {
    total: 0,
    pending: 0,
    processing: 0,
    sending: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    bounced: 0,
    skipped: 0
  };
  
  results.forEach(r => {
    stats[r._id] = r.count;
    stats.total += r.count;
  });
  
  return stats;
};

// ========== MIDDLEWARE ==========

// Antes de guardar, validar email
emailSendSchema.pre('save', function(next) {
  // Validar formato básico de email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(this.recipientEmail)) {
    return next(new Error(`Email inválido: ${this.recipientEmail}`));
  }
  next();
});

// ========== VIRTUAL FIELDS ==========

emailSendSchema.virtual('isStale').get(function() {
  return this.isLockExpired();
});

emailSendSchema.virtual('canRetryNow').get(function() {
  return this.canRetry() && this.status === 'pending';
});

const EmailSend = mongoose.model('EmailSend', emailSendSchema);

module.exports = EmailSend;