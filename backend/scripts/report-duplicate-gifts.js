require('dotenv').config();
const axios = require('axios');

// Configuración de Shopify - Compatible con SHOPIFY_STORE o SHOPIFY_STORE_URL
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const shopify = axios.create({
  baseURL: `https://${SHOPIFY_STORE}/admin/api/2024-10`,
  headers: {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json'
  }
});

async function getUnfulfilledOrders() {
  try {
    const response = await shopify.get('/orders.json', {
      params: {
        status: 'any',
        fulfillment_status: 'unfulfilled',
        created_at_min: '2024-11-28',
        limit: 250
      }
    });
    return response.data.orders;
  } catch (error) {
    console.error('Error obteniendo órdenes:', error.response?.data || error.message);
    throw error;
  }
}

function analyzeOrder(order) {
  const giftLineItems = order.line_items.filter(item => 
    item.properties?.some(prop => 
      prop.name === '_threshold_gift' && prop.value === 'true'
    )
  );

  const issues = [];
  
  giftLineItems.forEach(gift => {
    if (gift.quantity > 1) {
      issues.push({
        line_item_id: gift.id,
        product_title: gift.title,
        variant_title: gift.variant_title || 'N/A',
        current_quantity: gift.quantity,
        should_be: 1,
        difference: gift.quantity - 1,
        price: gift.price
      });
    }
  });

  return issues;
}

async function generateReport() {
  try {
    console.log('🔍 REPORTE DE ÓRDENES CON REGALOS DUPLICADOS');
    console.log('════════════════════════════════════════════════════════\n');
    console.log('Buscando órdenes no cumplidas...\n');
    
    const orders = await getUnfulfilledOrders();
    console.log(`📦 Total de órdenes no cumplidas: ${orders.length}\n`);

    const ordersWithIssues = [];
    let totalExtraItems = 0;

    for (const order of orders) {
      const issues = analyzeOrder(order);
      
      if (issues.length > 0) {
        const orderTotal = issues.reduce((sum, issue) => sum + issue.difference, 0);
        totalExtraItems += orderTotal;

        ordersWithIssues.push({
          order_id: order.id,
          order_name: order.name,
          order_number: order.order_number,
          customer_email: order.email,
          customer_name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
          created_at: order.created_at,
          total_price: order.total_price,
          issues: issues,
          extra_items_count: orderTotal
        });
      }
    }

    if (ordersWithIssues.length === 0) {
      console.log('✅ No se encontraron órdenes con regalos duplicados\n');
      console.log('════════════════════════════════════════════════════════\n');
      return;
    }

    console.log(`⚠️  RESUMEN:`);
    console.log(`   • Órdenes afectadas: ${ordersWithIssues.length}`);
    console.log(`   • Total de items extra a remover: ${totalExtraItems}`);
    console.log('\n════════════════════════════════════════════════════════\n');
    console.log('DETALLE DE ÓRDENES AFECTADAS:\n');

    // Ordenar por cantidad de items extra (de mayor a menor)
    ordersWithIssues.sort((a, b) => b.extra_items_count - a.extra_items_count);

    ordersWithIssues.forEach((orderIssue, index) => {
      console.log(`${index + 1}. Orden: ${orderIssue.order_name} (${orderIssue.order_number})`);
      console.log(`   Cliente: ${orderIssue.customer_name}`);
      console.log(`   Email: ${orderIssue.customer_email}`);
      console.log(`   Fecha: ${new Date(orderIssue.created_at).toLocaleDateString('es-ES')}`);
      console.log(`   Total orden: $${orderIssue.total_price}`);
      console.log(`   Problemas encontrados:`);
      
      orderIssue.issues.forEach(issue => {
        console.log(`      • ${issue.product_title} ${issue.variant_title !== 'N/A' ? `(${issue.variant_title})` : ''}`);
        console.log(`        Cantidad actual: ${issue.current_quantity} | Debería ser: ${issue.should_be} | Extra: ${issue.difference}`);
      });
      
      console.log('');
    });

    console.log('════════════════════════════════════════════════════════\n');
    
    // Generar CSV para exportar
    console.log('📊 DATOS EN FORMATO CSV (copiar y pegar en Excel):\n');
    console.log('Orden,Número,Cliente,Email,Fecha,Producto,Cantidad Actual,Cantidad Correcta,Extra,ID Line Item');
    
    ordersWithIssues.forEach(orderIssue => {
      orderIssue.issues.forEach(issue => {
        const row = [
          orderIssue.order_name,
          orderIssue.order_number,
          `"${orderIssue.customer_name}"`,
          orderIssue.customer_email,
          new Date(orderIssue.created_at).toLocaleDateString('es-ES'),
          `"${issue.product_title}"`,
          issue.current_quantity,
          issue.should_be,
          issue.difference,
          issue.line_item_id
        ].join(',');
        console.log(row);
      });
    });

    console.log('\n════════════════════════════════════════════════════════\n');
    console.log('💡 PRÓXIMOS PASOS:');
    console.log('   1. Revisa este reporte cuidadosamente');
    console.log('   2. Si todo se ve correcto, ejecuta: node fix-duplicate-gifts.js');
    console.log('   3. El script te pedirá confirmación antes de hacer cambios');
    console.log('\n════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('Error fatal generando reporte:', error);
    process.exit(1);
  }
}

// Ejecutar
if (require.main === module) {
  generateReport();
}

module.exports = { generateReport };