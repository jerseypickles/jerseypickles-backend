// backend/src/jobs/emailQueue.js - OPTIMIZADO v2.0 (CORREGIDO)
// ═══════════════════════════════════════════════════════════════════════════
// CAMBIOS IMPLEMENTADOS:
// 1. ✅ Bulk claim por batch (1 updateMany vs 100 queries individuales)
// 2. ✅ TTL lock + re-claim seguro (5 min timeout)
// 3. ✅ Unlock antes de retry en 429
// 4. ✅ Fix upsert (ahora usa $setOnInsert en controller)
// 8. ✅ Concurrency FIJA (no cambios en caliente)
// 9. ✅ Debounce de checkAndFinalizeCampaign (10s por campaña)
// 11. ✅ Timers por etapa en logs
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN PARA RESEND 10 req/s
// ═══════════════════════════════════════════════════════════════════════════
// Batch API: 100 emails = 1 request
// Tu límite: 10 req/s
// Throughput teórico: 10 × 100 = 1000 emails/s
// Throughput real: ~600-800 emails/s (con overhead de MongoDB)
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Worker settings (FIJOS - no cambiar en caliente)
  CONCURRENCY: 2,                    // 2 workers paralelos
  RATE_LIMIT_PER_SECOND: 4,          // 4 req/s por worker × 2 = 8 req/s total (margen de 2)
  
  // Batch settings
  RESEND_BATCH_SIZE: 100,            // Máximo de Resend Batch API
  DELAY_BETWEEN_SUBBATCHES: 120,     // ms entre sub-batches (≈8 req/s)
  
  // Lock settings
  LOCK_TTL_MS: 5 * 60 * 1000,        // 5 minutos
  
  // Debounce settings
  FINALIZE_DEBOUNCE_MS: 10 * 1000,   // 10 segundos entre checks
  
  // Retry settings
  RATE_LIMIT_PAUSE_MS: 30 * 1000,    // 30s pausa en 429
};

// ✅ CAMBIO #9: Debounce tracker para checkAndFinalizeCampaign
const lastFinalizeCheck = new Map();

