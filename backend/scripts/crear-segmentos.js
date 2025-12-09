// backend/scripts/crear-segmentos.js
// Ejecutar: node backend/scripts/crear-segmentos.js

require('dotenv').config();
const mongoose = require('mongoose');

// Importar después de configurar
const Segment = require('../src/models/Segment');
const segmentationService = require('../src/services/segmentationService');

async function crearSegmentos() {
  try {
    console.log('🔌 Conectando a MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado!\n');
    
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║        🎯 CREANDO SEGMENTOS PREDEFINIDOS                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    const results = await segmentationService.createAllPredefinedSegments();
    
    // Mostrar resultados
    console.log('📊 RESULTADOS');
    console.log('─'.repeat(60));
    
    const created = [];
    const updated = [];
    const errors = [];
    
    results.forEach(r => {
      if (r.action === 'created') {
        created.push(r);
        console.log(`   ✅ CREADO: ${r.key} (${r.count.toLocaleString()} clientes)`);
      } else if (r.action === 'updated') {
        updated.push(r);
        console.log(`   🔄 ACTUALIZADO: ${r.key} (${r.count.toLocaleString()} clientes)`);
      } else {
        errors.push(r);
        console.log(`   ❌ ERROR: ${r.key} - ${r.error}`);
      }
    });
    
    // Resumen
    console.log('\n' + '═'.repeat(60));
    console.log('📋 RESUMEN');
    console.log('─'.repeat(60));
    console.log(`   Creados:      ${created.length}`);
    console.log(`   Actualizados: ${updated.length}`);
    console.log(`   Errores:      ${errors.length}`);
    console.log(`   Total:        ${results.length}`);
    
    // Mostrar tabla de segmentos con conteos
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║              📊 SEGMENTOS DISPONIBLES                      ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    const segments = await Segment.find({ isPredefined: true, isActive: true })
      .sort({ category: 1, customerCount: -1 });
    
    let currentCategory = '';
    segments.forEach(s => {
      if (s.category !== currentCategory) {
        currentCategory = s.category;
        console.log(`\n   📁 ${currentCategory.toUpperCase()}`);
        console.log('   ' + '─'.repeat(50));
      }
      const countStr = s.customerCount.toLocaleString().padStart(10);
      console.log(`      ${s.name.padEnd(30)} ${countStr} clientes`);
    });
    
    console.log('\n\n✅ Proceso completado!\n');
    
    await mongoose.connection.close();
    console.log('🔌 Conexión cerrada.');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

crearSegmentos();