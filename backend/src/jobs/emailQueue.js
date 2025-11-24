// backend/src/jobs/emailQueue.js (CORREGIDO)
const { Queue, Worker } = require('bullmq');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

let emailQueue;
let emailWorker;
let isQueueReady = false;

// ✅ CONTADOR GLOBAL para jobIds únicos
let globalJobCounter = 0;

// ✅ CONFIGURACIÓN DE RATE LIMIT según plan de Resend CON BATCH SENDING
const RATE_LIMIT_CONFIG = {
  pro: {
    concurrency: 5,
    max: 10,
    duration: 1000,
    batchSize: 100,
    emailsPerSecond: 1000,
    monthlyLimit: 50000
  },
  scale: {
    concurrency: 10,
    max: 50,
    duration: 1000,
    batchSize: 100,
    emailsPerSecond: 5000,
    monthlyLimit: 200000
  }
};

const RESEND_PLAN = process.env.RESEND_PLAN || 'pro';
const RATE_LIMIT = RATE_LIMIT_CONFIG[RESEND_PLAN] || RATE_LIMIT_CONFIG.pro;

console.log(`📊 Configuración de Rate Limit: Plan "${RESEND_PLAN}" con BATCH SENDING`);
console.log(`⚡ Rate: ${RATE_LIMIT.max} batches/s × ${RATE_LIMIT.batchSize} emails`);
console.log(`🚀 Velocidad: ${RATE_LIMIT.emailsPerSecond} emails/segundo`);
if (RATE_LIMIT.monthlyLimit) {
  console.log(`📆 Límite mensual: ${RATE_LIMIT.monthlyLimit.toLocaleString()} emails`);
}

