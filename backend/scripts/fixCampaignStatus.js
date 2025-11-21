// backend/scripts/fixCampaignStatus.js
// Script para actualizar campañas que están en "sending" pero ya terminaron

require('dotenv').config();
const mongoose = require('mongoose');
const Campaign = require('../src/models/Campaign');

async function fixCampaignStatus() {
  try {
    console.log('🔧 Conectando a MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado\n');
    
    // Buscar campañas en "sending"
    const campaigns = await Campaign.find({ status: 'sending' });
    
    console.log(`📊 Encontradas ${campaigns.length} campañas en "sending"\n`);
    
    let fixed = 0;
    
    for (const campaign of campaigns) {
      console.log(`\n📧 Campaña: ${campaign.name}`);
      console.log(`   ID: ${campaign._id}`);
      console.log(`   Status: ${campaign.status}`);
      console.log(`   Enviados: ${campaign.stats.sent}/${campaign.stats.totalRecipients}`);
      
      // Si ya se enviaron todos los emails, marcar como "sent"
      if (campaign.stats.sent >= campaign.stats.totalRecipients && campaign.stats.totalRecipients > 0) {
        campaign.status = 'sent';
        
        if (!campaign.sentAt) {
          campaign.sentAt = new Date();
        }
        
        // Actualizar rates
        campaign.updateRates();
        
        await campaign.save();
        
        console.log(`   ✅ Status actualizado a "sent"`);
        fixed++;
      } else {
        console.log(`   ⏳ Aún enviando: ${campaign.stats.sent}/${campaign.stats.totalRecipients}`);
      }
    }
    
    console.log(`\n\n✅ Proceso completado: ${fixed} campañas actualizadas`);
    
    await mongoose.disconnect();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

fixCampaignStatus();