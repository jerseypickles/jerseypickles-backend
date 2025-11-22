// backend/src/controllers/webhooksController.js (COMPLETO CON FLOWS & TRIGGERS)
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const EmailEvent = require('../models/EmailEvent');
const Campaign = require('../models/Campaign');
const AttributionService = require('../middleware/attributionTracking');
const flowService = require('../services/flowService'); // 🆕 AGREGADO

class WebhooksController {
  
  // ==================== CUSTOMERS ====================
  
  async customerCreate(req, res) {
    try {
      const shopifyCustomer = req.body;
      
      console.log('📥 Webhook: Customer Create', shopifyCustomer.id);
      
      // ✅ CAMBIAR A findOneAndUpdate con upsert
      const customer = await Customer.findOneAndUpdate(
        { shopifyId: shopifyCustomer.id.toString() }, // Buscar por shopifyId
        {
          $set: {
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
          }
        },
        { 
          upsert: true,              // Crea si no existe
          new: true,                 // Retorna el documento nuevo/actualizado
          setDefaultsOnInsert: true  // Aplica defaults del schema si es nuevo
        }
      );
      
      console.log('✅ Cliente creado/actualizado:', customer.email);
      
      // 🆕 ==================== FLOW TRIGGER: CUSTOMER_CREATED ====================
      // Solo trigger si es un cliente NUEVO (no una actualización)
      const isNewCustomer = !shopifyCustomer.created_at || 
        new Date(shopifyCustomer.created_at) > new Date(Date.now() - 60000); // Creado hace menos de 1 minuto
      
      if (isNewCustomer) {
        console.log('🎯 Triggering CUSTOMER_CREATED flow...');
        
        await flowService.processTrigger('customer_created', {
          customerId: customer._id,
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          acceptsMarketing: customer.acceptsMarketing,
          source: 'shopify',
          tags: customer.tags,
          address: customer.address
        }).catch(err => {
          console.error('❌ Flow trigger error:', err.message);
          // No fallar el webhook por error en flows
        });
      }
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en customerCreate:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async customerUpdate(req, res) {
    try {
      const shopifyCustomer = req.body;
      
      console.log('📥 Webhook: Customer Update', shopifyCustomer.id);
      
      // Obtener cliente anterior para comparar tags
      const previousCustomer = await Customer.findOne({ 
        shopifyId: shopifyCustomer.id.toString() 
      });
      
      const previousTags = previousCustomer?.tags || [];
      
      const customer = await Customer.findOneAndUpdate(
        { shopifyId: shopifyCustomer.id.toString() },
        {
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
        { new: true, upsert: true }
      );
      
      console.log('✅ Cliente actualizado:', customer.email);
      
      // 🆕 ==================== FLOW TRIGGER: CUSTOMER_TAG_ADDED ====================
      const currentTags = customer.tags || [];
      const addedTags = currentTags.filter(tag => !previousTags.includes(tag));
      
      if (addedTags.length > 0) {
        console.log(`🏷️  New tags detected: ${addedTags.join(', ')}`);
        
        // Trigger flow para cada tag nuevo
        for (const tag of addedTags) {
          console.log(`🎯 Triggering CUSTOMER_TAG_ADDED flow for tag: ${tag}`);
          
          await flowService.processTrigger('customer_tag_added', {
            customerId: customer._id,
            email: customer.email,
            tag: tag,
            allTags: currentTags,
            previousTags: previousTags
          }).catch(err => {
            console.error(`❌ Flow trigger error for tag ${tag}:`, err.message);
          });
        }
      }
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en customerUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== ORDERS CON REVENUE TRACKING Y FLOWS ====================
  
  async orderCreate(req, res) {
    try {
      const shopifyOrder = req.body;
      
      console.log('\n💰 ==================== NEW ORDER ====================');
      console.log(`📥 Webhook: Order Create #${shopifyOrder.order_number}`);
      console.log(`💵 Order Value: $${shopifyOrder.total_price} ${shopifyOrder.currency}`);
      
      // Buscar o crear cliente
      let customer = await Customer.findOne({ 
        shopifyId: shopifyOrder.customer.id.toString() 
      });
      
      if (!customer) {
        customer = await Customer.create({
          shopifyId: shopifyOrder.customer.id.toString(),
          email: shopifyOrder.customer.email,
          firstName: shopifyOrder.customer.first_name,
          lastName: shopifyOrder.customer.last_name,
          acceptsMarketing: shopifyOrder.customer.accepts_marketing || false
        });
        console.log('✅ Nuevo cliente creado:', customer.email);
      }
      
      // Crear orden
      const order = await Order.create({
        shopifyId: shopifyOrder.id.toString(),
        orderNumber: shopifyOrder.order_number,
        customer: customer._id,
        totalPrice: parseFloat(shopifyOrder.total_price),
        subtotalPrice: parseFloat(shopifyOrder.subtotal_price),
        totalTax: parseFloat(shopifyOrder.total_tax),
        totalShipping: parseFloat(shopifyOrder.total_shipping_price_set?.shop_money?.amount || 0),
        totalDiscounts: parseFloat(shopifyOrder.total_discounts),
        currency: shopifyOrder.currency,
        lineItems: shopifyOrder.line_items.map(item => ({
          productId: item.product_id?.toString(),
          variantId: item.variant_id?.toString(),
          title: item.title,
          quantity: item.quantity,
          price: parseFloat(item.price),
          sku: item.sku
        })),
        financialStatus: shopifyOrder.financial_status,
        fulfillmentStatus: shopifyOrder.fulfillment_status,
        discountCodes: shopifyOrder.discount_codes?.map(d => d.code) || [],
        tags: shopifyOrder.tags?.split(', ') || [],
        orderDate: new Date(shopifyOrder.created_at),
        shopifyData: shopifyOrder
      });
      
      // Obtener conteo anterior de órdenes para detectar primera compra
      const previousOrdersCount = customer.ordersCount || 0;
      
      // Actualizar métricas del cliente
      await Customer.findByIdAndUpdate(customer._id, {
        $inc: { ordersCount: 1 },
        $set: { 
          lastOrderDate: new Date(shopifyOrder.created_at),
          totalSpent: parseFloat(shopifyOrder.customer.total_spent) || 0
        }
      });
      
      console.log('✅ Orden creada en DB:', order.orderNumber);
      
      // ==================== REVENUE ATTRIBUTION (tu código existente) ====================
      
      const attribution = AttributionService.getAttribution(req);
      
      let campaignId = null;
      let flowId = null; // 🆕 Para attribution de flows
      let customerId = customer._id;
      let attributionMethod = 'none';
      
      if (attribution) {
        campaignId = attribution.campaignId;
        customerId = attribution.customerId;
        attributionMethod = 'cookie';
        console.log(`🍪 Attribution found via cookie: Campaign ${campaignId}`);
      } else if (shopifyOrder.landing_site) {
        const urlParams = new URLSearchParams(shopifyOrder.landing_site);
        const utmCampaign = urlParams.get('utm_campaign');
        
        if (utmCampaign && utmCampaign.startsWith('email_')) {
          campaignId = utmCampaign.replace('email_', '');
          attributionMethod = 'utm';
          console.log(`🔗 Attribution found via UTM: Campaign ${campaignId}`);
        } else if (utmCampaign && utmCampaign.startsWith('flow_')) {
          // 🆕 Attribution para flows
          flowId = utmCampaign.replace('flow_', '');
          attributionMethod = 'utm_flow';
          console.log(`🔗 Attribution found via UTM for Flow: ${flowId}`);
        }
      }
      
      if (!campaignId && !flowId) {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        let lastClickEvent = await EmailEvent.findOne({
          $or: [
            { customer: customer._id },
            { customer: customer._id.toString() }
          ],
          eventType: 'clicked',
          eventDate: { $gte: sevenDaysAgo }
        }).sort({ eventDate: -1 });
        
        if (!lastClickEvent && customer.email) {
          console.log(`🔍 No click found by customer ID, trying by email: ${customer.email}`);
          
          lastClickEvent = await EmailEvent.findOne({
            email: customer.email,
            eventType: 'clicked',
            eventDate: { $gte: sevenDaysAgo }
          }).sort({ eventDate: -1 });
          
          if (lastClickEvent) {
            console.log(`📧 Found click by email match!`);
          }
        }
        
        if (lastClickEvent) {
          campaignId = lastClickEvent.campaign;
          attributionMethod = 'last_click';
          console.log(`🔙 Attribution found via last click: Campaign ${campaignId}`);
        }
      }
      
      // Si encontramos atribución de campaña, registrar revenue
      if (campaignId) {
        console.log(`\n💰 ATTRIBUTING REVENUE TO CAMPAIGN`);
        console.log(`   Method: ${attributionMethod}`);
        console.log(`   Campaign: ${campaignId}`);
        console.log(`   Revenue: $${shopifyOrder.total_price}`);
        
        await EmailEvent.create({
          campaign: campaignId,
          customer: customerId,
          email: customer.email,
          eventType: 'purchased',
          source: 'shopify',
          revenue: {
            orderValue: parseFloat(shopifyOrder.total_price),
            orderId: shopifyOrder.id.toString(),
            orderNumber: shopifyOrder.order_number,
            currency: shopifyOrder.currency,
            products: shopifyOrder.line_items.map(item => ({
              productId: item.product_id?.toString(),
              title: item.title,
              quantity: item.quantity,
              price: parseFloat(item.price)
            }))
          },
          metadata: {
            attributionMethod,
            financialStatus: shopifyOrder.financial_status,
            discountCodes: shopifyOrder.discount_codes?.map(d => d.code) || []
          }
        });
        
        await Campaign.updateStats(campaignId, 'purchased', parseFloat(shopifyOrder.total_price));
        
        console.log(`✅ Revenue tracked successfully!`);
      }
      
      // 🆕 Si encontramos atribución de flow, actualizar FlowExecution
      if (flowId) {
        console.log(`\n💰 ATTRIBUTING REVENUE TO FLOW`);
        console.log(`   Flow: ${flowId}`);
        console.log(`   Revenue: $${shopifyOrder.total_price}`);
        
        const FlowExecution = require('../models/FlowExecution');
        await FlowExecution.findOneAndUpdate(
          {
            flow: flowId,
            customer: customer._id,
            status: { $in: ['active', 'waiting', 'completed'] }
          },
          {
            $push: {
              attributedOrders: {
                orderId: order._id,
                amount: parseFloat(shopifyOrder.total_price),
                date: new Date()
              }
            }
          }
        );
        
        const Flow = require('../models/Flow');
        await Flow.findByIdAndUpdate(flowId, {
          $inc: {
            'metrics.totalRevenue': parseFloat(shopifyOrder.total_price),
            'metrics.totalOrders': 1
          }
        });
        
        console.log(`✅ Flow revenue tracked successfully!`);
      }
      
      // 🆕 ==================== FLOW TRIGGERS ====================
      
      // TRIGGER: order_placed
      console.log('🎯 Triggering ORDER_PLACED flow...');
      
      await flowService.processTrigger('order_placed', {
        customerId: customer._id,
        orderId: order._id,
        orderNumber: order.orderNumber,
        orderValue: order.totalPrice,
        currency: order.currency,
        firstOrder: previousOrdersCount === 0,
        ordersCount: previousOrdersCount + 1,
        products: order.lineItems,
        discountCodes: order.discountCodes,
        email: customer.email,
        customerName: `${customer.firstName} ${customer.lastName}`.trim()
      }).catch(err => {
        console.error('❌ Flow trigger error:', err.message);
      });
      
      console.log(`====================================================\n`);
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en orderCreate:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async orderUpdate(req, res) {
    try {
      const shopifyOrder = req.body;
      
      console.log('📥 Webhook: Order Update', shopifyOrder.id);
      
      const previousOrder = await Order.findOne({ 
        shopifyId: shopifyOrder.id.toString() 
      });
      
      const updatedOrder = await Order.findOneAndUpdate(
        { shopifyId: shopifyOrder.id.toString() },
        {
          financialStatus: shopifyOrder.financial_status,
          fulfillmentStatus: shopifyOrder.fulfillment_status,
          totalPrice: parseFloat(shopifyOrder.total_price),
          shopifyData: shopifyOrder
        },
        { new: true }
      );
      
      console.log('✅ Orden actualizada');
      
      // 🆕 ==================== FLOW TRIGGERS PARA CAMBIOS DE ESTADO ====================
      
      // Si cambió el fulfillment status
      if (previousOrder && previousOrder.fulfillmentStatus !== updatedOrder.fulfillmentStatus) {
        
        // TRIGGER: order_fulfilled
        if (updatedOrder.fulfillmentStatus === 'fulfilled') {
          console.log('🎯 Triggering ORDER_FULFILLED flow...');
          
          const customer = await Customer.findById(updatedOrder.customer);
          
          await flowService.processTrigger('order_fulfilled', {
            customerId: customer._id,
            orderId: updatedOrder._id,
            orderNumber: updatedOrder.orderNumber,
            email: customer.email,
            fulfillmentStatus: updatedOrder.fulfillmentStatus
          }).catch(err => {
            console.error('❌ Flow trigger error:', err.message);
          });
        }
      }
      
      // Si cambió el financial status
      if (previousOrder && previousOrder.financialStatus !== updatedOrder.financialStatus) {
        
        // TRIGGER: order_refunded
        if (updatedOrder.financialStatus === 'refunded' || 
            updatedOrder.financialStatus === 'partially_refunded') {
          console.log('🎯 Triggering ORDER_REFUNDED flow...');
          
          const customer = await Customer.findById(updatedOrder.customer);
          
          await flowService.processTrigger('order_refunded', {
            customerId: customer._id,
            orderId: updatedOrder._id,
            orderNumber: updatedOrder.orderNumber,
            email: customer.email,
            financialStatus: updatedOrder.financialStatus,
            refundAmount: shopifyOrder.total_refunded_set?.shop_money?.amount || 0
          }).catch(err => {
            console.error('❌ Flow trigger error:', err.message);
          });
        }
      }
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en orderUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  // 🆕 ==================== NUEVOS WEBHOOKS PARA FLOWS ====================
  
  /**
   * Webhook para carritos actualizados (necesitas configurarlo en Shopify)
   */
  async cartUpdate(req, res) {
    try {
      const cartData = req.body;
      
      console.log('🛒 Webhook: Cart Update', cartData.id);
      
      // Actualizar información del carrito en el cliente
      if (cartData.customer) {
        await Customer.findOneAndUpdate(
          { shopifyId: cartData.customer.id.toString() },
          {
            $set: {
              lastCartActivity: new Date(),
              cartItems: cartData.line_items?.map(item => ({
                productId: item.product_id,
                variantId: item.variant_id,
                title: item.title,
                quantity: item.quantity,
                price: item.price
              })) || [],
              cartValue: parseFloat(cartData.total_price) || 0,
              cartToken: cartData.token
            }
          }
        );
      }
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en cartUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Webhook para productos back in stock
   */
  async productUpdate(req, res) {
    try {
      const product = req.body;
      
      console.log('📦 Webhook: Product Update', product.id);
      
      // Verificar si volvió a estar en stock
      const wasOutOfStock = product.variants?.some(v => 
        v.inventory_quantity === 0 && v.old_inventory_quantity > 0
      );
      
      if (wasOutOfStock) {
        console.log('🎯 Product back in stock detected');
        
        // Buscar clientes que esperan este producto
        // (necesitarías trackear esto de alguna forma)
        
        await flowService.processTrigger('product_back_in_stock', {
          productId: product.id,
          productTitle: product.title,
          variants: product.variants
        }).catch(err => {
          console.error('❌ Flow trigger error:', err.message);
        });
      }
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en productUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new WebhooksController();