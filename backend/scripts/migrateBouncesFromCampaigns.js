// backend/scripts/migrateBouncesFromCampaigns.js
const mongoose = require('mongoose');
require('dotenv').config();

const Customer = require('../src/models/Customer');
const Campaign = require('../src/models/Campaign');
const EmailEvent = require('../src/models/EmailEvent');

async function migrateBouncesFromCampaigns() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    // Buscar todos los eventos de bounce y complaint
    const bounceEvents = await EmailEvent.find({
      eventType: { $in: ['bounced', 'complained'] }
    }).populate('customer campaign');

    console.log(`\n📊 Encontrados ${bounceEvents.length} eventos de bounce/complaint`);

    let processed = 0;
    let skipped = 0;

    for (const event of bounceEvents) {
      if (!event.customer) {
        console.log(`⚠️  Evento sin customer: ${event._id}`);
        skipped++;
        continue;
      }

      const customer = await Customer.findById(event.customer._id);
      
      if (!customer) {
        console.log(`⚠️  Customer no encontrado: ${event.customer._id}`);
        skipped++;
        continue;
      }

      if (event.eventType === 'bounced') {
        // Determinar tipo de bounce
        const bounceMessage = event.metadata?.message || '';
        const isHardBounce = /permanent|does not exist|invalid|unknown user|no such user|mailbox not found/i.test(bounceMessage);
        
        const bounceType = isHardBounce ? 'hard' : 'soft';
        
        // Marcar como bounced
        await customer.markAsBounced(
          bounceType,
          bounceMessage,
          event.campaign?._id
        );
        
        console.log(`✅ Bounce marcado: ${customer.email} (${bounceType})`);
        processed++;
        
      } else if (event.eventType === 'complained') {
        // Marcar como complained
        customer.emailStatus = 'complained';
        await customer.save();
        
        console.log(`✅ Complaint marcado: ${customer.email}`);
        processed++;
      }
    }

    console.log(`\n📊 Resumen de Migración:`);
    console.log(`   ✅ Procesados: ${processed}`);
    console.log(`   ⏭️  Saltados: ${skipped}`);
    console.log(`   📧 Total: ${bounceEvents.length}`);

    // Verificar resultados
    const bouncedCount = await Customer.countDocuments({
      'bounceInfo.isBounced': true
    });
    
    const complainedCount = await Customer.countDocuments({
      emailStatus: 'complained'
    });

    console.log(`\n🔍 Verificación Final:`);
    console.log(`   🔴 Bounced: ${bouncedCount}`);
    console.log(`   💜 Complained: ${complainedCount}`);

    mongoose.connection.close();
    console.log('\n✅ Migración completada');
    
  } catch (error) {
    console.error('❌ Error en migración:', error);
    process.exit(1);
  }
}

migrateBouncesFromCampaigns();