// backend/scripts/diagnostico-segments.js
// Ejecutar desde la raíz del proyecto: node backend/scripts/diagnostico-segments.js

require('dotenv').config();
const mongoose = require('mongoose');

// Rutas correctas desde scripts/
const Customer = require('../src/models/Customer');
const Order = require('../src/models/Order');
const EmailEvent = require('../src/models/EmailEvent');

async function diagnose() {
  try {
    // Conectar a MongoDB
    console.log('🔌 Conectando a MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado!\n');
    
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║        🥒 DIAGNÓSTICO DE DATOS - JERSEY PICKLES           ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    const results = {};
    
    // ==================== CUSTOMERS ====================
    console.log('📊 CUSTOMERS');
    console.log('─'.repeat(50));
    
    results.totalCustomers = await Customer.countDocuments();
    console.log(`   Total customers:          ${results.totalCustomers.toLocaleString()}`);
    
    results.acceptsMarketing = await Customer.countDocuments({ acceptsMarketing: true });
    console.log(`   Accepts Marketing:        ${results.acceptsMarketing.toLocaleString()}`);
    
    // ==================== COMPRADORES ====================
    console.log('\n🛒 COMPRADORES');
    console.log('─'.repeat(50));
    
    results.withOrders = await Customer.countDocuments({ ordersCount: { $gt: 0 } });
    console.log(`   Con órdenes (compraron):  ${results.withOrders.toLocaleString()}`);
    
    results.withoutOrders = await Customer.countDocuments({ ordersCount: 0 });
    console.log(`   Sin órdenes (no compra):  ${results.withoutOrders.toLocaleString()}`);
    
    results.repeatBuyers = await Customer.countDocuments({ ordersCount: { $gte: 2 } });
    console.log(`   Compradores 2+ veces:     ${results.repeatBuyers.toLocaleString()}`);
    
    results.vipBuyers = await Customer.countDocuments({ totalSpent: { $gte: 200 } });
    console.log(`   VIP ($200+ gastados):     ${results.vipBuyers.toLocaleString()}`);
    
    // ==================== POPUP ====================
    console.log('\n🎯 POPUP SUBSCRIBERS');
    console.log('─'.repeat(50));
    
    results.fromPopup = await Customer.countDocuments({ 
      popupDiscountCode: { $exists: true, $ne: null, $ne: '' } 
    });
    console.log(`   Con código popup:         ${results.fromPopup.toLocaleString()}`);
    
    results.popupNoOrder = await Customer.countDocuments({ 
      popupDiscountCode: { $exists: true, $ne: null, $ne: '' },
      ordersCount: 0
    });
    console.log(`   Popup SIN compra:         ${results.popupNoOrder.toLocaleString()}`);
    
    results.popupWithOrder = await Customer.countDocuments({ 
      popupDiscountCode: { $exists: true, $ne: null, $ne: '' },
      ordersCount: { $gt: 0 }
    });
    console.log(`   Popup CON compra:         ${results.popupWithOrder.toLocaleString()}`);
    
    // ==================== EMAIL ENGAGEMENT ====================
    console.log('\n📧 EMAIL ENGAGEMENT');
    console.log('─'.repeat(50));
    
    results.emailsSent = await Customer.countDocuments({ 
      'emailStats.sent': { $gt: 0 } 
    });
    console.log(`   Recibieron emails:        ${results.emailsSent.toLocaleString()}`);
    
    results.opened = await Customer.countDocuments({ 
      'emailStats.opened': { $gt: 0 } 
    });
    console.log(`   Abrieron al menos 1:      ${results.opened.toLocaleString()}`);
    
    results.openedNoOrder = await Customer.countDocuments({ 
      'emailStats.opened': { $gt: 0 },
      ordersCount: 0
    });
    console.log(`   Abrieron pero NO compran: ${results.openedNoOrder.toLocaleString()}`);
    
    results.clicked = await Customer.countDocuments({ 
      'emailStats.clicked': { $gt: 0 } 
    });
    console.log(`   Clickearon al menos 1:    ${results.clicked.toLocaleString()}`);
    
    results.clickedNoOrder = await Customer.countDocuments({ 
      'emailStats.clicked': { $gt: 0 },
      ordersCount: 0
    });
    console.log(`   Clickearon pero NO compra:${results.clickedNoOrder.toLocaleString()}`);
    
    // ==================== BOUNCES ====================
    console.log('\n⚠️  BOUNCES');
    console.log('─'.repeat(50));
    
    results.bounced = await Customer.countDocuments({ 
      'bounceInfo.isBounced': true 
    });
    console.log(`   Total bounced:            ${results.bounced.toLocaleString()}`);
    
    results.hardBounce = await Customer.countDocuments({ 
      'bounceInfo.bounceType': 'hard' 
    });
    console.log(`   Hard bounces:             ${results.hardBounce.toLocaleString()}`);
    
    results.softBounce = await Customer.countDocuments({ 
      'bounceInfo.bounceType': 'soft' 
    });
    console.log(`   Soft bounces:             ${results.softBounce.toLocaleString()}`);
    
    // ==================== ORDERS ====================
    console.log('\n💰 ORDERS');
    console.log('─'.repeat(50));
    
    results.totalOrders = await Order.countDocuments();
    console.log(`   Total órdenes:            ${results.totalOrders.toLocaleString()}`);
    
    results.ordersWithAttribution = await Order.countDocuments({ 
      'attribution.campaign': { $exists: true, $ne: null } 
    });
    console.log(`   Con atribución campaña:   ${results.ordersWithAttribution.toLocaleString()}`);
    
    const revenueResult = await Order.aggregate([
      { $group: { _id: null, total: { $sum: '$totalPrice' } } }
    ]);
    results.totalRevenue = revenueResult[0]?.total || 0;
    console.log(`   Revenue total:            $${results.totalRevenue.toLocaleString()}`);
    
    const attributedRevenue = await Order.aggregate([
      { $match: { 'attribution.campaign': { $exists: true, $ne: null } } },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } }
    ]);
    results.attributedRevenue = attributedRevenue[0]?.total || 0;
    console.log(`   Revenue atribuido:        $${results.attributedRevenue.toLocaleString()}`);
    
    // ==================== EMAIL EVENTS ====================
    console.log('\n📈 EMAIL EVENTS');
    console.log('─'.repeat(50));
    
    results.totalEmailEvents = await EmailEvent.countDocuments();
    console.log(`   Total eventos:            ${results.totalEmailEvents.toLocaleString()}`);
    
    const eventsByType = await EmailEvent.aggregate([
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    console.log('   Por tipo:');
    eventsByType.forEach(e => {
      console.log(`      - ${e._id}: ${e.count.toLocaleString()}`);
    });
    
    // ==================== BY SOURCE ====================
    console.log('\n🔍 CUSTOMERS POR SOURCE');
    console.log('─'.repeat(50));
    
    const bySource = await Customer.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    bySource.forEach(s => {
      console.log(`   ${s._id || 'null'}: ${s.count.toLocaleString()}`);
    });
    
    // ==================== RESUMEN SEGMENTOS SUGERIDOS ====================
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║              📋 SEGMENTOS SUGERIDOS                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`   1. "Compradores"           → ${results.withOrders.toLocaleString()} clientes`);
    console.log(`   2. "No han comprado"       → ${results.withoutOrders.toLocaleString()} clientes`);
    console.log(`   3. "Popup sin convertir"   → ${results.popupNoOrder.toLocaleString()} clientes`);
    console.log(`   4. "Engaged sin compra"    → ${results.openedNoOrder.toLocaleString()} clientes`);
    console.log(`   5. "Clickers sin compra"   → ${results.clickedNoOrder.toLocaleString()} clientes`);
    console.log(`   6. "Compradores recurrentes" → ${results.repeatBuyers.toLocaleString()} clientes`);
    console.log(`   7. "VIP ($200+)"           → ${results.vipBuyers.toLocaleString()} clientes`);
    console.log(`   8. "Bounced (limpiar)"     → ${results.bounced.toLocaleString()} clientes`);
    
    console.log('\n✅ Diagnóstico completado!\n');
    
    // Cerrar conexión
    await mongoose.connection.close();
    console.log('🔌 Conexión cerrada.');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

diagnose();