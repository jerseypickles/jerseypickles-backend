// backend/scripts/recalculate-all-segments.js
// Script para recalcular todos los segmentos con las nuevas reglas
require('dotenv').config();
const mongoose = require('mongoose');

async function recalculateSegments() {
  try {
    console.log('🔄 Recalculando todos los segmentos...\n');
    
    await mongoose.connect(process.env.MONGODB_URI);
    
    const Segment = require('../src/models/Segment');
    const Customer = require('../src/models/Customer');
    
    const segments = await Segment.find();
    
    console.log(`📊 Total de segmentos: ${segments.length}\n`);
    
    for (const segment of segments) {
      console.log(`🔄 Recalculando: ${segment.name}`);
      
      const query = segment.buildQuery();
      const count = await Customer.countDocuments(query);
      
      segment.customerCount = count;
      segment.lastCalculated = new Date();
      await segment.save();
      
      console.log(`   ✅ ${count} clientes\n`);
    }
    
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║  ✅ RECÁLCULO COMPLETADO                      ║');
    console.log('╚═══════════════════════════════════════════════╝\n');
    
    // Mostrar resumen
    console.log('📋 Resumen:');
    const updatedSegments = await Segment.find().sort({ customerCount: -1 });
    updatedSegments.forEach(seg => {
      console.log(`   ${seg.name}: ${seg.customerCount} clientes`);
    });
    console.log('');
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Conexión cerrada\n');
  }
}

// Ejecutar
recalculateSegments();