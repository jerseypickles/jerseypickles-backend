// backend/scripts/reatribuir-ordenes.js
// Versión OPTIMIZADA con cursor para evitar out of memory

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Order = require('../src/models/Order');
const Campaign = require('../src/models/Campaign');
const Customer = require('../src/models/Customer');
const EmailEvent = require('../src/models/EmailEvent');

// ⚠️ Cambiar a false para aplicar cambios reales
const DRY_RUN = true;

// Días hacia atrás para buscar órdenes
const DAYS_BACK = 90;

// Ventana de atribución (días entre click y compra)
const ATTRIBUTION_WINDOW = 7;

// Procesar en batches de 100
const BATCH_SIZE = 100;

async function run() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  📊 RE-ATRIBUCIÓN DE ÓRDENES HISTÓRICAS');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Modo: ${DRY_RUN ? '🔍 DRY RUN (sin cambios)' : '✅ APLICAR CAMBIOS'}`);
  console.log(`  Período: últimos ${DAYS_BACK} días`);
  console.log(`  Ventana de atribución: ${ATTRIBUTION_WINDOW} días`);
  console.log('═══════════════════════════════════════════════════\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Conectado a MongoDB\n');

  const since = new Date();
  since.setDate(since.getDate() - DAYS_BACK);

  // Contar primero
  const totalOrders = await Order.countDocuments({
    createdAt: { $gte: since },
    $or: [
      { 'attribution.campaign': { $exists: false } },
      { 'attribution.campaign': null }
    ]
  });

  console.log(`📦 Órdenes sin atribución: ${totalOrders}\n`);

  if (totalOrders === 0) {
    console.log('✅ No hay órdenes para procesar');
    await mongoose.disconnect();
    return;
  }

  let processed = 0;
  let attributed = 0;
  let skipped = 0;
  let noEmail = 0;
  let noClick = 0;
  
  const byCampaign = {};

  // Usar cursor para no cargar todo en memoria
  const cursor = Order.find({
    createdAt: { $gte: since },
    $or: [
      { 'attribution.campaign': { $exists: false } },
      { 'attribution.campaign': null }
    ]
  })
  .select('_id customer totalPrice createdAt orderNumber shopifyId currency')
  .sort({ createdAt: -1 })
  .cursor({ batchSize: BATCH_SIZE });

  console.log('🔄 Procesando con cursor...\n');

  for await (const order of cursor) {
    processed++;

    // Log progreso cada 100
    if (processed % 100 === 0) {
      const pct = ((processed / totalOrders) * 100).toFixed(1);
      console.log(`   📊 ${processed}/${totalOrders} (${pct}%) - Atribuidas: ${attributed}`);
    }

    if (!order.customer) {
      skipped++;
      continue;
    }

    // Buscar customer por separado (no populate)
    const customer = await Customer.findById(order.customer).select('email _id').lean();
    
    if (!customer || !customer.email) {
      noEmail++;
      continue;
    }

    const email = customer.email;
    const orderDate = new Date(order.createdAt);
    const windowStart = new Date(orderDate);
    windowStart.setDate(windowStart.getDate() - ATTRIBUTION_WINDOW);

    // Buscar último click por EMAIL dentro de la ventana
    const click = await EmailEvent.findOne({
      email: { $regex: new RegExp(`^${email}$`, 'i') },
      eventType: 'clicked',
      eventDate: { $gte: windowStart, $lte: orderDate },
      campaign: { $exists: true, $ne: null }
    })
    .select('campaign eventDate')
    .sort({ eventDate: -1 })
    .lean();

    if (!click) {
      noClick++;
      continue;
    }

    const campaignId = click.campaign.toString();
    
    if (!byCampaign[campaignId]) {
      byCampaign[campaignId] = { orders: 0, revenue: 0 };
    }
    byCampaign[campaignId].orders++;
    byCampaign[campaignId].revenue += order.totalPrice || 0;

    if (!DRY_RUN) {
      // Actualizar orden
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            'attribution.campaign': campaignId,
            'attribution.source': 'email_click',
            'attribution.clickedAt': click.eventDate
          }
        }
      );

      // Actualizar stats de campaña
      await Campaign.updateOne(
        { _id: campaignId },
        {
          $inc: {
            'stats.totalRevenue': order.totalPrice || 0,
            'stats.purchased': 1
          }
        }
      );

      // Crear evento de purchase si no existe
      const exists = await EmailEvent.findOne({
        campaign: campaignId,
        email: email,
        eventType: 'purchased',
        'revenue.orderNumber': order.orderNumber
      }).select('_id').lean();

      if (!exists) {
        await EmailEvent.create({
          campaign: campaignId,
          customer: customer._id,
          email: email,
          eventType: 'purchased',
          source: 'reatribution',
          eventDate: orderDate,
          revenue: {
            orderValue: order.totalPrice,
            orderId: order.shopifyId,
            orderNumber: order.orderNumber,
            currency: order.currency || 'USD'
          }
        });
      }
    }

    attributed++;
  }

  // REPORTE
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  📊 REPORTE FINAL');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`  Total analizadas: ${processed}`);
  console.log(`  ✅ Atribuidas: ${attributed}`);
  console.log(`  ⏭️  Sin customer: ${skipped}`);
  console.log(`  ⏭️  Sin email: ${noEmail}`);
  console.log(`  ⏭️  Sin click previo: ${noClick}`);
  
  const totalRevenue = Object.values(byCampaign).reduce((sum, c) => sum + c.revenue, 0);
  console.log(`\n  💰 Revenue atribuido: $${totalRevenue.toFixed(2)}`);

  if (Object.keys(byCampaign).length > 0) {
    console.log('\n  📧 Por campaña:');
    for (const [id, data] of Object.entries(byCampaign)) {
      const camp = await Campaign.findById(id).select('name').lean();
      console.log(`  - ${camp?.name || id}: ${data.orders} órdenes, $${data.revenue.toFixed(2)}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(DRY_RUN ? '  🔍 DRY RUN - Cambiar DRY_RUN=false para aplicar' : '  ✅ CAMBIOS APLICADOS');
  console.log('═══════════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Error:', err);
  mongoose.disconnect();
  process.exit(1);
});