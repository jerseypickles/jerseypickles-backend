// backend/scripts/testBounceSystem.js
require('dotenv').config();
const mongoose = require('mongoose');
const Customer = require('../src/models/Customer');
const List = require('../src/models/List');

async function testBounceSystem() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB\n');
    
    // ========== TEST 1: Encontrar un customer de prueba ==========
    console.log('🔍 TEST 1: Buscando customer de prueba');
    console.log('═'.repeat(60));
    
    let testCustomer = await Customer.findOne({ 
      email: 'cgibbs9946@aol.com'
    });
    
    if (!testCustomer) {
      console.log('⚠️  Customer cgibbs9946@aol.com no encontrado');
      console.log('   Buscando otro customer...');
      testCustomer = await Customer.findOne({ acceptsMarketing: true });
    }
    
    if (!testCustomer) {
      console.log('❌ No se encontró ningún customer para testing');
      return;
    }
    
    console.log(`✅ Customer encontrado: ${testCustomer.email}`);
    console.log(`   ID: ${testCustomer._id}`);
    console.log(`   Status actual: ${testCustomer.emailStatus}`);
    console.log(`   Bounce count: ${testCustomer.bounceInfo.bounceCount}`);
    
    // ========== TEST 2: Agregar a una lista de prueba ==========
    console.log('\n\n📋 TEST 2: Crear lista de prueba');
    console.log('═'.repeat(60));
    
    let testList = await List.findOne({ name: 'Test Bounce List' });
    
    if (!testList) {
      testList = await List.create({
        name: 'Test Bounce List',
        description: 'Lista temporal para testing de bounces',
        members: [testCustomer._id],
        memberCount: 1,
        isActive: true
      });
      console.log(`✅ Lista creada: ${testList.name} (ID: ${testList._id})`);
    } else {
      if (!testList.members.includes(testCustomer._id)) {
        testList.members.push(testCustomer._id);
        testList.memberCount = testList.members.length;
        await testList.save();
      }
      console.log(`✅ Lista encontrada: ${testList.name} (ID: ${testList._id})`);
    }
    
    console.log(`   Miembros en la lista: ${testList.memberCount}`);
    
    // ========== TEST 3: Simular SOFT BOUNCE ==========
    console.log('\n\n⚠️  TEST 3: Simular SOFT BOUNCE #1');
    console.log('═'.repeat(60));
    
    await testCustomer.markAsBounced(
      'soft',
      'Mailbox full - temporary failure',
      null
    );
    
    // Recargar
    testCustomer = await Customer.findById(testCustomer._id);
    console.log(`✅ Bounce count: ${testCustomer.bounceInfo.bounceCount}`);
    console.log(`   Status: ${testCustomer.emailStatus}`);
    console.log(`   Bounce type: ${testCustomer.bounceInfo.bounceType}`);
    
    // Verificar que NO se removió de la lista
    testList = await List.findById(testList._id);
    console.log(`   En lista: ${testList.members.includes(testCustomer._id) ? 'SÍ' : 'NO'}`);
    
    // ========== TEST 4: Simular SOFT BOUNCE #2 ==========
    console.log('\n\n⚠️  TEST 4: Simular SOFT BOUNCE #2');
    console.log('═'.repeat(60));
    
    await testCustomer.markAsBounced(
      'soft',
      'Mailbox full - temporary failure',
      null
    );
    
    testCustomer = await Customer.findById(testCustomer._id);
    console.log(`✅ Bounce count: ${testCustomer.bounceInfo.bounceCount}`);
    console.log(`   Status: ${testCustomer.emailStatus}`);
    console.log(`   Bounce type: ${testCustomer.bounceInfo.bounceType}`);
    
    testList = await List.findById(testList._id);
    console.log(`   En lista: ${testList.members.includes(testCustomer._id) ? 'SÍ' : 'NO'}`);
    
    // ========== TEST 5: Simular SOFT BOUNCE #3 (conversión a HARD) ==========
    console.log('\n\n🚫 TEST 5: Simular SOFT BOUNCE #3 (debería convertirse a HARD)');
    console.log('═'.repeat(60));
    
    await testCustomer.markAsBounced(
      'soft',
      'Mailbox full - temporary failure',
      null
    );
    
    testCustomer = await Customer.findById(testCustomer._id);
    console.log(`✅ Bounce count: ${testCustomer.bounceInfo.bounceCount}`);
    console.log(`   Status: ${testCustomer.emailStatus}`);
    console.log(`   Bounce type: ${testCustomer.bounceInfo.bounceType}`);
    console.log(`   Is bounced: ${testCustomer.bounceInfo.isBounced}`);
    
    // Verificar que SÍ se removió de la lista
    testList = await List.findById(testList._id);
    const stillInList = testList.members.some(id => id.equals(testCustomer._id));
    console.log(`   En lista: ${stillInList ? 'SÍ ❌' : 'NO ✅'}`);
    console.log(`   Miembros en lista: ${testList.memberCount}`);
    
    // ========== TEST 6: Intentar HARD BOUNCE directo ==========
    console.log('\n\n🚫 TEST 6: Simular HARD BOUNCE directo en otro customer');
    console.log('═'.repeat(60));
    
    let testCustomer2 = await Customer.findOne({ 
      email: { $ne: testCustomer.email },
      acceptsMarketing: true,
      emailStatus: 'active'
    });
    
    if (testCustomer2) {
      // Agregar a la lista
      testList.members.push(testCustomer2._id);
      testList.memberCount = testList.members.length;
      await testList.save();
      
      console.log(`✅ Segundo customer: ${testCustomer2.email}`);
      console.log(`   Agregado a lista (miembros: ${testList.memberCount})`);
      
      // Hard bounce directo
      await testCustomer2.markAsBounced(
        'hard',
        'Address does not exist - permanent failure',
        null
      );
      
      testCustomer2 = await Customer.findById(testCustomer2._id);
      console.log(`✅ Bounce count: ${testCustomer2.bounceInfo.bounceCount}`);
      console.log(`   Status: ${testCustomer2.emailStatus}`);
      console.log(`   Bounce type: ${testCustomer2.bounceInfo.bounceType}`);
      
      testList = await List.findById(testList._id);
      const inList = testList.members.some(id => id.equals(testCustomer2._id));
      console.log(`   En lista: ${inList ? 'SÍ ❌' : 'NO ✅'}`);
      console.log(`   Miembros en lista ahora: ${testList.memberCount}`);
    }
    
    // ========== TEST 7: Estadísticas finales ==========
    console.log('\n\n📊 TEST 7: Estadísticas finales del sistema');
    console.log('═'.repeat(60));
    
    const stats = await Customer.getBounceStats();
    console.log(`Total customers: ${stats.totalCustomers.toLocaleString()}`);
    console.log(`Total bounced: ${stats.totalBounced}`);
    console.log(`Hard bounces: ${stats.hardBounces}`);
    console.log(`Soft bounces: ${stats.softBounces}`);
    console.log(`Bounce rate: ${stats.bounceRate}%`);
    
    // ========== CLEANUP: Resetear customers de prueba ==========
    console.log('\n\n🧹 CLEANUP: Reseteando customers de prueba');
    console.log('═'.repeat(60));
    
    await testCustomer.resetBounceInfo();
    console.log(`✅ ${testCustomer.email} reseteado`);
    
    if (testCustomer2) {
      await testCustomer2.resetBounceInfo();
      console.log(`✅ ${testCustomer2.email} reseteado`);
    }
    
    // Eliminar lista de prueba
    await List.findByIdAndDelete(testList._id);
    console.log(`✅ Lista de prueba eliminada`);
    
    console.log('\n✅ TODOS LOS TESTS COMPLETADOS\n');
    
  } catch (error) {
    console.error('❌ Error en testing:', error);
  } finally {
    await mongoose.connection.close();
    console.log('👋 Desconectado de MongoDB');
    process.exit(0);
  }
}

testBounceSystem();