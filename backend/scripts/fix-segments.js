// backend/scripts/fix-segments.js
// Script para corregir segmentos sin slug
require('dotenv').config();
const mongoose = require('mongoose');

// Función helper para crear slug
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

async function fixSegments() {
  try {
    console.log('🔧 Corrigiendo segmentos...\n');
    
    await mongoose.connect(process.env.MONGODB_URI);
    
    const db = mongoose.connection.db;
    const segmentsCollection = db.collection('segments');
    
    // 1. Buscar segmentos sin slug o con slug null
    const problematicSegments = await segmentsCollection.find({
      $or: [
        { slug: null },
        { slug: { $exists: false } }
      ]
    }).toArray();
    
    console.log(`📊 Segmentos sin slug: ${problematicSegments.length}\n`);
    
    if (problematicSegments.length === 0) {
      console.log('✅ No hay segmentos problemáticos\n');
      return;
    }
    
    // 2. Opción A: Eliminarlos todos (más fácil)
    console.log('🗑️  Opción: Eliminar todos los segmentos sin slug...\n');
    
    const deleteResult = await segmentsCollection.deleteMany({
      $or: [
        { slug: null },
        { slug: { $exists: false } }
      ]
    });
    
    console.log(`✅ ${deleteResult.deletedCount} segmentos eliminados\n`);
    
    // 3. Verificar índice
    const indexes = await segmentsCollection.indexes();
    console.log('📋 Índices actuales:');
    indexes.forEach(idx => {
      console.log(`   - ${idx.name}: ${JSON.stringify(idx.key)}`);
    });
    
    const slugIndex = indexes.find(idx => idx.name === 'slug_1');
    if (slugIndex) {
      console.log('\n✅ Índice slug_1 existe y está funcionando correctamente\n');
    }
    
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║  ✅ CORRECCIÓN DE SEGMENTOS COMPLETADA       ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log('\n🎯 Ahora puedes crear los segmentos predefinidos de nuevo\n');
    console.log('POST /api/segments/predefined/create-all\n');
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Conexión cerrada\n');
  }
}

// Ejecutar
fixSegments();