// backend/src/jobs/emailQueue.js - OPTIMIZADO PARA 10K+ EMAILS
// Cambios principales:
// 1. Pre-carga bounces/complaints en batch (1 query vs N queries)
// 2. Batch updates para stats de Campaign
// 3. Rate limit ajustado para Resend (10 req/s máximo)
// 4. Bulk inserts para EmailEvents

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

// ========== CONFIGURACIÓN OPTIMIZADA PARA RESEND 10 req/s ==========

function getAdaptiveConfig(totalEmails = 0) {
  // ⚠️ IMPORTANTE: Resend = 10 req/s máximo
  // Con CONCURRENCY, el rate real = RATE_LIMIT * CONCURRENCY
  // Entonces: rate_limit * concurrency <= 10
  
  if (totalEmails < 5000) {
    return {
      name: 'FAST',
      BATCH_SIZE: 100,
      RATE_LIMIT_PER_SECOND: 5,   // 5 * 2 = 10 max
      CONCURRENCY: 2,
      description: 'Campañas pequeñas (5 req/s × 2 workers = 10 req/s)'
    };
  } else if (totalEmails < 20000) {
    return {
      name: 'BALANCED',
      BATCH_SIZE: 100,
      RATE_LIMIT_PER_SECOND: 4,   // 4 * 2 = 8 (margen seguro)
      CONCURRENCY: 2,
      description: 'Campañas medianas (4 req/s × 2 workers = 8 req/s)'
    };
  } else if (totalEmails < 100000) {
    return {
      name: 'STABLE',
      BATCH_SIZE: 75,
      RATE_LIMIT_PER_SECOND: 8,   // 8 * 1 = 8
      CONCURRENCY: 1,             // Single worker para control
      description: 'Campañas grandes (8 req/s × 1 worker)'
    };
  } else {
    return {
      name: 'ULTRA_STABLE',
      BATCH_SIZE: 50,
      RATE_LIMIT_PER_SECOND: 6,   // Conservador para mega campañas
      CONCURRENCY: 1,
      description: 'Campañas masivas (6 req/s × 1 worker)'
    };
  }
}

let CURRENT_CONFIG = getAdaptiveConfig(0);

console.log('\n╔════════════════════════════════════════════════╗');
console.log('║  📊 EMAIL QUEUE - OPTIMIZADO MONGODB           ║');
console.log('╚════════════════════════════════════════════════╝');
console.log('   ✅ Pre-carga bounces/complaints en batch');
console.log('   ✅ Batch stats updates (no +1 por email)');
console.log('   ✅ Rate limit ajustado para Resend 10 req/s');
console.log('════════════════════════════════════════════════\n');

// ========== GENERACIÓN DE JOB IDs ==========

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

// ========== INICIALIZACIÓN ==========

async function initializeQueue() {
  try {
    const redisUrl = process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.warn('⚠️  REDIS_URL no configurado\n');
      return null;
    }

    console.log('🔄 Inicializando BullMQ...\n');
    
    const url = new URL(redisUrl);
    
    const connectionConfig = {
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
      connection: { ...connectionConfig, maxRetriesPerRequest: 3 },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 }
      }
    });
    
    emailWorker = new Worker(
      'email-campaign',
      async (job) => await processEmailBatchOptimized(job),
      {
        connection: connectionConfig,
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
    
    emailWorker.on('ready', () => {
      console.log('✅ Worker listo - OPTIMIZADO\n');
    });
    
    emailWorker.on('completed', async (job, result) => {
      const throughput = result.sent > 0 
        ? ((result.sent / ((Date.now() - (job.timestamp || Date.now())) / 1000)) || 0).toFixed(1)
        : '0.0';
      
      console.log(`✅ [Batch ${result.chunkIndex}] ${result.sent} sent, ${result.skipped} skip, ${result.failed} fail (${throughput}/s)`);
      
      if (result.campaignId) {
        setTimeout(() => {
          checkAndFinalizeCampaign(result.campaignId).catch(console.error);
        }, 2000);
      }
    });
    
    emailWorker.on('failed', (job, err) => {
      console.error(`❌ [Batch ${job?.data?.chunkIndex}] Falló: ${err.message}`);
    });
    
    emailWorker.on('error', (err) => {
      console.error('❌ Worker error:', err.message);
    });
    
    isQueueReady = true;
    
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║  ✅ BullMQ OPTIMIZADO LISTO                   ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log(`   Rate: ${CURRENT_CONFIG.RATE_LIMIT_PER_SECOND} req/s × ${CURRENT_CONFIG.CONCURRENCY} workers`);
    console.log(`   Max efectivo: ${CURRENT_CONFIG.RATE_LIMIT_PER_SECOND * CURRENT_CONFIG.CONCURRENCY} req/s`);
    console.log('═══════════════════════════════════════════════\n');
    
    return emailQueue;
    
  } catch (error) {
    console.error('❌ Error inicializando:', error.message);
    isQueueReady = false;
    return null;
  }
}

