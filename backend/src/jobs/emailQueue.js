// backend/src/jobs/emailQueue.js - PRODUCCIÓN 100K+ (VERSIÓN ESTABLE)
const { Queue, Worker } = require('bullmq');
const crypto = require('crypto');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailSend = require('../models/EmailSend');
const EmailEvent = require('../models/EmailEvent');

let emailQueue;
let emailWorker;
let isQueueReady = false;
let isShuttingDown = false;

// ========== CONFIGURACIÓN DE RESEND (MODO ESTABLE) ==========
const RESEND_CONFIG = {
  BATCH_SIZE: 100,
  RATE_LIMIT_PER_SECOND: 8,  // 80% del límite de 10 (margen de seguridad 20%)
  CONCURRENCY: 2,             // Reducido para estabilidad
  MAX_RETRIES: 3,
  LOCK_DURATION: 300000       // 5 minutos
};

console.log('\n╔════════════════════════════════════════════════╗');
console.log('║  📊 CONFIGURACIÓN EMAIL QUEUE (ESTABLE)        ║');
console.log('╚════════════════════════════════════════════════╝');
console.log(`   Batch size: ${RESEND_CONFIG.BATCH_SIZE} emails`);
console.log(`   Rate limit: ${RESEND_CONFIG.RATE_LIMIT_PER_SECOND} req/s (80% capacidad)`);
console.log(`   Concurrency: ${RESEND_CONFIG.CONCURRENCY} workers`);
console.log(`   Velocidad máxima: ~${RESEND_CONFIG.BATCH_SIZE * RESEND_CONFIG.RATE_LIMIT_PER_SECOND} emails/s`);
console.log(`   Margen de seguridad: 20%`);
console.log(`   Modo: ESTABLE (prioridad: reliability > speed)`);
console.log('════════════════════════════════════════════════\n');

// ========== GENERACIÓN DE JOB IDs DETERMINÍSTICOS ==========

/**
 * Genera un jobId determinístico a partir de campaignId y email
 * El mismo input SIEMPRE genera el mismo ID = previene duplicados
 * 
 * @param {string} campaignId - ID de la campaña
 * @param {string} email - Email del destinatario
 * @returns {string} Hash SHA256 de 24 caracteres
 */
function generateJobId(campaignId, email) {
  // Normalizar email: lowercase y trim
  const normalized = `${campaignId}:${email.toLowerCase().trim()}`;
  
  // Generar hash SHA256 y tomar primeros 24 caracteres
  const hash = crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 24);
  
  return `email_${hash}`;
}

/**
 * Genera un jobId único para un batch (chunk de emails)
 * 
 * @param {string} campaignId - ID de la campaña
 * @param {number} chunkIndex - Índice del chunk
 * @returns {string} ID único del batch
 */
function generateBatchJobId(campaignId, chunkIndex) {
  return `batch_${campaignId}_${chunkIndex}`;
}

// ========== INICIALIZACIÓN DE QUEUE Y WORKER ==========

