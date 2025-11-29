// backend/scripts/fixIsBounced.js
const mongoose = require('mongoose');
require('dotenv').config();

const Customer = require('../src/models/Customer');

async function fixIsBounced() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    // Buscar todos los customers con bounceType pero isBounced = false
    const customersToFix = await Customer.find({
      'bounceInfo.bounceType': { $exists: true },
      'bounceInfo.isBounced': false
    });

    console.log(`\n🔍 Encontrados ${customersToFix.length} customers con isBounced = false`);

    let fixed = 0;

    for (const customer of customersToFix) {
      // Setear isBounced = true
      customer.bounceInfo.isBounced = true;
      
      // También actualizar emailStatus
      customer.emailStatus = 'bounced';
      
      await customer.save();
      
      fixed++;
      
      if (fixed % 50 === 0) {
        console.log(`   Procesados: ${fixed}/${customersToFix.length}`);
      }
    }

    console.log(`\n✅ Actualizados ${fixed} customers`);

    // Verificación
    const verification = await Customer.countDocuments({
      'bounceInfo.isBounced': true
    });

    console.log(`\n🔍 Verificación:`);
    console.log(`   Total con isBounced: true → ${verification}`);

    mongoose.connection.close();
    console.log('\n✅ Fix completado');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

fixIsBounced();