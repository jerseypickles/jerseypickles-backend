// backend/scripts/fixCampaignStats.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

async function fixCampaignStats() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Conectado a MongoDB\n');
    
        const Campaign = require(path.join(__dirname, '..', 'src', 'models', 'Campaign'));
        const EmailSend = require(path.join(__dirname, '..', 'src', 'models', 'EmailSend'));
        const EmailEvent = require(path.join(__dirname, '..', 'src', 'models', 'EmailEvent'));
    
    const campaigns = await Campaign.find({
      $or: [
        { status: 'sending' },
        { status: 'sent' },
        { $expr: { $gt: ['$stats.sent', '$stats.totalRecipients'] } }
      ]
    });
    
    console.log(`Encontradas ${campaigns.length} campañas para revisar\n`);
    
    let fixed = 0;
    let alreadyCorrect = 0;
    
    for (const campaign of campaigns) {
      console.log(`\n=== ${campaign.name} ===`);
      console.log(`   ID: ${campaign._id}`);
      console.log(`   Status: ${campaign.status}`);
      console.log(`   totalRecipients: ${campaign.stats.totalRecipients}`);
      console.log(`   sent actual: ${campaign.stats.sent}`);
      
      if (campaign.stats.sent > campaign.stats.totalRecipients) {
        console.log(`   DOBLE CONTEO DETECTADO`);
      }
      
      const emailSendStats = await EmailSend.aggregate([
        { $match: { campaignId: new mongoose.Types.ObjectId(campaign._id) } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      
      const realStats = { total: 0, pending: 0, processing: 0, sending: 0, sent: 0, delivered: 0, failed: 0, bounced: 0 };
      emailSendStats.forEach(r => { realStats[r._id] = r.count; realStats.total += r.count; });
      
      const eventCounts = await EmailEvent.aggregate([
        { $match: { campaign: new mongoose.Types.ObjectId(campaign._id) } },
        { $group: { _id: '$eventType', count: { $sum: 1 } } }
      ]);
      const events = {};
      eventCounts.forEach(e => { events[e._id] = e.count; });
      
      const correctSent = realStats.sent + realStats.delivered;
      const correctDelivered = realStats.delivered;
      const correctFailed = realStats.failed;
      const correctBounced = realStats.bounced + (events.bounced || 0);
      
      const totalProcessed = correctSent + correctFailed + correctBounced;
      const isComplete = totalProcessed >= campaign.stats.totalRecipients && 
                        realStats.pending === 0 && realStats.processing === 0 && realStats.sending === 0;
      
      console.log(`   Sent REAL: ${correctSent}`);
      console.log(`   Procesados: ${totalProcessed}/${campaign.stats.totalRecipients}`);
      console.log(`   Completa: ${isComplete ? 'SI' : 'NO'}`);
      
      const needsCorrection = campaign.stats.sent !== correctSent || 
                             campaign.stats.delivered !== correctDelivered ||
                             (isComplete && campaign.status === 'sending');
      
      if (!needsCorrection) {
        console.log(`   OK - no requiere cambios`);
        alreadyCorrect++;
        continue;
      }
      
      const updates = {
        'stats.sent': correctSent,
        'stats.delivered': correctDelivered,
        'stats.failed': correctFailed,
        'stats.bounced': correctBounced,
        'stats.opened': events.opened || campaign.stats.opened || 0,
        'stats.clicked': events.clicked || campaign.stats.clicked || 0,
      };
      
      if (correctDelivered > 0) {
        updates['stats.openRate'] = parseFloat(((events.opened || 0) / correctDelivered * 100).toFixed(2));
        updates['stats.clickRate'] = parseFloat(((events.clicked || 0) / correctDelivered * 100).toFixed(2));
      }
      if (correctSent > 0) {
        updates['stats.bounceRate'] = parseFloat((correctBounced / correctSent * 100).toFixed(2));
      }
      if (isComplete && campaign.status === 'sending') {
        updates.status = 'sent';
      }
      
      console.log(`   Corrigiendo: sent ${campaign.stats.sent} -> ${correctSent}`);
      if (isComplete && campaign.status === 'sending') console.log(`   Status: sending -> sent`);
      
      await Campaign.findByIdAndUpdate(campaign._id, { $set: updates });
      console.log(`   CORREGIDA`);
      fixed++;
    }
    
    console.log(`\n=== COMPLETADO: ${fixed} corregidas, ${alreadyCorrect} ya correctas ===\n`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

fixCampaignStats();