// backend/scripts/limpiar-y-crear-segmentos.js
// Ejecutar: node backend/scripts/limpiar-y-crear-segmentos.js

require('dotenv').config();
const mongoose = require('mongoose');

async function limpiarYCrear() {
  try {
    console.log('🔌 Conectando a MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado!\n');
    
    // Importar modelos DESPUÉS de conectar
    const Segment = require('../src/models/Segment');
    const Customer = require('../src/models/Customer');
    
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║     🧹 LIMPIEZA Y CREACIÓN DE SEGMENTOS                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    // ==================== PASO 1: LIMPIAR ====================
    console.log('🗑️  PASO 1: Eliminando segmentos existentes...');
    const deleteResult = await Segment.deleteMany({});
    console.log(`   ✅ Eliminados: ${deleteResult.deletedCount} segmentos\n`);
    
    // ==================== PASO 2: CREAR PREDEFINIDOS ====================
    console.log('🎯 PASO 2: Creando segmentos predefinidos...\n');
    
    const SEGMENTS = [
      // === PURCHASE ===
      {
        name: 'Compradores',
        slug: 'compradores',
        description: 'Clientes que han realizado al menos una compra',
        category: 'purchase',
        conditions: [{ field: 'ordersCount', operator: 'greater_than', value: 0 }]
      },
      {
        name: 'No han comprado',
        slug: 'no-compradores',
        description: 'Clientes registrados que nunca han comprado',
        category: 'purchase',
        conditions: [{ field: 'ordersCount', operator: 'equals', value: 0 }]
      },
      {
        name: 'Compradores recurrentes',
        slug: 'compradores-recurrentes',
        description: 'Clientes que han comprado 2 o más veces',
        category: 'purchase',
        conditions: [{ field: 'ordersCount', operator: 'greater_than_or_equals', value: 2 }]
      },
      {
        name: 'VIP ($200+)',
        slug: 'vip',
        description: 'Clientes que han gastado $200 o más',
        category: 'purchase',
        conditions: [{ field: 'totalSpent', operator: 'greater_than_or_equals', value: 200 }]
      },
      {
        name: 'Super VIP ($500+)',
        slug: 'super-vip',
        description: 'Clientes que han gastado $500 o más',
        category: 'purchase',
        conditions: [{ field: 'totalSpent', operator: 'greater_than_or_equals', value: 500 }]
      },
      
      // === ENGAGEMENT ===
      {
        name: 'Engaged sin compra',
        slug: 'engaged-sin-compra',
        description: 'Abrieron emails pero nunca compraron',
        category: 'engagement',
        conditions: [
          { field: 'emailStats.opened', operator: 'greater_than', value: 0 },
          { field: 'ordersCount', operator: 'equals', value: 0, logicalOperator: 'AND' }
        ]
      },
      {
        name: 'Clickers sin compra',
        slug: 'clickers-sin-compra',
        description: 'Hicieron click pero no compraron - muy cerca de convertir',
        category: 'engagement',
        conditions: [
          { field: 'emailStats.clicked', operator: 'greater_than', value: 0 },
          { field: 'ordersCount', operator: 'equals', value: 0, logicalOperator: 'AND' }
        ]
      },
      {
        name: 'Super engaged',
        slug: 'super-engaged',
        description: 'Abrieron 5+ emails',
        category: 'engagement',
        conditions: [{ field: 'emailStats.opened', operator: 'greater_than_or_equals', value: 5 }]
      },
      {
        name: 'Nunca abrieron',
        slug: 'nunca-abrieron',
        description: 'Recibieron emails pero nunca abrieron',
        category: 'engagement',
        conditions: [
          { field: 'emailStats.sent', operator: 'greater_than', value: 0 },
          { field: 'emailStats.opened', operator: 'equals', value: 0, logicalOperator: 'AND' }
        ]
      },
      
      // === POPUP ===
      {
        name: 'Popup sin convertir',
        slug: 'popup-sin-convertir',
        description: 'Suscriptores de popup que no han comprado',
        category: 'popup',
        conditions: [
          { field: 'popupDiscountCode', operator: 'exists' },
          { field: 'ordersCount', operator: 'equals', value: 0, logicalOperator: 'AND' }
        ]
      },
      {
        name: 'Popup convertidos',
        slug: 'popup-convertidos',
        description: 'Suscriptores de popup que sí compraron',
        category: 'popup',
        conditions: [
          { field: 'popupDiscountCode', operator: 'exists' },
          { field: 'ordersCount', operator: 'greater_than', value: 0, logicalOperator: 'AND' }
        ]
      },
      
      // === LIFECYCLE ===
      {
        name: 'Nuevos (30 días)',
        slug: 'nuevos-30-dias',
        description: 'Registrados en los últimos 30 días',
        category: 'lifecycle',
        conditions: [{ field: 'createdAt', operator: 'in_last_days', value: 30 }]
      },
      {
        name: 'Inactivos (90 días)',
        slug: 'inactivos-90-dias',
        description: 'Compradores que no han comprado en 90 días',
        category: 'lifecycle',
        conditions: [
          { field: 'lastOrderDate', operator: 'not_in_last_days', value: 90 },
          { field: 'ordersCount', operator: 'greater_than', value: 0, logicalOperator: 'AND' }
        ]
      },
      {
        name: 'Compradores recientes',
        slug: 'compradores-recientes',
        description: 'Compraron en los últimos 30 días',
        category: 'lifecycle',
        conditions: [{ field: 'lastOrderDate', operator: 'in_last_days', value: 30 }]
      },
      
      // === CLEANUP ===
      {
        name: 'Bounced (limpiar)',
        slug: 'bounced',
        description: 'Emails que rebotan',
        category: 'cleanup',
        conditions: [{ field: 'bounceInfo.isBounced', operator: 'equals', value: true }]
      },
      {
        name: 'Hard bounces',
        slug: 'hard-bounced',
        description: 'Hard bounces - eliminar inmediatamente',
        category: 'cleanup',
        conditions: [{ field: 'bounceInfo.bounceType', operator: 'equals', value: 'hard' }]
      },
      {
        name: 'Desuscritos',
        slug: 'unsubscribed',
        description: 'Se desuscribieron',
        category: 'cleanup',
        conditions: [{ field: 'emailStatus', operator: 'equals', value: 'unsubscribed' }]
      },
      {
        name: 'Reportaron spam',
        slug: 'complained',
        description: 'Marcaron como spam - NO enviar',
        category: 'cleanup',
        conditions: [{ field: 'emailStatus', operator: 'equals', value: 'complained' }]
      }
    ];
    
    // Función para construir query MongoDB
    const buildQuery = (conditions) => {
      if (!conditions || conditions.length === 0) return {};
      
      const mongoConditions = conditions.map(c => {
        const { field, operator, value } = c;
        
        switch (operator) {
          case 'equals': return { [field]: value };
          case 'not_equals': return { [field]: { $ne: value } };
          case 'greater_than': return { [field]: { $gt: value } };
          case 'less_than': return { [field]: { $lt: value } };
          case 'greater_than_or_equals': return { [field]: { $gte: value } };
          case 'less_than_or_equals': return { [field]: { $lte: value } };
          case 'exists': return { [field]: { $exists: true, $ne: null, $ne: '' } };
          case 'not_exists': return { $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }] };
          case 'in_last_days':
            const daysAgo = new Date();
            daysAgo.setDate(daysAgo.getDate() - parseInt(value));
            return { [field]: { $gte: daysAgo } };
          case 'not_in_last_days':
            const notDaysAgo = new Date();
            notDaysAgo.setDate(notDaysAgo.getDate() - parseInt(value));
            return { [field]: { $lt: notDaysAgo } };
          default: return {};
        }
      });
      
      return { $and: mongoConditions };
    };
    
    // Crear cada segmento
    const results = [];
    
    for (const def of SEGMENTS) {
      try {
        // Contar clientes
        const query = buildQuery(def.conditions);
        const count = await Customer.countDocuments(query);
        
        // Crear segmento
        const segment = new Segment({
          ...def,
          type: 'predefined',
          isPredefined: true,
          isActive: true,
          customerCount: count,
          lastCalculated: new Date()
        });
        
        await segment.save();
        results.push({ name: def.name, category: def.category, count, success: true });
        
      } catch (error) {
        results.push({ name: def.name, error: error.message, success: false });
      }
    }
    
    // ==================== MOSTRAR RESULTADOS ====================
    console.log('📊 SEGMENTOS CREADOS');
    console.log('═'.repeat(60) + '\n');
    
    const categories = ['purchase', 'engagement', 'popup', 'lifecycle', 'cleanup'];
    
    for (const cat of categories) {
      const catResults = results.filter(r => r.category === cat && r.success);
      if (catResults.length > 0) {
        console.log(`   📁 ${cat.toUpperCase()}`);
        console.log('   ' + '─'.repeat(50));
        catResults.forEach(r => {
          const countStr = r.count.toLocaleString().padStart(10);
          console.log(`      ${r.name.padEnd(28)} ${countStr} clientes`);
        });
        console.log('');
      }
    }
    
    // Errores
    const errors = results.filter(r => !r.success);
    if (errors.length > 0) {
      console.log('   ❌ ERRORES');
      errors.forEach(e => console.log(`      ${e.name}: ${e.error}`));
      console.log('');
    }
    
    // Resumen
    const successful = results.filter(r => r.success).length;
    console.log('═'.repeat(60));
    console.log(`✅ ${successful} segmentos creados exitosamente`);
    console.log('═'.repeat(60) + '\n');
    
    await mongoose.connection.close();
    console.log('🔌 Conexión cerrada.');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

limpiarYCrear();