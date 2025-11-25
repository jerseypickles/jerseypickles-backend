// backend/src/scripts/check-campaign-status.js
// Script para ver el status de una campaña y sus EmailSends sin hacer cambios

const mongoose = require('mongoose');
require('dotenv').config();

const Campaign = require('../src/models/Campaign');
const EmailSend = require('../src/models/EmailSend');
const EmailEvent = require('../src/models/EmailEvent');

async function checkCampaignStatus(campaignId) {
  try {
    console.log('🔄 Conectando a MongoDB...\n');
    await mongoose.connect(process.env.MONGODB_URI);
    
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║  📊 STATUS DE CAMPAÑA                     ║');
    console.log('╚═══════════════════════════════════════════╝\n');
    
    // 1. Datos de campaña
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) {
      console.error('❌ Campaña no encontrada\n');
      process.exit(1);
    }
    
    console.log(`📧 Campaña: "${campaign.name}"`);
    console.log(`   ID: ${campaign._id}`);
    console.log(`   Status: ${campaign.status}`);
    console.log(`   Creada: ${campaign.createdAt.toLocaleString()}`);
    if (campaign.sentAt) {
      console.log(`   Enviada: ${campaign.sentAt.toLocaleString()}`);
    }
    console.log();
    
    // 2. Stats de campaña
    console.log('📊 Stats de Campaña:');
    console.log(`   Total Recipients: ${campaign.stats.totalRecipients}`);
    console.log(`   Sent: ${campaign.stats.sent}`);
    console.log(`   Delivered: ${campaign.stats.delivered}`);
    console.log(`   Opened: ${campaign.stats.opened}`);
    console.log(`   Clicked: ${campaign.stats.clicked}`);
    console.log(`   Bounced: ${campaign.stats.bounced}`);
    console.log(`   Failed: ${campaign.stats.failed}`);
    console.log();
    
    // 3. EmailSends por status
    const emailSendsByStatus = await EmailSend.aggregate([
      { $match: { campaignId: campaignId } },
      { 
        $group: { 
          _id: '$status', 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { _id: 1 } }
    ]);
    
    const totalEmailSends = await EmailSend.countDocuments({ campaignId });
    
    console.log('📦 EmailSends en BD:');
    console.log(`   Total: ${totalEmailSends}`);
    if (emailSendsByStatus.length > 0) {
      emailSendsByStatus.forEach(item => {
        console.log(`   ${item._id}: ${item.count}`);
      });
    } else {
      console.log('   (ninguno)');
    }
    console.log();
    
    // 4. EmailSends con problemas
    const locked = await EmailSend.countDocuments({
      campaignId,
      lockedBy: { $ne: null }
    });
    
    const withErrors = await EmailSend.countDocuments({
      campaignId,
      lastError: { $ne: null }
    });
    
    const highAttempts = await EmailSend.countDocuments({
      campaignId,
      attempts: { $gte: 2 }
    });
    
    if (locked > 0 || withErrors > 0 || highAttempts > 0) {
      console.log('⚠️  Problemas detectados:');
      if (locked > 0) {
        console.log(`   ${locked} emails con lock activo`);
      }
      if (withErrors > 0) {
        console.log(`   ${withErrors} emails con errores`);
      }
      if (highAttempts > 0) {
        console.log(`   ${highAttempts} emails con 2+ intentos`);
      }
      console.log();
    }
    
    // 5. Eventos
    const eventsByType = await EmailEvent.aggregate([
      { $match: { campaign: new mongoose.Types.ObjectId(campaignId) } },
      { 
        $group: { 
          _id: '$eventType', 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { _id: 1 } }
    ]);
    
    const totalEvents = await EmailEvent.countDocuments({ 
      campaign: campaignId 
    });
    
    console.log('📊 Eventos registrados:');
    console.log(`   Total: ${totalEvents}`);
    if (eventsByType.length > 0) {
      eventsByType.forEach(item => {
        console.log(`   ${item._id}: ${item.count}`);
      });
    } else {
      console.log('   (ninguno)');
    }
    console.log();
    
    // 6. Análisis y recomendaciones
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║  💡 ANÁLISIS Y RECOMENDACIONES            ║');
    console.log('╚═══════════════════════════════════════════╝\n');
    
    const pendingCount = emailSendsByStatus.find(s => s._id === 'pending')?.count || 0;
    const sentCount = emailSendsByStatus.find(s => s._id === 'sent')?.count || 0;
    const failedCount = emailSendsByStatus.find(s => s._id === 'failed')?.count || 0;
    
    if (campaign.status === 'sending' && pendingCount > 0) {
      console.log(`⚠️  Campaña en "sending" pero hay ${pendingCount} emails pending`);
      console.log('   Opciones:');
      console.log('   1. Esperar a que los workers los procesen');
      console.log('   2. Verificar logs del servidor para ver errores');
      console.log('   3. Reencolar con: node requeue-pending-emails.js ' + campaignId + ' --confirm\n');
    }
    
    if (campaign.status === 'draft' && totalEmailSends > 0) {
      console.log(`⚠️  Campaña en "draft" pero hay ${totalEmailSends} EmailSends`);
      console.log('   Recomendación: Resetear antes de reenviar');
      console.log('   Comando: node reset-campaign.js ' + campaignId + ' --confirm\n');
    }
    
    if (campaign.status === 'sent' && pendingCount > 0) {
      console.log(`⚠️  Campaña marcada como "sent" pero hay ${pendingCount} emails pending`);
      console.log('   Esto indica que algunos emails nunca se enviaron');
      console.log('   Opciones:');
      console.log('   1. Reencolar solo los pending: node requeue-pending-emails.js ' + campaignId + ' --confirm');
      console.log('   2. Marcarlos como failed si ya pasó mucho tiempo\n');
    }
    
    if (sentCount === 0 && totalEmailSends > 0 && campaign.status === 'sending') {
      console.log('❌ PROBLEMA CRÍTICO: Ningún email fue enviado');
      console.log('   Todos fueron skipped por alguna razón');
      console.log('   Pasos a seguir:');
      console.log('   1. Deploy emailQueue.js con debug logs');
      console.log('   2. Resetear campaña: node reset-campaign.js ' + campaignId + ' --confirm');
      console.log('   3. Reenviar desde UI para obtener logs de debug\n');
    }
    
    if (totalEmailSends === 0) {
      console.log('✅ No hay EmailSends - Campaña lista para enviar desde UI\n');
    }
    
    if (campaign.status === 'sent' && sentCount === campaign.stats.totalRecipients) {
      console.log('✅ Campaña completada exitosamente\n');
    }
    
    await mongoose.disconnect();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Ejecutar
const campaignId = process.argv[2];

if (!campaignId) {
  console.error('❌ Uso: node check-campaign-status.js <campaignId>');
  console.error('   Ejemplo: node check-campaign-status.js 692601c8fa2172f513f5f2fc\n');
  process.exit(1);
}

checkCampaignStatus(campaignId);