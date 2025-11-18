// backend/src/controllers/ordersController.js
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const shopifyService = require('../services/shopifyService');

class OrdersController {
  
  // Listar órdenes
  async list(req, res) {
    try {
      const { 
        page = 1, 
        limit = 50,
        status = null,
        customerId = null
      } = req.query;
      
      const query = {};
      
      if (status) {
        query.financialStatus = status;
      }
      
      if (customerId) {
        query.customer = customerId;
      }
      
      const orders = await Order.find(query)
        .populate('customer', 'email firstName lastName')
        .sort({ orderDate: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);
      
      const total = await Order.countDocuments(query);
      
      res.json({
        orders,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      });
      
    } catch (error) {
      console.error('Error listando órdenes:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener una orden
  async getOne(req, res) {
    try {
      const order = await Order.findById(req.params.id)
        .populate('customer');
      
      if (!order) {
        return res.status(404).json({ error: 'Orden no encontrada' });
      }
      
      res.json(order);
      
    } catch (error) {
      console.error('Error obteniendo orden:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Sincronizar órdenes desde Shopify
  async syncFromShopify(req, res) {
    try {
      // 🔍 NUEVO: Permitir limitar páginas para debugging
      const maxPages = req.query.maxPages ? parseInt(req.query.maxPages) : null;
      
      console.log('\n╔═══════════════════════════════════════════════╗');
      console.log('║  📦 SINCRONIZACIÓN DE ÓRDENES INICIADA       ║');
      console.log('╚═══════════════════════════════════════════════╝\n');
      
      if (maxPages) {
        console.log(`🔍 MODO DEBUG: Limitando a ${maxPages} página(s) de Shopify\n`);
      }
      
      const startTime = Date.now();
      
      // Obtener órdenes de Shopify (con límite opcional)
      const shopifyOrders = await shopifyService.getAllOrders({}, maxPages);
      
      if (shopifyOrders.length === 0) {
        console.log('⚠️  No se encontraron órdenes en Shopify');
        return res.json({
          success: true,
          total: 0,
          created: 0,
          updated: 0,
          errors: 0,
          message: 'No hay órdenes para sincronizar'
        });
      }
      
      console.log('\n💾 Guardando órdenes en MongoDB...');
      console.log(`📦 Procesando ${shopifyOrders.length} órdenes en lotes de 250\n`);
      
      let created = 0;
      let updated = 0;
      let errors = 0;
      let skippedNoCustomer = 0;
      const errorDetails = [];
      const errorTypes = {}; // 🔍 NUEVO: Contador de tipos de error
      
      // Procesar en lotes de 250
      const batchSize = 250;
      const totalBatches = Math.ceil(shopifyOrders.length / batchSize);
      
      for (let i = 0; i < shopifyOrders.length; i += batchSize) {
        const batch = shopifyOrders.slice(i, i + batchSize);
        const currentBatch = Math.floor(i / batchSize) + 1;
        const batchStart = i + 1;
        const batchEnd = Math.min(i + batchSize, shopifyOrders.length);
        
        console.log(`📦 Lote ${currentBatch}/${totalBatches}: Procesando órdenes ${batchStart} a ${batchEnd}...`);
        
        const promises = batch.map(async (shopifyOrder) => {
          try {
            let customer = null;
            
            // Si la orden tiene información de cliente
            if (shopifyOrder.customer && shopifyOrder.customer.id) {
              // Buscar cliente existente
              customer = await Customer.findOne({ 
                shopifyId: shopifyOrder.customer.id.toString() 
              });
              
              // Si no existe Y tiene email válido, crear el cliente
              if (!customer && shopifyOrder.customer.email) {
                try {
                  customer = await Customer.create({
                    shopifyId: shopifyOrder.customer.id.toString(),
                    email: shopifyOrder.customer.email,
                    firstName: shopifyOrder.customer.first_name || '',
                    lastName: shopifyOrder.customer.last_name || '',
                    acceptsMarketing: shopifyOrder.customer.accepts_marketing || false
                  });
                } catch (customerError) {
                  // 🔍 LOGGING DETALLADO
                  console.log(`   ⚠️  Error creando cliente para orden ${shopifyOrder.order_number}:`);
                  console.log(`       Email: ${shopifyOrder.customer.email}`);
                  console.log(`       Error: ${customerError.message}`);
                }
              }
            }
            
            // Verificar si la orden ya existe
            const existing = await Order.findOne({ 
              shopifyId: shopifyOrder.id.toString() 
            });
            
            // Manejo seguro de valores numéricos
            const safeParseFloat = (value) => {
              const parsed = parseFloat(value);
              return isNaN(parsed) ? 0 : parsed;
            };
            
            // Crear o actualizar orden
            await Order.findOneAndUpdate(
              { shopifyId: shopifyOrder.id.toString() },
              {
                shopifyId: shopifyOrder.id.toString(),
                orderNumber: shopifyOrder.order_number,
                customer: customer?._id || null,
                totalPrice: safeParseFloat(shopifyOrder.total_price),
                subtotalPrice: safeParseFloat(shopifyOrder.subtotal_price),
                totalTax: safeParseFloat(shopifyOrder.total_tax),
                totalShipping: safeParseFloat(shopifyOrder.total_shipping_price_set?.shop_money?.amount || 0),
                totalDiscounts: safeParseFloat(shopifyOrder.total_discounts),
                currency: shopifyOrder.currency || 'USD',
                lineItems: (shopifyOrder.line_items || []).map(item => ({
                  productId: item.product_id?.toString() || null,
                  variantId: item.variant_id?.toString() || null,
                  title: item.title || 'Unknown Product',
                  quantity: item.quantity || 0,
                  price: safeParseFloat(item.price),
                  sku: item.sku || ''
                })),
                financialStatus: shopifyOrder.financial_status || 'pending',
                fulfillmentStatus: shopifyOrder.fulfillment_status || null,
                discountCodes: (shopifyOrder.discount_codes || []).map(d => d.code),
                tags: shopifyOrder.tags ? shopifyOrder.tags.split(', ') : [],
                orderDate: new Date(shopifyOrder.created_at),
                shopifyData: shopifyOrder
              },
              { upsert: true, new: true }
            );
            
            // Actualizar métricas solo si hay cliente
            if (customer) {
              try {
                const customerOrders = await Order.find({ customer: customer._id });
                const totalSpent = customerOrders.reduce((sum, order) => sum + order.totalPrice, 0);
                const ordersCount = customerOrders.length;
                const avgOrderValue = ordersCount > 0 ? totalSpent / ordersCount : 0;
                
                await Customer.findByIdAndUpdate(customer._id, {
                  ordersCount,
                  totalSpent,
                  averageOrderValue: avgOrderValue,
                  lastOrderDate: new Date(shopifyOrder.created_at)
                });
              } catch (metricsError) {
                console.log(`   ⚠️  Error actualizando métricas de cliente: ${metricsError.message}`);
              }
            }
            
            return { 
              success: true, 
              isNew: !existing,
              orderNumber: shopifyOrder.order_number,
              hasCustomer: !!customer
            };
            
          } catch (error) {
            // 🔍 LOGGING MUY DETALLADO DEL ERROR
            console.log(`\n   ❌ ERROR en orden ${shopifyOrder.order_number}:`);
            console.log(`       Shopify ID: ${shopifyOrder.id}`);
            console.log(`       Tiene customer: ${!!shopifyOrder.customer}`);
            if (shopifyOrder.customer) {
              console.log(`       Customer ID: ${shopifyOrder.customer.id}`);
              console.log(`       Customer Email: ${shopifyOrder.customer.email}`);
            }
            console.log(`       Error completo: ${error.message}`);
            console.log(`       Stack: ${error.stack?.split('\n')[0]}`);
            
            return { 
              success: false, 
              orderNumber: shopifyOrder.order_number,
              error: error.message,
              errorType: error.name || 'Unknown'
            };
          }
        });
        
        const results = await Promise.all(promises);
        
        // Contar resultados del lote
        let batchCreated = 0;
        let batchUpdated = 0;
        let batchErrors = 0;
        let batchNoCustomer = 0;
        
        results.forEach(result => {
          if (result.success) {
            if (result.isNew) {
              created++;
              batchCreated++;
            } else {
              updated++;
              batchUpdated++;
            }
            if (!result.hasCustomer) {
              batchNoCustomer++;
              skippedNoCustomer++;
            }
          } else {
            errors++;
            batchErrors++;
            errorDetails.push({
              orderNumber: result.orderNumber,
              error: result.error,
              errorType: result.errorType
            });
            
            // 🔍 NUEVO: Contar tipos de error
            errorTypes[result.errorType] = (errorTypes[result.errorType] || 0) + 1;
          }
        });
        
        console.log(`   ✅ Completado: ${batchCreated} nuevas, ${batchUpdated} actualizadas, ${batchNoCustomer} sin cliente, ${batchErrors} errores`);
        
        // 🔍 NUEVO: Mostrar primeros 3 errores del lote si hay
        if (batchErrors > 0 && currentBatch <= 3) {
          console.log(`\n   📋 Primeros errores del lote ${currentBatch}:`);
          const batchErrorDetails = results.filter(r => !r.success).slice(0, 3);
          batchErrorDetails.forEach((err, idx) => {
            console.log(`      ${idx + 1}. Orden ${err.orderNumber}: ${err.error}`);
          });
          console.log('');
        }
        
        // Pausa entre lotes
        if (i + batchSize < shopifyOrders.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('\n╔═══════════════════════════════════════════════╗');
      console.log('║  ✅ SINCRONIZACIÓN DE ÓRDENES COMPLETADA     ║');
      console.log('╚═══════════════════════════════════════════════╝');
      console.log(`📊 Total procesadas: ${shopifyOrders.length}`);
      console.log(`✨ Nuevas creadas: ${created}`);
      console.log(`♻️  Actualizadas: ${updated}`);
      console.log(`⚠️  Sin cliente: ${skippedNoCustomer}`);
      console.log(`❌ Errores: ${errors}`);
      console.log(`⏱️  Tiempo total: ${duration}s`);
      console.log(`⚡ Velocidad: ${(shopifyOrders.length / parseFloat(duration)).toFixed(0)} órdenes/segundo`);
      
      // 🔍 NUEVO: Mostrar resumen de tipos de error
      if (Object.keys(errorTypes).length > 0) {
        console.log('\n📊 TIPOS DE ERRORES:');
        Object.entries(errorTypes).forEach(([type, count]) => {
          console.log(`   ${type}: ${count} ocurrencias`);
        });
      }
      
      console.log('═══════════════════════════════════════════════\n');
      
      const response = {
        success: true,
        total: shopifyOrders.length,
        created,
        updated,
        skippedNoCustomer,
        errors,
        errorTypes,
        duration: `${duration}s`,
        speed: `${(shopifyOrders.length / parseFloat(duration)).toFixed(0)} órdenes/s`
      };
      
      if (errorDetails.length > 0) {
        response.errorDetails = errorDetails.slice(0, 20); // Mostrar más errores
        if (errorDetails.length > 20) {
          response.moreErrors = `y ${errorDetails.length - 20} errores más`;
        }
      }
      
      res.json(response);
      
    } catch (error) {
      console.error('\n╔═══════════════════════════════════════════════╗');
      console.error('║  ❌ ERROR EN SINCRONIZACIÓN DE ÓRDENES       ║');
      console.error('╚═══════════════════════════════════════════════╝');
      console.error('Error:', error.message);
      console.error('Stack completo:', error.stack);
      console.error('═══════════════════════════════════════════════\n');
      
      res.status(500).json({ 
        success: false,
        error: error.message,
        details: error.response?.data 
      });
    }
  }

  // Estadísticas de órdenes
  async stats(req, res) {
    try {
      const totalOrders = await Order.countDocuments();
      
      const revenueData = await Order.aggregate([
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$totalPrice' },
            avgOrderValue: { $avg: '$totalPrice' }
          }
        }
      ]);
      
      const ordersByStatus = await Order.aggregate([
        {
          $group: {
            _id: '$financialStatus',
            count: { $sum: 1 }
          }
        }
      ]);
      
      // Top productos vendidos
      const topProducts = await Order.aggregate([
        { $unwind: '$lineItems' },
        {
          $group: {
            _id: '$lineItems.title',
            quantity: { $sum: '$lineItems.quantity' },
            revenue: { $sum: { $multiply: ['$lineItems.price', '$lineItems.quantity'] } }
          }
        },
        { $sort: { quantity: -1 } },
        { $limit: 10 }
      ]);
      
      res.json({
        totalOrders,
        totalRevenue: revenueData[0]?.totalRevenue || 0,
        averageOrderValue: revenueData[0]?.avgOrderValue || 0,
        ordersByStatus,
        topProducts
      });
      
    } catch (error) {
      console.error('Error obteniendo stats de órdenes:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Revenue timeline
  async revenueTimeline(req, res) {
    try {
      const { days = 30 } = req.query;
      
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));
      
      const timeline = await Order.aggregate([
        {
          $match: {
            orderDate: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$orderDate' }
            },
            revenue: { $sum: '$totalPrice' },
            orders: { $sum: 1 }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]);
      
      res.json(timeline);
      
    } catch (error) {
      console.error('Error en revenue timeline:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new OrdersController();