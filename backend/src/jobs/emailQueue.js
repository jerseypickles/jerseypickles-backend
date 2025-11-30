// backend/src/jobs/emailQueue.js - ADAPTIVE + CIRCUIT BREAKER
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

// ========== CONFIGURACIÓN ADAPTATIVA ==========

/**
 * Obtiene configuración óptima según tamaño de campaña
 */
function getAdaptiveConfig(totalEmails = 0) {
  if (totalEmails < 5000) {
    return {
      name: 'FAST',
      BATCH_SIZE: 100,
      RATE_LIMIT_PER_SECOND: 10,
      CONCURRENCY: 3,
      description: 'Velocidad máxima para campañas pequeñas'
    };
  } else if (totalEmails < 50000) {
    return {
      name: 'BALANCED',
      BATCH_SIZE: 100,
      RATE_LIMIT_PER_SECOND: 8,
      CONCURRENCY: 2,
      description: 'Balance velocidad/estabilidad'
    };
  } else if (totalEmails < 200000) {
    return {
      name: 'STABLE',
      BATCH_SIZE: 75,
      RATE_LIMIT_PER_SECOND: 6,
      CONCURRENCY: 2,
      description: 'Prioridad estabilidad'
    };
  } else {
    return {
      name: 'ULTRA_STABLE',
      BATCH_SIZE: 50,
      RATE_LIMIT_PER_SECOND: 5,
      CONCURRENCY: 1,
      description: 'Máxima estabilidad para campañas masivas'
    };
  }
}

// Configuración por defecto (se actualiza dinámicamente)
let CURRENT_CONFIG = getAdaptiveConfig(0);

console.log('\n╔════════════════════════════════════════════════╗');
console.log('║  📊 EMAIL QUEUE - ADAPTIVE MODE                ║');
console.log('╚════════════════════════════════════════════════╝');
console.log('   Configuración dinámica según tamaño');
console.log('   Auto-ajuste: FAST → BALANCED → STABLE → ULTRA');
console.log('════════════════════════════════════════════════\n');

// ========== GENERACIÓN DE JOB IDs DETERMINÍSTICOS ==========

function generateJobId(campaignId, email) {
  const normalized = `${campaignId}:${email.toLowerCase().trim()}`;
  const hash = crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 24);
  
  return `email_${hash}`;
}

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
    
    const queueConnection = {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      connectTimeout: 30000,
      keepAlive: 10000
    };
    
    const workerConnection = {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      enableOfflineQueue: true,
      connectTimeout: 30000,
      keepAlive: 10000
    };
    
    emailQueue = new Queue('email-campaign', {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        removeOnComplete: {
          age: 3600,
          count: 1000
        },
        removeOnFail: {
          age: 86400
        }
      }
    });
    
    emailWorker = new Worker(
      'email-campaign',
      async (job) => await processEmailBatch(job),
      {
        connection: workerConnection,
        concurrency: CURRENT_CONFIG.CONCURRENCY,
        limiter: {
          max: CURRENT_CONFIG.RATE_LIMIT_PER_SECOND,
          duration: 1000
        },
        lockDuration: 300000,
        stalledInterval: 60000,
        maxStalledCount: 2,
        autorun: true
      }
    );
    
    // ========== EVENT LISTENERS ==========
    
    emailWorker.on('ready', () => {
      console.log('✅ Worker listo - Modo ADAPTIVE\n');
    });
    
    emailWorker.on('completed', async (job, result) => {
      const throughput = result.sent > 0 
        ? ((result.sent / ((Date.now() - (job.timestamp || Date.now())) / 1000)) || 0).toFixed(1)
        : '0.0';
      
      console.log(`✅ [Batch ${result.chunkIndex}] ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed (${throughput} emails/s)`);
      
      if (result.campaignId) {
        setTimeout(() => {
          checkAndFinalizeCampaign(result.campaignId).catch(err => {
            console.error('Error verificando finalización:', err.message);
          });
        }, 2000);
      }
    });
    
    emailWorker.on('failed', (job, err) => {
      console.error(`❌ [Batch ${job?.data?.chunkIndex || 'unknown'}] Falló: ${err.message}`);
      
      if (job?.data?.campaignId) {
        setTimeout(() => {
          checkAndFinalizeCampaign(job.data.campaignId).catch(e => {
            console.error('Error verificando tras fallo:', e.message);
          });
        }, 3000);
      }
    });
    
    emailWorker.on('error', (err) => {
      console.error('❌ Worker error:', err.message);
    });
    
    emailWorker.on('stalled', (jobId) => {
      console.warn(`⚠️  Job ${jobId} estancado - será recuperado`);
    });
    
    isQueueReady = true;
    
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║  ✅ BullMQ INICIALIZADO - ADAPTIVE MODE       ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log(`   Modo actual: ${CURRENT_CONFIG.name}`);
    console.log(`   Rate Limit: ${CURRENT_CONFIG.RATE_LIMIT_PER_SECOND} req/s`);
    console.log(`   Concurrency: ${CURRENT_CONFIG.CONCURRENCY} workers`);
    console.log(`   Batch Size: ${CURRENT_CONFIG.BATCH_SIZE} emails`);
    console.log('═══════════════════════════════════════════════\n');
    
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

