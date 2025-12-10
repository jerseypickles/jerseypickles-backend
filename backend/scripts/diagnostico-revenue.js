// diagnostico-revenue.js
// Ejecutar: node diagnostico-revenue.js
// Este script diagnostica por qué el revenue no se está atribuyendo correctamente

require('dotenv').config();
const mongoose = require('mongoose');

async function runDiagnostic() {
  try {
    // Conectar a MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB\n');
    
    const Order = require('./src/models/Order');
    const EmailEvent = require('./src/models/EmailEvent');
    const Campaign = require('./src/models/Campaign');
    const Customer = require('./src/models/Customer');
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('    DIAGNÓSTICO DE REVENUE Y ATRIBUCIÓN - ÚLTIMOS 30 DÍAS');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // ==================== 1. ÓRDENES TOTALES ====================
    console.log('📦 ÓRDENES:');
    console.log('─────────────────────────────────────────────────────────');
    
    const totalOrders = await Order.countDocuments({
      orderDate: { $gte: thirtyDaysAgo }
    });
    
    const totalRevenue = await Order.aggregate([
      { $match: { orderDate: { $gte: thirtyDaysAgo } } },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } }
    ]);
    
    console.log(`   Total órdenes: ${totalOrders}`);
    console.log(`   Revenue total: $${(totalRevenue[0]?.total || 0).toFixed(2)}`);
    
    // Órdenes CON atribución
    const ordersWithAttribution = await Order.countDocuments({
      orderDate: { $gte: thirtyDaysAgo },
      'attribution.campaign': { $exists: true, $ne: null }
    });
    
    const attributedRevenue = await Order.aggregate([
      { 
        $match: { 
          orderDate: { $gte: thirtyDaysAgo },
          'attribution.campaign': { $exists: true, $ne: null }
        } 
      },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } }
    ]);
    
    console.log(`\n   Órdenes CON atribución: ${ordersWithAttribution}`);
    console.log(`   Revenue atribuido: $${(attributedRevenue[0]?.total || 0).toFixed(2)}`);
    
    const ordersWithoutAttribution = totalOrders - ordersWithAttribution;
    const unattributedRevenue = (totalRevenue[0]?.total || 0) - (attributedRevenue[0]?.total || 0);
    
    console.log(`\n   ❌ Órdenes SIN atribución: ${ordersWithoutAttribution}`);
    console.log(`   ❌ Revenue NO atribuido: $${unattributedRevenue.toFixed(2)}`);
    console.log(`   📊 Tasa de atribución: ${totalOrders > 0 ? ((ordersWithAttribution/totalOrders)*100).toFixed(1) : 0}%`);
    
    // ==================== 2. EMAIL EVENTS ====================
    console.log('\n\n📧 EMAIL EVENTS (Clicks):');
    console.log('─────────────────────────────────────────────────────────');
    
    const clickEvents = await EmailEvent.countDocuments({
      eventType: 'clicked',
      eventDate: { $gte: thirtyDaysAgo }
    });
    
    console.log(`   Total clicks: ${clickEvents}`);
    
    // Verificar tipos de datos en customer field
    const customerTypes = await EmailEvent.aggregate([
      { 
        $match: { 
          eventType: 'clicked',
          eventDate: { $gte: thirtyDaysAgo }
        }
      },
      {
        $project: {
          customerType: { $type: '$customer' }
        }
      },
      {
        $group: {
          _id: '$customerType',
          count: { $sum: 1 }
        }
      }
    ]);
    
    console.log('\n   Tipos de dato en campo "customer":');
    customerTypes.forEach(t => {
      console.log(`      ${t._id}: ${t.count} eventos`);
    });
    
    // ==================== 3. CAMPAÑAS ENVIADAS ====================
    console.log('\n\n📣 CAMPAÑAS ENVIADAS:');
    console.log('─────────────────────────────────────────────────────────');
    
    const sentCampaigns = await Campaign.find({
      status: 'sent',
      sentAt: { $gte: thirtyDaysAgo }
    }).select('name stats.sent stats.clicked stats.totalRevenue stats.purchased sentAt');
    
    console.log(`   Campañas enviadas: ${sentCampaigns.length}`);
    
    if (sentCampaigns.length > 0) {
      console.log('\n   Detalle por campaña:');
      let totalCampaignRevenue = 0;
      
      for (const c of sentCampaigns) {
        totalCampaignRevenue += c.stats?.totalRevenue || 0;
        console.log(`\n   📌 ${c.name}`);
        console.log(`      Enviados: ${c.stats?.sent || 0}`);
        console.log(`      Clicks: ${c.stats?.clicked || 0}`);
        console.log(`      Compras: ${c.stats?.purchased || 0}`);
        console.log(`      Revenue: $${(c.stats?.totalRevenue || 0).toFixed(2)}`);
      }
      
      console.log(`\n   💰 Revenue total en Campaign.stats: $${totalCampaignRevenue.toFixed(2)}`);
    }
    
    // ==================== 4. PROBLEMA DE MATCHING ====================
    console.log('\n\n🔍 DIAGNÓSTICO DE MATCHING:');
    console.log('─────────────────────────────────────────────────────────');
    
    // Buscar órdenes sin atribución que PODRÍAN atribuirse
    const recentOrders = await Order.find({
      orderDate: { $gte: thirtyDaysAgo },
      'attribution.campaign': { $exists: false }
    })
    .populate('customer', 'email')
    .limit(10)
    .sort({ orderDate: -1 });
    
    console.log(`\n   Últimas 10 órdenes sin atribución:`);
    
    let potentialMatches = 0;
    
    for (const order of recentOrders) {
      const customerEmail = order.customer?.email;
      
      if (!customerEmail) {
        console.log(`\n   ❌ Orden #${order.orderNumber}: Sin email de cliente`);
        continue;
      }
      
      // Buscar clicks de este cliente en los últimos 7 días antes de la orden
      const sevenDaysBefore = new Date(order.orderDate);
      sevenDaysBefore.setDate(sevenDaysBefore.getDate() - 7);
      
      const clicksBefore = await EmailEvent.find({
        email: customerEmail,
        eventType: 'clicked',
        eventDate: { $gte: sevenDaysBefore, $lte: order.orderDate }
      }).sort({ eventDate: -1 }).limit(1);
      
      if (clicksBefore.length > 0) {
        potentialMatches++;
        const click = clicksBefore[0];
        console.log(`\n   ⚠️  Orden #${order.orderNumber} ($${order.totalPrice.toFixed(2)})`);
        console.log(`      Email: ${customerEmail}`);
        console.log(`      TIENE click previo de campaña: ${click.campaign}`);
        console.log(`      Click fue: ${click.eventDate.toISOString()}`);
        console.log(`      Orden fue: ${order.orderDate.toISOString()}`);
        console.log(`      → DEBERÍA estar atribuida pero NO lo está`);
      } else {
        console.log(`\n   ✓ Orden #${order.orderNumber}: No hay clicks previos (ok no atribuir)`);
      }
    }
    
    console.log(`\n   📊 Órdenes que DEBERÍAN tener atribución: ${potentialMatches} de 10 muestreadas`);
    
    // ==================== 5. RECOMENDACIONES ====================
    console.log('\n\n💡 PROBLEMAS DETECTADOS:');
    console.log('═══════════════════════════════════════════════════════════');
    
    if (ordersWithoutAttribution > ordersWithAttribution) {
      console.log('\n❌ PROBLEMA CRÍTICO: La mayoría de órdenes NO tienen atribución');
      console.log('   CAUSA: El webhook de Shopify no puede leer cookies del navegador');
      console.log('   SOLUCIÓN: Usar búsqueda por EMAIL en vez de customer ID');
    }
    
    const stringCustomers = customerTypes.find(t => t._id === 'string');
    const objectIdCustomers = customerTypes.find(t => t._id === 'objectId');
    
    if (stringCustomers && objectIdCustomers) {
      console.log('\n❌ PROBLEMA: Inconsistencia en tipos de customer ID');
      console.log(`   Strings: ${stringCustomers.count}, ObjectIds: ${objectIdCustomers.count}`);
      console.log('   CAUSA: El tracking guarda strings, pero se buscan ObjectIds');
      console.log('   SOLUCIÓN: Normalizar a ObjectId o buscar por email');
    }
    
    if (potentialMatches > 0) {
      console.log('\n❌ PROBLEMA: Hay órdenes que DEBERÍAN estar atribuidas');
      console.log('   CAUSA: La búsqueda de "last click" no encuentra los eventos');
      console.log('   SOLUCIÓN: Buscar por email en vez de customer ID');
    }
    
    console.log('\n\n✅ SOLUCIÓN RECOMENDADA:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('1. Modificar orderCreate webhook para buscar clicks por EMAIL');
    console.log('2. No depender de cookies (no funcionan con webhooks)');
    console.log('3. Normalizar customer IDs en EmailEvent a ObjectId');
    console.log('4. Ejecutar script de re-atribución para órdenes pasadas');
    
    await mongoose.disconnect();
    console.log('\n\n✅ Diagnóstico completado\n');
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

runDiagnostic();