async function initializeQueue() {
  try {
    const redisUrl = process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.warn('⚠️  REDIS_URL no configurado - Queue no disponible');
      console.warn('    Para envíos masivos, configura REDIS_URL con Upstash Redis\n');
      return null;
    }

    console.log('🔄 Inicializando BullMQ con Upstash Redis...\n');
    
    const url = new URL(redisUrl);
    
    // ✅ UPSTASH REDIS CONNECTION - Queue (Producer)
    const queueConnection = {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: 3,        // Fast-fail para producers
      enableReadyCheck: false,
      enableOfflineQueue: false,      // No encolar si Redis está caído
      connectTimeout: 30000,
      keepAlive: 10000
    };
    
    // ✅ UPSTASH REDIS CONNECTION - Worker (Consumer)
    // CRÍTICO: maxRetriesPerRequest DEBE ser null
    const workerConnection = {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,     // ← REQUERIDO para BullMQ workers
      enableReadyCheck: false,
      enableOfflineQueue: true,       // Workers deben ser resilientes
      connectTimeout: 30000,
      keepAlive: 10000
    };
    
    // ✅ CREAR QUEUE
    emailQueue = new Queue('email-campaign', {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: RESEND_CONFIG.MAX_RETRIES,
        backoff: {
          type: 'exponential',
          delay: 2000  // 2s, 4s, 8s
        },
        // CRÍTICO: NO usar removeOnComplete: true (rompe deduplicación)
        removeOnComplete: {
          age: 3600,   // Mantener 1 hora
          count: 1000  // Últimos 1000 jobs
        },
        removeOnFail: {
          age: 86400   // Mantener fallos 24h
        }
      }
    });
    
    // ✅ CREAR WORKER con procesamiento por batch
    emailWorker = new Worker(
      'email-campaign',
      async (job) => await processEmailBatch(job),
      {
        connection: workerConnection,
        concurrency: RESEND_CONFIG.CONCURRENCY,
        limiter: {
          max: RESEND_CONFIG.RATE_LIMIT_PER_SECOND,
          duration: 1000  // Por segundo
        },
        lockDuration: RESEND_CONFIG.LOCK_DURATION,
        stalledInterval: 60000,    // Verificar jobs estancados cada 1min
        maxStalledCount: 2,        // Máximo 2 reintentos por estancamiento
        autorun: true
      }
    );
    
    // ========== EVENT LISTENERS ==========
    
    emailWorker.on('ready', () => {
      console.log('✅ Worker listo y escuchando jobs\n');
    });
    
    emailWorker.on('completed', async (job, result) => {
      const throughput = result.sent > 0 
        ? ((result.sent / ((Date.now() - (job.timestamp || Date.now())) / 1000)) || 0).toFixed(1)
        : '0.0';
      
      console.log(`✅ [Batch ${result.chunkIndex}] Completado: ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed (${throughput} emails/s)`);
      
      if (result.campaignId) {
        // Verificar si la campaña terminó después de cada batch
        setTimeout(() => {
          checkAndFinalizeCampaign(result.campaignId).catch(err => {
            console.error('Error verificando finalización:', err.message);
          });
        }, 2000);
      }
    });
    
    emailWorker.on('failed', (job, err) => {
      console.error(`❌ [Batch ${job?.data?.chunkIndex || 'unknown'}] Job falló: ${err.message}`);
      
      if (job?.data?.campaignId) {
        // También verificar tras fallos por si fue el último batch
        setTimeout(() => {
          checkAndFinalizeCampaign(job.data.campaignId).catch(e => {
            console.error('Error verificando tras fallo:', e.message);
          });
        }, 3000);
      }
    });
    
    emailWorker.on('error', (err) => {
      console.error('❌ Worker error crítico:', err.message);
    });
    
    emailWorker.on('stalled', (jobId) => {
      console.warn(`⚠️  Job ${jobId} estancado - será recuperado`);
    });
    
    isQueueReady = true;
    
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║  ✅ BullMQ INICIALIZADO CORRECTAMENTE         ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log(`   Rate Limit: ${RESEND_CONFIG.RATE_LIMIT_PER_SECOND} req/s`);
    console.log(`   Concurrency: ${RESEND_CONFIG.CONCURRENCY} workers`);
    console.log(`   Batch Size: ${RESEND_CONFIG.BATCH_SIZE} emails`);
    console.log(`   Modo: ESTABLE`);
    console.log('═══════════════════════════════════════════════\n');
    
    // Recuperar locks expirados al iniciar
    try {
      const recovered = await EmailSend.recoverExpiredLocks();
      if (recovered > 0) {
        console.log(`🔄 Recuperados ${recovered} locks expirados\n`);
      }
    } catch (err) {
      console.error('Error recuperando locks:', err.message);
    }
    
    return emailQueue;
    
  } catch (error) {
    console.error('❌ Error inicializando queue:', error.message);
    emailQueue = null;
    emailWorker = null;
    isQueueReady = false;
    return null;
  }
}

// ========== PROCESAMIENTO DE BATCH ==========

/**
 * Procesa un batch de emails con logging detallado
 * ✅ AHORA CON FILTRADO AUTOMÁTICO DE BOUNCED EMAILS
 */
