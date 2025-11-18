// backend/src/jobs/emailQueue.js
const Queue = require('bull');
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

// Crear cola (necesita Redis)
let emailQueue;

try {
  emailQueue = new Queue('email-sending', process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  
  console.log('✅ Email queue initialized');
} catch (error) {
  console.warn('⚠️  Redis no disponible, usando envío directo');
  emailQueue = null;
}

// Procesar jobs de email
if (emailQueue) {
  emailQueue.process(async (job) => {
    const { campaignId, customer, emailData } = job.data;
    
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
          resendId: result.id
        });
        
        // Actualizar stats de campaña
        await Campaign.findByIdAndUpdate(campaignId, {
          $inc: { 'stats.sent': 1, 'stats.delivered': 1 }
        });
        
        return { success: true, email: customer.email };
      } else {
        throw new Error(result.error);
      }
      
    } catch (error) {
      console.error(`Error enviando a ${customer.email}:`, error.message);
      
      // Registrar bounce
      await EmailEvent.create({
        campaign: campaignId,
        customer: customer._id,
        email: customer.email,
        eventType: 'bounced',
        bounceReason: error.message
      });
      
      throw error;
    }
  });
  
  // Event handlers
  emailQueue.on('completed', (job, result) => {
    console.log(`✅ Email job completed: ${result.email}`);
  });
  
  emailQueue.on('failed', (job, err) => {
    console.error(`❌ Email job failed:`, err.message);
  });
}

module.exports = emailQueue;