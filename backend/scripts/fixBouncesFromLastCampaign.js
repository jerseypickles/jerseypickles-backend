// backend/scripts/fixBouncesFromLastCampaign.js
const mongoose = require('mongoose');
require('dotenv').config();

const Customer = require('../src/models/Customer');
const Campaign = require('../src/models/Campaign');
const EmailEvent = require('../src/models/EmailEvent');
const List = require('../src/models/List');

async function fixBouncesFromLastCampaign() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    // Tu campaña específica
    const campaignId = '692b1a61b4e57a567d3e0bd5';
    
    const campaign = await Campaign.findById(campaignId).populate('list');
    
    if (!campaign) {
      console.log('❌ Campaña no encontrada');
      return;
    }

    console.log(`\n📧 Campaña: ${campaign.name}`);
    console.log(`   Lista: ${campaign.list.name}`);
    console.log(`   Stats: ${campaign.stats.bounced} bounces, ${campaign.stats.complained} complaints`);

    // Buscar TODOS los eventos de esta campaña
    const allEvents = await EmailEvent.find({
      campaign: campaignId
    }).lean();

    console.log(`\n📊 Total de eventos: ${allEvents.length}`);

    // Agrupar por email para encontrar bounces y complaints
    const emailEvents = {};
    
    for (const event of allEvents) {
      const email = event.recipientEmail || event.email;
      
      if (!email) continue;
      
      if (!emailEvents[email]) {
        emailEvents[email] = {
          email: email,
          events: []
        };
      }
      
      emailEvents[email].events.push({
        type: event.eventType,
        date: event.eventDate,
        metadata: event.metadata
      });
    }

    console.log(`\n📧 Emails únicos con eventos: ${Object.keys(emailEvents).length}`);

    // Procesar bounces y complaints
    let bouncesProcessed = 0;
    let complaintsProcessed = 0;
    let notFound = 0;

    for (const [email, data] of Object.entries(emailEvents)) {
      const hasBounce = data.events.some(e => e.type === 'bounced');
      const hasComplaint = data.events.some(e => e.type === 'complained');
      
      if (!hasBounce && !hasComplaint) continue;

      // Buscar customer por email
      const customer = await Customer.findOne({ 
        email: email.toLowerCase().trim() 
      });

      if (!customer) {
        console.log(`⚠️  Customer no encontrado: ${email}`);
        notFound++;
        continue;
      }

      // Procesar bounce
      if (hasBounce) {
        const bounceEvent = data.events.find(e => e.type === 'bounced');
        const bounceMessage = bounceEvent?.metadata?.message || 
                             bounceEvent?.metadata?.error || 
                             'Bounce from campaign';
        
        // Determinar si es hard o soft bounce
        const hardBounceIndicators = [
          'permanent', 'does not exist', 'invalid', 'unknown user',
          'no such user', 'mailbox not found', 'address rejected',
          'user unknown', 'domain not found', 'recipient address rejected'
        ];
        
        const isHardBounce = hardBounceIndicators.some(indicator => 
          bounceMessage.toLowerCase().includes(indicator)
        );
        
        const bounceType = isHardBounce ? 'hard' : 'soft';
        
        // Solo marcar si no está ya marcado
        if (!customer.bounceInfo?.isBounced) {
          await customer.markAsBounced(bounceType, bounceMessage, campaignId);
          console.log(`✅ Bounce marcado: ${email} (${bounceType})`);
          bouncesProcessed++;
        } else {
          console.log(`⏭️  Ya bounced: ${email}`);
        }
      }

      // Procesar complaint
      if (hasComplaint && customer.emailStatus !== 'complained') {
        customer.emailStatus = 'complained';
        await customer.save();
        console.log(`✅ Complaint marcado: ${email}`);
        complaintsProcessed++;
      }
    }

    console.log(`\n📊 Resumen Final:`);
    console.log(`   ✅ Bounces procesados: ${bouncesProcessed}`);
    console.log(`   ✅ Complaints procesados: ${complaintsProcessed}`);
    console.log(`   ⚠️  No encontrados: ${notFound}`);

    // Verificación final
    const totalBounced = await Customer.countDocuments({
      'bounceInfo.isBounced': true
    });
    
    const totalComplained = await Customer.countDocuments({
      emailStatus: 'complained'
    });

    const hardBounces = await Customer.countDocuments({
      'bounceInfo.bounceType': 'hard'
    });

    const softBounces = await Customer.countDocuments({
      'bounceInfo.bounceType': 'soft'
    });

    console.log(`\n🔍 Estado Global de la Base de Datos:`);
    console.log(`   🔴 Total Bounced: ${totalBounced}`);
    console.log(`   🔴 Hard Bounces: ${hardBounces}`);
    console.log(`   🟡 Soft Bounces: ${softBounces}`);
    console.log(`   💜 Complained: ${totalComplained}`);

    // Estado de la lista específica
    const list = campaign.list;
    const listBounced = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.isBounced': true
    });

    const listComplained = await Customer.countDocuments({
      _id: { $in: list.members },
      emailStatus: 'complained'
    });

    console.log(`\n📋 Estado de la Lista "${list.name}":`);
    console.log(`   👥 Total miembros: ${list.memberCount}`);
    console.log(`   🔴 Bounced: ${listBounced}`);
    console.log(`   💜 Complained: ${listComplained}`);
    console.log(`   ✅ Limpios: ${list.memberCount - listBounced - listComplained}`);

    mongoose.connection.close();
    console.log('\n✅ Proceso completado');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

fixBouncesFromLastCampaign();