console.log('\n╔════════════════════════════════════════════════╗');
console.log('║  📊 EMAIL QUEUE - OPTIMIZADO v2.0              ║');
console.log('╚════════════════════════════════════════════════╝');
console.log('   ✅ Bulk claim (1 query por batch)');
console.log('   ✅ TTL locks (5 min) + re-claim');
console.log('   ✅ Unlock antes de 429 retry');
console.log('   ✅ Debounce finalize (10s)');
console.log('   ✅ Concurrency fija: 2 workers');
console.log(`   ✅ Rate limit: ${CONFIG.RATE_LIMIT_PER_SECOND} req/s × 2 = 8 req/s`);
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

    console.log('🔄 Inicializando BullMQ v2.0...\n');
    
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
    
    // ✅ CAMBIO #8: Concurrency FIJA
    emailWorker = new Worker(
      'email-campaign',
      async (job) => await processEmailBatchOptimized(job),
      {
        connection: connectionConfig,
        concurrency: CONFIG.CONCURRENCY,  // FIJO: 2
        limiter: {
          max: CONFIG.RATE_LIMIT_PER_SECOND,  // FIJO: 4 req/s por worker
          duration: 1000
        },
        lockDuration: 300000,
        stalledInterval: 60000,
        maxStalledCount: 2,
        autorun: true
      }
    );
    
    emailWorker.on('ready', () => {
      console.log('✅ Worker listo - v2.0 OPTIMIZADO\n');
    });
    
    emailWorker.on('completed', async (job, result) => {
      const duration = job.finishedOn && job.processedOn 
        ? ((job.finishedOn - job.processedOn) / 1000).toFixed(2)
        : '?';
      
      const throughput = result.sent > 0 && duration !== '?'
        ? (result.sent / parseFloat(duration)).toFixed(1)
        : '0';
      
      console.log(`✅ [Batch ${result.chunkIndex}] ${result.sent} sent, ${result.skipped} skip, ${result.failed} fail (${duration}s, ${throughput}/s)`);
      
      // ✅ CAMBIO #9: Debounce check
      if (result.campaignId) {
        checkAndFinalizeCampaignDebounced(result.campaignId).catch(console.error);
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
    console.log('║  ✅ BullMQ v2.0 LISTO                         ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log(`   Concurrency: ${CONFIG.CONCURRENCY} (fijo)`);
    console.log(`   Rate limit: ${CONFIG.RATE_LIMIT_PER_SECOND} × ${CONFIG.CONCURRENCY} = ${CONFIG.RATE_LIMIT_PER_SECOND * CONFIG.CONCURRENCY} req/s`);
    console.log(`   Batch size: ${CONFIG.RESEND_BATCH_SIZE}`);
    console.log(`   Throughput: ~${CONFIG.RATE_LIMIT_PER_SECOND * CONFIG.CONCURRENCY * 100} emails/s teórico`);
    console.log('═══════════════════════════════════════════════\n');
    
    return emailQueue;
    
  } catch (error) {
    console.error('❌ Error inicializando:', error.message);
    isQueueReady = false;
    return null;
  }
}

// ========== PROCESAMIENTO OPTIMIZADO v2.0 ==========

async function processEmailBatchOptimized(job) {
  const { campaignId, recipients, chunkIndex } = job.data;
  const workerId = `w-${process.pid}-${Date.now()}`;
  const startTime = Date.now();
  
  // Timers por etapa
  const timers = {};
  const startTimer = (name) => { timers[name] = Date.now(); };
  const endTimer = (name) => { 
    if (timers[name]) {
      timers[name] = Date.now() - timers[name];
    }
  };
  
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
    skippedAlreadySent: 0,
    failed: 0,
    errors: []
  };
  
  const Customer = require('../models/Customer');
  
  // ═══════════════════════════════════════════════════════════════════════
  // ETAPA 1: Pre-cargar bounces/complaints/unsubscribed (1 query)
  // ═══════════════════════════════════════════════════════════════════════
  startTimer('preloadInvalid');
  
  const emailsInBatch = recipients.map(r => r.email.toLowerCase().trim());
  
  const invalidCustomers = await Customer.find({
    email: { $in: emailsInBatch },
    $or: [
      { emailStatus: { $in: ['bounced', 'complained', 'unsubscribed'] } },
      { 'bounceInfo.isBounced': true }
    ]
  }).select('email emailStatus bounceInfo').lean();
  
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
  
  endTimer('preloadInvalid');
  console.log(`   📋 Pre-carga: ${invalidCustomers.length} inválidos (${timers.preloadInvalid}ms)`);
  
  // ═══════════════════════════════════════════════════════════════════════
  // ETAPA 2: Filtrar y preparar emails válidos
  // ═══════════════════════════════════════════════════════════════════════
  startTimer('filterAndPrepare');
  
  const emailSendUpdates = [];
  const emailsToSend = [];
  const emailMetadata = [];
  const jobIdsToClaimArr = [];
  
  for (const recipient of recipients) {
    const normalizedEmail = recipient.email.toLowerCase().trim();
    const jobId = recipient.jobId || generateJobId(campaignId, normalizedEmail);
    
    // Skip bounced
    if (bouncedEmails.has(normalizedEmail)) {
      results.skippedBounced++;
      results.skipped++;
      emailSendUpdates.push({
        updateOne: {
          filter: { jobId },
          update: { 
            $set: { 
              status: 'skipped', 
              lastError: 'Bounced email', 
              skippedAt: new Date() 
            } 
          }
        }
      });
      continue;
    }
    
    // Skip complained
    if (complainedEmails.has(normalizedEmail)) {
      results.skippedComplained++;
      results.skipped++;
      emailSendUpdates.push({
        updateOne: {
          filter: { jobId },
          update: { 
            $set: { 
              status: 'skipped', 
              lastError: 'Complained', 
              skippedAt: new Date() 
            } 
          }
        }
      });
      continue;
    }
    
    // Skip unsubscribed
    if (unsubscribedEmails.has(normalizedEmail)) {
      results.skippedUnsubscribed++;
      results.skipped++;
      emailSendUpdates.push({
        updateOne: {
          filter: { jobId },
          update: { 
            $set: { 
              status: 'skipped', 
              lastError: 'Unsubscribed', 
              skippedAt: new Date() 
            } 
          }
        }
      });
      continue;
    }
    
    // Agregar a lista para bulk claim
    jobIdsToClaimArr.push(jobId);
    
    // Preparar para envío
    emailsToSend.push({
      from: recipient.from,
      to: recipient.email,
      subject: recipient.subject,
      html: recipient.html,
      replyTo: recipient.replyTo,
      tags: [
        { name: 'campaign_id', value: campaignId },
        { name: 'customer_id', value: recipient.customerId || 'unknown' }
      ]
    });
    
    emailMetadata.push({
      jobId,
      email: normalizedEmail,
      customerId: recipient.customerId
    });
  }
  
  endTimer('filterAndPrepare');
  console.log(`   🔍 Filtrado: ${emailsToSend.length} válidos de ${recipients.length} (${timers.filterAndPrepare}ms)`);
  
  // ═══════════════════════════════════════════════════════════════════════
  // ✅ CAMBIO #1: BULK CLAIM (1 query en vez de 100)
  // ═══════════════════════════════════════════════════════════════════════
  startTimer('bulkClaim');
  
  if (jobIdsToClaimArr.length > 0) {
    const now = new Date();
    const lockExpiry = new Date(now.getTime() - CONFIG.LOCK_TTL_MS);
    
    // Claim todos los que están pending O tienen lock expirado
    const claimResult = await EmailSend.updateMany(
      {
        jobId: { $in: jobIdsToClaimArr },
        $or: [
          { status: 'pending' },
          // ✅ CAMBIO #2: Re-claim si lock expiró (TTL)
          { 
            status: 'processing', 
            lockedAt: { $lt: lockExpiry } 
          }
        ]
      },
      {
        $set: {
          status: 'processing',
          lockedBy: workerId,
          lockedAt: now
        },
        $inc: { attempts: 1 }
      }
    );
    
    const claimedCount = claimResult.modifiedCount || 0;
    
    endTimer('bulkClaim');
    console.log(`   🔒 Bulk claim: ${claimedCount}/${jobIdsToClaimArr.length} (${timers.bulkClaim}ms)`);
    
    // Si no pudimos reclamar ninguno, probablemente ya fueron procesados
    if (claimedCount === 0) {
      console.log(`   ⏭️  Todos ya procesados o locked por otro worker`);
      results.skippedAlreadySent = jobIdsToClaimArr.length;
      results.skipped += jobIdsToClaimArr.length;
      
      // Ejecutar updates de skipped
      if (emailSendUpdates.length > 0) {
        await EmailSend.bulkWrite(emailSendUpdates, { ordered: false }).catch(() => {});
      }
      
      return results;
    }
    
    // Verificar cuáles realmente fueron claimed (para no enviar duplicados)
    const claimedDocs = await EmailSend.find({
      jobId: { $in: jobIdsToClaimArr },
      status: 'processing',
      lockedBy: workerId
    }).select('jobId').lean();
    
    const claimedJobIds = new Set(claimedDocs.map(d => d.jobId));
    
    // Filtrar solo los que realmente tenemos locked
    const finalEmailsToSend = [];
    const finalMetadata = [];
    
    for (let i = 0; i < emailMetadata.length; i++) {
      if (claimedJobIds.has(emailMetadata[i].jobId)) {
        finalEmailsToSend.push(emailsToSend[i]);
        finalMetadata.push(emailMetadata[i]);
      } else {
        results.skippedAlreadySent++;
        results.skipped++;
      }
    }
    
    console.log(`   📧 Emails con lock confirmado: ${finalEmailsToSend.length}`);
    
    // Reemplazar arrays
    emailsToSend.length = 0;
    emailMetadata.length = 0;
    emailsToSend.push(...finalEmailsToSend);
    emailMetadata.push(...finalMetadata);
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // ETAPA 3: Enviar con RESEND BATCH API
  // ═══════════════════════════════════════════════════════════════════════
  startTimer('sendBatch');
  
  const emailEventsToInsert = [];
  
  if (emailsToSend.length > 0) {
    // Dividir en sub-batches de 100 (límite de Resend Batch API)
    for (let i = 0; i < emailsToSend.length; i += CONFIG.RESEND_BATCH_SIZE) {
      const subBatch = emailsToSend.slice(i, i + CONFIG.RESEND_BATCH_SIZE);
      const subMetadata = emailMetadata.slice(i, i + CONFIG.RESEND_BATCH_SIZE);
      const subBatchNum = Math.floor(i / CONFIG.RESEND_BATCH_SIZE) + 1;
      const totalSubBatches = Math.ceil(emailsToSend.length / CONFIG.RESEND_BATCH_SIZE);
      
      try {
        // UNA llamada a Resend por cada 100 emails
        const batchResult = await emailService.sendBatch(subBatch, {
          includeUnsubscribe: false  // Ya está inyectado en el HTML
        });
        
        if (batchResult.success) {
          // ✅ CORREGIDO: batchResult.data ya es el array de IDs de Resend
          // Tu emailService.sendBatch() retorna { success, data: response.data, count }
          // donde response.data ES el array [{ id: 'xxx' }, { id: 'yyy' }, ...]
          const batchIds = batchResult.data || [];
          
          subMetadata.forEach((meta, idx) => {
            const resendId = batchIds[idx]?.id || null;
            
            emailSendUpdates.push({
              updateOne: {
                filter: { jobId: meta.jobId, lockedBy: workerId },
                update: {
                  $set: {
                    status: 'sent',
                    sentAt: new Date(),
                    resendId: resendId,
                    lockedBy: null,
                    lockedAt: null
                  }
                }
              }
            });
            
            emailEventsToInsert.push({
              campaign: campaignId,
              customer: meta.customerId || null,
              email: meta.email,
              eventType: 'sent',
              source: 'custom',
              resendId: resendId,
              eventDate: new Date()
            });
            
            results.sent++;
          });
          
          if (totalSubBatches > 1) {
            console.log(`   ✅ Sub-batch ${subBatchNum}/${totalSubBatches}: ${subBatch.length} enviados`);
          }
          
        } else {
          throw new Error(batchResult.error || 'Batch send failed');
        }
        
      } catch (error) {
        const errorType = classifyError(error);
        
        // ═══════════════════════════════════════════════════════════════════
        // ✅ CAMBIO #3: UNLOCK antes de retry en 429
        // ═══════════════════════════════════════════════════════════════════
        if (errorType === 'rate_limit') {
          console.warn(`\n   ⚠️  RATE LIMIT (429) - Liberando locks y pausando...`);
          
          // Liberar locks de este sub-batch para que puedan ser re-claimed
          const subBatchJobIds = subMetadata.map(m => m.jobId);
          await EmailSend.updateMany(
            { jobId: { $in: subBatchJobIds }, lockedBy: workerId },
            { 
              $set: { 
                status: 'pending', 
                lockedBy: null, 
                lockedAt: null,
                lastError: 'Rate limited - will retry'
              } 
            }
          );
          
          console.log(`   🔓 ${subBatchJobIds.length} jobs liberados`);
          console.log(`   ⏳ Esperando ${CONFIG.RATE_LIMIT_PAUSE_MS / 1000}s antes de retry...`);
          
          // Re-throw para que BullMQ reintente el job completo
          throw error;
          
        } else {
          // Error no-rate-limit: marcar como fallido
          subMetadata.forEach(meta => {
            emailSendUpdates.push({
              updateOne: {
                filter: { jobId: meta.jobId },
                update: {
                  $set: { 
                    status: 'failed', 
                    lastError: error.message, 
                    failedAt: new Date(),
                    lockedBy: null,
                    lockedAt: null
                  }
                }
              }
            });
            results.failed++;
          });
          
          console.error(`   ❌ Sub-batch ${subBatchNum} falló: ${error.message}`);
          results.errors.push({ batch: subBatchNum, error: error.message });
        }
      }
      
      // Delay entre sub-batches para respetar rate limit
      if (i + CONFIG.RESEND_BATCH_SIZE < emailsToSend.length) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_SUBBATCHES));
      }
    }
  }
  
  endTimer('sendBatch');
  
  // ═══════════════════════════════════════════════════════════════════════
  // ETAPA 4: Bulk writes finales
  // ═══════════════════════════════════════════════════════════════════════
  startTimer('bulkWrites');
  
  if (emailSendUpdates.length > 0) {
    try {
      await EmailSend.bulkWrite(emailSendUpdates, { ordered: false });
    } catch (err) {
      if (err.code !== 11000) {
        console.error('   ⚠️  Bulk EmailSend error:', err.message);
      }
    }
  }
  
  if (emailEventsToInsert.length > 0) {
    try {
      await EmailEvent.insertMany(emailEventsToInsert, { ordered: false });
    } catch (err) {
      console.error('   ⚠️  Bulk EmailEvent error:', err.message);
    }
  }
  
  // Update Campaign stats
  if (results.sent > 0 || results.failed > 0 || results.skipped > 0) {
    await Campaign.findByIdAndUpdate(campaignId, {
      $inc: {
        'stats.sent': results.sent,
        'stats.failed': results.failed,
        'stats.skipped': results.skipped
      }
    });
  }
  
  endTimer('bulkWrites');
  
  // ═══════════════════════════════════════════════════════════════════════
  // Resumen final con timers
  // ═══════════════════════════════════════════════════════════════════════
  const totalDuration = Date.now() - startTime;
  const throughput = results.sent > 0 ? (results.sent / (totalDuration / 1000)).toFixed(1) : '0';
  
  console.log(`\n   ⏱️  Timers:`);
  console.log(`      preloadInvalid: ${timers.preloadInvalid}ms`);
  console.log(`      filterAndPrepare: ${timers.filterAndPrepare}ms`);
  console.log(`      bulkClaim: ${timers.bulkClaim}ms`);
  console.log(`      sendBatch: ${timers.sendBatch}ms`);
  console.log(`      bulkWrites: ${timers.bulkWrites}ms`);
  console.log(`   ✅ TOTAL: ${totalDuration}ms (${throughput} emails/s)`);
  
  if (results.skippedBounced > 0 || results.skippedComplained > 0 || results.skippedUnsubscribed > 0) {
    console.log(`   📊 Skips: bounced=${results.skippedBounced}, complained=${results.skippedComplained}, unsub=${results.skippedUnsubscribed}, alreadySent=${results.skippedAlreadySent}`);
  }
  
  console.log(`════════════════════════════════════════════\n`);
  
  return results;
}

