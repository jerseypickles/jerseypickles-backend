// backend/scripts/diagnosticBounces.js
const mongoose = require('mongoose');
require('dotenv').config();

const Customer = require('../src/models/Customer');
const List = require('../src/models/List');

async function diagnosticBounces() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    const listId = '691ea301906f6e3d4cfc95b7';
    const list = await List.findById(listId);

    console.log(`\n📋 Lista: ${list.name}`);
    console.log(`   Total miembros: ${list.memberCount}`);

    // 1. Contar por emailStatus
    console.log(`\n📊 Por emailStatus:`);
    const byStatus = await Customer.aggregate([
      { $match: { _id: { $in: list.members } } },
      { $group: { _id: '$emailStatus', count: { $sum: 1 } } }
    ]);
    byStatus.forEach(s => console.log(`   ${s._id || 'null'}: ${s.count}`));

    // 2. Contar por bounceInfo.isBounced
    console.log(`\n📊 Por bounceInfo.isBounced:`);
    const isBounced = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.isBounced': true
    });
    console.log(`   true: ${isBounced}`);

    const notBounced = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.isBounced': { $ne: true }
    });
    console.log(`   false/null: ${notBounced}`);

    // 3. Contar por bounceType
    console.log(`\n📊 Por bounceType:`);
    const hard = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.bounceType': 'hard'
    });
    console.log(`   hard: ${hard}`);

    const soft = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.bounceType': 'soft'
    });
    console.log(`   soft: ${soft}`);

    const noBounceType = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.bounceType': { $exists: false }
    });
    console.log(`   sin bounceType: ${noBounceType}`);

    // 4. Ver ejemplos de customers con bounceInfo
    console.log(`\n📋 Ejemplos de customers con bounceInfo:`);
    const examples = await Customer.find({
      _id: { $in: list.members },
      'bounceInfo.bounceType': 'soft'
    })
    .select('email emailStatus bounceInfo')
    .limit(5)
    .lean();

    examples.forEach(c => {
      console.log(`\n   Email: ${c.email}`);
      console.log(`   Status: ${c.emailStatus}`);
      console.log(`   BounceInfo:`, JSON.stringify(c.bounceInfo, null, 2));
    });

    // 5. Ver ejemplos de customers SIN bounceInfo (que deberían tenerlo)
    console.log(`\n📋 Ejemplos de customers SIN bounceInfo:`);
    const noBounceInfo = await Customer.find({
      _id: { $in: list.members },
      $or: [
        { bounceInfo: { $exists: false } },
        { 'bounceInfo.bounceType': { $exists: false } }
      ]
    })
    .select('email emailStatus bounceInfo')
    .limit(5)
    .lean();

    noBounceInfo.forEach(c => {
      console.log(`\n   Email: ${c.email}`);
      console.log(`   Status: ${c.emailStatus}`);
      console.log(`   BounceInfo:`, c.bounceInfo || 'NO EXISTE');
    });

    // 6. Query exacto que usa getHealth()
    console.log(`\n📊 Query exacto de getHealth():`);
    
    const bouncedCount = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.isBounced': true
    });
    console.log(`   bounceInfo.isBounced: true → ${bouncedCount}`);

    const hardBounces = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.bounceType': 'hard'
    });
    console.log(`   bounceInfo.bounceType: 'hard' → ${hardBounces}`);

    const softBounces = await Customer.countDocuments({
      _id: { $in: list.members },
      'bounceInfo.bounceType': 'soft'
    });
    console.log(`   bounceInfo.bounceType: 'soft' → ${softBounces}`);

    // 7. Ver la estructura del campo bounceInfo
    console.log(`\n🔍 Estructura de bounceInfo en un customer:`);
    const oneExample = await Customer.findOne({
      _id: { $in: list.members },
      'bounceInfo.bounceType': 'soft'
    }).lean();

    if (oneExample) {
      console.log(JSON.stringify(oneExample, null, 2));
    }

    mongoose.connection.close();
    console.log('\n✅ Diagnóstico completado');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

diagnosticBounces();