// Función helper: Verificar si la campaña terminó
async function checkAndFinalizeCampaign(campaignId) {
  try {
    const campaign = await Campaign.findById(campaignId);
    
    if (!campaign) {
      console.warn(`⚠️  Campaña ${campaignId} no encontrada`);
      return false;
    }
    
    if (campaign.status !== 'sending') {
      return false;
    }
    
    console.log(`🔍 Verificando campaña ${campaign.name}: ${campaign.stats.sent}/${campaign.stats.totalRecipients}`);
    
    if (campaign.stats.sent >= campaign.stats.totalRecipients && campaign.stats.totalRecipients > 0) {
      
      if (emailQueue && isQueueReady) {
        try {
          const counts = await emailQueue.getJobCounts('waiting', 'active', 'delayed');
          const pending = (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0);
          
          if (pending > 1) {
            console.log(`⏳ Aún hay ${pending} batches pendientes, esperando...`);
            return false;
          }
        } catch (error) {
          console.warn('⚠️  No se pudo verificar la cola, finalizando de todos modos:', error.message);
        }
      }
      
      campaign.status = 'sent';
      
      if (!campaign.sentAt) {
        campaign.sentAt = new Date();
      }
      
      campaign.updateRates();
      await campaign.save();
      
      console.log(`\n╔════════════════════════════════════════╗`);
      console.log(`║  🎉 CAMPAÑA COMPLETADA                ║`);
      console.log(`╚════════════════════════════════════════╝`);
      console.log(`📧 Campaña: ${campaign.name}`);
      console.log(`📊 Enviados: ${campaign.stats.sent}/${campaign.stats.totalRecipients}`);
      console.log(`✅ Status: sent`);
      console.log(`📅 Completada: ${campaign.sentAt}\n`);
      
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error('❌ Error verificando finalización de campaña:', error.message);
    return false;
  }
}

async function initializeQueue() {
  try {
    const redisUrl = process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.warn('⚠️  REDIS_URL no configurado - Queue no disponible');
      return null;
    }

    console.log('🔄 Inicializando BullMQ con Upstash Redis...');
    
    const url = new URL(redisUrl);
    
    // ✅ Conexión para Queue
    const queueConnection = {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      enableOfflineQueue: true,
    };
    
    // ✅ Conexión SEPARADA para Worker
    const workerConnection = {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      enableOfflineQueue: true,
    };
    
    // ✅ CREAR QUEUE
    emailQueue = new Queue('email-sending', {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        removeOnComplete: {
          age: 3600,
          count: 5000
        },
        removeOnFail: {
          age: 86400
        }
      }
    });
    
    // ✅ CREAR WORKER CON BATCH PROCESSING
    emailWorker = new Worker(
      'email-sending',
      async (job) => {
        const { campaignId, emailBatch } = job.data;
        
        console.log(`📦 [${job.id}] Procesando batch de ${emailBatch.length} emails...`);
        
        try {
          const result = await emailService.sendBatch(emailBatch);
          
          if (result.success) {
            const events = emailBatch.map((email, index) => ({
              campaign: campaignId,
              customer: email.customerId,
              email: Array.isArray(email.to) ? email.to[0] : email.to,
              eventType: 'sent',
              source: 'custom',
              resendId: result.data[index]?.id || null
            }));
            
            await EmailEvent.insertMany(events);
            
            await Campaign.findByIdAndUpdate(campaignId, {
              $inc: { 
                'stats.sent': emailBatch.length,
                'stats.delivered': emailBatch.length 
              }
            });
            
            console.log(`✅ [${job.id}] Batch enviado: ${emailBatch.length} emails`);
            
            return { success: true, count: emailBatch.length, campaignId };
            
          } else {
            throw new Error(result.error);
          }
          
        } catch (error) {
          console.error(`❌ [${job.id}] Error en batch:`, error.message);
          
          if (error.message && error.message.includes('rate_limit_exceeded')) {
            console.warn('⚠️  Rate limit de Resend alcanzado - reintentando batch...');
            await Campaign.findByIdAndUpdate(campaignId, {
              $inc: { 'stats.rateLimited': 1 }
            });
            throw error;
          }
          
          await Campaign.findByIdAndUpdate(campaignId, {
            $inc: { 'stats.failed': emailBatch.length }
          });
          
          if (job.attemptsMade >= job.opts.attempts) {
            const failedEvents = emailBatch.map(email => ({
              campaign: campaignId,
              customer: email.customerId,
              email: Array.isArray(email.to) ? email.to[0] : email.to,
              eventType: 'bounced',
              source: 'custom',
              bounceReason: error.message
            }));
            
            await EmailEvent.insertMany(failedEvents);
          }
          
          throw error;
        }
      },
      {
        connection: workerConnection,
        concurrency: RATE_LIMIT.concurrency,
        limiter: {
          max: RATE_LIMIT.max,
          duration: RATE_LIMIT.duration
        }
      }
    );
    
    // Event listeners
    emailWorker.on('completed', async (job, result) => {
      console.log(`✅ Job ${job.id} completado`);
      
      if (result && result.campaignId) {
        setTimeout(() => {
          checkAndFinalizeCampaign(result.campaignId).catch(err => {
            console.error('Error finalizando campaña:', err.message);
          });
        }, 1000);
      }
    });
    
    emailWorker.on('failed', (job, err) => {
      console.error(`❌ Job ${job.id} falló: ${err.message}`);
      
      if (job && job.data && job.data.campaignId) {
        setTimeout(() => {
          checkAndFinalizeCampaign(job.data.campaignId).catch(e => {
            console.error('Error verificando campaña tras fallo:', e.message);
          });
        }, 2000);
      }
    });
    
    emailWorker.on('error', (err) => {
      console.error('❌ Worker error:', err.message);
    });
    
    // ✅ Log cuando el worker está listo
    emailWorker.on('ready', () => {
      console.log('✅ Worker listo y escuchando jobs');
    });
    
    isQueueReady = true;
    console.log('✅ BullMQ Queue initialized with Upstash Redis + BATCH SENDING');
    console.log(`⚡ Rate Limit: ${RATE_LIMIT.max} batches/s | Concurrency: ${RATE_LIMIT.concurrency}`);
    console.log(`🚀 Velocidad máxima: ${RATE_LIMIT.emailsPerSecond} emails/segundo`);
    
    return emailQueue;
    
  } catch (error) {
    console.error('❌ Error inicializando queue:', error.message);
    emailQueue = null;
    emailWorker = null;
    isQueueReady = false;
    return null;
  }
}

// ✅ INICIALIZAR
initializeQueue().catch(err => {
  console.error('❌ Failed to initialize queue:', err.message);
});

