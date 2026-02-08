// backend/src/controllers/webhooksController.js
// 📡 COMPLETE WEBHOOK CONTROLLER WITH LOGGING, MONITORING & SMS CONVERSION TRACKING
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const EmailEvent = require('../models/EmailEvent');
const EmailSend = require('../models/EmailSend');
const Campaign = require('../models/Campaign');
const BybFunnelEvent = require('../models/BybFunnelEvent');
const WebhookLog = require('../models/WebhookLog');
const AttributionService = require('../middleware/attributionTracking');
const crypto = require('crypto');

// SMS Conversion Service
const smsConversionService = require('../services/smsConversionService');

// SMS Campaign Conversion Service (for campaign discount codes like BOWL20)
let smsCampaignConversionService = null;
try {
  smsCampaignConversionService = require('../services/smsCampaignConversionService');
  console.log('✅ SMS Campaign Conversion Service loaded');
} catch (err) {
  console.log('⚠️ SMS Campaign Conversion Service not available:', err.message);
}

// SMS Transactional Service (Order Confirmation, Shipping, Delivery)
let smsTransactionalService = null;
try {
  smsTransactionalService = require('../services/smsTransactionalService');
  console.log('✅ SMS Transactional Service loaded');
} catch (err) {
  console.log('⚠️ SMS Transactional Service not available:', err.message);
}

// Store for tracking abandoned carts (in production, use Redis)
const abandonedCartTracker = new Map();

// ==================== HELPER FUNCTIONS ====================

const extractHeaders = (req) => ({
  shopifyTopic: req.headers['x-shopify-topic'],
  shopifyHmac: req.headers['x-shopify-hmac-sha256'],
  shopifyShopDomain: req.headers['x-shopify-shop-domain'],
  shopifyApiVersion: req.headers['x-shopify-api-version'],
  shopifyWebhookId: req.headers['x-shopify-webhook-id']
});

const extractMetadata = (req) => ({
  ip: req.ip || req.headers['x-forwarded-for'],
  userAgent: req.headers['user-agent'],
  contentLength: req.headers['content-length'],
  receivedAt: new Date()
});

const parseLineItemProperties = (properties) => {
  if (!properties) return {};

  if (Array.isArray(properties)) {
    return properties.reduce((acc, prop) => {
      const key = prop?.name || prop?.key;
      if (!key) return acc;
      acc[String(key)] = prop?.value;
      return acc;
    }, {});
  }

  if (typeof properties === 'object') return properties;
  return {};
};

const parseJarCountFromBoxSize = (boxSize) => {
  if (!boxSize) return undefined;
  const match = String(boxSize).match(/(\d+)/);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
};

const parseSelectedProducts = (selectedProducts) => {
  if (!selectedProducts || typeof selectedProducts !== 'string') return [];

  return selectedProducts
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(.*)\((\d+)\)$/);
      if (match) {
        return {
          name: match[1].trim(),
          quantity: parseInt(match[2], 10) || 1
        };
      }

      return { name: item, quantity: 1 };
    });
};

const extractBybContextFromOrder = (order = {}) => {
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const bybSignalKeys = new Set([
    'Box_Type',
    'Jar_Type',
    'Box_Size',
    'Max_Items',
    'Selected_Barcodes',
    'Selected_Product_Names',
    'Extra_Olive',
    '_byb_session',
    '_byb_addon'
  ]);

  let isByb = false;
  let sessionId = null;
  let baseLineItem = null;
  let baseProps = null;

  for (const item of lineItems) {
    const properties = parseLineItemProperties(item?.properties);
    const propKeys = Object.keys(properties);
    const hasBybProperty = propKeys.some(
      (key) => bybSignalKeys.has(key) || key.startsWith('_byb_')
    );
    const title = String(item?.title || '').toLowerCase();
    const productType = String(item?.product_type || '').toLowerCase();
    const hasBybTitleSignal = title.includes('build your box') || title.includes('byb');
    const hasBybTypeSignal = productType.includes('build your box') || productType === 'byb';

    if (!hasBybProperty && !hasBybTitleSignal && !hasBybTypeSignal) continue;

    isByb = true;

    if (!sessionId && properties._byb_session) {
      sessionId = String(properties._byb_session).trim();
    }

    const isAddon = String(properties._byb_addon || '').toLowerCase() === 'true';
    if (!isAddon && !baseProps) {
      baseProps = properties;
      baseLineItem = item;
    }
  }

  if (!sessionId && Array.isArray(order.note_attributes)) {
    for (const attr of order.note_attributes) {
      const key = String(attr?.name || '').trim();
      if (!key) continue;
      if (key === '_byb_session' || key === 'byb_session_id') {
        const value = String(attr?.value || '').trim();
        if (value) {
          sessionId = value;
          break;
        }
      }
    }
  }

  if (!isByb) {
    return {
      isByb: false,
      sessionId: null,
      metadata: {}
    };
  }

  const maxItems = parseInt(baseProps?.Max_Items, 10);
  const productsSelected = parseSelectedProducts(baseProps?.Selected_Product_Names);
  const productsCountFromNames = productsSelected.reduce(
    (sum, product) => sum + (parseInt(product.quantity, 10) || 0),
    0
  );
  const jarCountFromSize = parseJarCountFromBoxSize(baseProps?.Box_Size);
  const lineItemPrice = parseFloat(baseLineItem?.price || baseLineItem?.final_price || 0);
  const extraOliveAccepted = String(baseProps?.Extra_Olive || '').toLowerCase() === 'yes';

  return {
    isByb: true,
    sessionId: sessionId || null,
    metadata: {
      jarType: baseProps?.Jar_Type || undefined,
      jarCount: jarCountFromSize || (Number.isFinite(maxItems) ? maxItems : undefined),
      boxPrice: Number.isFinite(lineItemPrice) ? lineItemPrice : undefined,
      productsSelected,
      totalProducts: productsCountFromNames || (Number.isFinite(maxItems) ? maxItems : undefined),
      extraOliveShown: extraOliveAccepted || undefined,
      extraOliveAccepted: extraOliveAccepted || undefined
    }
  };
};

const appendBybStep8Action = (actions, bybFunnelResult, fallbackOrderId) => {
  if (!bybFunnelResult) return;

  if (bybFunnelResult.tracked) {
    actions.push({
      type: 'byb_funnel_step_8_recorded',
      details: {
        eventId: bybFunnelResult.eventId,
        sessionId: bybFunnelResult.sessionId,
        usedFallbackSession: bybFunnelResult.usedFallbackSession
      },
      success: true
    });
    return;
  }

  if (bybFunnelResult.reason === 'already_tracked') {
    actions.push({
      type: 'byb_funnel_step_8_already_tracked',
      details: { orderId: fallbackOrderId || bybFunnelResult.orderId || null },
      success: true
    });
    return;
  }

  if (bybFunnelResult.reason !== 'not_byb') {
    actions.push({
      type: 'byb_funnel_step_8_recorded',
      details: { error: bybFunnelResult.error || bybFunnelResult.reason },
      success: false
    });
  }
};

class WebhooksController {
  
  // ==================== SHOPIFY WEBHOOKS ====================
  