async function processEmailBatch(job) {
  const { campaignId, recipients, chunkIndex } = job.data;
  const workerId = `worker-${process.pid}-${Date.now()}`;
  const startTime = Date.now();
  
  // Logging detallado de inicio
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  📦 BATCH ${String(chunkIndex).padStart(3, '0')} - ${recipients.length} emails${' '.repeat(17)}║`);
  console.log(`╚════════════════════════════════════════════╝`);
  console.log(`   Campaign: ${campaignId}`);
  console.log(`   Worker: ${workerId}`);
  console.log(`   Started: ${new Date().toISOString()}`);
  console.log(`   Mode: STABLE + BOUNCE FILTER`);
  
  const results = {
    campaignId,
    chunkIndex,
    sent: 0,
    skipped: 0,
    skippedBounced: 0,    // ✅ NUEVO: contador de bounced
    skippedComplained: 0, // ✅ NUEVO: contador de complained
    skippedUnsubscribed: 0, // ✅ NUEVO: contador de unsubscribed
    failed: 0,
    errors: []
  };
  
  // ✅ NUEVO: Cargar Customer model una sola vez
  const Customer = require('../models/Customer');
  
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    
    // Generar jobId con email normalizado
    const jobId = generateJobId(campaignId, recipient.email);
    
    // DEBUG: Solo primer email de cada batch
    if (i === 0) {
      console.log(`\n   🔍 Verificación primer email:`);
      console.log(`      Email: "${recipient.email}"`);
      console.log(`      JobId: ${jobId}`);
    }
    
    try {
      // ========== ✅ NUEVO: VERIFICAR SI EMAIL ESTÁ BOUNCED/COMPLAINED/UNSUBSCRIBED ==========
      const customer = await Customer.findOne({ 
        email: recipient.email.toLowerCase().trim() 
      }).select('emailStatus bounceInfo email').lean();
      
      if (customer) {
        // Verificar si está bounced
        if (customer.emailStatus === 'bounced' || customer.bounceInfo?.isBounced === true) {
          
          if (i === 0 || results.skippedBounced < 3) {
            console.log(`   ⏭️  SKIPPED (bounced): ${recipient.email}`);
          }
          
          results.skippedBounced++;
          results.skipped++;
          
          // Marcar en EmailSend como skipped
          await EmailSend.findOneAndUpdate(
            { jobId },
            { 
              $set: {
                status: 'skipped',
                lastError: `Email is bounced (${customer.bounceInfo?.bounceType || 'unknown'}) - not sending`,
                skippedAt: new Date()
              }
            },
            { upsert: true }
          );
          
          continue; // ← NO enviar este email
        }
        
        // Verificar si está complained (spam report)
        if (customer.emailStatus === 'complained') {
          
          if (i === 0 || results.skippedComplained < 3) {
            console.log(`   ⏭️  SKIPPED (complained): ${recipient.email}`);
          }
          
          results.skippedComplained++;
          results.skipped++;
          
          await EmailSend.findOneAndUpdate(
            { jobId },
            { 
              $set: {
                status: 'skipped',
                lastError: 'Email has complained (spam report) - not sending',
                skippedAt: new Date()
              }
            },
            { upsert: true }
          );
          
          continue;
        }
        
        // Verificar si está unsubscribed
        if (customer.emailStatus === 'unsubscribed') {
          
          if (i === 0 || results.skippedUnsubscribed < 3) {
            console.log(`   ⏭️  SKIPPED (unsubscribed): ${recipient.email}`);
          }
          
          results.skippedUnsubscribed++;
          results.skipped++;
          
          await EmailSend.findOneAndUpdate(
            { jobId },
            { 
              $set: {
                status: 'skipped',
                lastError: 'Email is unsubscribed - not sending',
                skippedAt: new Date()
              }
            },
            { upsert: true }
          );
          
          continue;
        }
      }
      
      // ========== PASO 1: ATOMIC CLAIM ==========
      const claim = await EmailSend.claimForProcessing(jobId, workerId);
      
      if (!claim) {
        // Ya fue procesado o está siendo procesado
        results.skipped++;
        continue;
      }
      
      // Verificar si ya está sent (idempotencia doble)
      if (claim.status === 'sent' || claim.status === 'delivered') {
        results.skipped++;
        continue;
      }
      
      // ========== PASO 2: MARCAR COMO "SENDING" ==========
      await EmailSend.findOneAndUpdate(
        { jobId, lockedBy: workerId },
        { $set: { status: 'sending' } }
      );
      
      // ========== PASO 3: ENVIAR VÍA RESEND ==========
      const sendResult = await emailService.sendEmail({
        to: recipient.email,
        subject: recipient.subject,
        html: recipient.html,
        from: recipient.from,
        replyTo: recipient.replyTo,
        tags: [
          { name: 'campaign_id', value: campaignId },
          { name: 'customer_id', value: recipient.customerId || 'unknown' }
        ]
      });
      
      if (sendResult.success) {
        // ========== PASO 4: MARCAR COMO "SENT" ==========
        await EmailSend.markAsSent(jobId, workerId, sendResult.id);
        
        // Crear evento en EmailEvent para tracking
        await EmailEvent.create({
          campaign: campaignId,
          customer: recipient.customerId || null,
          email: recipient.email,
          eventType: 'sent',
          source: 'custom',
          resendId: sendResult.id
        });
        
        // SOLO incrementar 'sent' aquí (NO incrementar delivered)
        await Campaign.findByIdAndUpdate(campaignId, {
          $inc: { 'stats.sent': 1 }
        });
        
        results.sent++;
        
      } else {
        // Error enviando
        throw new Error(sendResult.error || 'Error desconocido enviando email');
      }
      
    } catch (error) {
      // ========== MANEJO DE ERRORES (sin cambios) ==========
      const errorType = classifyError(error);
      
      if (errorType === 'rate_limit') {
        console.warn(`\n   ⚠️  RATE LIMIT detectado en batch ${chunkIndex}`);
        console.warn(`      Esperando 60s antes de reintentar...`);
        
        await new Promise(resolve => setTimeout(resolve, 60000));
        
        await EmailSend.findOneAndUpdate(
          { jobId, lockedBy: workerId },
          {
            $set: {
              status: 'pending',
              lockedBy: null,
              lockedAt: null,
              lastError: 'Rate limit - will retry'
            },
            $inc: { attempts: 1 }
          }
        );
        
        console.warn(`      Reintentando después de espera...\n`);
        throw error;
        
      } else if (errorType === 'fatal') {
        await EmailSend.markAsFailed(jobId, workerId, error.message);
        
        await Campaign.findByIdAndUpdate(campaignId, {
          $inc: { 'stats.failed': 1 }
        });
        
        results.failed++;
        results.errors.push({ email: recipient.email, error: error.message });
        
        if (results.failed === 1) {
          console.error(`   ❌ Error fatal: ${error.message}`);
        }
        
      } else {
        await EmailSend.findOneAndUpdate(
          { jobId, lockedBy: workerId },
          {
            $set: {
              status: 'pending',
              lockedBy: null,
              lockedAt: null,
              lastError: error.message
            },
            $inc: { attempts: 1 }
          }
        );
        
        results.failed++;
        results.errors.push({ email: recipient.email, error: error.message });
      }
    }
    
    // Update progress cada 10 emails
    if (i % 10 === 0 && i > 0) {
      await job.updateProgress(Math.round((i / recipients.length) * 100));
    }
    
    // Log progreso cada 25 emails
    if (i > 0 && i % 25 === 0) {
      const partialDuration = ((Date.now() - startTime) / 1000).toFixed(1);
      const partialThroughput = (results.sent / partialDuration).toFixed(1);
      console.log(`   [${chunkIndex}] Progreso: ${i}/${recipients.length} | Sent: ${results.sent} | Skipped: ${results.skipped} | Throughput: ${partialThroughput}/s`);
    }
  }
  
  // ✅ LOGGING MEJORADO CON BOUNCE STATS
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const throughput = results.sent > 0 ? (results.sent / duration).toFixed(1) : '0.0';
  const successRate = ((results.sent / recipients.length) * 100).toFixed(1);
  
  console.log(`\n   ✅ Batch ${chunkIndex} completado:`);
  console.log(`      Sent: ${results.sent} | Skipped: ${results.skipped} | Failed: ${results.failed}`);
  
  // ✅ NUEVO: Desglose de skipped
  if (results.skippedBounced > 0 || results.skippedComplained > 0 || results.skippedUnsubscribed > 0) {
    console.log(`      Skipped details:`);
    if (results.skippedBounced > 0) {
      console.log(`        - Bounced: ${results.skippedBounced}`);
    }
    if (results.skippedComplained > 0) {
      console.log(`        - Complained: ${results.skippedComplained}`);
    }
    if (results.skippedUnsubscribed > 0) {
      console.log(`        - Unsubscribed: ${results.skippedUnsubscribed}`);
    }
  }
  
  console.log(`      Duration: ${duration}s | Throughput: ${throughput} emails/s`);
  console.log(`      Success rate: ${successRate}%`);
  
  if (results.errors.length > 0 && results.errors.length <= 5) {
    console.log(`      Errores: ${results.errors.length}`);
    results.errors.forEach(err => {
      console.log(`        - ${err.email}: ${err.error.substring(0, 50)}`);
    });
  } else if (results.errors.length > 5) {
    console.log(`      Errores: ${results.errors.length} (mostrando primeros 3)`);
    results.errors.slice(0, 3).forEach(err => {
      console.log(`        - ${err.email}: ${err.error.substring(0, 50)}`);
    });
  }
  
  console.log(`════════════════════════════════════════════\n`);
  
  return results;
}

/**
 * Clasifica el tipo de error para decidir estrategia de retry
 */
function classifyError(error) {
  const message = error.message || '';
  const statusCode = error.statusCode || error.status;
  
  // Rate limit
  if (statusCode === 429 || message.includes('rate_limit') || message.toLowerCase().includes('too many requests')) {
    return 'rate_limit';
  }
  
  // Errores fatales (no reintentar)
  if ([400, 401, 403, 404, 422].includes(statusCode)) {
    return 'fatal';
  }
  
  // Email inválido
  if (message.toLowerCase().includes('invalid email') || message.toLowerCase().includes('invalid recipient')) {
    return 'fatal';
  }
  
  // Errores temporales (reintentar)
  if (statusCode >= 500 || message.includes('timeout') || message.includes('ECONNREFUSED')) {
    return 'retry';
  }
  
  // Por defecto, reintentar
  return 'retry';
}

// ========== FUNCIÓN PARA AGREGAR CAMPAÑA A LA COLA ==========

/**
 * Agrega una campaña completa a la cola dividida en chunks
 * 
 * @param {Array} recipients - Array de recipientes con {email, subject, html, from, replyTo, customerId}
 * @param {string} campaignId - ID de la campaña
 * @returns {Object} Información sobre los jobs creados
 */
async function addCampaignToQueue(recipients, campaignId) {
  if (!emailQueue || !isQueueReady) {
    throw new Error('Redis queue no disponible. Verifica REDIS_URL.');
  }
  
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  📥 AGREGANDO CAMPAÑA A COLA (MODO ESTABLE)   ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`   Total recipients: ${recipients.length.toLocaleString()}`);
  console.log(`   Batch size: ${RESEND_CONFIG.BATCH_SIZE}`);
  
  // Dividir en chunks
  const chunks = [];
  for (let i = 0; i < recipients.length; i += RESEND_CONFIG.BATCH_SIZE) {
    chunks.push(recipients.slice(i, i + RESEND_CONFIG.BATCH_SIZE));
  }
  
  const estimatedSeconds = Math.ceil(recipients.length / (RESEND_CONFIG.BATCH_SIZE * RESEND_CONFIG.RATE_LIMIT_PER_SECOND));
  const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
  
  console.log(`   Total batches: ${chunks.length}`);
  console.log(`   Velocidad estimada: ${RESEND_CONFIG.BATCH_SIZE * RESEND_CONFIG.RATE_LIMIT_PER_SECOND} emails/s`);
  console.log(`   Tiempo estimado: ${estimatedMinutes > 1 ? estimatedMinutes + ' minutos' : estimatedSeconds + ' segundos'}`);
  console.log(`   Modo: STABLE (reliability > speed)`);
  console.log('════════════════════════════════════════════════\n');
  
  // Crear jobs para cada chunk
  const jobs = chunks.map((chunk, index) => ({
    name: 'process-batch',
    data: {
      campaignId,
      chunkIndex: index,
      recipients: chunk
    },
    opts: {
      jobId: generateBatchJobId(campaignId, index),  // ID determinístico
      priority: 1,
      attempts: RESEND_CONFIG.MAX_RETRIES,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    }
  }));
  
  // Agregar todos los jobs en bulk
  const addedJobs = await emailQueue.addBulk(jobs);
  
  console.log(`✅ ${chunks.length} batches encolados correctamente\n`);
  
  return {
    totalJobs: chunks.length,
    totalEmails: recipients.length,
    batchSize: RESEND_CONFIG.BATCH_SIZE,
    jobIds: addedJobs.map(j => j.id),
    estimatedSeconds
  };
}

// ========== VERIFICACIÓN Y FINALIZACIÓN DE CAMPAÑA ==========

async function checkAndFinalizeCampaign(campaignId) {
  try {
    const campaign = await Campaign.findById(campaignId);
    
    if (!campaign || campaign.status !== 'sending') {
      return false;
    }
    
    // Obtener stats reales desde EmailSend
    const emailSendStats = await EmailSend.getCampaignStats(campaignId);
    
    const totalProcessed = emailSendStats.sent + emailSendStats.delivered + emailSendStats.failed + emailSendStats.bounced;
    const totalRecipients = campaign.stats.totalRecipients;
    
    console.log(`🔍 Verificando campaña ${campaign.name}:`);
    console.log(`   Procesados: ${totalProcessed} / ${totalRecipients}`);
    console.log(`   Stats: sent=${emailSendStats.sent}, delivered=${emailSendStats.delivered}, failed=${emailSendStats.failed}`);
    
    // Verificar si terminó
    if (totalProcessed >= totalRecipients && totalRecipients > 0) {
      // Verificar que no haya jobs pendientes en la cola
      if (emailQueue && isQueueReady) {
        try {
          const counts = await emailQueue.getJobCounts('waiting', 'active', 'delayed');
          const pending = (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0);
          
          if (pending > 0) {
            console.log(`   ⏳ Hay ${pending} batches pendientes, esperando...\n`);
            return false;
          }
        } catch (error) {
          console.warn('   ⚠️  No se pudo verificar cola:', error.message);
        }
      }
      
      // ✅ CAMPAÑA TERMINADA
      campaign.status = 'sent';
      campaign.sentAt = campaign.sentAt || new Date();
      
      // Actualizar stats finales desde EmailSend
      campaign.stats.sent = emailSendStats.sent;
      campaign.stats.failed = emailSendStats.failed + emailSendStats.bounced;
      
      campaign.updateRates();
      await campaign.save();
      
      console.log('\n╔═══════════════════════════════════════════╗');
      console.log('║  🎉 CAMPAÑA COMPLETADA EXITOSAMENTE       ║');
      console.log('╚═══════════════════════════════════════════╝');
      console.log(`   Campaña: ${campaign.name}`);
      console.log(`   Total enviados: ${emailSendStats.sent.toLocaleString()}`);
      console.log(`   Total fallidos: ${(emailSendStats.failed + emailSendStats.bounced).toLocaleString()}`);
      console.log(`   Success rate: ${((emailSendStats.sent / totalRecipients) * 100).toFixed(1)}%`);
      console.log(`   Status: sent`);
      console.log(`   Completada: ${campaign.sentAt.toISOString()}`);
      console.log('═══════════════════════════════════════════\n');
      
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error('❌ Error verificando finalización:', error.message);
    return false;
  }
}

// ========== UTILIDADES DE QUEUE ==========

async function getQueueStatus() {
  if (!emailQueue || !isQueueReady) {
    return {
      available: false,
      error: 'Queue no inicializada'
    };
  }
  
  try {
    const counts = await emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    const paused = await emailQueue.isPaused();
    
    return {
      available: true,
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      paused,
      total: (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0),
      config: RESEND_CONFIG
    };
  } catch (error) {
    return {
      available: false,
      error: error.message
    };
  }
}

async function pauseQueue() {
  if (!emailQueue || !isQueueReady) {
    return { success: false, error: 'Queue no disponible' };
  }
  
  try {
    await emailQueue.pause();
    console.log('⏸️  Cola pausada');
    return { success: true, message: 'Queue pausada' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function resumeQueue() {
  if (!emailQueue || !isQueueReady) {
    return { success: false, error: 'Queue no disponible' };
  }
  
  try {
    await emailQueue.resume();
    console.log('▶️  Cola resumida');
    return { success: true, message: 'Queue resumida' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function cleanQueue() {
  if (!emailQueue || !isQueueReady) {
    return { success: false, error: 'Queue no disponible' };
  }
  
  try {
    await emailQueue.clean(0, 1000, 'completed');
    await emailQueue.clean(0, 1000, 'failed');
    
    console.log('🧹 Cola limpiada');
    return { success: true, message: 'Queue limpiada' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getActiveJobs() {
  if (!emailQueue || !isQueueReady) {
    return [];
  }
  
  try {
    return await emailQueue.getActive();
  } catch (error) {
    console.error('Error getting active jobs:', error);
    return [];
  }
}

async function getWaitingJobs() {
  if (!emailQueue || !isQueueReady) {
    return [];
  }
  
  try {
    return await emailQueue.getWaiting();
  } catch (error) {
    console.error('Error getting waiting jobs:', error);
    return [];
  }
}

async function checkAllSendingCampaigns() {
  try {
    console.log('🔍 Verificando todas las campañas en "sending"...');
    
    const sendingCampaigns = await Campaign.find({ status: 'sending' });
    
    console.log(`📊 Encontradas ${sendingCampaigns.length} campañas en "sending"`);
    
    const results = [];
    
    for (const campaign of sendingCampaigns) {
      const wasFinalized = await checkAndFinalizeCampaign(campaign._id);
      results.push({
        id: campaign._id,
        name: campaign.name,
        finalized: wasFinalized,
        sent: campaign.stats.sent,
        total: campaign.stats.totalRecipients
      });
    }
    
    return results;
    
  } catch (error) {
    console.error('Error verificando campañas:', error);
    throw error;
  }
}

// ========== GRACEFUL SHUTDOWN ==========

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`\n⚠️  Recibida señal ${signal}, cerrando gracefully...`);
  
  const timeout = setTimeout(() => {
    console.error('❌ Timeout en shutdown, forzando salida');
    process.exit(1);
  }, 30000); // 30 segundos
  
  try {
    if (emailWorker) {
      console.log('🔄 Cerrando worker (esperando jobs actuales)...');
      await emailWorker.close();
    }
    
    if (emailQueue) {
      console.log('🔄 Cerrando queue...');
      await emailQueue.close();
    }
    
    clearTimeout(timeout);
    console.log('✅ Shutdown completado\n');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error en shutdown:', error);
    process.exit(1);
  }
}

// Registrar handlers de shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ========== INICIALIZACIÓN ==========

initializeQueue().catch(err => {
  console.error('❌ Error fatal inicializando queue:', err);
  process.exit(1);
});

// ========== EXPORTS ==========

module.exports = {
  emailQueue,
  addCampaignToQueue,
  getQueueStatus,
  pauseQueue,
  resumeQueue,
  cleanQueue,
  getActiveJobs,
  getWaitingJobs,
  checkAndFinalizeCampaign,
  checkAllSendingCampaigns,
  isAvailable: () => emailQueue && isQueueReady,
  getConfig: () => RESEND_CONFIG,
  
  // ✅ Exportar para testing y uso en controller
  generateJobId,
  generateBatchJobId
};