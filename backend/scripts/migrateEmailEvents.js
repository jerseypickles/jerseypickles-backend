// backend/scripts/migrateEmailEvents.js
const mongoose = require('mongoose');
require('dotenv').config();

async function migrateEmailEvents() {
  try {
    console.log('🔗 Conectando a MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    
    const EmailEvent = require('../src/models/EmailEvent');
    
    console.log('📊 Migrando datos existentes...\n');
    
    // 1. Mover resendId a metadata.resendEventId
    const updateResult = await EmailEvent.updateMany(
      { 
        resendId: { $exists: true, $ne: null },
        'metadata.resendEventId': { $exists: false }
      },
      [
        {
          $set: {
            'metadata.resendEventId': '$resendId'
          }
        }
      ]
    );
    
    console.log(`✅ Migrados ${updateResult.modifiedCount} documentos con resendId`);
    
    // 2. Crear todos los índices
    console.log('\n📋 Creando índices...');
    await EmailEvent.createIndexes();
    console.log('✅ Índices creados');
    
    // 3. Verificar índices
    const indexes = await EmailEvent.collection.getIndexes();
    console.log('\n📋 Índices activos:');
    Object.keys(indexes).forEach((name, i) => {
      console.log(`   ${i + 1}. ${name}`);
    });
    
    // 4. Eliminar duplicados existentes (si hay)
    console.log('\n🧹 Buscando duplicados...');
    
    const duplicates = await EmailEvent.aggregate([
      {
        $match: {
          'metadata.resendEventId': { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: {
            resendEventId: '$metadata.resendEventId',
            eventType: '$eventType'
          },
          count: { $sum: 1 },
          ids: { $push: '$_id' }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ]);
    
    console.log(`⚠️  Encontrados ${duplicates.length} grupos de duplicados`);
    
    if (duplicates.length > 0) {
      console.log('\n🗑️  Eliminando duplicados (manteniendo el más antiguo)...');
      
      let deletedCount = 0;
      
      for (const dup of duplicates) {
        // Mantener el primero (más antiguo), eliminar el resto
        const idsToDelete = dup.ids.slice(1);
        
        await EmailEvent.deleteMany({
          _id: { $in: idsToDelete }
        });
        
        deletedCount += idsToDelete.length;
      }
      
      console.log(`✅ Eliminados ${deletedCount} eventos duplicados`);
    }
    
    // 5. Estadísticas finales
    const stats = await EmailEvent.collection.stats();
    console.log('\n📈 Estadísticas finales:');
    console.log(`   📄 Documentos: ${stats.count.toLocaleString()}`);
    console.log(`   💾 Tamaño colección: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   🗂️  Tamaño índices: ${(stats.totalIndexSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   📊 Índices totales: ${stats.nindexes}`);
    
    await mongoose.disconnect();
    console.log('\n✅ Migración completada exitosamente!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error en migración:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

migrateEmailEvents();