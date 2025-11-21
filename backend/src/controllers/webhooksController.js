// backend/src/controllers/webhooksController.js (ACTUALIZADO CON REVENUE - FIX CUSTOMER MATCHING)
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const EmailEvent = require('../models/EmailEvent');
const Campaign = require('../models/Campaign');
const AttributionService = require('../middleware/attributionTracking');

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
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en customerUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== ORDERS CON REVENUE TRACKING ====================
  
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
      
      // Actualizar métricas del cliente
      await Customer.findByIdAndUpdate(customer._id, {
        $inc: { ordersCount: 1 },
        $set: { 
          lastOrderDate: new Date(shopifyOrder.created_at),
          totalSpent: parseFloat(shopifyOrder.customer.total_spent) || 0
        }
      });
      
      console.log('✅ Orden creada en DB:', order.orderNumber);
      
      // 🆕 ==================== REVENUE ATTRIBUTION ====================
      
      // 🍪 MÉTODO 1: Buscar attribution cookie (si viene en el request)
      // NOTA: Los webhooks de Shopify NO incluyen cookies del usuario
      // Esta parte es para cuando implementes un endpoint de confirmation
      const attribution = AttributionService.getAttribution(req);
      
      // 🔍 MÉTODO 2: Buscar por UTM params guardados en la orden
      // Shopify guarda landing_site con UTM parameters
      let campaignId = null;
      let customerId = customer._id;
      let attributionMethod = 'none';
      
      if (attribution) {
        campaignId = attribution.campaignId;
        customerId = attribution.customerId;
        attributionMethod = 'cookie';
        console.log(`🍪 Attribution found via cookie: Campaign ${campaignId}`);
      } else if (shopifyOrder.landing_site) {
        // Extraer campaign_id de UTM params
        const urlParams = new URLSearchParams(shopifyOrder.landing_site);
        const utmCampaign = urlParams.get('utm_campaign');
        
        if (utmCampaign && utmCampaign.startsWith('email_')) {
          campaignId = utmCampaign.replace('email_', '');
          attributionMethod = 'utm';
          console.log(`🔗 Attribution found via UTM: Campaign ${campaignId}`);
        }
      }
      
      // 🔍 MÉTODO 3: Buscar último click en los últimos 7 días
      if (!campaignId) {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        // ✅ FIX: Buscar por AMBOS tipos (String y ObjectId) para compatibilidad
        const lastClickEvent = await EmailEvent.findOne({
          $or: [
            { customer: customer._id },              // ObjectId
            { customer: customer._id.toString() }    // String
          ],
          eventType: 'clicked',
          eventDate: { $gte: sevenDaysAgo }
        }).sort({ eventDate: -1 });
        
        if (lastClickEvent) {
          campaignId = lastClickEvent.campaign;
          attributionMethod = 'last_click';
          console.log(`🔙 Attribution found via last click: Campaign ${campaignId}`);
          console.log(`   Click event customer ID: ${lastClickEvent.customer} (${typeof lastClickEvent.customer})`);
          console.log(`   Current customer ID: ${customer._id} (ObjectId)`);
        } else {
          console.log(`🔍 No click events found for customer ${customer._id}`);
          console.log(`   Checked both ObjectId and String formats`);
        }
      }
      
      // Si encontramos atribución, registrar revenue event
      if (campaignId) {
        console.log(`\n💰 ATTRIBUTING REVENUE TO CAMPAIGN`);
        console.log(`   Method: ${attributionMethod}`);
        console.log(`   Campaign: ${campaignId}`);
        console.log(`   Revenue: $${shopifyOrder.total_price}`);
        
        // Registrar evento de purchase
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
        
        // Actualizar stats de campaña
        await Campaign.updateStats(campaignId, 'purchased', parseFloat(shopifyOrder.total_price));
        
        console.log(`✅ Revenue tracked successfully!`);
        console.log(`====================================================\n`);
      } else {
        console.log(`ℹ️  No attribution found for this order`);
        console.log(`   Tried: cookie, UTM params, and last click (7 days)`);
        console.log(`====================================================\n`);
      }
      
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
      
      await Order.findOneAndUpdate(
        { shopifyId: shopifyOrder.id.toString() },
        {
          financialStatus: shopifyOrder.financial_status,
          fulfillmentStatus: shopifyOrder.fulfillment_status,
          totalPrice: parseFloat(shopifyOrder.total_price),
          shopifyData: shopifyOrder
        }
      );
      
      console.log('✅ Orden actualizada');
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en orderUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new WebhooksController();