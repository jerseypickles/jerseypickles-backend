// backend/src/jobs/emailQueue.js
const { Queue, Worker } = require('bullmq');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

let emailQueue;
let emailWorker;
let isQueueReady = false;

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
    
    // ✅ CREAR WORKER (para procesar jobs)
    emailWorker = new Worker(
      'email-sending',
      async (job) => {
        const { campaignId, customer, emailData } = job.data;
        
        console.log(`📧 [${job.id}] Enviando a ${customer.email}...`);
        
        try {
          const result = await emailService.sendEmail(emailData);
          
          if (result.success) {
            await EmailEvent.create({
              campaign: campaignId,
              customer: customer._id,
              email: customer.email,
              eventType: 'sent',
              source: 'custom',
              resendId: result.id
            });
            
            await Campaign.findByIdAndUpdate(campaignId, {
              $inc: { 'stats.sent': 1, 'stats.delivered': 1 }
            });
            
            console.log(`✅ [${job.id}] Enviado: ${customer.email}`);
            
            // Verificar si es el último job
            try {
              const counts = await emailQueue.getJobCounts();
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
            
            return { success: true, email: customer.email, id: result.id };
            
          } else {
            throw new Error(result.error);
          }
          
        } catch (error) {
          console.error(`❌ [${job.id}] Error: ${error.message}`);
          
          await Campaign.findByIdAndUpdate(campaignId, {
            $inc: { 'stats.failed': 1 }
          });
          
          if (job.attemptsMade >= job.opts.attempts) {
            await EmailEvent.create({
              campaign: campaignId,
              customer: customer._id,
              email: customer.email,
              eventType: 'bounced',
              source: 'custom',
              bounceReason: error.message
            });
          }
          
          throw error;
        }
      },
      {
        connection,
        concurrency: 20,
        limiter: {
          max: 100,
          duration: 60000
        }
      }
    );
    
    // ✅ Event listeners
    emailWorker.on('completed', (job) => {
      console.log(`✅ Job ${job.id} completado`);
    });
    
    emailWorker.on('failed', (job, err) => {
      console.error(`❌ Job ${job.id} falló: ${err.message}`);
    });
    
    emailWorker.on('error', (err) => {
      console.error('❌ Worker error:', err.message);
    });
    
    // ✅ Marcar como ready
    isQueueReady = true;
    console.log('✅ BullMQ Queue initialized with Upstash Redis');
    
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

// Función helper para agregar emails a la cola
async function addEmailsToQueue(emails, campaignId) {
  if (!emailQueue || !isQueueReady) {
    throw new Error('Redis queue no disponible. Verifica REDIS_URL y conexión.');
  }
  
  console.log(`📥 Agregando ${emails.length} emails a la cola...`);
  
  const jobs = emails.map((emailData, index) => ({
    name: 'send-email',
    data: {
      campaignId,
      customer: emailData.customer,
      emailData: {
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
        from: emailData.from,
        replyTo: emailData.replyTo,
        campaignId: emailData.campaignId,
        customerId: emailData.customerId
      }
    },
    opts: {
      delay: index * 100,
      jobId: `${campaignId}-${emailData.customerId || index}`,
      priority: 1
    }
  }));
  
  // ✅ BullMQ usa addBulk diferente
  const addedJobs = await emailQueue.addBulk(jobs);
  
  console.log(`✅ ${jobs.length} emails agregados correctamente`);
  
  return {
    jobIds: addedJobs.map(j => j.id),
    total: jobs.length
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
      error: !emailQueue ? 'Redis queue no configurado' : 'Redis conectando...'
    };
  }
  
  try {
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis timeout')), 3000)
    );
    
    // ✅ BullMQ tiene métodos diferentes
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
    // ✅ BullMQ usa clean diferente
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

module.exports = {
  emailQueue,
  addEmailsToQueue,
  getQueueStatus,
  pauseQueue,
  resumeQueue,
  cleanQueue,
  closeQueue,
  isAvailable: () => emailQueue && isQueueReady
};