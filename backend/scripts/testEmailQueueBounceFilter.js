// backend/scripts/testEmailQueueBounceFilter.js
require('dotenv').config();
const mongoose = require('mongoose');
const Customer = require('../src/models/Customer');

async function testBounceFilter() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB\n');
    
    console.log('🧪 TEST: Simular filtrado de bounces en email queue');
    console.log('═'.repeat(60));
    
    // 1. Marcar 2 customers como bounced
    const customers = await Customer.find({ 
      acceptsMarketing: true 
    }).limit(2);
    
    if (customers.length < 2) {
      console.log('❌ No hay suficientes customers para testing');
      return;
    }
    
    const [customer1, customer2] = customers;
    
    console.log(`\n📧 Customer 1: ${customer1.email}`);
    console.log(`   Status actual: ${customer1.emailStatus}`);
    
    console.log(`\n📧 Customer 2: ${customer2.email}`);
    console.log(`   Status actual: ${customer2.emailStatus}`);
    
    // Marcar customer1 como bounced
    await customer1.markAsBounced('hard', 'Test - permanent failure', null);
    console.log(`\n✅ ${customer1.email} marcado como BOUNCED`);
    
    // customer2 queda active
    console.log(`✅ ${customer2.email} permanece ACTIVE`);
    
    // 2. Simular el filtrado
    console.log('\n\n🔄 Simulando procesamiento del queue...\n');
    
    const recipients = [
      { email: customer1.email, customerId: customer1._id },
      { email: customer2.email, customerId: customer2._id }
    ];
    
    let sent = 0;
    let skippedBounced = 0;
    
    for (const recipient of recipients) {
      const customer = await Customer.findOne({ 
        email: recipient.email.toLowerCase().trim() 
      }).select('emailStatus bounceInfo email').lean();
      
      if (customer) {
        if (customer.emailStatus === 'bounced' || customer.bounceInfo?.isBounced === true) {
          console.log(`   ⏭️  SKIPPED (bounced): ${recipient.email}`);
          skippedBounced++;
          continue;
        }
      }
      
      console.log(`   ✅ WOULD SEND: ${recipient.email}`);
      sent++;
    }
    
    console.log('\n\n📊 RESULTADOS:');
    console.log('═'.repeat(60));
    console.log(`   Total recipients: ${recipients.length}`);
    console.log(`   Would send: ${sent}`);
    console.log(`   Skipped (bounced): ${skippedBounced}`);
    
    if (sent === 1 && skippedBounced === 1) {
      console.log('\n✅ ¡FILTRADO FUNCIONA CORRECTAMENTE!');
      console.log('   - Emails bounced son detectados y saltados');
      console.log('   - Emails active se procesan normalmente');
    } else {
      console.log('\n❌ ERROR en filtrado');
    }
    
    // Cleanup
    await customer1.resetBounceInfo();
    console.log(`\n🧹 ${customer1.email} reseteado`);
    
    console.log('\n✅ Test completado\n');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

testBounceFilter();