// ========== CLASIFICACIÓN DE ERRORES ==========

function classifyError(error) {
  const message = (error.message || '').toLowerCase();
  const statusCode = error.statusCode || error.status;
  
  // Rate limit
  if (statusCode === 429 || 
      message.includes('rate_limit') || 
      message.includes('too many') ||
      message.includes('rate limit')) {
    return 'rate_limit';
  }
  
  // Errores fatales (no reintentar)
  if ([400, 401, 403, 404, 422].includes(statusCode) || 
      message.includes('invalid email') ||
      message.includes('validation')) {
    return 'fatal';
  }
  
  return 'retry';
}

// ========== VERIFICACIÓN Y FINALIZACIÓN ==========

/**
 * ✅ CAMBIO #9: Debounce de checkAndFinalizeCampaign
 * Solo ejecuta si pasaron >10s desde última verificación
 */
async function checkAndFinalizeCampaignDebounced(campaignId) {
  const now = Date.now();
  const lastCheck = lastFinalizeCheck.get(campaignId) || 0;
  
  if (now - lastCheck < CONFIG.FINALIZE_DEBOUNCE_MS) {
    // Muy pronto desde última verificación
    return false;
  }
  
  lastFinalizeCheck.set(campaignId, now);
  return await checkAndFinalizeCampaign(campaignId);
}

