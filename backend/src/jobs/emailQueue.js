// backend/src/jobs/emailQueue.js
const Queue = require('bull');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

// Crear cola con configuración para Upstash
let emailQueue;
let isQueueReady = false;

async function initializeQueue() {
  try {
    const redisUrl = process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.warn('⚠️  REDIS_URL no configurado - Queue no disponible');
      return null;
    }

    console.log('🔄 Conectando a Upstash Redis...');
    
    // ✅ CONFIGURACIÓN CORRECTA para Bull + Upstash
    const queueOptions = {
      redis: {
        // ✅ CRÍTICO: enableOfflineQueue debe estar aquí
        enableOfflineQueue: true,
        
        // ✅ TLS para Upstash
        tls: redisUrl.includes('upstash.io') ? {
          rejectUnauthorized: false
        } : undefined,
        
        // ✅ TIMEOUTS
        connectTimeout: 10000,
        commandTimeout: 5000,
        keepAlive: 30000,
        
        // ✅ ESTRATEGIA DE RECONEXIÓN
        retryStrategy: (times) => {
          if (times > 5) {
            console.error('❌ Máximo de reintentos alcanzado');
            return null;
          }
          const delay = Math.min(times * 1000, 5000);
          console.log(`🔄 Reintentando conexión Redis (${times}/5) en ${delay}ms...`);
          return delay;
        },
        
        // ✅ CONFIGURACIÓN ADICIONAL
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
        
        // ✅ MANEJO DE ERRORES
        reconnectOnError: (err) => {
          console.error('❌ Redis error:', err.message);
          return true; // Intentar reconectar
        }
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
      },
      
      settings: {
        lockDuration: 30000,
        lockRenewTime: 15000,
        stalledInterval: 30000,
        maxStalledCount: 1,
        guardInterval: 5000
      }
    };
    
    // ✅ CREAR QUEUE
    emailQueue = new Queue('email-sending', redisUrl, queueOptions);
    
    // ✅ ESPERAR A QUE ESTÉ LISTA antes de procesar
    await emailQueue.isReady();
    
    console.log('✅ Redis conectado y listo');
    isQueueReady = true;
    
    // ✅ AHORA SÍ inicializar el processor
    setupProcessor();
    setupEventListeners();
    
    return emailQueue;
    
  } catch (error) {
    console.error('❌ Error inicializando queue:', error.message);
    emailQueue = null;
    isQueueReady = false;
    return null;
  }
}

// ✅ CONFIGURAR PROCESSOR solo después de que Redis esté listo
function setupProcessor() {
  if (!emailQueue || !isQueueReady) {
    console.warn('⚠️  No se puede inicializar processor - Queue no está lista');
    return;
  }
  
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
          // Ignorar error de status check
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

// ✅ CONFIGURAR EVENT LISTENERS
function setupEventListeners() {
  if (!emailQueue) return;
  
  emailQueue.on('error', (error) => {
    console.error('❌ Queue error:', error.message);
    isQueueReady = false;
  });
  
  emailQueue.on('completed', (job) => {
    console.log(`✅ Job ${job.id} completado`);
  });
  
  emailQueue.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} falló: ${err.message}`);
  });
  
  emailQueue.on('stalled', (job) => {
    console.warn(`⚠️  Job ${job.id} stalled`);
  });
  
  // ✅ Event listeners del cliente Redis
  if (emailQueue.client) {
    emailQueue.client.on('connect', () => {
      console.log('🔗 Redis conectado');
    });
    
    emailQueue.client.on('ready', () => {
      console.log('✅ Redis listo');
      isQueueReady = true;
    });
    
    emailQueue.client.on('reconnecting', () => {
      console.log('🔄 Reconectando a Redis...');
      isQueueReady = false;
    });
    
    emailQueue.client.on('error', (err) => {
      console.error('❌ Redis client error:', err.message);
      isQueueReady = false;
    });
    
    emailQueue.client.on('end', () => {
      console.log('⚠️  Conexión Redis cerrada');
      isQueueReady = false;
    });
  }
}

// ✅ INICIALIZAR al cargar el módulo
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

// ✅ getQueueStatus MEJORADO
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
    // ✅ TIMEOUT de 3 segundos
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

// Pausar cola
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

// Resumir cola
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

// Limpiar trabajos completados/fallidos
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

// ✅ GRACEFUL SHUTDOWN
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