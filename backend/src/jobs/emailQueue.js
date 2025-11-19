// backend/src/jobs/emailQueue.js
const Queue = require('bull');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

// Crear cola con configuración para Upstash
let emailQueue;

try {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  
  // ✅ CONFIGURACIÓN OPTIMIZADA para Upstash
  const redisConfig = {
    redis: {
      // Si es Upstash, parsear URL y configurar TLS + timeouts
      ...(redisUrl.includes('upstash.io') ? {
        port: parseInt(redisUrl.match(/:(\d+)/)?.[1]) || 6379,
        host: redisUrl.match(/@([^:]+)/)?.[1],
        password: redisUrl.match(/:\/\/[^:]*:([^@]+)/)?.[1],
        tls: {
          rejectUnauthorized: false
        },
        // ✅ TIMEOUTS CRÍTICOS para evitar 499
        connectTimeout: 5000,      // 5s para conectar
        commandTimeout: 5000,      // 5s por comando
        keepAlive: 30000,          // Keep alive cada 30s
        retryStrategy: (times) => {
          if (times > 3) return null; // Máximo 3 reintentos
          return Math.min(times * 1000, 3000);
        },
        enableOfflineQueue: false, // No encolar si está offline
        maxRetriesPerRequest: 2    // Máximo 2 reintentos por request
      } : redisUrl) // Si no es Upstash, usar URL directa
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      },
      removeOnComplete: true,
      removeOnFail: false,
      timeout: 30000
    },
    limiter: {
      max: 100,
      duration: 60000
    },
    // ✅ SETTINGS ADICIONALES
    settings: {
      lockDuration: 30000,
      lockRenewTime: 15000,
      stalledInterval: 30000,
      maxStalledCount: 1,
      guardInterval: 5000
    }
  };
  
  emailQueue = new Queue('email-sending', redisConfig);
  
  // ✅ VERIFICAR CONEXIÓN al iniciar
  emailQueue.isReady()
    .then(() => {
      console.log('✅ Email queue initialized with Upstash Redis');
    })
    .catch(err => {
      console.error('❌ Queue connection failed:', err.message);
    });
    
} catch (error) {
  console.error('❌ Redis connection error:', error.message);
  console.warn('⚠️  Email queue NOT available - check REDIS_URL');
  emailQueue = null;
}

// Procesar jobs (20 concurrentes máximo)
if (emailQueue) {
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
        
        // Verificar si es el último job de la campaña
        const queueStatus = await emailQueue.getJobCounts();
        if (queueStatus.waiting === 0 && queueStatus.active <= 1) {
          await Campaign.findByIdAndUpdate(campaignId, {
            status: 'sent',
            sentAt: new Date()
          });
          console.log(`\n🎉 Campaña ${campaignId} completada!\n`);
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
  
  // Event handlers
  emailQueue.on('completed', (job) => {
    console.log(`✅ Job ${job.id} completado`);
  });
  
  emailQueue.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} falló: ${err.message}`);
  });
  
  emailQueue.on('stalled', (job) => {
    console.warn(`⚠️  Job ${job.id} stalled - reintentando...`);
  });
}

// Función helper para agregar emails a la cola
async function addEmailsToQueue(emails, campaignId) {
  if (!emailQueue) {
    throw new Error('Redis queue no disponible. Verifica REDIS_URL en variables de entorno.');
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

// ✅ OPTIMIZADO: getQueueStatus con timeout y una sola llamada
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
      error: 'Redis queue no disponible' 
    };
  }
  
  try {
    // ✅ TIMEOUT de 5 segundos para evitar bloqueos
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis timeout')), 5000)
    );
    
    // ✅ UNA SOLA LLAMADA getJobCounts() en lugar de 6 llamadas individuales
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
    
    // ✅ RETORNAR ESTADO OFFLINE en lugar de lanzar error
    return {
      available: false,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
      total: 0,
      error: error.message === 'Redis timeout' 
        ? 'Redis timeout - conexión muy lenta' 
        : error.message
    };
  }
}

// Pausar cola
async function pauseQueue() {
  if (!emailQueue) {
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
  if (!emailQueue) {
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
  if (!emailQueue) {
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

module.exports = {
  emailQueue,
  addEmailsToQueue,
  getQueueStatus,
  pauseQueue,
  resumeQueue,
  cleanQueue,
  isAvailable: !!emailQueue
};