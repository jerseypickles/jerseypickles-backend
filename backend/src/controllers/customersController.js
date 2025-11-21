// backend/src/controllers/customersController.js
const Customer = require('../models/Customer');
const shopifyService = require('../services/shopifyService');

class CustomersController {
  
  // Listar clientes
  async list(req, res) {
    try {
      const { 
        page = 1, 
        limit = 50,
        search = '',
        acceptsMarketing = null
      } = req.query;
      
      const query = {};
      
      // Filtro de búsqueda
      if (search) {
        query.$or = [
          { email: { $regex: search, $options: 'i' } },
          { firstName: { $regex: search, $options: 'i' } },
          { lastName: { $regex: search, $options: 'i' } }
        ];
      }
      
      // Filtro de marketing
      if (acceptsMarketing !== null) {
        query.acceptsMarketing = acceptsMarketing === 'true';
      }
      
      const customers = await Customer.find(query)
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);
      
      const total = await Customer.countDocuments(query);
      
      res.json({
        customers,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      });
      
    } catch (error) {
      console.error('Error listando clientes:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener un cliente
  async getOne(req, res) {
    try {
      const customer = await Customer.findById(req.params.id);
      
      if (!customer) {
        return res.status(404).json({ error: 'Cliente no encontrado' });
      }
      
      res.json(customer);
      
    } catch (error) {
      console.error('Error obteniendo cliente:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Sincronizar desde Shopify
  async syncFromShopify(req, res) {
    try {
      console.log('\n╔═══════════════════════════════════════════════╗');
      console.log('║  🔄 SINCRONIZACIÓN DE CLIENTES INICIADA      ║');
      console.log('╚═══════════════════════════════════════════════╝\n');
      
      const startTime = Date.now();
      
      // Obtener clientes de Shopify
      const shopifyCustomers = await shopifyService.getAllCustomers();
      
      if (shopifyCustomers.length === 0) {
        console.log('⚠️  No se encontraron clientes en Shopify');
        return res.json({
          success: true,
          total: 0,
          created: 0,
          updated: 0,
          errors: 0,
          message: 'No hay clientes para sincronizar'
        });
      }
      
      console.log('\n💾 Guardando en MongoDB...');
      console.log(`📦 Procesando ${shopifyCustomers.length} clientes en lotes de 250\n`);
      
      let created = 0;
      let updated = 0;
      let errors = 0;
      const errorDetails = [];
      
      // Procesar en lotes de 250 para mejor performance
      const batchSize = 250;
      const totalBatches = Math.ceil(shopifyCustomers.length / batchSize);
      
      for (let i = 0; i < shopifyCustomers.length; i += batchSize) {
        const batch = shopifyCustomers.slice(i, i + batchSize);
        const currentBatch = Math.floor(i / batchSize) + 1;
        const batchStart = i + 1;
        const batchEnd = Math.min(i + batchSize, shopifyCustomers.length);
        
        console.log(`📦 Lote ${currentBatch}/${totalBatches}: Procesando clientes ${batchStart} a ${batchEnd}...`);
        
        const promises = batch.map(async (shopifyCustomer) => {
          try {
            const existing = await Customer.findOne({ 
              shopifyId: shopifyCustomer.id.toString() 
            });
            
            await Customer.findOneAndUpdate(
              { shopifyId: shopifyCustomer.id.toString() },
              {
                shopifyId: shopifyCustomer.id.toString(),
                email: shopifyCustomer.email,
                firstName: shopifyCustomer.first_name,
                lastName: shopifyCustomer.last_name,
                phone: shopifyCustomer.phone,
                ordersCount: shopifyCustomer.orders_count || 0,
                totalSpent: parseFloat(shopifyCustomer.total_spent) || 0,
                acceptsMarketing: shopifyCustomer.accepts_marketing || false,
                tags: shopifyCustomer.tags?.split(', ') || [],
                address: {
                  city: shopifyCustomer.default_address?.city,
                  province: shopifyCustomer.default_address?.province,
                  country: shopifyCustomer.default_address?.country,
                  zip: shopifyCustomer.default_address?.zip
                },
                shopifyData: shopifyCustomer
              },
              { upsert: true, new: true }
            );
            
            return { 
              success: true, 
              isNew: !existing,
              email: shopifyCustomer.email
            };
          } catch (error) {
            return { 
              success: false, 
              email: shopifyCustomer.email,
              error: error.message 
            };
          }
        });
        
        const results = await Promise.all(promises);
        
        // Contar resultados del lote
        let batchCreated = 0;
        let batchUpdated = 0;
        let batchErrors = 0;
        
        results.forEach(result => {
          if (result.success) {
            if (result.isNew) {
              created++;
              batchCreated++;
            } else {
              updated++;
              batchUpdated++;
            }
          } else {
            errors++;
            batchErrors++;
            errorDetails.push({
              email: result.email,
              error: result.error
            });
          }
        });
        
        console.log(`   ✅ Completado: ${batchCreated} nuevos, ${batchUpdated} actualizados, ${batchErrors} errores`);
        
        // Pequeña pausa entre lotes para no saturar MongoDB
        if (i + batchSize < shopifyCustomers.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('\n╔═══════════════════════════════════════════════╗');
      console.log('║  ✅ SINCRONIZACIÓN COMPLETADA                ║');
      console.log('╚═══════════════════════════════════════════════╝');
      console.log(`📊 Total procesados: ${shopifyCustomers.length}`);
      console.log(`✨ Nuevos creados: ${created}`);
      console.log(`♻️  Actualizados: ${updated}`);
      console.log(`❌ Errores: ${errors}`);
      console.log(`⏱️  Tiempo total: ${duration}s`);
      console.log(`⚡ Velocidad: ${(shopifyCustomers.length / parseFloat(duration)).toFixed(0)} clientes/segundo`);
      console.log('═══════════════════════════════════════════════\n');
      
      const response = {
        success: true,
        total: shopifyCustomers.length,
        created,
        updated,
        errors,
        duration: `${duration}s`,
        speed: `${(shopifyCustomers.length / parseFloat(duration)).toFixed(0)} clientes/s`
      };
      
      // Incluir detalles de errores si hay
      if (errorDetails.length > 0) {
        response.errorDetails = errorDetails.slice(0, 10); // Solo los primeros 10
        if (errorDetails.length > 10) {
          response.moreErrors = `y ${errorDetails.length - 10} errores más`;
        }
      }
      
      res.json(response);
      
    } catch (error) {
      console.error('\n╔═══════════════════════════════════════════════╗');
      console.error('║  ❌ ERROR EN SINCRONIZACIÓN                  ║');
      console.error('╚═══════════════════════════════════════════════╝');
      console.error('Error:', error.message);
      console.error('═══════════════════════════════════════════════\n');
      
      res.status(500).json({ 
        success: false,
        error: error.message,
        details: error.response?.data 
      });
    }
  }

  // Test de conexión a Shopify
  async testShopify(req, res) {
    try {
      console.log('\n🧪 Testeando conexión con Shopify...\n');
      
      const result = await shopifyService.testConnection();
      
      if (result.success) {
        console.log('✅ Test exitoso\n');
        res.json({
          success: true,
          message: 'Conexión exitosa con Shopify',
          shop: {
            name: result.shop.name,
            email: result.shop.email,
            domain: result.shop.domain,
            currency: result.shop.currency,
            timezone: result.shop.timezone
          }
        });
      } else {
        console.log('❌ Test fallido\n');
        res.status(500).json({
          success: false,
          error: result.error,
          message: 'No se pudo conectar con Shopify. Verifica tus credenciales.'
        });
      }
      
    } catch (error) {
      console.error('❌ Error en test:', error.message);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  // Estadísticas
async stats(req, res) {
  try {
    const total = await Customer.countDocuments();
    const acceptsMarketing = await Customer.countDocuments({ acceptsMarketing: true });
    const highValue = await Customer.countDocuments({ totalSpent: { $gte: 500 } });
    
    const avgOrderValue = await Customer.aggregate([
      { $match: { ordersCount: { $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: '$totalSpent' } } }
    ]);
    
    const topSpenders = await Customer.find()
      .sort({ totalSpent: -1 })
      .limit(5)
      .select('email firstName lastName totalSpent ordersCount');
    
    res.json({
      total,
      acceptsMarketing,
      acceptanceRate: total > 0 ? ((acceptsMarketing / total) * 100).toFixed(2) + '%' : '0%',
      highValue,
      // ✅ CAMBIA ESTA LÍNEA - devuelve número, no string
      averageOrderValue: avgOrderValue[0]?.avg || 0,  // ← SIN .toFixed()
      topSpenders
    });
    
  } catch (error) {
    console.error('Error obteniendo stats:', error);
    res.status(500).json({ error: error.message });
  }
}

  // Setup webhooks de Shopify
  async setupWebhooks(req, res) {
    try {
      console.log('\n🔗 Configurando webhooks de Shopify...\n');
      
      const results = await shopifyService.createWebhooks();
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      console.log(`\n✅ Webhooks configurados: ${successful} exitosos, ${failed} fallidos\n`);
      
      res.json({
        success: failed === 0,
        total: results.length,
        successful,
        failed,
        results
      });
      
    } catch (error) {
      console.error('❌ Error configurando webhooks:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  // Listar webhooks actuales
  async listWebhooks(req, res) {
    try {
      const webhooks = await shopifyService.listWebhooks();
      
      res.json({
        success: true,
        count: webhooks.length,
        webhooks: webhooks.map(w => ({
          id: w.id,
          topic: w.topic,
          address: w.address,
          createdAt: w.created_at
        }))
      });
      
    } catch (error) {
      console.error('Error listando webhooks:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }
}

module.exports = new CustomersController();