// backend/scripts/enqueue-pending.js
// VERSIÓN CORREGIDA - Procesa TODOS los pendientes
require('dotenv').config();
const mongoose = require('mongoose');
const { addCampaignToQueue } = require('../src/jobs/emailQueue');
const EmailSend = require('../src/models/EmailSend');
const Customer = require('../src/models/Customer');
const Campaign = require('../src/models/Campaign');
const emailService = require('../src/services/emailService');

const CAMPAIGN_ID = '692c9a1c4dc337d3eca514b7';

async function enqueuePending() {
  try {
    console.log('🔗 Conectando a MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado\n');
    
    console.log('📥 Buscando EmailSend pendientes...');
    
    const campaign = await Campaign.findById(CAMPAIGN_ID);
    if (!campaign) {
      throw new Error('Campaña no encontrada');
    }
    
    // PROCESAR TODO DE UNA VEZ - Sin límites
    const allPending = await EmailSend.find({
      campaignId: CAMPAIGN_ID,
      status: 'pending'
    }).lean();
    
    const totalPending = allPending.length;
    
    console.log(`Encontrados: ${totalPending.toLocaleString()}\n`);
    
    if (totalPending === 0) {
      console.log('✅ No hay emails pendientes');
      await mongoose.connection.close();
      process.exit(0);
    }
    
    console.log('📤 Preparando todos los emails...');
    console.log('⏳ Esto puede tardar 1-2 minutos...\n');
    
    const recipients = [];
    let skipped = 0;
    
    // Procesar todos de una vez
    for (let i = 0; i < allPending.length; i++) {
      const emailSend = allPending[i];
      
      // Log progreso cada 5000
      if (i > 0 && i % 5000 === 0) {
        console.log(`   Procesados: ${i.toLocaleString()}/${totalPending.toLocaleString()} (${((i/totalPending)*100).toFixed(1)}%)`);
      }
      
      const customer = await Customer.findById(emailSend.customerId).lean();
      if (!customer) {
        console.log(`   ⚠️  Customer no encontrado: ${emailSend.customerId}`);
        skipped++;
        continue;
      }
      
      // Skip bounced/unsubscribed
      if (customer.emailBounced || customer.unsubscribed || customer.complained) {
        skipped++;
        continue;
      }
      
      let html = campaign.htmlContent;
      html = emailService.personalize(html, customer);
      html = emailService.injectTracking(
        html,
        CAMPAIGN_ID,
        customer._id.toString(),
        emailSend.recipientEmail
      );
      
      recipients.push({
        email: emailSend.recipientEmail,
        subject: campaign.subject,
        html: html,
        from: `${campaign.fromName} <${campaign.fromEmail}>`,
        replyTo: campaign.replyTo,
        customerId: customer._id.toString()
      });
    }
    
    console.log(`\n✅ Preparación completada:`);
    console.log(`   Total preparados: ${recipients.length.toLocaleString()}`);
    console.log(`   Saltados: ${skipped.toLocaleString()}`);
    console.log(`\n📤 Encolando ${recipients.length.toLocaleString()} emails...`);
    
    try {
      const result = await addCampaignToQueue(recipients, CAMPAIGN_ID);
      
      console.log('\n╔════════════════════════════════════════╗');
      console.log('║  ✅ ENCOLADO EXITOSO                   ║');
      console.log('╚════════════════════════════════════════╝');
      console.log(`   Total emails: ${result.totalEmails.toLocaleString()}`);
      console.log(`   Batches creados: ${result.totalJobs}`);
      console.log(`   Modo: ${result.mode}`);
      console.log(`   Tiempo estimado: ${result.estimatedSeconds}s`);
      console.log('════════════════════════════════════════\n');
      
      console.log('🚀 Workers procesarán los emails automáticamente');
      console.log('📊 Monitorea el progreso en MongoDB o logs del servidor\n');
      
    } catch (error) {
      console.error('\n❌ Error encolando:', error.message);
      console.error('Stack:', error.stack);
    }
    
    await mongoose.connection.close();
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Error fatal:', error);
    console.error('Stack:', error.stack);
    await mongoose.connection.close();
    process.exit(1);
  }
}

enqueuePending();