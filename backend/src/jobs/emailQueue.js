// backend/src/jobs/emailQueue.js
const Queue = require('bull');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

// Crear cola con configuración para Upstash
let emailQueue;

try {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  
  // ⚠️ CRÍTICO: Configuración específica para Upstash
  const redisConfig = {
    redis: redisUrl,
    // Upstash requiere TLS
    tls: redisUrl.includes('upstash.io') ? {
      rejectUnauthorized: false
    } : undefined
  };
  
  emailQueue = new Queue('email-sending', redisConfig, {
    defaultJobOptions: {
      attempts: 3, // Reintentar hasta 3 veces
      backoff: {
        type: 'exponential',
        delay: 2000 // 2s, 4s, 8s
      },
      removeOnComplete: true, // ⚠️ CAMBIO: true para liberar memoria con 100k emails
      removeOnFail: false, // Mantener fallidos para debug
      timeout: 30000 // 30s timeout por email
    },
    limiter: {
      max: 100, // ⚠️ CRÍTICO: Máximo 100 emails por minuto
      duration: 60000 // Para cumplir límites de Resend
    }
  });
  
  console.log('✅ Email queue initialized with Upstash Redis');
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
      // Enviar email
      const result = await emailService.sendEmail(emailData);
      
      if (result.success) {
        // Registrar evento
        await EmailEvent.create({
          campaign: campaignId,
          customer: customer._id,
          email: customer.email,
          eventType: 'sent',
          source: 'custom',
          resendId: result.id
        });
        
        // Actualizar stats
        await Campaign.findByIdAndUpdate(campaignId, {
          $inc: { 'stats.sent': 1, 'stats.delivered': 1 }
        });
        
        console.log(`✅ [${job.id}] Enviado: ${customer.email}`);
        
        // ⚠️ NUEVO: Verificar si es el último job de la campaña
        const queueStatus = await emailQueue.getJobCounts();
        if (queueStatus.waiting === 0 && queueStatus.active <= 1) {
          // Marcar campaña como completada
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
      
      // Incrementar fallidos
      await Campaign.findByIdAndUpdate(campaignId, {
        $inc: { 'stats.failed': 1 }
      });
      
      // Si es el último intento, registrar bounce
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
      
      throw error; // Bull hará retry automático
    }
  });
  
  // Event handlers
  emailQueue.on('completed', (job, result) => {
    console.log(`✅ Job ${job.id} completado`);
  });
  
  emailQueue.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} falló después de ${job.attemptsMade} intentos: ${err.message}`);
  });
  
  emailQueue.on('stalled', (job) => {
    console.warn(`⚠️  Job ${job.id} stalled - reintentando...`);
  });
  
  emailQueue.on('progress', (job, progress) => {
    console.log(`📊 Job ${job.id} progreso: ${progress}%`);
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
      delay: index * 100, // 100ms entre cada email
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

// Obtener estado de la cola
async function getQueueStatus() {
  if (!emailQueue) {
    return { 
      available: false,
      error: 'Redis queue no disponible' 
    };
  }
  
  const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
    emailQueue.getWaitingCount(),
    emailQueue.getActiveCount(),
    emailQueue.getCompletedCount(),
    emailQueue.getFailedCount(),
    emailQueue.getDelayedCount(),
    emailQueue.isPaused()
  ]);
  
  return {
    available: true,
    waiting,
    active,
    completed,
    failed,
    delayed,
    paused,
    total: waiting + active + delayed
  };
}

// ⚠️ NUEVO: Pausar cola
async function pauseQueue() {
  if (!emailQueue) {
    return { error: 'Queue not available' };
  }
  
  await emailQueue.pause();
  console.log('⏸️  Cola pausada');
  
  return { success: true, message: 'Queue paused' };
}

// ⚠️ NUEVO: Resumir cola
async function resumeQueue() {
  if (!emailQueue) {
    return { error: 'Queue not available' };
  }
  
  await emailQueue.resume();
  console.log('▶️  Cola resumida');
  
  return { success: true, message: 'Queue resumed' };
}

// Limpiar trabajos completados/fallidos
async function cleanQueue() {
  if (!emailQueue) {
    return { error: 'Queue not available' };
  }
  
  await emailQueue.clean(5000, 'completed'); // Older than 5s
  await emailQueue.clean(5000, 'failed');
  
  console.log('🧹 Cola limpiada');
  
  return { success: true, message: 'Queue cleaned' };
}

module.exports = {
  emailQueue,
  addEmailsToQueue,
  getQueueStatus,
  pauseQueue,    // ⚠️ AGREGADO
  resumeQueue,   // ⚠️ AGREGADO
  cleanQueue,
  isAvailable: !!emailQueue
};