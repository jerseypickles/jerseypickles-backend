// backend/scripts/migrateCustomersBounceFields.js
require('dotenv').config();
const mongoose = require('mongoose');
const Customer = require('../src/models/Customer');

async function migrateCustomers() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB\n');
    
    console.log('🔄 MIGRACIÓN DE BOUNCE FIELDS');
    console.log('═'.repeat(60));
    
    // Contar customers sin emailStatus
    const needsMigration = await Customer.countDocuments({
      $or: [
        { emailStatus: { $exists: false } },
        { emailStatus: null }
      ]
    });
    
    console.log(`📊 Customers a migrar: ${needsMigration.toLocaleString()}`);
    
    if (needsMigration === 0) {
      console.log('✅ Todos los customers ya están migrados\n');
      return;
    }
    
    const batchSize = 1000;
    let migrated = 0;
    
    console.log(`\n🚀 Migrando en batches de ${batchSize}...\n`);
    
    const startTime = Date.now();
    
    // Migrar en batches para no sobrecargar
    while (migrated < needsMigration) {
      const result = await Customer.updateMany(
        {
          $or: [
            { emailStatus: { $exists: false } },
            { emailStatus: null }
          ]
        },
        {
          $set: {
            emailStatus: 'active',
            'bounceInfo.isBounced': false,
            'bounceInfo.bounceType': null,
            'bounceInfo.bounceCount': 0
          }
        },
        { limit: batchSize }
      );
      
      migrated += result.modifiedCount;
      
      const percentage = ((migrated / needsMigration) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (migrated / elapsed).toFixed(0);
      
      console.log(`  [${percentage}%] ${migrated.toLocaleString()} / ${needsMigration.toLocaleString()} (${rate}/s)`);
      
      if (result.modifiedCount === 0) break;
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║  ✅ MIGRACIÓN COMPLETADA                  ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(`   Customers migrados: ${migrated.toLocaleString()}`);
    console.log(`   Tiempo total: ${totalTime}s`);
    console.log(`   Velocidad: ${(migrated / totalTime).toFixed(0)} docs/s`);
    
    // Verificar
    console.log('\n📊 Verificando migración...');
    const stats = await Customer.getBounceStats();
    console.log(`   Total customers: ${stats.totalCustomers.toLocaleString()}`);
    console.log(`   Status active: ${stats.byStatus.find(s => s._id === 'active')?.count || 0}`);
    console.log(`   Sin status: ${stats.byStatus.find(s => !s._id)?.count || 0}`);
    
    console.log('\n✅ Migración exitosa\n');
    
  } catch (error) {
    console.error('❌ Error en migración:', error);
  } finally {
    await mongoose.connection.close();
    console.log('👋 Desconectado de MongoDB');
    process.exit(0);
  }
}

migrateCustomers();