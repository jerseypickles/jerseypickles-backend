// backend/src/controllers/smsController.js
const SmsSubscriber = require('../models/SmsSubscriber');
const telnyxService = require('../services/telnyxService');

// Cargar shopifyService de forma segura
let shopifyService = null;
try {
  shopifyService = require('../services/shopifyService');
  console.log('📱 SMS Controller: Shopify service loaded');
} catch (e) {
  console.log('⚠️  SMS Controller: Shopify service not available');
}

const smsController = {
  // ==================== SUSCRIBIR NUEVO NÚMERO ====================
  
  /**
   * POST /api/sms/subscribe
   * Suscribe un nuevo número desde el popup
   */
  async subscribe(req, res) {
    try {
      const { phone, source = 'popup', sourceUrl, deviceType, consent, consentTimestamp, pageUrl } = req.body;

      // Validar teléfono
      const formattedPhone = telnyxService.formatPhoneNumber(phone);
      if (!formattedPhone) {
        return res.status(400).json({
          success: false,
          error: 'Invalid phone number. Please enter a valid 10-digit US phone number.'
        });
      }

      // Verificar si ya existe
      let subscriber = await SmsSubscriber.findOne({ phone: formattedPhone });
      
      if (subscriber) {
        // Si ya existe y está activo - devolver código existente
        if (subscriber.status === 'active') {
          return res.json({
            success: true,
            message: 'You are already subscribed!',
            discountCode: subscriber.discountCode,
            alreadySubscribed: true
          });
        }
        
        // Si estaba unsubscribed, reactivar
        if (subscriber.status === 'unsubscribed') {
          subscriber.status = 'active';
          subscriber.subscribedAt = new Date();
          subscriber.unsubscribedAt = null;
          subscriber.unsubscribeReason = null;
          await subscriber.save();
          
          // Enviar SMS de bienvenida de nuevo
          const smsResult = await telnyxService.sendWelcomeSms(
            formattedPhone,
            subscriber.discountCode,
            subscriber.discountPercent
          );
          
          return res.json({
            success: true,
            message: 'Welcome back! Check your phone for your discount code.',
            discountCode: subscriber.discountCode,
            resubscribed: true,
            smsSent: smsResult.success
          });
        }
      }
      
      // ========== NUEVO SUSCRIPTOR ==========
      
      // Generar código de descuento único
      const discountCode = await SmsSubscriber.generateDiscountCode();
      console.log(`🎟️  Generated discount code: ${discountCode}`);
      
      // Crear código en Shopify
      let shopifyDiscount = null;
      try {
        shopifyDiscount = await createShopifyDiscountCode(discountCode, 15);
        if (shopifyDiscount) {
          console.log(`✅ Shopify discount created: ${discountCode}`);
        }
      } catch (err) {
        console.error('⚠️  Error creating Shopify discount:', err.message);
        // Continuamos sin el código de Shopify - el código igual funcionará si se crea manualmente
      }

      // Normalizar source para que sea válido en el enum
      const validSources = ['popup', 'checkout', 'manual', 'import', 'landing_page', 'website-popup-sms', 'api', 'test'];
      const normalizedSource = validSources.includes(source) ? source : 'popup';

      // Crear subscriber
      subscriber = new SmsSubscriber({
        phone: formattedPhone,
        phoneFormatted: telnyxService.formatForDisplay(formattedPhone),
        discountCode,
        discountPercent: 15,
        status: 'pending',
        source: normalizedSource,
        sourceUrl: sourceUrl || pageUrl || req.headers['referer'],
        deviceType: deviceType || 'unknown',
        tcpaConsent: consent !== false,
        tcpaConsentAt: consentTimestamp ? new Date(consentTimestamp) : new Date(),
        tcpaConsentIp: req.ip || req.headers['x-forwarded-for']?.split(',')[0],
        shopifyPriceRuleId: shopifyDiscount?.priceRuleId || null,
        shopifyDiscountId: shopifyDiscount?.discountId || null
      });

      await subscriber.save();
      console.log(`📱 New SMS subscriber created: ${formattedPhone}`);

      // Enviar SMS de bienvenida
      const smsResult = await telnyxService.sendWelcomeSms(
        formattedPhone,
        subscriber.discountCode,
        subscriber.discountPercent
      );

      if (smsResult.success) {
        subscriber.welcomeSmsSent = true;
        subscriber.welcomeSmsSentAt = new Date();
        subscriber.welcomeSmsId = smsResult.messageId;
        subscriber.welcomeSmsStatus = smsResult.status || 'queued';
        subscriber.welcomeSmsCost = smsResult.cost;
        subscriber.carrier = smsResult.carrier;
        subscriber.lineType = smsResult.lineType?.toLowerCase() || 'unknown';
        subscriber.status = 'active';
        subscriber.totalSmsSent = 1;
        console.log(`✅ Welcome SMS sent to ${formattedPhone} - ID: ${smsResult.messageId}`);
      } else {
        subscriber.welcomeSmsStatus = 'failed';
        subscriber.welcomeSmsError = smsResult.error;
        subscriber.status = 'invalid';
        console.log(`❌ Welcome SMS failed to ${formattedPhone}: ${smsResult.error}`);
      }

      await subscriber.save();

      res.status(201).json({
        success: true,
        message: smsResult.success 
          ? 'Success! Check your phone for your discount code.' 
          : 'Subscribed but there was an error sending the SMS. Please try again.',
        discountCode: subscriber.discountCode,
        smsSent: smsResult.success,
        smsError: smsResult.error
      });

    } catch (error) {
      console.error('❌ SMS Subscribe Error:', error);
      
      // Error de duplicado
      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          error: 'This phone number is already subscribed.'
        });
      }
      
      res.status(500).json({
        success: false,
        error: 'An error occurred. Please try again.'
      });
    }
  },

  // ==================== WEBHOOK DE TELNYX ====================
  
  /**
   * POST /api/webhooks/telnyx
   * Recibe actualizaciones de estado de SMS
   */
  async handleWebhook(req, res) {
    try {
      // Responder inmediatamente (Telnyx requiere respuesta rápida)
      res.status(200).json({ received: true });

      const webhookData = telnyxService.processWebhook(req.body);
      
      if (!webhookData.valid) {
        console.log('⚠️ Invalid Telnyx webhook:', webhookData.error);
        return;
      }

      if (webhookData.ignored) {
        console.log(`📨 Telnyx webhook ignored: ${webhookData.eventType}`);
        return;
      }

      console.log(`📨 Telnyx webhook: ${webhookData.eventType} - ${webhookData.messageId} - ${webhookData.status}`);

      // Manejar mensaje entrante (STOP para opt-out)
      if (webhookData.isInbound) {
        await handleInboundSms(webhookData);
        return;
      }

      // Actualizar estado del SMS saliente
      if (webhookData.messageId) {
        await updateSmsStatus(webhookData);
      }

    } catch (error) {
      console.error('❌ Telnyx Webhook Error:', error);
      // Ya respondimos 200, solo logueamos
    }
  },

  // ==================== ESTADÍSTICAS ====================
  
  /**
   * GET /api/sms/stats
   * Obtiene estadísticas generales de SMS
   */
  async getStats(req, res) {
    try {
      const { startDate, endDate } = req.query;
      
      const dateRange = {};
      if (startDate) dateRange.start = startDate;
      if (endDate) dateRange.end = endDate;

      const stats = await SmsSubscriber.getStats(dateRange);
      const dailyStats = await SmsSubscriber.getDailyStats(30);

      // Calcular algunas métricas adicionales
      const recentSubscribers = await SmsSubscriber.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      });

      const pendingDelivery = await SmsSubscriber.countDocuments({
        welcomeSmsStatus: { $in: ['pending', 'queued', 'sending', 'sent'] }
      });

      res.json({
        success: true,
        stats: {
          ...stats,
          recentSubscribers24h: recentSubscribers,
          pendingDelivery
        },
        dailyStats
      });

    } catch (error) {
      console.error('❌ SMS Stats Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting statistics'
      });
    }
  },

  // ==================== LISTAR SUSCRIPTORES ====================
  
  /**
   * GET /api/sms/subscribers
   * Lista suscriptores con paginación y filtros
   */
  async getSubscribers(req, res) {
    try {
      const {
        page = 1,
        limit = 50,
        status,
        converted,
        search,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      const query = {};
      
      if (status) query.status = status;
      if (converted !== undefined) query.converted = converted === 'true';
      if (search) {
        query.$or = [
          { phone: { $regex: search, $options: 'i' } },
          { discountCode: { $regex: search, $options: 'i' } }
        ];
      }

      const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

      const [subscribers, total] = await Promise.all([
        SmsSubscriber.find(query)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(parseInt(limit))
          .select('-smsHistory'),
        SmsSubscriber.countDocuments(query)
      ]);

      res.json({
        success: true,
        subscribers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });

    } catch (error) {
      console.error('❌ Get Subscribers Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting subscribers'
      });
    }
  },

  // ==================== DETALLE DE SUSCRIPTOR ====================
  
  /**
   * GET /api/sms/subscribers/:id
   */
  async getSubscriber(req, res) {
    try {
      const subscriber = await SmsSubscriber.findById(req.params.id);
      
      if (!subscriber) {
        return res.status(404).json({
          success: false,
          error: 'Subscriber not found'
        });
      }

      res.json({
        success: true,
        subscriber
      });

    } catch (error) {
      console.error('❌ Get Subscriber Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting subscriber'
      });
    }
  },

  // ==================== REENVIAR SMS ====================
  
  /**
   * POST /api/sms/subscribers/:id/resend
   */
  async resendWelcomeSms(req, res) {
    try {
      const subscriber = await SmsSubscriber.findById(req.params.id);
      
      if (!subscriber) {
        return res.status(404).json({
          success: false,
          error: 'Subscriber not found'
        });
      }

      if (subscriber.status !== 'active') {
        return res.status(400).json({
          success: false,
          error: 'Subscriber is not active'
        });
      }

      const smsResult = await telnyxService.sendWelcomeSms(
        subscriber.phone,
        subscriber.discountCode,
        subscriber.discountPercent
      );

      if (smsResult.success) {
        subscriber.totalSmsSent += 1;
        subscriber.lastSmsAt = new Date();
        subscriber.addSmsToHistory({
          messageId: smsResult.messageId,
          type: 'welcome',
          content: `Code: ${subscriber.discountCode}`,
          status: smsResult.status,
          cost: smsResult.cost
        });
        await subscriber.save();
      }

      res.json({
        success: smsResult.success,
        message: smsResult.success ? 'SMS resent successfully' : 'Error resending SMS',
        error: smsResult.error
      });

    } catch (error) {
      console.error('❌ Resend SMS Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error resending SMS'
      });
    }
  },

  // ==================== HEALTH CHECK ====================
  
  /**
   * GET /api/sms/health
   */
  async healthCheck(req, res) {
    try {
      const telnyxHealth = await telnyxService.healthCheck();
      
      res.json({
        success: true,
        telnyx: telnyxHealth,
        shopify: shopifyService ? 'connected' : 'not available',
        database: 'connected'
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
};

// ==================== FUNCIONES AUXILIARES ====================

/**
 * Crea código de descuento en Shopify usando los métodos existentes
 */
async function createShopifyDiscountCode(code, percentOff) {
  // Verificar que shopifyService esté disponible
  if (!shopifyService) {
    console.log('⚠️  Shopify service not available - skipping discount creation');
    return null;
  }
  
  // Verificar que tenga los métodos necesarios
  if (typeof shopifyService.createPriceRule !== 'function' || 
      typeof shopifyService.createDiscountCode !== 'function') {
    console.log('⚠️  Shopify service missing required methods - skipping discount creation');
    return null;
  }
  
  try {
    // Calcular fecha de expiración (30 días)
    const endsAt = new Date();
    endsAt.setDate(endsAt.getDate() + 30);
    
    // 1. Crear Price Rule
    const priceRule = await shopifyService.createPriceRule({
      title: `SMS Welcome - ${code}`,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: 'percentage',
      value: `-${percentOff}`,
      customer_selection: 'all',
      usage_limit: 1,
      once_per_customer: true,
      starts_at: new Date().toISOString(),
      ends_at: endsAt.toISOString()
    });
    
    if (!priceRule || !priceRule.id) {
      console.log('⚠️  Failed to create price rule');
      return null;
    }
    
    // 2. Crear Discount Code
    const discountCodeResult = await shopifyService.createDiscountCode(priceRule.id, code);
    
    if (!discountCodeResult || !discountCodeResult.id) {
      console.log('⚠️  Failed to create discount code');
      return null;
    }
    
    return {
      priceRuleId: priceRule.id.toString(),
      discountId: discountCodeResult.id.toString()
    };
    
  } catch (error) {
    console.error('❌ Error creating Shopify discount:', error.message);
    
    // Log específico para errores de permisos
    if (error.response?.status === 403) {
      console.error('⚠️  PERMISSION ERROR: Access Token needs write_price_rules scope');
    }
    
    return null;
  }
}

/**
 * Actualiza el estado de un SMS en la DB
 */
async function updateSmsStatus(webhookData) {
  try {
    // Buscar por messageId en welcomeSmsId
    let subscriber = await SmsSubscriber.findOne({ 
      welcomeSmsId: webhookData.messageId 
    });

    if (subscriber) {
      subscriber.welcomeSmsStatus = webhookData.status;
      
      if (webhookData.status === 'delivered') {
        subscriber.welcomeSmsDeliveredAt = new Date();
        subscriber.totalSmsDelivered = (subscriber.totalSmsDelivered || 0) + 1;
      }
      
      if (webhookData.cost) {
        subscriber.welcomeSmsCost = webhookData.cost;
      }

      if (webhookData.errors?.length > 0) {
        subscriber.welcomeSmsError = webhookData.errors[0]?.detail || 'Unknown error';
      }

      await subscriber.save();
      console.log(`✅ Updated SMS status: ${subscriber.phone} -> ${webhookData.status}`);
      return;
    }

    // Buscar en historial de SMS
    subscriber = await SmsSubscriber.findOne({
      'smsHistory.messageId': webhookData.messageId
    });

    if (subscriber) {
      await subscriber.updateSmsStatus(
        webhookData.messageId, 
        webhookData.status,
        webhookData.status === 'delivered' ? new Date() : null
      );
      console.log(`✅ Updated SMS history status: ${subscriber.phone} -> ${webhookData.status}`);
    }

  } catch (error) {
    console.error('❌ Error updating SMS status:', error);
  }
}

/**
 * Maneja SMS entrantes (opt-out, etc.)
 */
async function handleInboundSms(webhookData) {
  try {
    const fromPhone = telnyxService.formatPhoneNumber(webhookData.fromPhone);
    
    if (!fromPhone) return;

    const subscriber = await SmsSubscriber.findOne({ phone: fromPhone });
    
    if (!subscriber) {
      console.log(`📨 Inbound SMS from unknown number: ${fromPhone}`);
      return;
    }

    // Manejar opt-out (STOP, UNSUBSCRIBE, etc.)
    if (webhookData.isOptOut) {
      subscriber.status = 'unsubscribed';
      subscriber.unsubscribedAt = new Date();
      subscriber.unsubscribeReason = 'SMS STOP';
      await subscriber.save();
      
      console.log(`🚫 Unsubscribed via SMS STOP: ${fromPhone}`);
      
      // Enviar confirmación de opt-out
      try {
        await telnyxService.sendSms(fromPhone, 
          'Jersey Pickles: You have been unsubscribed and will receive no further messages. Reply START to resubscribe.'
        );
      } catch (e) {
        console.log('⚠️  Could not send opt-out confirmation');
      }
    } else {
      console.log(`📨 Inbound SMS from ${fromPhone}: ${webhookData.text}`);
      // Aquí podrías manejar otros tipos de respuestas como HELP, START, etc.
    }

  } catch (error) {
    console.error('❌ Error handling inbound SMS:', error);
  }
}

module.exports = smsController;