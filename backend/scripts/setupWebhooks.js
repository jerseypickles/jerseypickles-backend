// backend/scripts/setupWebhooks.js
require('dotenv').config();
const shopifyService = require('../src/services/shopifyService');

async function setupWebhooks() {
  try {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║   🔧 CONFIGURACIÓN DE WEBHOOKS        ║');
    console.log('╚════════════════════════════════════════╝\n');
    
    // Verificar conexión
    const test = await shopifyService.testConnection();
    if (!test.success) {
      throw new Error('No se pudo conectar a Shopify');
    }
    
    // Crear webhooks
    console.log('\n🆕 Creando/actualizando webhooks...\n');
    const results = await shopifyService.createWebhooks();
    
    // Mostrar resultados
    const created = results.filter(r => r.success && !r.exists);
    const existing = results.filter(r => r.success && r.exists);
    const failed = results.filter(r => !r.success);
    
    console.log(`\n✅ Creados: ${created.length}`);
    console.log(`⏭️  Ya existían: ${existing.length}`);
    console.log(`❌ Fallidos: ${failed.length}`);
    
    console.log('\n✨ Configuración completada!\n');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

setupWebhooks();