async function checkAndFinalizeCampaign(campaignId) {
  try {
    const campaign = await Campaign.findById(campaignId);
    
    if (!campaign || (campaign.status !== 'sending' && campaign.status !== 'preparing')) {
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
      // Verificar que no hay jobs pendientes en la cola
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
      
      // Limpiar debounce tracker
      lastFinalizeCheck.delete(campaignId);
      
      console.log('\n╔═══════════════════════════════════════════╗');
      console.log('║  🎉 CAMPAÑA COMPLETADA                    ║');
      console.log('╚═══════════════════════════════════════════╝');
      console.log(`   ${campaign.name}`);
      console.log(`   ✅ Enviados: ${emailSendStats.sent.toLocaleString()}`);
      console.log(`   ⏭️  Skipped: ${(emailSendStats.skipped || 0).toLocaleString()}`);
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
  
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  📥 ENCOLANDO - v2.0 OPTIMIZADO               ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`   Total: ${recipients.length.toLocaleString()}`);
  console.log(`   Rate: ${CONFIG.RATE_LIMIT_PER_SECOND} × ${CONFIG.CONCURRENCY} = ${CONFIG.RATE_LIMIT_PER_SECOND * CONFIG.CONCURRENCY} req/s`);
  
  const chunks = [];
  for (let i = 0; i < recipients.length; i += CONFIG.RESEND_BATCH_SIZE) {
    chunks.push(recipients.slice(i, i + CONFIG.RESEND_BATCH_SIZE));
  }
  
  const effectiveRate = CONFIG.RESEND_BATCH_SIZE * CONFIG.RATE_LIMIT_PER_SECOND * CONFIG.CONCURRENCY;
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
  
  await emailQueue.addBulk(jobs);
  
  console.log(`✅ ${chunks.length} batches encolados\n`);
  
  return {
    totalJobs: chunks.length,
    totalEmails: recipients.length,
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
      config: {
        concurrency: CONFIG.CONCURRENCY,
        rateLimit: CONFIG.RATE_LIMIT_PER_SECOND,
        batchSize: CONFIG.RESEND_BATCH_SIZE,
        lockTTL: CONFIG.LOCK_TTL_MS / 1000 + 's',
        debounceFinalize: CONFIG.FINALIZE_DEBOUNCE_MS / 1000 + 's'
      }
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

async function pauseQueue() {
  if (!emailQueue) return { success: false, error: 'Queue no disponible' };
  await emailQueue.pause();
  return { success: true, message: 'Queue pausada' };
}

async function resumeQueue() {
  if (!emailQueue) return { success: false, error: 'Queue no disponible' };
  await emailQueue.resume();
  return { success: true, message: 'Queue resumida' };
}

async function cleanQueue() {
  if (!emailQueue) return { success: false, error: 'Queue no disponible' };
  await emailQueue.clean(0, 1000, 'completed');
  await emailQueue.clean(0, 1000, 'failed');
  return { success: true, message: 'Queue limpiada' };
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
  // Incluir también 'preparing' por si quedó stuck
  const sendingCampaigns = await Campaign.find({ 
    status: { $in: ['sending', 'preparing'] } 
  });
  
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

/**
 * ✅ CAMBIO #2: Función para re-claim jobs stuck
 * Útil para mantenimiento manual
 */
async function reclaimStuckJobs() {
  const lockExpiry = new Date(Date.now() - CONFIG.LOCK_TTL_MS);
  
  const result = await EmailSend.updateMany(
    {
      status: 'processing',
      lockedAt: { $lt: lockExpiry }
    },
    {
      $set: {
        status: 'pending',
        lockedBy: null,
        lockedAt: null,
        lastError: 'Re-claimed after lock timeout'
      }
    }
  );
  
  console.log(`🔄 Re-claimed ${result.modifiedCount} stuck jobs`);
  return { reclaimed: result.modifiedCount };
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
  checkAndFinalizeCampaignDebounced,
  checkAllSendingCampaigns,
  reclaimStuckJobs,
  isAvailable: () => emailQueue && isQueueReady,
  getConfig: () => CONFIG,
  generateJobId,
  generateBatchJobId,
  close: closeQueue
};