// ========== PROCESAMIENTO OPTIMIZADO ==========

async function processEmailBatchOptimized(job) {
  const { campaignId, recipients, chunkIndex } = job.data;
  const workerId = `w-${process.pid}-${Date.now()}`;
  const startTime = Date.now();
  
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  📦 BATCH ${String(chunkIndex).padStart(3, '0')} - ${recipients.length} emails${' '.repeat(17)}║`);
  console.log(`╚════════════════════════════════════════════╝`);
  
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
  
  // ═══════════════════════════════════════════════════════════════
  // 🚀 OPTIMIZACIÓN #1: Pre-cargar bounces/complaints en UNA query
  // ═══════════════════════════════════════════════════════════════
  const emailsInBatch = recipients.map(r => r.email.toLowerCase().trim());
  
  const invalidCustomers = await Customer.find({
    email: { $in: emailsInBatch },
    $or: [
      { emailStatus: { $in: ['bounced', 'complained', 'unsubscribed'] } },
      { 'bounceInfo.isBounced': true }
    ]
  }).select('email emailStatus bounceInfo').lean();
  
  // Crear Set para lookup O(1)
  const bouncedEmails = new Set();
  const complainedEmails = new Set();
  const unsubscribedEmails = new Set();
  
  invalidCustomers.forEach(c => {
    const email = c.email.toLowerCase();
    if (c.emailStatus === 'bounced' || c.bounceInfo?.isBounced) {
      bouncedEmails.add(email);
    } else if (c.emailStatus === 'complained') {
      complainedEmails.add(email);
    } else if (c.emailStatus === 'unsubscribed') {
      unsubscribedEmails.add(email);
    }
  });
  
  console.log(`   📋 Pre-carga: ${invalidCustomers.length} emails inválidos (1 query)`);
  
  // ═══════════════════════════════════════════════════════════════
  // 🚀 OPTIMIZACIÓN #2: Acumular eventos para bulk insert
  // ═══════════════════════════════════════════════════════════════
  const emailEventsToInsert = [];
  const emailSendUpdates = [];
  
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    const normalizedEmail = recipient.email.toLowerCase().trim();
    const jobId = generateJobId(campaignId, normalizedEmail);
    
    // ═══════════════════════════════════════════════════════════════
    // CHECK RÁPIDO (O(1) lookup en Sets, NO query MongoDB)
    // ═══════════════════════════════════════════════════════════════
    if (bouncedEmails.has(normalizedEmail)) {
      results.skippedBounced++;
      results.skipped++;
      emailSendUpdates.push({
        updateOne: {
          filter: { jobId },
          update: { $set: { status: 'skipped', lastError: 'Bounced', skippedAt: new Date() } },
          upsert: true
        }
      });
      continue;
    }
    
    if (complainedEmails.has(normalizedEmail)) {
      results.skippedComplained++;
      results.skipped++;
      emailSendUpdates.push({
        updateOne: {
          filter: { jobId },
          update: { $set: { status: 'skipped', lastError: 'Complained', skippedAt: new Date() } },
          upsert: true
        }
      });
      continue;
    }
    
    if (unsubscribedEmails.has(normalizedEmail)) {
      results.skippedUnsubscribed++;
      results.skipped++;
      emailSendUpdates.push({
        updateOne: {
          filter: { jobId },
          update: { $set: { status: 'skipped', lastError: 'Unsubscribed', skippedAt: new Date() } },
          upsert: true
        }
      });
      continue;
    }
    
    try {
      // Claim (única operación individual necesaria para atomicidad)
      const claim = await EmailSend.claimForProcessing(jobId, workerId);
      
      if (!claim || claim.status === 'sent' || claim.status === 'delivered') {
        results.skipped++;
        continue;
      }
      
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
        // Acumular para bulk update (no update individual)
        emailSendUpdates.push({
          updateOne: {
            filter: { jobId, lockedBy: workerId },
            update: {
              $set: {
                status: 'sent',
                sentAt: new Date(),
                resendId: sendResult.id,
                lockedBy: null,
                lockedAt: null
              }
            }
          }
        });
        
        // Acumular evento para bulk insert
        emailEventsToInsert.push({
          campaign: campaignId,
          customer: recipient.customerId || null,
          email: recipient.email,
          eventType: 'sent',
          source: 'custom',
          resendId: sendResult.id,
          eventDate: new Date()
        });
        
        results.sent++;
        
      } else {
        throw new Error(sendResult.error || 'Error desconocido');
      }
      
    } catch (error) {
      const errorType = classifyError(error);
      
      if (errorType === 'rate_limit') {
        console.warn(`\n   ⚠️  RATE LIMIT - pausa 60s...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        
        emailSendUpdates.push({
          updateOne: {
            filter: { jobId },
            update: {
              $set: { status: 'pending', lockedBy: null, lockedAt: null, lastError: 'Rate limit' },
              $inc: { attempts: 1 }
            }
          }
        });
        
        throw error; // Re-throw para que BullMQ reintente el batch
        
      } else {
        emailSendUpdates.push({
          updateOne: {
            filter: { jobId },
            update: {
              $set: { status: 'failed', lastError: error.message, failedAt: new Date() }
            }
          }
        });
        
        results.failed++;
        results.errors.push({ email: recipient.email, error: error.message });
      }
    }
    
    // Progress cada 20 emails
    if (i > 0 && i % 20 === 0) {
      await job.updateProgress(Math.round((i / recipients.length) * 100));
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // 🚀 OPTIMIZACIÓN #3: Bulk writes al final del batch
  // ═══════════════════════════════════════════════════════════════
  
  // Bulk update EmailSends (1 operación vs N)
  if (emailSendUpdates.length > 0) {
    try {
      await EmailSend.bulkWrite(emailSendUpdates, { ordered: false });
      console.log(`   💾 EmailSend bulk: ${emailSendUpdates.length} ops`);
    } catch (err) {
      if (err.code !== 11000) console.error('   ⚠️  Bulk EmailSend error:', err.message);
    }
  }
  
  // Bulk insert EmailEvents (1 operación vs N)
  if (emailEventsToInsert.length > 0) {
    try {
      await EmailEvent.insertMany(emailEventsToInsert, { ordered: false });
      console.log(`   📝 EmailEvent bulk: ${emailEventsToInsert.length} inserts`);
    } catch (err) {
      console.error('   ⚠️  Bulk EmailEvent error:', err.message);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // 🚀 OPTIMIZACIÓN #4: Update Campaign stats UNA vez por batch
  // ═══════════════════════════════════════════════════════════════
  if (results.sent > 0 || results.failed > 0 || results.skipped > 0) {
    await Campaign.findByIdAndUpdate(campaignId, {
      $inc: {
        'stats.sent': results.sent,
        'stats.failed': results.failed,
        'stats.skipped': results.skipped
      }
    });
    console.log(`   📊 Campaign stats: +${results.sent} sent, +${results.skipped} skip`);
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const throughput = results.sent > 0 ? (results.sent / duration).toFixed(1) : '0.0';
  
  console.log(`\n   ✅ Batch ${chunkIndex} completado en ${duration}s (${throughput}/s)`);
  console.log(`      Sent: ${results.sent} | Skip: ${results.skipped} | Fail: ${results.failed}`);
  
  if (results.skippedBounced || results.skippedComplained || results.skippedUnsubscribed) {
    console.log(`      Detalle skip: bounce=${results.skippedBounced}, complaint=${results.skippedComplained}, unsub=${results.skippedUnsubscribed}`);
  }
  console.log(`════════════════════════════════════════════\n`);
  
  return results;
}

function classifyError(error) {
  const message = error.message || '';
  const statusCode = error.statusCode || error.status;
  
  if (statusCode === 429 || message.includes('rate_limit') || message.toLowerCase().includes('too many')) {
    return 'rate_limit';
  }
  
  if ([400, 401, 403, 404, 422].includes(statusCode) || 
      message.toLowerCase().includes('invalid email')) {
    return 'fatal';
  }
  
  return 'retry';
}

// ========== VERIFICACIÓN Y FINALIZACIÓN ==========

async function checkAndFinalizeCampaign(campaignId) {
  try {
    const campaign = await Campaign.findById(campaignId);
    
    if (!campaign || campaign.status !== 'sending') {
      return false;
    }
    
    const emailSendStats = await EmailSend.getCampaignStats(campaignId);
    
    const totalProcessed = emailSendStats.sent + 
                           emailSendStats.delivered + 
                           emailSendStats.failed + 
                           emailSendStats.bounced +
                           emailSendStats.skipped;
    
    const totalRecipients = campaign.stats.totalRecipients;
    
    console.log(`🔍 Check: ${campaign.name} - ${totalProcessed}/${totalRecipients}`);
    
    if (totalProcessed >= totalRecipients && totalRecipients > 0) {
      if (emailQueue && isQueueReady) {
        const counts = await emailQueue.getJobCounts('waiting', 'active', 'delayed');
        const pending = (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0);
        
        if (pending > 0) {
          console.log(`   ⏳ ${pending} batches pendientes\n`);
          return false;
        }
      }
      
      campaign.status = 'sent';
      campaign.sentAt = campaign.sentAt || new Date();
      campaign.stats.sent = emailSendStats.sent;
      campaign.stats.failed = emailSendStats.failed + emailSendStats.bounced;
      campaign.stats.skipped = emailSendStats.skipped || 0;
      
      campaign.updateRates();
      await campaign.save();
      
      console.log('\n╔═══════════════════════════════════════════╗');
      console.log('║  🎉 CAMPAÑA COMPLETADA                    ║');
      console.log('╚═══════════════════════════════════════════╝');
      console.log(`   ${campaign.name}`);
      console.log(`   ✅ Enviados: ${emailSendStats.sent.toLocaleString()}`);
      console.log(`   ⏭️  Skipped: ${emailSendStats.skipped.toLocaleString()}`);
      console.log(`   ❌ Fallidos: ${(emailSendStats.failed + emailSendStats.bounced).toLocaleString()}`);
      console.log('═══════════════════════════════════════════\n');
      
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error('❌ Error check:', error.message);
    return false;
  }
}

// ========== UTILIDADES ==========

async function addCampaignToQueue(recipients, campaignId) {
  if (!emailQueue || !isQueueReady) {
    throw new Error('Queue no disponible');
  }
  
  const adaptiveConfig = getAdaptiveConfig(recipients.length);
  CURRENT_CONFIG = adaptiveConfig;
  
  // Actualizar worker con nueva config si cambió
  if (emailWorker) {
    emailWorker.opts.concurrency = adaptiveConfig.CONCURRENCY;
  }
  
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  📥 ENCOLANDO - MODO OPTIMIZADO               ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`   Total: ${recipients.length.toLocaleString()}`);
  console.log(`   Modo: ${adaptiveConfig.name}`);
  console.log(`   Rate: ${adaptiveConfig.RATE_LIMIT_PER_SECOND} × ${adaptiveConfig.CONCURRENCY} = ${adaptiveConfig.RATE_LIMIT_PER_SECOND * adaptiveConfig.CONCURRENCY} req/s`);
  
  const chunks = [];
  for (let i = 0; i < recipients.length; i += adaptiveConfig.BATCH_SIZE) {
    chunks.push(recipients.slice(i, i + adaptiveConfig.BATCH_SIZE));
  }
  
  const effectiveRate = adaptiveConfig.BATCH_SIZE * adaptiveConfig.RATE_LIMIT_PER_SECOND * adaptiveConfig.CONCURRENCY;
  const estimatedSeconds = Math.ceil(recipients.length / effectiveRate);
  
  console.log(`   Batches: ${chunks.length}`);
  console.log(`   Estimado: ~${Math.ceil(estimatedSeconds / 60)} min`);
  console.log('════════════════════════════════════════════════\n');
  
  const jobs = chunks.map((chunk, index) => ({
    name: 'process-batch',
    data: { campaignId, chunkIndex: index, recipients: chunk },
    opts: {
      jobId: generateBatchJobId(campaignId, index),
      priority: 1,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    }
  }));
  
  const addedJobs = await emailQueue.addBulk(jobs);
  
  console.log(`✅ ${chunks.length} batches encolados\n`);
  
  return {
    totalJobs: chunks.length,
    totalEmails: recipients.length,
    mode: adaptiveConfig.name,
    estimatedSeconds
  };
}

async function getQueueStatus() {
  if (!emailQueue || !isQueueReady) {
    return { available: false, error: 'Queue no inicializada' };
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
    return { available: false, error: error.message };
  }
}

async function pauseQueue() {
  if (!emailQueue) return { success: false, error: 'Queue no disponible' };
  await emailQueue.pause();
  return { success: true };
}

async function resumeQueue() {
  if (!emailQueue) return { success: false, error: 'Queue no disponible' };
  await emailQueue.resume();
  return { success: true };
}

async function cleanQueue() {
  if (!emailQueue) return { success: false, error: 'Queue no disponible' };
  await emailQueue.clean(0, 1000, 'completed');
  await emailQueue.clean(0, 1000, 'failed');
  return { success: true };
}

async function getActiveJobs() {
  if (!emailQueue || !isQueueReady) return [];
  return await emailQueue.getActive();
}

async function getWaitingJobs() {
  if (!emailQueue || !isQueueReady) return [];
  return await emailQueue.getWaiting();
}

async function checkAllSendingCampaigns() {
  const sendingCampaigns = await Campaign.find({ status: 'sending' });
  const results = [];
  
  for (const campaign of sendingCampaigns) {
    const finalized = await checkAndFinalizeCampaign(campaign._id);
    results.push({
      id: campaign._id,
      name: campaign.name,
      finalized,
      sent: campaign.stats.sent,
      total: campaign.stats.totalRecipients
    });
  }
  
  return results;
}

async function closeQueue() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  try {
    if (emailWorker) await emailWorker.close();
    if (emailQueue) await emailQueue.close();
    console.log('✅ Queue cerrada\n');
  } catch (error) {
    console.error('Error cerrando queue:', error.message);
  }
}

// ========== INICIALIZACIÓN ==========

initializeQueue().catch(console.error);

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
  getAdaptiveConfig,
  generateJobId,
  generateBatchJobId,
  close: closeQueue
};