  async customerCreate(req, res) {
    const topic = 'customers/create';
    let webhookLog;
    
    try {
      const shopifyCustomer = req.body;
      
      // Log the webhook
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: shopifyCustomer.id?.toString(),
        email: shopifyCustomer.email,
        payload: shopifyCustomer,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('📥 Webhook: Customer Create', shopifyCustomer.id);
      
      await webhookLog.markProcessing();
      
      const actions = [];
      const flowsTriggered = [];
      
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
      
      actions.push({
        type: 'customer_upserted',
        details: { customerId: customer._id, email: customer.email },
        success: true
      });
      
      // FLOW TRIGGER: CUSTOMER_CREATED
      const isNewCustomer = !shopifyCustomer.created_at || 
        new Date(shopifyCustomer.created_at) > new Date(Date.now() - 60000);
      
      if (isNewCustomer) {
        console.log('🎯 Triggering CUSTOMER_CREATED flow...');
        
        try {
          const flowService = require('../services/flowService');
          const result = await flowService.processTrigger('customer_created', {
            customerId: customer._id,
            email: customer.email,
            firstName: customer.firstName,
            lastName: customer.lastName,
            acceptsMarketing: customer.acceptsMarketing,
            source: 'shopify',
            tags: customer.tags,
            address: customer.address
          });
          
          if (result?.flowsTriggered) {
            result.flowsTriggered.forEach(f => {
              flowsTriggered.push({
                flowId: f.flowId,
                flowName: f.flowName,
                executionId: f.executionId
              });
            });
          }
          
          actions.push({
            type: 'flow_trigger_customer_created',
            details: { flowsTriggered: flowsTriggered.length },
            success: true
          });
          
        } catch (err) {
          console.log('Flow service not available:', err.message);
          actions.push({
            type: 'flow_trigger_customer_created',
            details: { error: err.message },
            success: false,
            error: err.message
          });
        }
      }
      
      await webhookLog.markProcessed(actions, flowsTriggered);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en customerCreate:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  async customerUpdate(req, res) {
    const topic = 'customers/update';
    let webhookLog;
    
    try {
      const shopifyCustomer = req.body;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: shopifyCustomer.id?.toString(),
        email: shopifyCustomer.email,
        payload: shopifyCustomer,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('📥 Webhook: Customer Update', shopifyCustomer.id);
      
      await webhookLog.markProcessing();
      
      const actions = [];
      const flowsTriggered = [];
      
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
      
      actions.push({
        type: 'customer_updated',
        details: { customerId: customer._id, email: customer.email },
        success: true
      });
      
      // FLOW TRIGGER: CUSTOMER_TAG_ADDED
      const currentTags = customer.tags || [];
      const addedTags = currentTags.filter(tag => !previousTags.includes(tag));
      
      if (addedTags.length > 0) {
        console.log(`🏷️  New tags detected: ${addedTags.join(', ')}`);
        
        for (const tag of addedTags) {
          console.log(`🎯 Triggering CUSTOMER_TAG_ADDED flow for tag: ${tag}`);
          
          try {
            const flowService = require('../services/flowService');
            const result = await flowService.processTrigger('customer_tag_added', {
              customerId: customer._id,
              email: customer.email,
              tag: tag,
              allTags: currentTags,
              previousTags: previousTags
            });
            
            if (result?.flowsTriggered) {
              result.flowsTriggered.forEach(f => {
                flowsTriggered.push({
                  flowId: f.flowId,
                  flowName: f.flowName,
                  executionId: f.executionId
                });
              });
            }
            
            actions.push({
              type: 'flow_trigger_tag_added',
              details: { tag, flowsTriggered: result?.flowsTriggered?.length || 0 },
              success: true
            });
            
          } catch (err) {
            console.log('Flow service not available:', err.message);
            actions.push({
              type: 'flow_trigger_tag_added',
              details: { tag, error: err.message },
              success: false,
              error: err.message
            });
          }
        }
      }
      
      await webhookLog.markProcessed(actions, flowsTriggered);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en customerUpdate:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  async orderCreate(req, res) {
    const topic = 'orders/create';
    let webhookLog;
    
    try {
      const shopifyOrder = req.body;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: shopifyOrder.id?.toString(),
        email: shopifyOrder.email || shopifyOrder.customer?.email,
        payload: shopifyOrder,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('\n💰 ==================== NEW ORDER ====================');
      console.log(`📥 Webhook: Order Create #${shopifyOrder.order_number}`);
      console.log(`💵 Order Value: $${shopifyOrder.total_price} ${shopifyOrder.currency}`);
      
      await webhookLog.markProcessing();
      
      const actions = [];
      const flowsTriggered = [];

      const shopifyOrderId = shopifyOrder.id?.toString();
      const customerEmail = shopifyOrder.customer?.email || shopifyOrder.email;
      const customerShopifyId = shopifyOrder.customer?.id?.toString();

      // Idempotency guard: Shopify can retry orders/create webhooks.
      if (shopifyOrderId) {
        const existingOrder = await Order.findOne({ shopifyId: shopifyOrderId })
          .select('_id orderNumber totalPrice')
          .lean();

        if (existingOrder) {
          console.log(`⏭️ Order already exists in DB: #${existingOrder.orderNumber || shopifyOrderId}`);
          actions.push({
            type: 'order_already_exists',
            details: {
              orderId: existingOrder._id?.toString(),
              shopifyId: shopifyOrderId,
              orderNumber: existingOrder.orderNumber,
              total: existingOrder.totalPrice
            },
            success: true
          });

          const bybFunnelResult = await WebhooksController.prototype.recordBybPurchaseCompleteFromOrder(
            shopifyOrder,
            topic
          );
          appendBybStep8Action(actions, bybFunnelResult, shopifyOrderId);

          await webhookLog.markProcessed(actions, flowsTriggered);
          return res.status(200).json({ success: true, logId: webhookLog._id, duplicate: true });
        }
      }
      
      // Buscar o crear cliente
      if (!customerEmail) {
        throw new Error('Order missing customer email');
      }

      let customer = null;
      if (customerShopifyId) {
        customer = await Customer.findOne({ shopifyId: customerShopifyId });
      }
      if (!customer) {
        customer = await Customer.findOne({ email: customerEmail.toLowerCase() });
      }
      
      if (!customer) {
        const customerPayload = {
          email: customerEmail,
          firstName: shopifyOrder.customer?.first_name || '',
          lastName: shopifyOrder.customer?.last_name || '',
          acceptsMarketing: shopifyOrder.customer?.accepts_marketing || false
        };

        if (customerShopifyId) {
          customerPayload.shopifyId = customerShopifyId;
        }

        customer = await Customer.create(customerPayload);
        console.log('✅ Nuevo cliente creado:', customer.email);
        
        actions.push({
          type: 'customer_created_from_order',
          details: { email: customer.email },
          success: true
        });
      }
      
      // Crear orden
      const orderPayload = {
        shopifyId: shopifyOrderId,
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
      };

      let order;
      try {
        order = await Order.create(orderPayload);
      } catch (createError) {
        if (createError?.code === 11000 && createError?.keyPattern?.shopifyId) {
          const dupOrder = await Order.findOne({ shopifyId: shopifyOrderId })
            .select('_id orderNumber totalPrice')
            .lean();

          console.log(`⏭️ Duplicate orders/create webhook detected for Shopify order ${shopifyOrderId}`);
          actions.push({
            type: 'order_already_exists',
            details: {
              orderId: dupOrder?._id?.toString() || null,
              shopifyId: shopifyOrderId,
              orderNumber: dupOrder?.orderNumber || shopifyOrder.order_number,
              total: dupOrder?.totalPrice || parseFloat(shopifyOrder.total_price)
            },
            success: true
          });

          const bybFunnelResult = await WebhooksController.prototype.recordBybPurchaseCompleteFromOrder(
            shopifyOrder,
            topic
          );
          appendBybStep8Action(actions, bybFunnelResult, shopifyOrderId);

          await webhookLog.markProcessed(actions, flowsTriggered);
          return res.status(200).json({ success: true, logId: webhookLog._id, duplicate: true });
        }

        throw createError;
      }
      
      actions.push({
        type: 'order_created',
        details: { orderId: order._id, orderNumber: order.orderNumber, total: order.totalPrice },
        success: true
      });

      const bybFunnelResult = await WebhooksController.prototype.recordBybPurchaseCompleteFromOrder(
        shopifyOrder,
        topic
      );
      appendBybStep8Action(actions, bybFunnelResult, shopifyOrderId);
      
      const previousOrdersCount = customer.ordersCount || 0;
      
      // Actualizar métricas del cliente
      await Customer.findByIdAndUpdate(customer._id, {
        $inc: { ordersCount: 1 },
        $set: { 
          lastOrderDate: new Date(shopifyOrder.created_at),
          totalSpent: parseFloat(shopifyOrder.customer?.total_spent) || 0
        }
      });
      
      console.log('✅ Orden creada en DB:', order.orderNumber);
      
      // ==================== SMS CONVERSION TRACKING ====================
      try {
        if (shopifyOrder.discount_codes && shopifyOrder.discount_codes.length > 0) {
          console.log(`\n📱 -------- SMS CONVERSION CHECK --------`);
          console.log(`   Discount codes used: ${shopifyOrder.discount_codes.map(d => d.code).join(', ')}`);
          
          const conversionResult = await smsConversionService.processOrderConversion(shopifyOrder);
          
          if (conversionResult.converted) {
            // 🆕 Detectar si fue first (JP-) o second (JP2-)
            const successfulConversion = conversionResult.results?.find(r => r.success);
            const conversionType = successfulConversion?.convertedWith || 'first';
            const usedCode = successfulConversion?.code || 'N/A';
            
            // 🆕 Logs diferenciados por tipo
            if (conversionType === 'second') {
              console.log(`   🟣 RECOVERED! (Second Chance SMS - 20% OFF)`);
            } else {
              console.log(`   🟢 CONVERTED! (First SMS - 15% OFF)`);
            }
            
            console.log(`   🏷️  Code used: ${usedCode}`);
            console.log(`   💵 Order total: $${shopifyOrder.total_price}`);
            console.log(`   ⏱️  Time to convert: ${successfulConversion?.timeToConvert || 'N/A'} min`);
            console.log(`   Codes processed: ${conversionResult.codesProcessed}`);
            
            actions.push({
              type: 'sms_conversion_tracked',
              details: {
                conversionType, // 🆕 'first' o 'second'
                usedCode,       // 🆕 El código que usó
                codesProcessed: conversionResult.codesProcessed,
                successfulConversions: conversionResult.successfulConversions,
                results: conversionResult.results?.map(r => ({
                  code: r.code,
                  success: r.success,
                  convertedWith: r.convertedWith, // 🆕
                  orderTotal: r.orderTotal,
                  timeToConvert: r.timeToConvert
                }))
              },
              success: true
            });
          } else {
            console.log(`   ℹ️  No SMS subscriber codes found: ${conversionResult.reason || 'N/A'}`);
          }

          // ==================== SMS CAMPAIGN CONVERSION CHECK ====================
          // Check for campaign-specific codes (e.g., BOWL20, HOLIDAY25, etc.)
          if (smsCampaignConversionService) {
            try {
              const campaignResult = await smsCampaignConversionService.processOrderConversion(shopifyOrder);

              if (campaignResult.campaignConversion) {
                console.log(`   📢 CAMPAIGN CONVERSION DETECTED!`);
                campaignResult.details.forEach(d => {
                  if (d.type === 'campaign') {
                    console.log(`   📱 Campaign: ${d.campaignName}`);
                    console.log(`   🏷️  Code: ${d.discountCode}`);
                    console.log(`   💵 Revenue: $${d.revenue}`);
                  }
                });

                actions.push({
                  type: 'sms_campaign_conversion',
                  details: campaignResult.details,
                  success: true
                });
              }
            } catch (campaignError) {
              console.log(`   ⚠️  Campaign conversion check skipped: ${campaignError.message}`);
            }
          }
          // ==================== END CAMPAIGN CONVERSION CHECK ====================

          console.log(`   ------------------------------------\n`);
        }
      } catch (smsError) {
        console.log(`   ⚠️  SMS conversion tracking skipped: ${smsError.message}`);
        actions.push({
          type: 'sms_conversion_tracking',
          details: { error: smsError.message },
          success: false
        });
      }
      // ==================== END SMS CONVERSION TRACKING ====================
      
      // ==================== CANCEL ABANDONED CART TRACKING ====================
      const checkoutToken = shopifyOrder.checkout_token;
      
      if (checkoutToken && abandonedCartTracker.has(checkoutToken)) {
        clearTimeout(abandonedCartTracker.get(checkoutToken).timer);
        abandonedCartTracker.delete(checkoutToken);
        
        actions.push({
          type: 'abandoned_cart_cancelled',
          details: { checkoutToken, reason: 'order_completed' },
          success: true
        });
        
        console.log('✅ Abandoned cart tracking cancelled - order completed');
        
        // Mark any pending abandoned cart logs as recovered
        await WebhookLog.updateMany(
          { 
            'cartDetails.token': checkoutToken,
            'cartDetails.isRecovered': false 
          },
          { 
            $set: { 
              'cartDetails.isRecovered': true,
              'cartDetails.recoveredAt': new Date()
            }
          }
        );
      }
      
      // ==================== REVENUE ATTRIBUTION ====================
      
      const attribution = AttributionService.getAttribution(req);
      
      let campaignId = null;
      let flowId = null;
      let customerId = customer._id;
      let attributionMethod = 'none';
      
      // Método 1: Cookie
      if (attribution) {
        campaignId = attribution.campaignId;
        customerId = attribution.customerId;
        attributionMethod = 'cookie';
        console.log(`🍪 Attribution found via cookie: Campaign ${campaignId}`);
      }
      
      // Método 2: UTM Parameters en landing_site
      if (!campaignId && !flowId && shopifyOrder.landing_site) {
        try {
          const url = new URL(shopifyOrder.landing_site, 'https://jerseypickles.com');
          const utmCampaign = url.searchParams.get('utm_campaign');
          
          console.log(`🔍 Parsing landing_site: ${shopifyOrder.landing_site}`);
          console.log(`   utm_campaign: ${utmCampaign || 'not found'}`);
          
          if (utmCampaign && utmCampaign.startsWith('email_')) {
            campaignId = utmCampaign.replace('email_', '');
            attributionMethod = 'utm';
            console.log(`🔗 Attribution found via UTM: Campaign ${campaignId}`);
          } else if (utmCampaign && utmCampaign.startsWith('flow_')) {
            flowId = utmCampaign.replace('flow_', '');
            attributionMethod = 'utm_flow';
            console.log(`🔗 Attribution found via UTM for Flow: ${flowId}`);
          }
        } catch (e) {
          console.log(`⚠️ Could not parse landing_site: ${shopifyOrder.landing_site}`);
        }
      }
      
      // Método 3: Discount code attribution (for email campaigns)
      if (!campaignId && !flowId && shopifyOrder.discount_codes?.length > 0) {
        for (const discount of shopifyOrder.discount_codes) {
          // Skip SMS codes (JP-XXXXX) for campaign attribution
          if (discount.code.toUpperCase().startsWith('JP-')) {
            continue;
          }
          
          const campaignWithCode = await Campaign.findOne({
            discountCode: discount.code,
            status: 'sent'
          }).select('_id');
          
          if (campaignWithCode) {
            campaignId = campaignWithCode._id;
            attributionMethod = 'discount_code';
            console.log(`🏷️ Attribution found via discount code: ${discount.code} → Campaign ${campaignId}`);
            break;
          }
        }
      }
      
      // Método 4: Last click por EMAIL
      if (!campaignId && !flowId) {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        if (customer.email) {
          const lastClickEvent = await EmailEvent.findOne({
            email: { $regex: new RegExp(`^${customer.email}$`, 'i') },
            eventType: 'clicked',
            eventDate: { $gte: sevenDaysAgo },
            campaign: { $exists: true, $ne: null }
          }).sort({ eventDate: -1 });
          
          if (lastClickEvent) {
            campaignId = lastClickEvent.campaign;
            attributionMethod = 'last_click_email';
            console.log(`📧 Attribution found via email click: ${customer.email} → Campaign ${campaignId}`);
          }
        }
        
        if (!campaignId) {
          const lastClickEvent = await EmailEvent.findOne({
            $or: [
              { customer: customer._id },
              { customer: customer._id.toString() }
            ],
            eventType: 'clicked',
            eventDate: { $gte: sevenDaysAgo },
            campaign: { $exists: true, $ne: null }
          }).sort({ eventDate: -1 });
          
          if (lastClickEvent) {
            campaignId = lastClickEvent.campaign;
            attributionMethod = 'last_click_id';
            console.log(`🔙 Attribution found via customer ID click: Campaign ${campaignId}`);
          }
        }
      }
      
      // Log attribution action
      actions.push({
        type: 'revenue_attribution',
        details: { 
          method: attributionMethod, 
          campaignId: campaignId?.toString() || null,
          flowId: flowId || null,
          revenue: parseFloat(shopifyOrder.total_price)
        },
        success: !!campaignId || !!flowId
      });
      
      // Process attribution
      if (campaignId) {
        console.log(`\n💰 ═══════════════════════════════════════════`);
        console.log(`   ATTRIBUTING REVENUE TO CAMPAIGN`);
        console.log(`   Method: ${attributionMethod}`);
        console.log(`   Campaign: ${campaignId}`);
        console.log(`   Revenue: $${shopifyOrder.total_price}`);
        console.log(`═══════════════════════════════════════════════`);
        
        await Order.findByIdAndUpdate(order._id, {
          'attribution.campaign': campaignId,
          'attribution.source': attributionMethod === 'cookie' ? 'email_click' : 
                                attributionMethod === 'utm' ? 'utm' : 
                                attributionMethod === 'discount_code' ? 'discount_code' :
                                attributionMethod.startsWith('last_click') ? 'email_click' : 'unknown',
          'attribution.clickedAt': new Date()
        });
        
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
      
      // Flow revenue tracking
      if (flowId) {
        console.log(`\n💰 ATTRIBUTING REVENUE TO FLOW: ${flowId}`);
        
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
        const result = await flowService.processTrigger('order_placed', {
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
        
        if (result?.flowsTriggered) {
          result.flowsTriggered.forEach(f => {
            flowsTriggered.push({
              flowId: f.flowId,
              flowName: f.flowName,
              executionId: f.executionId
            });
          });
        }
        
        actions.push({
          type: 'flow_trigger_order_placed',
          details: { flowsTriggered: result?.flowsTriggered?.length || 0 },
          success: true
        });
        
      } catch (err) {
        console.log('Flow service not available:', err.message);
        actions.push({
          type: 'flow_trigger_order_placed',
          details: { error: err.message },
          success: false,
          error: err.message
        });
      }
      
      console.log(`====================================================\n`);

      // ==================== SMS ORDER CONFIRMATION ====================
      if (smsTransactionalService) {
        try {
          console.log('📱 Triggering Order Confirmation SMS...');
          const smsResult = await smsTransactionalService.sendOrderConfirmation(shopifyOrder);

          actions.push({
            type: 'sms_order_confirmation',
            details: {
              success: smsResult.success,
              reason: smsResult.reason || null,
              messageId: smsResult.messageId || null
            },
            success: smsResult.success
          });

          if (smsResult.success) {
            console.log('✅ Order confirmation SMS sent');
          } else {
            console.log(`⚠️ Order confirmation SMS not sent: ${smsResult.reason}`);
          }
        } catch (smsErr) {
          console.log('⚠️ SMS Order Confirmation error:', smsErr.message);
          actions.push({
            type: 'sms_order_confirmation',
            details: { error: smsErr.message },
            success: false
          });
        }
      }
      // ==================== END SMS ORDER CONFIRMATION ====================

      await webhookLog.markProcessed(actions, flowsTriggered);

      res.status(200).json({ success: true, logId: webhookLog._id });

    } catch (error) {
      console.error('❌ Error en orderCreate:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  async orderUpdate(req, res) {
    const topic = 'orders/update';
    let webhookLog;
    
    try {
      const shopifyOrder = req.body;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: shopifyOrder.id?.toString(),
        email: shopifyOrder.email,
        payload: shopifyOrder,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('📥 Webhook: Order Update', shopifyOrder.id);
      
      await webhookLog.markProcessing();
      
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

      const actions = [
        { type: 'order_updated', details: { orderId: shopifyOrder.id }, success: true }
      ];

      // ==================== SMS SHIPPING NOTIFICATION ====================
      // Check for new fulfillments with tracking info
      if (smsTransactionalService && shopifyOrder.fulfillments && shopifyOrder.fulfillments.length > 0) {
        for (const fulfillment of shopifyOrder.fulfillments) {
          // Only process if has tracking and is recent (created in last 5 minutes)
          const hasTracking = fulfillment.tracking_number || fulfillment.tracking_url;
          const createdAt = new Date(fulfillment.created_at);
          const isRecent = (Date.now() - createdAt.getTime()) < 5 * 60 * 1000; // 5 minutes

          if (hasTracking && isRecent) {
            try {
              console.log(`📱 Triggering Shipping SMS for fulfillment ${fulfillment.id}...`);
              const smsResult = await smsTransactionalService.sendShippingNotification(shopifyOrder, fulfillment);

              actions.push({
                type: 'sms_shipping_notification',
                details: {
                  fulfillmentId: fulfillment.id,
                  trackingNumber: fulfillment.tracking_number,
                  success: smsResult.success,
                  reason: smsResult.reason || null
                },
                success: smsResult.success
              });

              if (smsResult.success) {
                console.log(`✅ Shipping SMS sent for fulfillment ${fulfillment.id}`);
              } else {
                console.log(`⚠️ Shipping SMS not sent: ${smsResult.reason}`);
              }
            } catch (smsErr) {
              console.log('⚠️ SMS Shipping error:', smsErr.message);
            }
          }
        }
      }
      // ==================== END SMS SHIPPING NOTIFICATION ====================

      await webhookLog.markProcessed(actions, []);

      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en orderUpdate:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }
  
  async orderFulfilled(req, res) {
    const topic = 'orders/fulfilled';
    let webhookLog;
    
    try {
      const order = req.body;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: order.id?.toString(),
        email: order.email || order.customer?.email,
        payload: order,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('📦 Webhook: Order Fulfilled', order.id);

      await webhookLog.markProcessing();

      const actions = [];
      const flowsTriggered = [];

      // ==================== REMOVE FROM DELAYED SHIPMENT QUEUE ====================
      try {
        const DelayedShipmentQueue = require('../models/DelayedShipmentQueue');
        const queueResult = await DelayedShipmentQueue.markFulfilled(order.id);
        if (queueResult) {
          console.log(`✅ Order #${order.order_number} removed from delayed shipment queue`);
          actions.push({
            type: 'delayed_queue_removed',
            details: { orderId: order.id, orderNumber: order.order_number },
            success: true
          });
        }
      } catch (queueErr) {
        console.log('⚠️ Could not update delayed queue:', queueErr.message);
      }
      // ==================== END DELAYED SHIPMENT QUEUE ====================

      const customer = await Customer.findOne({
        shopifyId: order.customer?.id?.toString()
      });
      
      if (customer) {
        try {
          const flowService = require('../services/flowService');
          const result = await flowService.processTrigger('order_fulfilled', {
            customerId: customer._id,
            orderId: order.id,
            orderNumber: order.order_number,
            trackingNumber: order.fulfillments?.[0]?.tracking_number,
            trackingUrl: order.fulfillments?.[0]?.tracking_url,
            email: customer.email
          });
          
          if (result?.flowsTriggered) {
            result.flowsTriggered.forEach(f => {
              flowsTriggered.push({
                flowId: f.flowId,
                flowName: f.flowName,
                executionId: f.executionId
              });
            });
          }
          
          actions.push({
            type: 'flow_trigger_order_fulfilled',
            details: { 
              trackingNumber: order.fulfillments?.[0]?.tracking_number,
              flowsTriggered: flowsTriggered.length 
            },
            success: true
          });
          
        } catch (err) {
          console.log('Flow service not available:', err.message);
          actions.push({
            type: 'flow_trigger_order_fulfilled',
            details: { error: err.message },
            success: false,
            error: err.message
          });
        }
      }
      
      await webhookLog.markProcessed(actions, flowsTriggered);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en orderFulfilled:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  async orderCancelled(req, res) {
    const topic = 'orders/cancelled';
    let webhookLog;
    
    try {
      const order = req.body;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: order.id?.toString(),
        email: order.email || order.customer?.email,
        payload: order,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('❌ Webhook: Order Cancelled', order.id);
      
      await webhookLog.markProcessing();
      
      const actions = [];
      const flowsTriggered = [];
      
      const customer = await Customer.findOne({ 
        shopifyId: order.customer?.id?.toString() 
      });
      
      if (customer) {
        try {
          const flowService = require('../services/flowService');
          const result = await flowService.processTrigger('order_cancelled', {
            customerId: customer._id,
            orderId: order.id,
            orderNumber: order.order_number,
            cancelReason: order.cancel_reason,
            refundAmount: order.total_price,
            email: customer.email
          });

          if (result?.flowsTriggered) {
            result.flowsTriggered.forEach(f => flowsTriggered.push(f));
          }

          actions.push({
            type: 'flow_trigger_order_cancelled',
            details: { cancelReason: order.cancel_reason },
            success: true
          });

        } catch (err) {
          console.log('Flow service not available:', err.message);
        }
      }

      // ==================== SMS ORDER CANCELLED ====================
      if (smsTransactionalService) {
        try {
          console.log('📱 Triggering Order Cancelled SMS...');
          const smsResult = await smsTransactionalService.sendOrderCancelled(order, order.cancel_reason);

          actions.push({
            type: 'sms_order_cancelled',
            details: {
              success: smsResult.success,
              reason: smsResult.reason || null,
              messageId: smsResult.messageId || null
            },
            success: smsResult.success
          });

          if (smsResult.success) {
            console.log(`   ✅ Order cancelled SMS triggered for order #${order.order_number || order.id}`);
          } else {
            console.log(`   ⚠️ Order cancelled SMS skipped: ${smsResult.reason}`);
          }
        } catch (err) {
          console.log('📱 SMS Order Cancelled error:', err.message);
          actions.push({
            type: 'sms_order_cancelled',
            details: { error: err.message },
            success: false
          });
        }
      }

      await webhookLog.markProcessed(actions, flowsTriggered);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en orderCancelled:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  async recordBybPurchaseCompleteFromOrder(order, webhookTopic = 'orders/create') {
    try {
      const bybContext = extractBybContextFromOrder(order);
      if (!bybContext.isByb) {
        return { tracked: false, reason: 'not_byb' };
      }

      const orderId = order?.id?.toString();
      if (!orderId) {
        return { tracked: false, reason: 'missing_order_id' };
      }

      const existingStep8 = await BybFunnelEvent.findOne({
        step: 'step_8_purchase_complete',
        'metadata.orderId': orderId
      }).select('_id').lean();

      if (existingStep8) {
        return {
          tracked: false,
          reason: 'already_tracked',
          eventId: existingStep8._id?.toString()
        };
      }

      const sessionId = bybContext.sessionId || `byb_order_${orderId}`;
      const totalPrice = parseFloat(order?.total_price || order?.current_total_price || 0) || 0;

      const event = new BybFunnelEvent({
        sessionId,
        customerId: order?.customer?.id?.toString(),
        step: 'step_8_purchase_complete',
        metadata: {
          ...bybContext.metadata,
          cartTotal: totalPrice,
          orderId,
          orderNumber: order?.order_number?.toString()
        },
        pageUrl: order?.order_status_url || '',
        referrer: order?.referring_site || ''
      });

      await event.save();
      console.log(
        `📊 BYB Funnel: Recorded step_8_purchase_complete via ${webhookTopic} for order ${orderId} (session ${sessionId})`
      );

      return {
        tracked: true,
        eventId: event._id?.toString(),
        sessionId,
        usedFallbackSession: !bybContext.sessionId
      };
    } catch (error) {
      console.error(`❌ BYB Funnel step_8 webhook error (${webhookTopic}):`, error.message);
      return { tracked: false, reason: 'error', error: error.message };
    }
  }

  async orderPaid(req, res) {
    const topic = 'orders/paid';
    let webhookLog;
    
    try {
      const order = req.body;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: order.id?.toString(),
        email: order.email,
        payload: order,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('💰 Webhook: Order Paid', order.id);

      await webhookLog.markProcessing();

      const actions = [
        { type: 'order_paid', details: { orderId: order.id }, success: true }
      ];

      const bybFunnelResult = await WebhooksController.prototype.recordBybPurchaseCompleteFromOrder(
        order,
        topic
      );
      appendBybStep8Action(actions, bybFunnelResult, order.id?.toString());

      await webhookLog.markProcessed(actions, []);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en orderPaid:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== CHECKOUT WEBHOOKS (Abandoned Cart) ====================

  async checkoutCreate(req, res) {
    const topic = 'checkouts/create';
    let webhookLog;
    
    try {
      const checkout = req.body;
      const checkoutToken = checkout.token;
      const email = checkout.email || checkout.customer?.email;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: checkout.id?.toString(),
        email,
        payload: checkout,
        headers: extractHeaders(req),
        metadata: extractMetadata(req),
        cartDetails: {
          token: checkoutToken,
          totalPrice: parseFloat(checkout.total_price || 0),
          itemCount: checkout.line_items?.length || 0,
          customerEmail: email
        }
      });
      
      console.log('🛒 Webhook: Checkout Created', checkout.id);
      
      await webhookLog.markProcessing();
      
      const actions = [];
      
      // Update customer cart info
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
        
        actions.push({
          type: 'customer_cart_updated',
          details: { cartValue: parseFloat(checkout.total_price || 0) },
          success: true
        });
      }
      
      // Start abandonment tracking
      if (email) {
        const abandonmentDelay = 60 * 60 * 1000; // 1 hour
        
        // Clear existing timer
        if (abandonedCartTracker.has(checkoutToken)) {
          clearTimeout(abandonedCartTracker.get(checkoutToken).timer);
        }
        
        // Set new timer - usar referencia directa al método
        const self = this;
        const timer = setTimeout(async () => {
          await self.processAbandonedCart(checkoutToken, email, checkout);
        }, abandonmentDelay);
        
        abandonedCartTracker.set(checkoutToken, {
          timer,
          email,
          payload: checkout,
          createdAt: new Date()
        });
        
        actions.push({
          type: 'abandonment_tracking_started',
          details: { checkoutToken, email, delayMinutes: 60 },
          success: true
        });
        
        console.log(`⏱️  Abandonment tracking started for ${email}`);
      }
      
      await webhookLog.markProcessed(actions, []);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en checkoutCreate:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  async checkoutUpdate(req, res) {
    const topic = 'checkouts/update';
    let webhookLog;
    
    try {
      const checkout = req.body;
      const checkoutToken = checkout.token;
      const email = checkout.email || checkout.customer?.email;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: checkout.id?.toString(),
        email,
        payload: checkout,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('🛒 Webhook: Checkout Updated', checkout.id);
      
      await webhookLog.markProcessing();
      
      const actions = [];
      
      if (!checkout.customer) {
        await webhookLog.markProcessed([
          { type: 'checkout_update_no_customer', success: true }
        ], []);
        return res.status(200).json({ success: true });
      }
      
      if (checkout.completed_at) {
        // Checkout completed - clear tracking
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
        
        // Cancel abandonment tracking
        if (abandonedCartTracker.has(checkoutToken)) {
          clearTimeout(abandonedCartTracker.get(checkoutToken).timer);
          abandonedCartTracker.delete(checkoutToken);
          
          actions.push({
            type: 'abandonment_tracking_cancelled',
            details: { reason: 'checkout_completed' },
            success: true
          });
        }
        
        // Mark as recovered
        await WebhookLog.updateMany(
          { 
            'cartDetails.token': checkoutToken,
            'cartDetails.isRecovered': false 
          },
          { 
            $set: { 
              'cartDetails.isRecovered': true,
              'cartDetails.recoveredAt': new Date()
            }
          }
        );
        
      } else {
        // Checkout still in progress - reset timer
        await Customer.findOneAndUpdate(
          { shopifyId: checkout.customer.id.toString() },
          {
            $set: {
              lastCartActivity: new Date(),
              cartValue: parseFloat(checkout.total_price || 0)
            }
          }
        );
        
        // Reset abandonment timer
        if (abandonedCartTracker.has(checkoutToken)) {
          const tracked = abandonedCartTracker.get(checkoutToken);
          clearTimeout(tracked.timer);

          const abandonmentDelay = 60 * 60 * 1000;
          const self = this;
          const timer = setTimeout(async () => {
            await self.processAbandonedCart(checkoutToken, email || tracked.email, checkout);
          }, abandonmentDelay);
          
          abandonedCartTracker.set(checkoutToken, {
            ...tracked,
            timer,
            payload: checkout,
            updatedAt: new Date()
          });
          
          actions.push({
            type: 'abandonment_timer_reset',
            details: { checkoutToken },
            success: true
          });
        }
      }
      
      await webhookLog.markProcessed(actions, []);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en checkoutUpdate:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Process an abandoned cart - called after timeout
   * INCLUYE DEDUPLICACIÓN para evitar múltiples emails al mismo cliente
   */
  async processAbandonedCart(checkoutToken, email, checkoutData) {
    console.log(`\n🛒 ==================== ABANDONED CART ====================`);
    console.log(`   Token: ${checkoutToken}`);
    console.log(`   Email: ${email}`);
    
    try {
      // ==================== DEDUPLICACIÓN ====================
      // Verificar si ya procesamos este checkout o este email recientemente
      
      const FlowExecution = require('../models/FlowExecution');
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      // 1. Verificar si ya procesamos este checkout token en las últimas 24h
      const existingByToken = await WebhookLog.findOne({
        topic: 'cart_abandoned',
        'cartDetails.token': checkoutToken,
        createdAt: { $gte: twentyFourHoursAgo }
      });
      
      if (existingByToken) {
        console.log(`   ⏭️  Checkout ${checkoutToken} ya procesado - saltando`);
        abandonedCartTracker.delete(checkoutToken);
        return;
      }
      
      // 2. Verificar si este email ya tiene un flow de abandoned cart activo en 24h
      if (email) {
        const existingByEmail = await FlowExecution.findOne({
          'triggerData.email': { $regex: new RegExp(`^${email}$`, 'i') },
          status: { $in: ['active', 'waiting', 'completed'] },
          createdAt: { $gte: twentyFourHoursAgo },
          $or: [
            { 'triggerData.trigger': 'cart_abandoned' },
            { 'triggerData.cart.token': { $exists: true } }
          ]
        });
        
        if (existingByEmail) {
          console.log(`   ⏭️  Email ${email} ya tiene flow de abandoned cart activo - saltando`);
          abandonedCartTracker.delete(checkoutToken);
          return;
        }
      }
      
      console.log(`   ✅ Deduplicación pasada - procesando carrito abandonado`);
      
      // ==================== FIN DEDUPLICACIÓN ====================
      
      // Log the abandonment
      const webhookLog = await WebhookLog.logWebhook({
        topic: 'cart_abandoned',
        source: 'shopify',
        shopifyId: checkoutToken,
        email,
        payload: checkoutData,
        headers: {},
        metadata: { receivedAt: new Date() },
        cartDetails: {
          token: checkoutToken,
          totalPrice: parseFloat(checkoutData.total_price || 0),
          itemCount: checkoutData.line_items?.length || 0,
          customerEmail: email,
          abandonedAt: new Date()
        }
      });
      
      await webhookLog.markProcessing();
      
      const actions = [];
      const flowsTriggered = [];
      
      // Find or create customer
      let customer = await Customer.findOne({ email: email?.toLowerCase() });
      
      if (!customer && email) {
        customer = new Customer({
          email: email.toLowerCase(),
          firstName: checkoutData.shipping_address?.first_name || checkoutData.billing_address?.first_name,
          lastName: checkoutData.shipping_address?.last_name || checkoutData.billing_address?.last_name,
          source: 'abandoned_cart'
        });
        await customer.save();
        
        actions.push({
          type: 'customer_created_from_cart',
          details: { email },
          success: true
        });
      }
      
      // Prepare cart data
      const cartItems = checkoutData.line_items?.map(item => ({
        productId: item.product_id,
        variantId: item.variant_id,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        image: item.image?.src || item.featured_image?.url
      })) || [];
      
      // Trigger abandoned cart flows
      try {
        const flowService = require('../services/flowService');
        const result = await flowService.processTrigger('cart_abandoned', {
          customerId: customer?._id,
          email: customer?.email || email,
          firstName: customer?.firstName,
          trigger: 'cart_abandoned', // Para identificación en deduplicación
          cart: {
            token: checkoutToken,
            checkoutUrl: checkoutData.abandoned_checkout_url || 
                        `https://${process.env.SHOPIFY_SHOP_DOMAIN || 'jerseypickles.myshopify.com'}/checkouts/${checkoutToken}`,
            totalPrice: checkoutData.total_price,
            itemCount: cartItems.length,
            items: cartItems
          },
          abandoned: {
            productNames: cartItems.map(i => i.title).join(', '),
            firstProductName: cartItems[0]?.title || 'your items',
            firstProductImage: cartItems[0]?.image,
            firstProductPrice: cartItems[0]?.price
          }
        });
        
        if (result?.flowsTriggered) {
          result.flowsTriggered.forEach(f => {
            flowsTriggered.push({
              flowId: f.flowId,
              flowName: f.flowName,
              executionId: f.executionId
            });
          });
        }
        
        actions.push({
          type: 'abandoned_cart_flow_triggered',
          details: { flowsTriggered: flowsTriggered.length },
          success: true
        });
        
        console.log(`   🚀 Flows triggered: ${flowsTriggered.length}`);
        
      } catch (err) {
        console.log(`   ⚠️ Flow service not available: ${err.message}`);
        actions.push({
          type: 'abandoned_cart_flow_trigger_failed',
          details: { error: err.message },
          success: false,
          error: err.message
        });
      }
      
      await webhookLog.markProcessed(actions, flowsTriggered);
      
      // Clean up tracker
      abandonedCartTracker.delete(checkoutToken);
      
      console.log(`   ✅ Abandoned cart processed successfully`);
      console.log(`====================================================\n`);
      
    } catch (error) {
      console.error('❌ Error processing abandoned cart:', error.message);
      // Clean up tracker even on error
      abandonedCartTracker.delete(checkoutToken);
    }
  }

  // ==================== OTHER SHOPIFY WEBHOOKS ====================

  async productUpdate(req, res) {
    const topic = 'products/update';
    let webhookLog;
    
    try {
      const product = req.body;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: product.id?.toString(),
        payload: product,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('📦 Webhook: Product Update', product.id);
      
      await webhookLog.markProcessing();
      
      const actions = [];
      const flowsTriggered = [];
      
      const variants = product.variants || [];
      const nowInStock = variants.filter(v => 
        v.inventory_quantity > 0 && 
        v.old_inventory_quantity === 0
      );
      
      if (nowInStock.length > 0) {
        try {
          const flowService = require('../services/flowService');
          const result = await flowService.processTrigger('product_back_in_stock', {
            productId: product.id,
            productTitle: product.title,
            productHandle: product.handle,
            variants: nowInStock
          });
          
          if (result?.flowsTriggered) {
            result.flowsTriggered.forEach(f => flowsTriggered.push(f));
          }
          
          actions.push({
            type: 'back_in_stock_triggered',
            details: { productId: product.id, variantsBack: nowInStock.length },
            success: true
          });
          
        } catch (err) {
          console.log('Flow service not available:', err.message);
        }
      }
      
      await webhookLog.markProcessed(actions, flowsTriggered);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en productUpdate:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  async refundCreate(req, res) {
    const topic = 'refunds/create';
    let webhookLog;
    
    try {
      const refund = req.body;
      
      webhookLog = await WebhookLog.logWebhook({
        topic,
        source: 'shopify',
        shopifyId: refund.id?.toString(),
        payload: refund,
        headers: extractHeaders(req),
        metadata: extractMetadata(req)
      });
      
      console.log('💸 Webhook: Refund Created', refund.id);
      
      await webhookLog.markProcessing();
      
      const actions = [];
      const flowsTriggered = [];
      
      const order = await Order.findOne({ 
        shopifyId: refund.order_id?.toString() 
      });
      
      if (order) {
        const customer = await Customer.findById(order.customer);
        
        if (customer) {
          try {
            const flowService = require('../services/flowService');
            const result = await flowService.processTrigger('order_refunded', {
              customerId: customer._id,
              orderId: order._id,
              refundAmount: parseFloat(refund.transactions?.[0]?.amount || 0),
              refundReason: refund.note,
              email: customer.email
            });
            
            if (result?.flowsTriggered) {
              result.flowsTriggered.forEach(f => flowsTriggered.push(f));
            }
            
            actions.push({
              type: 'refund_flow_triggered',
              details: { refundAmount: parseFloat(refund.transactions?.[0]?.amount || 0) },
              success: true
            });
            
          } catch (err) {
            console.log('Flow service not available:', err.message);
          }
        }
      }
      
      await webhookLog.markProcessed(actions, flowsTriggered);
      
      res.status(200).json({ success: true, logId: webhookLog._id });
      
    } catch (error) {
      console.error('❌ Error en refundCreate:', error);
      if (webhookLog) await webhookLog.markFailed(error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== MONITORING ENDPOINTS ====================

  async getWebhookLogs(req, res) {
    try {
      const { 
        limit = 50, 
        topic, 
        status,
        hours = 24 
      } = req.query;
      
      const since = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
      
      const logs = await WebhookLog.getRecent({
        limit: parseInt(limit),
        topic,
        status,
        since
      });
      
      res.json({
        success: true,
        count: logs.length,
        logs
      });
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getWebhookStats(req, res) {
    try {
      const { hours = 24 } = req.query;
      
      const stats = await WebhookLog.getStats(parseInt(hours));
      
      const since = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
      const totals = await WebhookLog.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);
      
      // Abandoned cart recovery stats
      const cartStats = await WebhookLog.aggregate([
        { 
          $match: { 
            topic: 'cart_abandoned',
            createdAt: { $gte: since }
          } 
        },
        {
          $group: {
            _id: '$cartDetails.isRecovered',
            count: { $sum: 1 },
            totalValue: { $sum: '$cartDetails.totalPrice' }
          }
        }
      ]);
      
      res.json({
        success: true,
        period: `Last ${hours} hours`,
        byTopic: stats,
        byStatus: totals,
        abandonedCarts: {
          total: cartStats.reduce((sum, s) => sum + s.count, 0),
          recovered: cartStats.find(s => s._id === true)?.count || 0,
          recoveredValue: cartStats.find(s => s._id === true)?.totalValue || 0,
          pending: cartStats.find(s => s._id === false)?.count || 0
        }
      });
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getWebhookLog(req, res) {
    try {
      const { id } = req.params;
      
      const log = await WebhookLog.findById(id)
        .populate('processing.flowsTriggered.flowId', 'name')
        .lean();
      
      if (!log) {
        return res.status(404).json({ error: 'Log not found' });
      }
      
      res.json({ success: true, log });
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getAbandonedCartStatus(req, res) {
    try {
      const trackedCarts = [];
      
      abandonedCartTracker.forEach((value, key) => {
        trackedCarts.push({
          token: key,
          email: value.email,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          cartValue: parseFloat(value.payload?.total_price || 0),
          itemCount: value.payload?.line_items?.length || 0
        });
      });
      
      res.json({
        success: true,
        count: trackedCarts.length,
        carts: trackedCarts
      });
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async testWebhook(req, res) {
    try {
      const { type, email, data } = req.body;
      
      console.log(`\n🧪 ==================== TEST WEBHOOK ====================`);
      console.log(`   Type: ${type}`);
      console.log(`   Email: ${email}`);
      
      let webhookLog;
      const actions = [];
      const flowsTriggered = [];
      
      switch (type) {
        case 'customer_created':
          webhookLog = await WebhookLog.logWebhook({
            topic: 'customers/create',
            source: 'test',
            email,
            payload: {
              id: `test_${Date.now()}`,
              email,
              first_name: data?.firstName || 'Test',
              last_name: data?.lastName || 'Customer',
              created_at: new Date().toISOString(),
              accepts_marketing: true,
              ...data
            },
            headers: {},
            metadata: { receivedAt: new Date(), ip: 'test' }
          });
          
          // Try to trigger flows
          try {
            let customer = await Customer.findOne({ email: email?.toLowerCase() });
            
            if (!customer) {
              customer = await Customer.create({
                email: email.toLowerCase(),
                firstName: data?.firstName || 'Test',
                lastName: data?.lastName || 'Customer',
                source: 'test'
              });
              
              actions.push({
                type: 'test_customer_created',
                details: { email },
                success: true
              });
            }
            
            const flowService = require('../services/flowService');
            const result = await flowService.processTrigger('customer_created', {
              customerId: customer._id,
              email: customer.email,
              firstName: customer.firstName,
              source: 'test'
            });
            
            if (result?.flowsTriggered) {
              result.flowsTriggered.forEach(f => flowsTriggered.push(f));
            }
            
            actions.push({
              type: 'test_flow_triggered',
              details: { flowsTriggered: flowsTriggered.length },
              success: true
            });
            
          } catch (err) {
            actions.push({
              type: 'test_flow_trigger_failed',
              details: { error: err.message },
              success: false,
              error: err.message
            });
          }
          break;
          
        case 'cart_abandoned':
          webhookLog = await WebhookLog.logWebhook({
            topic: 'cart_abandoned',
            source: 'test',
            email,
            payload: {
              token: `test_cart_${Date.now()}`,
              email,
              total_price: data?.totalPrice || '49.99',
              line_items: data?.items || [
                { title: 'Garlic Dill Spears', quantity: 1, price: '15.99', product_id: '123' },
                { title: 'Cucumber Salad', quantity: 2, price: '16.99', product_id: '456' }
              ],
              abandoned_checkout_url: `https://jerseypickles.com/checkouts/test_${Date.now()}`,
              ...data
            },
            headers: {},
            metadata: { receivedAt: new Date(), ip: 'test' },
            cartDetails: {
              token: `test_cart_${Date.now()}`,
              totalPrice: parseFloat(data?.totalPrice || 49.99),
              itemCount: data?.items?.length || 2,
              customerEmail: email,
              abandonedAt: new Date()
            }
          });
          
          // Try to trigger flows
          try {
            let customer = await Customer.findOne({ email: email?.toLowerCase() });
            
            if (!customer) {
              customer = await Customer.create({
                email: email.toLowerCase(),
                source: 'test_abandoned_cart'
              });
            }
            
            const flowService = require('../services/flowService');
            const result = await flowService.processTrigger('cart_abandoned', {
              customerId: customer._id,
              email: customer.email,
              cart: {
                token: `test_cart_${Date.now()}`,
                checkoutUrl: 'https://jerseypickles.com/checkouts/test',
                totalPrice: data?.totalPrice || '49.99',
                itemCount: 2,
                items: [
                  { title: 'Garlic Dill Spears', quantity: 1, price: '15.99' },
                  { title: 'Cucumber Salad', quantity: 2, price: '16.99' }
                ]
              },
              abandoned: {
                productNames: 'Garlic Dill Spears, Cucumber Salad',
                firstProductName: 'Garlic Dill Spears',
                firstProductPrice: '15.99'
              }
            });
            
            if (result?.flowsTriggered) {
              result.flowsTriggered.forEach(f => flowsTriggered.push(f));
            }
            
            actions.push({
              type: 'test_abandoned_cart_flow',
              details: { flowsTriggered: flowsTriggered.length },
              success: true
            });
            
          } catch (err) {
            actions.push({
              type: 'test_flow_trigger_failed',
              details: { error: err.message },
              success: false,
              error: err.message
            });
          }
          break;
          
        case 'order_created':
          webhookLog = await WebhookLog.logWebhook({
            topic: 'orders/create',
            source: 'test',
            email,
            payload: {
              id: `test_order_${Date.now()}`,
              order_number: Math.floor(Math.random() * 10000) + 1000,
              email,
              total_price: data?.totalPrice || '49.99',
              currency: 'USD',
              line_items: data?.items || [
                { title: 'Garlic Dill Spears', quantity: 1, price: '15.99', product_id: '123' }
              ],
              customer: {
                id: `test_customer_${Date.now()}`,
                email,
                first_name: 'Test',
                last_name: 'Customer'
              },
              created_at: new Date().toISOString(),
              ...data
            },
            headers: {},
            metadata: { receivedAt: new Date(), ip: 'test' }
          });
          
          // Try to trigger flows
          try {
            let customer = await Customer.findOne({ email: email?.toLowerCase() });
            
            if (!customer) {
              customer = await Customer.create({
                email: email.toLowerCase(),
                firstName: 'Test',
                lastName: 'Customer',
                source: 'test_order'
              });
            }
            
            const flowService = require('../services/flowService');
            const result = await flowService.processTrigger('order_placed', {
              customerId: customer._id,
              email: customer.email,
              orderNumber: Math.floor(Math.random() * 10000) + 1000,
              orderValue: parseFloat(data?.totalPrice || 49.99),
              firstOrder: true,
              products: [{ title: 'Garlic Dill Spears', quantity: 1, price: '15.99' }]
            });
            
            if (result?.flowsTriggered) {
              result.flowsTriggered.forEach(f => flowsTriggered.push(f));
            }
            
            actions.push({
              type: 'test_order_flow',
              details: { flowsTriggered: flowsTriggered.length },
              success: true
            });
            
          } catch (err) {
            actions.push({
              type: 'test_flow_trigger_failed',
              details: { error: err.message },
              success: false,
              error: err.message
            });
          }
          break;
          
        default:
          return res.status(400).json({ error: 'Invalid test type. Use: customer_created, cart_abandoned, order_created' });
      }
      
      await webhookLog.markProcessed(actions, flowsTriggered);
      
      console.log(`   ✅ Test webhook processed`);
      console.log(`   Actions: ${actions.length}`);
      console.log(`   Flows triggered: ${flowsTriggered.length}`);
      console.log(`====================================================\n`);
      
      res.json({
        success: true,
        message: `Test ${type} webhook created and processed`,
        logId: webhookLog._id,
        actions,
        flowsTriggered
      });
      
    } catch (error) {
      console.error('❌ Test webhook error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== RESEND WEBHOOKS ====================
  
  async handleResendWebhook(req, res) {
    try {
      const { type, data, created_at } = req.body;
      
      if (!type || !data) {
        return res.status(400).json({ error: 'Payload inválido' });
      }
      
      console.log(`\n📬 Webhook Resend: ${type} → ${data.to || data.email || 'unknown'}`);
      
      const eventId = this.generateEventId(data.email_id, type);
      
      try {
        await EmailEvent.create({
          eventId,
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
          console.log(`   ℹ️  Evento ${eventId} ya procesado (duplicado ignorado)`);
          return res.status(200).json({ 
            success: true, 
            message: 'Evento ya procesado' 
          });
        }
        throw error;
      }
      
      if (data.email_id) {
        await this.updateEmailSendStatus(data.email_id, type, data);
      }
      
      if (data.tags?.campaign_id) {
        await this.updateCampaignStats(data.tags.campaign_id, type);
      }
      
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
      
      res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('❌ Error procesando webhook Resend:', error);
      
      res.status(200).json({ 
        success: false, 
        error: error.message 
      });
    }
  }
  
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
  
  generateEventId(emailId, eventType) {
    const normalized = `${emailId}:${eventType}`;
    return crypto
      .createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 32);
  }
  
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
