// backend/scripts/testBounceModel.js
require('dotenv').config();
const mongoose = require('mongoose');
const Customer = require('../src/models/Customer');

async function testBounceManagement() {
  try {
    // Conectar a MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB\n');
    
    // ========== TEST 1: Obtener estadísticas actuales ==========
    console.log('📊 TEST 1: Estadísticas actuales de bounces');
    console.log('═'.repeat(60));
    
    const stats = await Customer.getBounceStats();
    console.log('Total customers:', stats.totalCustomers);
    console.log('Total bounced:', stats.totalBounced);
    console.log('Hard bounces:', stats.hardBounces);
    console.log('Soft bounces:', stats.softBounces);
    console.log('Bounce rate:', stats.bounceRate + '%');
    console.log('Recent bounces (7 días):', stats.recentBounces);
    console.log('\nPor status:');
    stats.byStatus.forEach(s => {
      console.log(`  ${s._id || 'sin status'}: ${s.count}`);
    });
    
    // ========== TEST 2: Simular un soft bounce ==========
    console.log('\n\n📧 TEST 2: Simular soft bounce');
    console.log('═'.repeat(60));
    
    const testCustomer = await Customer.findOne({ 
      acceptsMarketing: true,
      emailStatus: 'active'
    });
    
    if (testCustomer) {
      console.log(`Email de prueba: ${testCustomer.email}`);
      console.log(`Bounce count inicial: ${testCustomer.bounceInfo.bounceCount}`);
      
      // Simular bounce
      await testCustomer.markAsBounced('soft', 'Test bounce - mailbox full', null);
      
      // Recargar
      const updated = await Customer.findById(testCustomer._id);
      console.log(`Bounce count después: ${updated.bounceInfo.bounceCount}`);
      console.log(`Estado: ${updated.emailStatus}`);
      console.log(`Bounce type: ${updated.bounceInfo.bounceType}`);
      
    } else {
      console.log('⚠️  No se encontró customer para testing');
    }
    
    // ========== TEST 3: Listar customers at-risk ==========
    console.log('\n\n⚠️  TEST 3: Customers en riesgo (2+ soft bounces)');
    console.log('═'.repeat(60));
    
    const atRisk = await Customer.getAtRiskCustomers();
    console.log(`Encontrados: ${atRisk.length} customers`);
    
    atRisk.slice(0, 5).forEach(c => {
      console.log(`  ${c.email} - ${c.bounceInfo.bounceCount} bounces`);
    });
    
    console.log('\n✅ Tests completados\n');
    
  } catch (error) {
    console.error('❌ Error en testing:', error);
  } finally {
    await mongoose.connection.close();
    console.log('👋 Desconectado de MongoDB');
    process.exit(0);
  }
}

testBounceManagement();