// ✅ FUNCIÓN CORREGIDA CON JOBIDs ÚNICOS
async function addEmailsToQueue(emails, campaignId) {
  if (!emailQueue || !isQueueReady) {
    throw new Error('Redis queue no disponible. Verifica REDIS_URL y conexión.');
  }
  
  const batches = [];
  for (let i = 0; i < emails.length; i += RATE_LIMIT.batchSize) {
    batches.push(emails.slice(i, i + RATE_LIMIT.batchSize));
  }
  
  console.log(`\n📥 ============ AGREGANDO EMAILS A COLA ============`);
  console.log(`📊 Total emails: ${emails.length}`);
  console.log(`📦 Total batches: ${batches.length} (${RATE_LIMIT.batchSize} emails/batch)`);
  console.log(`⚡ Velocidad: ${RATE_LIMIT.emailsPerSecond} emails/segundo`);
  console.log(`⏱️  Tiempo estimado: ~${Math.ceil(batches.length / RATE_LIMIT.max)} segundos`);
  console.log(`==================================================\n`);
  
  // ✅ CORREGIDO: Usar timestamp + contador global para jobId único
  const timestamp = Date.now();
  
  const jobs = batches.map((batch, index) => {
    globalJobCounter++; // Incrementar contador global
    
    return {
      name: 'send-batch',
      data: {
        campaignId,
        emailBatch: batch.map(emailData => ({
          from: emailData.from,
          to: emailData.to,
          subject: emailData.subject,
          html: emailData.html,
          reply_to: emailData.replyTo || undefined,
          tags: [
            { name: 'campaign_id', value: emailData.campaignId },
            { name: 'customer_id', value: emailData.customerId }
          ],
          customerId: emailData.customerId
        }))
      },
      opts: {
        // ✅ CORREGIDO: jobId ahora es único usando timestamp + contador global
        jobId: `${campaignId}-${timestamp}-${globalJobCounter}`,
        priority: 1
      }
    };
  });
  
  const addedJobs = await emailQueue.addBulk(jobs);
  
  console.log(`✅ ${batches.length} batches agregados correctamente (jobs ${globalJobCounter - batches.length + 1} a ${globalJobCounter})`);
  
  return {
    jobIds: addedJobs.map(j => j.id),
    total: emails.length,
    batches: batches.length,
    estimatedSeconds: Math.ceil(batches.length / RATE_LIMIT.max)
  };
}

// getQueueStatus
async function getQueueStatus() {
  if (!emailQueue || !isQueueReady) {
    return { 
      available: false,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
      total: 0,
      rateLimit: RATE_LIMIT,
      error: !emailQueue ? 'Redis queue no configurado' : 'Redis conectando...'
    };
  }
  
  try {
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis timeout')), 3000)
    );
    
    const countsPromise = emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    const pausedPromise = emailQueue.isPaused();
    
    const [counts, paused] = await Promise.race([
      Promise.all([countsPromise, pausedPromise]),
      timeout
    ]);
    
    return {
      available: true,
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      paused: paused || false,
      total: (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0),
      rateLimit: RATE_LIMIT,
      batchMode: true,
      error: null
    };
    
  } catch (error) {
    console.error('Queue status error:', error.message);
    
    return {
      available: false,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
      total: 0,
      rateLimit: RATE_LIMIT,
      batchMode: true,
      error: error.message
    };
  }
}

async function pauseQueue() {
  if (!emailQueue || !isQueueReady) {
    return { success: false, error: 'Queue not available' };
  }
  
  try {
    await emailQueue.pause();
    console.log('⏸️  Cola pausada');
    return { success: true, message: 'Queue paused' };
  } catch (error) {
    console.error('Pause error:', error);
    return { success: false, error: error.message };
  }
}

async function resumeQueue() {
  if (!emailQueue || !isQueueReady) {
    return { success: false, error: 'Queue not available' };
  }
  
  try {
    await emailQueue.resume();
    console.log('▶️  Cola resumida');
    return { success: true, message: 'Queue resumed' };
  } catch (error) {
    console.error('Resume error:', error);
    return { success: false, error: error.message };
  }
}

async function cleanQueue() {
  if (!emailQueue || !isQueueReady) {
    return { success: false, error: 'Queue not available' };
  }
  
  try {
    await emailQueue.clean(0, 1000, 'completed');
    await emailQueue.clean(0, 1000, 'failed');
    await emailQueue.drain(); // ✅ También limpiar jobs pendientes
    
    console.log('🧹 Cola limpiada completamente');
    return { success: true, message: 'Queue cleaned' };
  } catch (error) {
    console.error('Clean error:', error);
    return { success: false, error: error.message };
  }
}

async function closeQueue() {
  if (emailWorker) {
    console.log('🔄 Cerrando worker...');
    await emailWorker.close();
  }
  if (emailQueue) {
    console.log('🔄 Cerrando queue...');
    await emailQueue.close();
  }
  console.log('✅ Queue cerrada');
}

async function getActiveJobs() {
  if (!emailQueue || !isQueueReady) return [];
  try {
    return await emailQueue.getActive();
  } catch (error) {
    console.error('Error getting active jobs:', error);
    return [];
  }
}

async function getWaitingJobs() {
  if (!emailQueue || !isQueueReady) return [];
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

module.exports = {
  emailQueue,
  addEmailsToQueue,
  getQueueStatus,
  pauseQueue,
  resumeQueue,
  cleanQueue,
  closeQueue,
  isAvailable: () => emailQueue && isQueueReady,
  getRateLimitConfig: () => RATE_LIMIT,
  getActiveJobs,
  getWaitingJobs,
  checkAndFinalizeCampaign,
  checkAllSendingCampaigns
};