async function processEmailBatch(job) {
  const { campaignId, recipients, chunkIndex } = job.data;
  const workerId = `worker-${process.pid}-${Date.now()}`;
  const startTime = Date.now();
  
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  📦 BATCH ${String(chunkIndex).padStart(3, '0')} - ${recipients.length} emails${' '.repeat(17)}║`);
  console.log(`╚════════════════════════════════════════════╝`);
  console.log(`   Campaign: ${campaignId}`);
  console.log(`   Worker: ${workerId}`);
  console.log(`   Mode: ${CURRENT_CONFIG.name}`);
  
  const results = {
    campaignId,
    chunkIndex,
    sent: 0,
    skipped: 0,
    skippedBounced: 0,
    skippedComplained: 0,
    skippedUnsubscribed: 0,
    failed: 0,
    errors: []
  };
  
  const Customer = require('../models/Customer');
  
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    const jobId = generateJobId(campaignId, recipient.email);
    
    if (i === 0) {
      console.log(`   🔍 Primer email: "${recipient.email}"`);
    }
    
    try {
      // Verificar bounce/complaint/unsubscribe
      const customer = await Customer.findOne({ 
        email: recipient.email.toLowerCase().trim() 
      }).select('emailStatus bounceInfo email').lean();
      
      if (customer) {
        if (customer.emailStatus === 'bounced' || customer.bounceInfo?.isBounced === true) {
          if (i === 0 || results.skippedBounced < 3) {
            console.log(`   ⏭️  SKIPPED (bounced): ${recipient.email}`);
          }
          results.skippedBounced++;
          results.skipped++;
          
          await EmailSend.findOneAndUpdate(
            { jobId },
            { 
              $set: {
                status: 'skipped',
                lastError: `Bounced (${customer.bounceInfo?.bounceType || 'unknown'})`,
                skippedAt: new Date()
              }
            },
            { upsert: true }
          );
          continue;
        }
        
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
                lastError: 'Complained (spam report)',
                skippedAt: new Date()
              }
            },
            { upsert: true }
          );
          continue;
        }
        
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
                lastError: 'Unsubscribed',
                skippedAt: new Date()
              }
            },
            { upsert: true }
          );
          continue;
        }
      }
      
      // Claim email
      const claim = await EmailSend.claimForProcessing(jobId, workerId);
      
      if (!claim) {
        results.skipped++;
        continue;
      }
      
      if (claim.status === 'sent' || claim.status === 'delivered') {
        results.skipped++;
        continue;
      }
      
      await EmailSend.findOneAndUpdate(
        { jobId, lockedBy: workerId },
        { $set: { status: 'sending' } }
      );
      
      // Enviar vía Resend
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
        await EmailSend.markAsSent(jobId, workerId, sendResult.id);
        
        await EmailEvent.create({
          campaign: campaignId,
          customer: recipient.customerId || null,
          email: recipient.email,
          eventType: 'sent',
          source: 'custom',
          resendId: sendResult.id
        });
        
        await Campaign.findByIdAndUpdate(campaignId, {
          $inc: { 'stats.sent': 1 }
        });
        
        results.sent++;
        
      } else {
        throw new Error(sendResult.error || 'Error desconocido');
      }
      
    } catch (error) {
      const errorType = classifyError(error);
      
      if (errorType === 'rate_limit') {
        console.warn(`\n   ⚠️  RATE LIMIT - esperando 60s...`);
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
        
        throw error;
        
      } else if (errorType === 'fatal') {
        await EmailSend.markAsFailed(jobId, workerId, error.message);
        
        await Campaign.findByIdAndUpdate(campaignId, {
          $inc: { 'stats.failed': 1 }
        });
        
        results.failed++;
        results.errors.push({ email: recipient.email, error: error.message });
        
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
    
    if (i % 10 === 0 && i > 0) {
      await job.updateProgress(Math.round((i / recipients.length) * 100));
    }
    
    if (i > 0 && i % 25 === 0) {
      const partialDuration = ((Date.now() - startTime) / 1000).toFixed(1);
      const partialThroughput = (results.sent / partialDuration).toFixed(1);
      console.log(`   [${chunkIndex}] ${i}/${recipients.length} | Sent: ${results.sent} | ${partialThroughput}/s`);
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const throughput = results.sent > 0 ? (results.sent / duration).toFixed(1) : '0.0';
  
  console.log(`\n   ✅ Batch ${chunkIndex} completado:`);
  console.log(`      Sent: ${results.sent} | Skipped: ${results.skipped} | Failed: ${results.failed}`);
  
  if (results.skippedBounced > 0 || results.skippedComplained > 0 || results.skippedUnsubscribed > 0) {
    console.log(`      Skip breakdown: bounced=${results.skippedBounced}, complained=${results.skippedComplained}, unsub=${results.skippedUnsubscribed}`);
  }
  
  console.log(`      ${duration}s | ${throughput} emails/s`);
  console.log(`════════════════════════════════════════════\n`);
  
  return results;
}

function classifyError(error) {
  const message = error.message || '';
  const statusCode = error.statusCode || error.status;
  
  if (statusCode === 429 || message.includes('rate_limit') || message.toLowerCase().includes('too many requests')) {
    return 'rate_limit';
  }
  
  if ([400, 401, 403, 404, 422].includes(statusCode)) {
    return 'fatal';
  }
  
  if (message.toLowerCase().includes('invalid email') || message.toLowerCase().includes('invalid recipient')) {
    return 'fatal';
  }
  
  if (statusCode >= 500 || message.includes('timeout') || message.includes('ECONNREFUSED')) {
    return 'retry';
  }
  
  return 'retry';
}

// ========== AGREGAR CAMPAÑA A COLA ==========

async function addCampaignToQueue(recipients, campaignId) {
  if (!emailQueue || !isQueueReady) {
    throw new Error('Redis queue no disponible');
  }
  
  // ✅ ADAPTIVE: Seleccionar config según tamaño
  const adaptiveConfig = getAdaptiveConfig(recipients.length);
  CURRENT_CONFIG = adaptiveConfig;
  
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  📥 ENCOLANDO CAMPAÑA - ADAPTIVE MODE          ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`   Total: ${recipients.length.toLocaleString()}`);
  console.log(`   Modo: ${adaptiveConfig.name}`);
  console.log(`   Batch: ${adaptiveConfig.BATCH_SIZE}`);
  console.log(`   ${adaptiveConfig.description}`);
  
  const chunks = [];
  for (let i = 0; i < recipients.length; i += adaptiveConfig.BATCH_SIZE) {
    chunks.push(recipients.slice(i, i + adaptiveConfig.BATCH_SIZE));
  }
  
  const estimatedSeconds = Math.ceil(recipients.length / (adaptiveConfig.BATCH_SIZE * adaptiveConfig.RATE_LIMIT_PER_SECOND));
  const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
  
  console.log(`   Batches: ${chunks.length}`);
  console.log(`   Velocidad: ~${adaptiveConfig.BATCH_SIZE * adaptiveConfig.RATE_LIMIT_PER_SECOND} emails/s`);
  console.log(`   Estimado: ${estimatedMinutes > 1 ? estimatedMinutes + 'min' : estimatedSeconds + 's'}`);
  console.log('════════════════════════════════════════════════\n');
  
  const jobs = chunks.map((chunk, index) => ({
    name: 'process-batch',
    data: {
      campaignId,
      chunkIndex: index,
      recipients: chunk
    },
    opts: {
      jobId: generateBatchJobId(campaignId, index),
      priority: 1,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    }
  }));
  
  const addedJobs = await emailQueue.addBulk(jobs);
  
  console.log(`✅ ${chunks.length} batches encolados\n`);
  
  return {
    totalJobs: chunks.length,
    totalEmails: recipients.length,
    batchSize: adaptiveConfig.BATCH_SIZE,
    mode: adaptiveConfig.name,
    jobIds: addedJobs.map(j => j.id),
    estimatedSeconds
  };
}

// ========== VERIFICACIÓN Y FINALIZACIÓN ==========

async function checkAndFinalizeCampaign(campaignId) {
  try {
    const campaign = await Campaign.findById(campaignId);
    
    if (!campaign || campaign.status !== 'sending') {
      return false;
    }
    
    const emailSendStats = await EmailSend.getCampaignStats(campaignId);
    
    // ✅ FIX: Incluir "skipped" en el total
    const totalProcessed = emailSendStats.sent + 
                           emailSendStats.delivered + 
                           emailSendStats.failed + 
                           emailSendStats.bounced +
                           emailSendStats.skipped;  // ← NUEVO
    
    const totalRecipients = campaign.stats.totalRecipients;
    
    console.log(`🔍 Verificando campaña ${campaign.name}:`);
    console.log(`   Procesados: ${totalProcessed} / ${totalRecipients}`);
    console.log(`   Stats: sent=${emailSendStats.sent}, skipped=${emailSendStats.skipped}, failed=${emailSendStats.failed}`);
    
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
          console.warn('   ⚠️  Error verificando cola:', error.message);
        }
      }
      
      // ✅ CAMPAÑA TERMINADA
      campaign.status = 'sent';
      campaign.sentAt = campaign.sentAt || new Date();
      
      // Actualizar stats finales
      campaign.stats.sent = emailSendStats.sent;
      campaign.stats.failed = emailSendStats.failed + emailSendStats.bounced;
      // ✅ NUEVO: También guardar skipped
      campaign.stats.skipped = emailSendStats.skipped || 0;
      
      campaign.updateRates();
      await campaign.save();
      
      console.log('\n╔═══════════════════════════════════════════╗');
      console.log('║  🎉 CAMPAÑA COMPLETADA AUTOMÁTICAMENTE    ║');
      console.log('╚═══════════════════════════════════════════╝');
      console.log(`   ${campaign.name}`);
      console.log(`   Enviados: ${emailSendStats.sent.toLocaleString()}`);
      console.log(`   Skipped: ${emailSendStats.skipped.toLocaleString()}`);
      console.log(`   Fallidos: ${(emailSendStats.failed + emailSendStats.bounced).toLocaleString()}`);
      console.log(`   Success rate: ${((emailSendStats.sent / totalRecipients) * 100).toFixed(1)}%`);
      console.log('═══════════════════════════════════════════\n');
      
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error('❌ Error verificando:', error.message);
    return false;
  }
}

// ========== UTILIDADES ==========

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
      config: CURRENT_CONFIG,
      mode: CURRENT_CONFIG.name
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
  if (!emailQueue || !isQueueReady) return [];
  try {
    return await emailQueue.getActive();
  } catch (error) {
    return [];
  }
}

async function getWaitingJobs() {
  if (!emailQueue || !isQueueReady) return [];
  try {
    return await emailQueue.getWaiting();
  } catch (error) {
    return [];
  }
}

async function checkAllSendingCampaigns() {
  try {
    const sendingCampaigns = await Campaign.find({ status: 'sending' });
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
  
  console.log(`\n⚠️  ${signal} - cerrando gracefully...`);
  
  const timeout = setTimeout(() => {
    console.error('❌ Timeout - forzando salida');
    process.exit(1);
  }, 30000);
  
  try {
    if (emailWorker) {
      console.log('🔄 Cerrando worker...');
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

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ========== INICIALIZACIÓN ==========

initializeQueue().catch(err => {
  console.error('❌ Error fatal:', err);
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
  getConfig: () => CURRENT_CONFIG,
  getAdaptiveConfig, // ✅ Exportar para uso en controller
  generateJobId,
  generateBatchJobId
};