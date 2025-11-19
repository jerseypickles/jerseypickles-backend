// backend/src/jobs/emailQueue.js
const Queue = require('bull');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

let emailQueue;
let isQueueReady = false;
let processorInitialized = false;

async function initializeQueue() {
  try {
    const redisUrl = process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.warn('⚠️  REDIS_URL no configurado - Queue no disponible');
      return null;
    }

    console.log('🔄 Inicializando Bull Queue con Upstash Redis...');
    
    // ✅ CONFIGURACIÓN CORRECTA SEGÚN DOCUMENTACIÓN DE UPSTASH
    const queueOptions = {
      redis: redisUrl,
      // ✅ Upstash requiere TLS
      ...(redisUrl.includes('upstash.io') && {
        redis: {
          tls: {}
        }
      }),
      // ✅ CRITICAL: Settings específicos para Upstash
      settings: {
        stalledInterval: 300000,  // 5 minutos - Upstash necesita intervalos largos
        guardInterval: 300000,    // 5 minutos - Reducir llamadas a Redis
        drainDelay: 300,          // Timeout cuando queue está vacía
        lockDuration: 30000,
        lockRenewTime: 15000,
        maxStalledCount: 1,
        retryProcessDelay: 5000
      },
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
        },
        timeout: 30000
      },
      limiter: {
        max: 100,
        duration: 60000
      }
    };
    
    emailQueue = new Queue('email-sending', queueOptions);
    
    // ✅ ESPERAR A QUE REDIS ESTÉ READY
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Redis connection timeout after 10s'));
      }, 10000);
      
      // ✅ Event listeners ANTES de isReady()
      emailQueue.on('error', (error) => {
        console.error('❌ Queue error:', error.message);
        isQueueReady = false;
      });
      
      // ✅ Escuchar el evento 'ready' del cliente Redis interno
      if (emailQueue.client) {
        emailQueue.client.once('ready', () => {
          clearTimeout(timeout);
          isQueueReady = true;
          console.log('✅ Redis connected and ready');
          
          // ✅ SOLO AHORA inicializar el processor
          if (!processorInitialized) {
            setupProcessor();
            setupEventListeners();
            processorInitialized = true;
          }
          
          resolve(emailQueue);
        });
        
        emailQueue.client.on('error', (err) => {
          console.error('❌ Redis client error:', err.message);
          isQueueReady = false;
        });
        
        emailQueue.client.on('end', () => {
          console.log('⚠️  Redis connection closed');
          isQueueReady = false;
        });
        
        emailQueue.client.on('reconnecting', () => {
          console.log('🔄 Reconnecting to Redis...');
          isQueueReady = false;
        });
      } else {
        // Fallback si no hay acceso al client
        emailQueue.isReady()
          .then(() => {
            clearTimeout(timeout);
            isQueueReady = true;
            console.log('✅ Queue ready');
            
            if (!processorInitialized) {
              setupProcessor();
              setupEventListeners();
              processorInitialized = true;
            }
            
            resolve(emailQueue);
          })
          .catch(reject);
      }
    });
    
  } catch (error) {
    console.error('❌ Error inicializando queue:', error.message);
    emailQueue = null;
    isQueueReady = false;
    return null;
  }
}

// ✅ CONFIGURAR PROCESSOR solo después de que Redis esté listo
function setupProcessor() {
  if (!emailQueue) {
    console.warn('⚠️  No se puede inicializar processor - Queue no existe');
    return;
  }
  
  console.log('🔧 Configurando processor...');
  
  emailQueue.process(20, async (job) => {
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
          if (counts.waiting === 0 && counts.active <= 1) {
            await Campaign.findByIdAndUpdate(campaignId, {
              status: 'sent',
              sentAt: new Date()
            });
            console.log(`\n🎉 Campaña ${campaignId} completada!\n`);
          }
        } catch (err) {
          // Ignorar errores de status check
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
  });
  
  console.log('✅ Email processor iniciado (20 concurrentes)');
}

function setupEventListeners() {
  if (!emailQueue) return;
  
  emailQueue.on('completed', (job) => {
    console.log(`✅ Job ${job.id} completado`);
  });
  
  emailQueue.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} falló: ${err.message}`);
  });
  
  emailQueue.on('stalled', (job) => {
    console.warn(`⚠️  Job ${job.id} stalled`);
  });
}

// ✅ INICIALIZAR de forma asíncrona
initializeQueue()
  .then(() => {
    console.log('✅ Email queue initialized with Upstash Redis');
  })
  .catch(err => {
    console.error('❌ Failed to initialize queue:', err.message);
    emailQueue = null;
    isQueueReady = false;
  });

// Función helper para agregar emails a la cola
async function addEmailsToQueue(emails, campaignId) {
  if (!emailQueue || !isQueueReady) {
    throw new Error('Redis queue no disponible. Verifica REDIS_URL y conexión.');
  }
  
  console.log(`📥 Agregando ${emails.length} emails a la cola...`);
  
  const jobs = emails.map((emailData, index) => ({
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
  
  const addedJobs = await emailQueue.addBulk(jobs);
  
  console.log(`✅ ${jobs.length} emails agregados correctamente`);
  
  return {
    jobIds: addedJobs.map(j => j.id),
    total: jobs.length
  };
}

// ✅ getQueueStatus OPTIMIZADO
async function getQueueStatus() {
  if (!emailQueue) {
    return { 
      available: false,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
      total: 0,
      error: 'Redis queue no configurado' 
    };
  }
  
  if (!isQueueReady) {
    return {
      available: false,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
      total: 0,
      error: 'Redis conectando...'
    };
  }
  
  try {
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis timeout')), 3000)
    );
    
    const countsPromise = emailQueue.getJobCounts();
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
    await Promise.all([
      emailQueue.clean(5000, 'completed'),
      emailQueue.clean(5000, 'failed')
    ]);
    
    console.log('🧹 Cola limpiada');
    return { success: true, message: 'Queue cleaned' };
  } catch (error) {
    console.error('Clean error:', error);
    return { success: false, error: error.message };
  }
}

async function closeQueue() {
  if (emailQueue) {
    console.log('🔄 Cerrando queue...');
    await emailQueue.close();
    console.log('✅ Queue cerrada');
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
  isAvailable: () => emailQueue && isQueueReady
};