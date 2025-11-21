// backend/src/jobs/emailQueue.js
const { Queue, Worker } = require('bullmq');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

let emailQueue;
let emailWorker;
let isQueueReady = false;

// ✅ CONFIGURACIÓN DE RATE LIMIT según plan de Resend CON BATCH SENDING
const RATE_LIMIT_CONFIG = {
  // Plan Pro: 10 req/s × 100 emails/batch = 1000 emails/segundo
  pro: {
    concurrency: 5,
    max: 10,              // 10 batches por segundo
    duration: 1000,
    batchSize: 100,       // 100 emails por batch
    emailsPerSecond: 1000, // 10 req/s × 100 emails
    monthlyLimit: 50000
  },
  // Plan Scale: 50 req/s × 100 emails/batch = 5000 emails/segundo
  scale: {
    concurrency: 10,
    max: 50,
    duration: 1000,
    batchSize: 100,
    emailsPerSecond: 5000,
    monthlyLimit: 200000
  }
};

// ✅ Usar plan Pro
const RESEND_PLAN = process.env.RESEND_PLAN || 'pro';
const RATE_LIMIT = RATE_LIMIT_CONFIG[RESEND_PLAN] || RATE_LIMIT_CONFIG.pro;

console.log(`📊 Configuración de Rate Limit: Plan "${RESEND_PLAN}" con BATCH SENDING`);
console.log(`⚡ Rate: ${RATE_LIMIT.max} batches/s × ${RATE_LIMIT.batchSize} emails`);
console.log(`🚀 Velocidad: ${RATE_LIMIT.emailsPerSecond} emails/segundo`);
if (RATE_LIMIT.monthlyLimit) {
  console.log(`📆 Límite mensual: ${RATE_LIMIT.monthlyLimit.toLocaleString()} emails`);
}

async function initializeQueue() {
  try {
    const redisUrl = process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.warn('⚠️  REDIS_URL no configurado - Queue no disponible');
      return null;
    }

    console.log('🔄 Inicializando BullMQ con Upstash Redis...');
    
    // ✅ PARSEAR URL de Upstash
    const url = new URL(redisUrl);
    const connection = {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      
      // ✅ CONFIGURACIÓN OPTIMIZADA para Upstash
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      enableOfflineQueue: true,
    };
    
    // ✅ CREAR QUEUE (para agregar jobs)
    emailQueue = new Queue('email-sending', {
      connection,
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
    
    // ✅ CREAR WORKER CON BATCH PROCESSING
    emailWorker = new Worker(
      'email-sending',
      async (job) => {
        const { campaignId, emailBatch } = job.data;
        
        console.log(`📦 [${job.id}] Procesando batch de ${emailBatch.length} emails...`);
        
        try {
          // 🆕 Enviar batch completo a Resend
          const result = await emailService.sendBatch(emailBatch);
          
          if (result.success) {
            // Registrar eventos para todos los emails del batch
            const events = emailBatch.map((email, index) => ({
              campaign: campaignId,
              customer: email.customerId,
              email: Array.isArray(email.to) ? email.to[0] : email.to,
              eventType: 'sent',
              source: 'custom',
              resendId: result.data[index]?.id || null
            }));
            
            await EmailEvent.insertMany(events);
            
            // Actualizar stats de campaña
            await Campaign.findByIdAndUpdate(campaignId, {
              $inc: { 
                'stats.sent': emailBatch.length,
                'stats.delivered': emailBatch.length 
              }
            });
            
            console.log(`✅ [${job.id}] Batch enviado: ${emailBatch.length} emails`);
            
            // Verificar si es el último batch
            try {
              const counts = await emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
              if ((counts.waiting || 0) === 0 && (counts.active || 0) <= 1) {
                await Campaign.findByIdAndUpdate(campaignId, {
                  status: 'sent',
                  sentAt: new Date()
                });
                console.log(`\n🎉 Campaña ${campaignId} completada!\n`);
              }
            } catch (err) {
              // Ignorar
            }
            
            return { success: true, count: emailBatch.length };
            
          } else {
            throw new Error(result.error);
          }
          
        } catch (error) {
          console.error(`❌ [${job.id}] Error en batch:`, error.message);
          
          // ✅ Detectar rate limit de Resend
          if (error.message && error.message.includes('rate_limit_exceeded')) {
            console.warn('⚠️  Rate limit de Resend alcanzado - reintentando batch...');
            await Campaign.findByIdAndUpdate(campaignId, {
              $inc: { 'stats.rateLimited': 1 }
            });
            throw error; // Reintentar automáticamente
          }
          
          // Marcar todos los emails del batch como fallidos
          await Campaign.findByIdAndUpdate(campaignId, {
            $inc: { 'stats.failed': emailBatch.length }
          });
          
          // Si es el último intento, registrar como bounced
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
        connection,
        concurrency: RATE_LIMIT.concurrency,  // 5 batches simultáneos
        limiter: {
          max: RATE_LIMIT.max,      // 10 batches por segundo
          duration: RATE_LIMIT.duration
        }
      }
    );
    
    // ✅ Event listeners
    emailWorker.on('completed', (job) => {
      console.log(`✅ Batch job ${job.id} completado`);
    });
    
    emailWorker.on('failed', (job, err) => {
      console.error(`❌ Batch job ${job.id} falló: ${err.message}`);
    });
    
    emailWorker.on('error', (err) => {
      console.error('❌ Worker error:', err.message);
    });
    
    // ✅ Marcar como ready
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

// 🆕 FUNCIÓN HELPER CON BATCH PROCESSING
async function addEmailsToQueue(emails, campaignId) {
  if (!emailQueue || !isQueueReady) {
    throw new Error('Redis queue no disponible. Verifica REDIS_URL y conexión.');
  }
  
  // ✅ Dividir emails en batches de 100
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
  
  // Crear jobs para cada batch
  const jobs = batches.map((batch, index) => ({
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
        customerId: emailData.customerId // Para tracking interno
      }))
    },
    opts: {
      jobId: `${campaignId}-batch-${index}`,
      priority: 1
    }
  }));
  
  // ✅ Agregar todos los batches a la cola
  const addedJobs = await emailQueue.addBulk(jobs);
  
  console.log(`✅ ${batches.length} batches agregados correctamente`);
  
  return {
    jobIds: addedJobs.map(j => j.id),
    total: emails.length,
    batches: batches.length,
    estimatedSeconds: Math.ceil(batches.length / RATE_LIMIT.max)
  };
}

// getQueueStatus (actualizado para batch)
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
    await emailQueue.clean(5000, 100, 'completed');
    await emailQueue.clean(5000, 100, 'failed');
    
    console.log('🧹 Cola limpiada');
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
  getWaitingJobs
};