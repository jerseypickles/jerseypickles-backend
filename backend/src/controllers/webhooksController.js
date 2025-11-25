// backend/src/controllers/webhooksController.js - COMPLETO (Shopify + Resend)
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const EmailEvent = require('../models/EmailEvent');
const EmailSend = require('../models/EmailSend');
const Campaign = require('../models/Campaign');
const AttributionService = require('../middleware/attributionTracking');
const crypto = require('crypto');

class WebhooksController {
  
  // ==================== SHOPIFY WEBHOOKS ====================
  
  async customerCreate(req, res) {
    try {
      const shopifyCustomer = req.body;
      
      console.log('📥 Webhook: Customer Create', shopifyCustomer.id);
      
      const customer = await Customer.findOneAndUpdate(
        { shopifyId: shopifyCustomer.id.toString() },
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
          upsert: true,
          new: true,
          setDefaultsOnInsert: true
        }
      );
      
      console.log('✅ Cliente creado/actualizado:', customer.email);
      
      // FLOW TRIGGER: CUSTOMER_CREATED
      const isNewCustomer = !shopifyCustomer.created_at || 
        new Date(shopifyCustomer.created_at) > new Date(Date.now() - 60000);
      
      if (isNewCustomer) {
        console.log('🎯 Triggering CUSTOMER_CREATED flow...');
        
        try {
          const flowService = require('../services/flowService');
          await flowService.processTrigger('customer_created', {
            customerId: customer._id,
            email: customer.email,
            firstName: customer.firstName,
            lastName: customer.lastName,
            acceptsMarketing: customer.acceptsMarketing,
            source: 'shopify',
            tags: customer.tags,
            address: customer.address
          });
        } catch (err) {
          console.log('Flow service not available:', err.message);
        }
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
      
      // FLOW TRIGGER: CUSTOMER_TAG_ADDED
      const currentTags = customer.tags || [];
      const addedTags = currentTags.filter(tag => !previousTags.includes(tag));
      
      if (addedTags.length > 0) {
        console.log(`🏷️  New tags detected: ${addedTags.join(', ')}`);
        
        for (const tag of addedTags) {
          console.log(`🎯 Triggering CUSTOMER_TAG_ADDED flow for tag: ${tag}`);
          
          try {
            const flowService = require('../services/flowService');
            await flowService.processTrigger('customer_tag_added', {
              customerId: customer._id,
              email: customer.email,
              tag: tag,
              allTags: currentTags,
              previousTags: previousTags
            });
          } catch (err) {
            console.log('Flow service not available:', err.message);
          }
        }
      }
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error en customerUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }

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
      
      // ==================== REVENUE ATTRIBUTION ====================
      
      const attribution = AttributionService.getAttribution(req);
      
      let campaignId = null;
      let flowId = null;
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
      
      // Revenue tracking para campaigns
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
      
      // Revenue tracking para flows
      if (flowId) {
        console.log(`\n💰 ATTRIBUTING REVENUE TO FLOW`);
        console.log(`   Flow: ${flowId}`);
        console.log(`   Revenue: $${shopifyOrder.total_price}`);
        
        try {
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
        } catch (err) {
          console.log('Flow models not available:', err.message);
        }
      }
      
      // FLOW TRIGGER: order_placed
      console.log('🎯 Triggering ORDER_PLACED flow...');
      
      try {
        const flowService = require('../services/flowService');
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
        });
      } catch (err) {
        console.log('Flow service not available:', err.message);
      }
      
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
  
  async orderFulfilled(req, res) {
    try {
      const order = req.body;
      console.log('📦 Webhook: Order Fulfilled', order.id);
      
      const customer = await Customer.findOne({ 
        shopifyId: order.customer?.id?.toString() 
      });
      
      if (customer) {
        try {
          const flowService = require('../services/flowService');
          await flowService.processTrigger('order_fulfilled', {
            customerId: customer._id,
            orderId: order.id,
            orderNumber: order.order_number,
            trackingNumber: order.fulfillments?.[0]?.tracking_number,
            trackingUrl: order.fulfillments?.[0]?.tracking_url,
            email: customer.email
          });
        } catch (err) {
          console.log('Flow service not available:', err.message);
        }
      }
      
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Error en orderFulfilled:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async orderCancelled(req, res) {
    try {
      const order = req.body;
      console.log('❌ Webhook: Order Cancelled', order.id);
      
      const customer = await Customer.findOne({ 
        shopifyId: order.customer?.id?.toString() 
      });
      
      if (customer) {
        try {
          const flowService = require('../services/flowService');
          await flowService.processTrigger('order_cancelled', {
            customerId: customer._id,
            orderId: order.id,
            orderNumber: order.order_number,
            cancelReason: order.cancel_reason,
            refundAmount: order.total_price,
            email: customer.email
          });
        } catch (err) {
          console.log('Flow service not available:', err.message);
        }
      }
      
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Error en orderCancelled:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async orderPaid(req, res) {
    try {
      const order = req.body;
      console.log('💰 Webhook: Order Paid', order.id);
      
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Error en orderPaid:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async checkoutCreate(req, res) {
    try {
      const checkout = req.body;
      console.log('🛒 Webhook: Checkout Created', checkout.id);
      
      if (checkout.customer) {
        await Customer.findOneAndUpdate(
          { shopifyId: checkout.customer.id.toString() },
          {
            $set: {
              lastCartActivity: new Date(),
              abandonedCheckoutId: checkout.id,
              cartValue: parseFloat(checkout.total_price || 0),
              cartItems: checkout.line_items?.map(item => ({
                title: item.title,
                quantity: item.quantity,
                price: item.price
              })) || []
            }
          }
        );
      }
      
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Error en checkoutCreate:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async checkoutUpdate(req, res) {
    try {
      const checkout = req.body;
      console.log('🛒 Webhook: Checkout Updated', checkout.id);
      
      if (!checkout.customer) {
        return res.status(200).json({ success: true });
      }
      
      if (checkout.completed_at) {
        await Customer.findOneAndUpdate(
          { shopifyId: checkout.customer.id.toString() },
          {
            $unset: { 
              abandonedCheckoutId: 1,
              cartItems: 1,
              cartValue: 1
            }
          }
        );
      } else {
        await Customer.findOneAndUpdate(
          { shopifyId: checkout.customer.id.toString() },
          {
            $set: {
              lastCartActivity: new Date(),
              cartValue: parseFloat(checkout.total_price || 0)
            }
          }
        );
      }
      
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Error en checkoutUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async productUpdate(req, res) {
    try {
      const product = req.body;
      console.log('📦 Webhook: Product Update', product.id);
      
      const variants = product.variants || [];
      const nowInStock = variants.filter(v => 
        v.inventory_quantity > 0 && 
        v.old_inventory_quantity === 0
      );
      
      if (nowInStock.length > 0) {
        try {
          const flowService = require('../services/flowService');
          await flowService.processTrigger('product_back_in_stock', {
            productId: product.id,
            productTitle: product.title,
            productHandle: product.handle,
            variants: nowInStock
          });
        } catch (err) {
          console.log('Flow service not available:', err.message);
        }
      }
      
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Error en productUpdate:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async refundCreate(req, res) {
    try {
      const refund = req.body;
      console.log('💸 Webhook: Refund Created', refund.id);
      
      const order = await Order.findOne({ 
        shopifyId: refund.order_id?.toString() 
      });
      
      if (order) {
        const customer = await Customer.findById(order.customer);
        
        if (customer) {
          try {
            const flowService = require('../services/flowService');
            await flowService.processTrigger('order_refunded', {
              customerId: customer._id,
              orderId: order._id,
              refundAmount: parseFloat(refund.transactions?.[0]?.amount || 0),
              refundReason: refund.note,
              email: customer.email
            });
          } catch (err) {
            console.log('Flow service not available:', err.message);
          }
        }
      }
      
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Error en refundCreate:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== RESEND WEBHOOKS (NUEVO - IDEMPOTENTE) ====================
  
  /**
   * Handler para webhooks de Resend
   * IDEMPOTENCIA: Usa eventId único para prevenir procesamiento duplicado
   * 
   * Eventos soportados:
   * - email.sent
   * - email.delivered ← IMPORTANTE: Incrementa delivered aquí (NO en worker)
   * - email.opened
   * - email.clicked
   * - email.bounced
   * - email.complained
   */
  async handleResendWebhook(req, res) {
    try {
      const { type, data, created_at } = req.body;
      
      if (!type || !data) {
        return res.status(400).json({ error: 'Payload inválido' });
      }
      
      console.log(`\n📬 Webhook Resend: ${type} → ${data.to || data.email || 'unknown'}`);
      
      // ========== PASO 1: Generar eventId ÚNICO ==========
      const eventId = this.generateEventId(data.email_id, type);
      
      // ========== PASO 2: Intentar crear evento (idempotente) ==========
      try {
        await EmailEvent.create({
          eventId,                          // Índice único - falla si ya existe
          campaign: data.tags?.campaign_id || null,
          customer: data.tags?.customer_id || null,
          email: data.to || data.email,
          eventType: this.mapResendEventType(type),
          source: 'resend',
          resendId: data.email_id,
          eventDate: created_at ? new Date(created_at) : new Date(),
          metadata: {
            subject: data.subject,
            from: data.from,
            ...this.extractEventMetadata(type, data)
          }
        });
        
        console.log(`   ✅ Evento ${eventId} creado`);
        
      } catch (error) {
        if (error.code === 11000) {
          // Duplicate key - evento ya procesado
          console.log(`   ℹ️  Evento ${eventId} ya procesado (duplicado ignorado)`);
          return res.status(200).json({ 
            success: true, 
            message: 'Evento ya procesado' 
          });
        }
        throw error;
      }
      
      // ========== PASO 3: Actualizar EmailSend status ==========
      if (data.email_id) {
        await this.updateEmailSendStatus(data.email_id, type, data);
      }
      
      // ========== PASO 4: Actualizar stats de campaña ==========
      if (data.tags?.campaign_id) {
        await this.updateCampaignStats(data.tags.campaign_id, type);
      }
      
      // ========== PASO 5: Verificar si campaña terminó ==========
      if (data.tags?.campaign_id && type === 'email.delivered') {
        const { checkAndFinalizeCampaign } = require('../jobs/emailQueue');
        
        setImmediate(async () => {
          try {
            await checkAndFinalizeCampaign(data.tags.campaign_id);
          } catch (err) {
            console.error('Error verificando finalización:', err.message);
          }
        });
      }
      
      console.log(`   ✅ Webhook procesado exitosamente\n`);
      
      // CRÍTICO: Siempre responder 200 para que Resend no reintente
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error procesando webhook Resend:', error);
      
      // Aún así responder 200 para evitar reintentos infinitos
      res.status(200).json({ 
        success: false, 
        error: error.message 
      });
    }
  }
  
  /**
   * Actualiza el estado de EmailSend basado en el webhook
   */
  async updateEmailSendStatus(resendEmailId, eventType, data) {
    try {
      const emailSend = await EmailSend.findOne({ 
        externalMessageId: resendEmailId 
      });
      
      if (!emailSend) {
        console.log(`   ⚠️  EmailSend no encontrado para ${resendEmailId}`);
        return;
      }
      
      const updates = {};
      
      switch (eventType) {
        case 'email.sent':
          // Ya está marcado como 'sent' desde el worker
          break;
          
        case 'email.delivered':
          updates.status = 'delivered';
          updates.deliveredAt = new Date();
          console.log(`   📧 Email ${emailSend.recipientEmail} → delivered`);
          break;
          
        case 'email.bounced':
          updates.status = 'bounced';
          updates.lastError = data.bounce?.message || 'Email bounced';
          console.log(`   ⚠️  Email ${emailSend.recipientEmail} → bounced`);
          break;
          
        case 'email.complained':
          updates.status = 'bounced';
          updates.lastError = 'Spam complaint';
          console.log(`   ⚠️  Email ${emailSend.recipientEmail} → spam complaint`);
          break;
          
        default:
          // Eventos de tracking (opened, clicked) no cambian status
          break;
      }
      
      if (Object.keys(updates).length > 0) {
        await EmailSend.findByIdAndUpdate(emailSend._id, {
          $set: updates,
          $inc: { version: 1 }
        });
      }
      
    } catch (error) {
      console.error(`   Error actualizando EmailSend: ${error.message}`);
    }
  }
  
  /**
   * Actualiza stats de campaña basado en el webhook
   * IMPORTANTE: delivered se incrementa AQUÍ, no en el worker
   */
  async updateCampaignStats(campaignId, eventType) {
    try {
      const campaign = await Campaign.findById(campaignId);
      
      if (!campaign) {
        console.log(`   ⚠️  Campaña ${campaignId} no encontrada`);
        return;
      }
      
      const updates = {};
      
      switch (eventType) {
        case 'email.delivered':
          // ✅ CRÍTICO: delivered se incrementa SOLO aquí (NO en worker)
          updates['stats.delivered'] = 1;
          console.log(`   📊 Campaign ${campaign.name}: delivered +1`);
          break;
          
        case 'email.opened':
          updates['stats.opened'] = 1;
          break;
          
        case 'email.clicked':
          updates['stats.clicked'] = 1;
          break;
          
        case 'email.bounced':
          updates['stats.bounced'] = 1;
          break;
          
        case 'email.complained':
          updates['stats.complained'] = 1;
          break;
      }
      
      if (Object.keys(updates).length > 0) {
        await Campaign.findByIdAndUpdate(campaignId, {
          $inc: updates
        });
        
        // Actualizar rates
        if (eventType === 'email.delivered' || eventType === 'email.opened' || eventType === 'email.clicked') {
          const refreshedCampaign = await Campaign.findById(campaignId);
          refreshedCampaign.updateRates();
          await refreshedCampaign.save();
        }
      }
      
    } catch (error) {
      console.error(`   Error actualizando campaign stats: ${error.message}`);
    }
  }
  
  /**
   * Genera un eventId único para idempotencia
   */
  generateEventId(emailId, eventType) {
    const normalized = `${emailId}:${eventType}`;
    return crypto
      .createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 32);
  }
  
  /**
   * Mapea tipos de eventos de Resend a nuestros tipos
   */
  mapResendEventType(resendType) {
    const mapping = {
      'email.sent': 'sent',
      'email.delivered': 'delivered',
      'email.opened': 'opened',
      'email.clicked': 'clicked',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
      'email.delivery_delayed': 'delayed'
    };
    
    return mapping[resendType] || 'unknown';
  }
  
  /**
   * Extrae metadata relevante según tipo de evento
   */
  extractEventMetadata(eventType, data) {
    const metadata = {};
    
    switch (eventType) {
      case 'email.opened':
        metadata.userAgent = data.user_agent;
        metadata.ipAddress = data.ip_address;
        break;
        
      case 'email.clicked':
        metadata.url = data.click?.link;
        metadata.userAgent = data.user_agent;
        metadata.ipAddress = data.ip_address;
        break;
        
      case 'email.bounced':
        metadata.bounceType = data.bounce?.type;
        metadata.bounceMessage = data.bounce?.message;
        break;
        
      case 'email.complained':
        metadata.feedbackType = data.complaint?.feedback_type;
        break;
    }
    
    return metadata;
  }
}

module.exports = new WebhooksController();