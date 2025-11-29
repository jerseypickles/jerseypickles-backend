// backend/scripts/fixIsBounced.js - VERSIÓN FINAL
const mongoose = require('mongoose');
require('dotenv').config();

const Customer = require('../src/models/Customer');
const List = require('../src/models/List');  // ✅ AGREGAR ESTO

async function fixIsBounced() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    console.log('\n🔍 Buscando customers con bounceType pero isBounced = false...');

    // Contar cuántos hay (con email válido)
    const count = await Customer.countDocuments({
      email: { $exists: true, $ne: null },
      'bounceInfo.bounceType': { $exists: true, $ne: null },
      'bounceInfo.isBounced': false
    });

    console.log(`📊 Encontrados ${count.toLocaleString()} customers para actualizar`);

    if (count === 0) {
      console.log('✅ No hay customers para actualizar');
      mongoose.connection.close();
      return;
    }

    // Usar updateMany para actualizar todo de una vez
    const result = await Customer.updateMany(
      {
        email: { $exists: true, $ne: null },
        'bounceInfo.bounceType': { $exists: true, $ne: null },
        'bounceInfo.isBounced': false
      },
      {
        $set: {
          'bounceInfo.isBounced': true,
          'emailStatus': 'bounced'
        }
      }
    );

    console.log(`\n✅ Actualización completada:`);
    console.log(`   Documentos modificados: ${result.modifiedCount.toLocaleString()}`);
    console.log(`   Documentos encontrados: ${result.matchedCount.toLocaleString()}`);

    // Verificación por tipo de bounce
    console.log(`\n🔍 Verificación por tipo de bounce:`);
    
    const hardCount = await Customer.countDocuments({
      'bounceInfo.bounceType': 'hard',
      'bounceInfo.isBounced': true
    });
    
    const softCount = await Customer.countDocuments({
      'bounceInfo.bounceType': 'soft',
      'bounceInfo.isBounced': true
    });

    console.log(`   🔴 Hard Bounces: ${hardCount.toLocaleString()}`);
    console.log(`   🟡 Soft Bounces: ${softCount.toLocaleString()}`);
    console.log(`   📊 Total Bounced: ${(hardCount + softCount).toLocaleString()}`);

    // Verificar por emailStatus
    console.log(`\n🔍 Verificación por emailStatus:`);
    
    const byStatus = await Customer.aggregate([
      {
        $group: {
          _id: '$emailStatus',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    byStatus.forEach(s => {
      console.log(`   ${s._id || 'null'}: ${s.count.toLocaleString()}`);
    });

    // Verificación de la lista específica
    const listId = '691ea301906f6e3d4cfc95b7';
    const list = await List.findById(listId);

    if (list) {
      console.log(`\n📋 Estado de la Lista "${list.name}":`);
      console.log(`   Total miembros: ${list.memberCount.toLocaleString()}`);

      const listBounced = await Customer.countDocuments({
        _id: { $in: list.members },
        'bounceInfo.isBounced': true
      });

      const listHard = await Customer.countDocuments({
        _id: { $in: list.members },
        'bounceInfo.bounceType': 'hard',
        'bounceInfo.isBounced': true
      });

      const listSoft = await Customer.countDocuments({
        _id: { $in: list.members },
        'bounceInfo.bounceType': 'soft',
        'bounceInfo.isBounced': true
      });

      const listActive = await Customer.countDocuments({
        _id: { $in: list.members },
        emailStatus: 'active'
      });

      const healthScore = ((listActive / list.memberCount) * 100).toFixed(1);

      console.log(`   ✅ Active: ${listActive.toLocaleString()}`);
      console.log(`   🔴 Bounced: ${listBounced}`);
      console.log(`      - Hard: ${listHard}`);
      console.log(`      - Soft: ${listSoft}`);
      console.log(`   📊 Health Score: ${healthScore}%`);
      console.log(`   🎯 Bounce Rate: ${((listBounced / list.memberCount) * 100).toFixed(2)}%`);
    }

    mongoose.connection.close();
    console.log('\n✅ Fix completado exitosamente\n');
    
  } catch (error) {
    console.error('❌ Error:', error);
    mongoose.connection.close();
    process.exit(1);
  }
}

fixIsBounced();