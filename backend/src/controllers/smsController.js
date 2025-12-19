// backend/src/controllers/smsController.js
const SmsSubscriber = require('../models/SmsSubscriber');
const telnyxService = require('../services/telnyxService');
const shopifyService = require('../services/shopifyService'); // Tu servicio existente

const smsController = {
  // ==================== SUSCRIBIR NUEVO NÚMERO ====================
  
  /**
   * POST /api/sms/subscribe
   * Suscribe un nuevo número desde el popup
   */
  async subscribe(req, res) {
    try {
      const { phone, source = 'popup', sourceUrl, deviceType } = req.body;

      // Validar teléfono
      const formattedPhone = telnyxService.formatPhoneNumber(phone);
      if (!formattedPhone) {
        return res.status(400).json({
          success: false,
          error: 'Número de teléfono inválido'
        });
      }

      // Verificar si ya existe
      let subscriber = await SmsSubscriber.findOne({ phone: formattedPhone });
      
      if (subscriber) {
        // Si ya existe y está activo
        if (subscriber.status === 'active') {
          return res.status(400).json({
            success: false,
            error: 'Este número ya está suscrito',
            alreadySubscribed: true
          });
        }
        
        // Si estaba unsubscribed, reactivar
        if (subscriber.status === 'unsubscribed') {
          subscriber.status = 'active';
          subscriber.subscribedAt = new Date();
          subscriber.unsubscribedAt = null;
          await subscriber.save();
        }
      } else {
        // Generar código de descuento único
        const discountCode = await SmsSubscriber.generateDiscountCode();
        
        // Crear código en Shopify
        let shopifyDiscount = null;
        try {
          shopifyDiscount = await createShopifyDiscountCode(discountCode, 15);
        } catch (err) {
          console.error('⚠️ Error creating Shopify discount:', err.message);
          // Continuamos sin el código de Shopify
        }

        // Crear subscriber
        subscriber = new SmsSubscriber({
          phone: formattedPhone,
          phoneFormatted: telnyxService.formatForDisplay(formattedPhone),
          discountCode,
          discountPercent: 15,
          status: 'pending',
          source,
          sourceUrl,
          deviceType: deviceType || 'unknown',
          tcpaConsent: true,
          tcpaConsentAt: new Date(),
          tcpaConsentIp: req.ip || req.headers['x-forwarded-for'],
          shopifyPriceRuleId: shopifyDiscount?.priceRuleId,
          shopifyDiscountId: shopifyDiscount?.discountId
        });

        await subscriber.save();
      }

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
        subscriber.welcomeSmsStatus = smsResult.status;
        subscriber.welcomeSmsCost = smsResult.cost;
        subscriber.carrier = smsResult.carrier;
        subscriber.lineType = smsResult.lineType?.toLowerCase() || 'unknown';
        subscriber.status = 'active';
        subscriber.totalSmsSent = 1;
      } else {
        subscriber.welcomeSmsStatus = 'failed';
        subscriber.welcomeSmsError = smsResult.error;
        subscriber.status = 'invalid';
      }

      await subscriber.save();

      console.log(`📱 New SMS subscriber: ${formattedPhone} - Code: ${subscriber.discountCode}`);

      res.status(201).json({
        success: true,
        message: smsResult.success 
          ? '¡Código enviado! Revisa tu teléfono.' 
          : 'Suscrito pero hubo un error enviando el SMS',
        discountCode: subscriber.discountCode,
        smsSent: smsResult.success,
        smsError: smsResult.error
      });

    } catch (error) {
      console.error('❌ SMS Subscribe Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error al procesar la suscripción'
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
        error: 'Error al obtener estadísticas'
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
        error: 'Error al obtener suscriptores'
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
          error: 'Suscriptor no encontrado'
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
        error: 'Error al obtener suscriptor'
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
          error: 'Suscriptor no encontrado'
        });
      }

      if (subscriber.status !== 'active') {
        return res.status(400).json({
          success: false,
          error: 'El suscriptor no está activo'
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
          content: `Código: ${subscriber.discountCode}`,
          status: smsResult.status,
          cost: smsResult.cost
        });
        await subscriber.save();
      }

      res.json({
        success: smsResult.success,
        message: smsResult.success ? 'SMS reenviado' : 'Error al reenviar',
        error: smsResult.error
      });

    } catch (error) {
      console.error('❌ Resend SMS Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error al reenviar SMS'
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

    // Manejar opt-out
    if (webhookData.isOptOut) {
      subscriber.status = 'unsubscribed';
      subscriber.unsubscribedAt = new Date();
      subscriber.unsubscribeReason = 'SMS STOP';
      await subscriber.save();
      
      console.log(`🚫 Unsubscribed via SMS STOP: ${fromPhone}`);
      
      // Opcional: Enviar confirmación de opt-out
      // await telnyxService.sendSms(fromPhone, 'You have been unsubscribed from Jersey Pickles SMS. You will not receive any more messages.');
    } else {
      console.log(`📨 Inbound SMS from ${fromPhone}: ${webhookData.text}`);
      // Aquí podrías manejar otros tipos de respuestas
    }

  } catch (error) {
    console.error('❌ Error handling inbound SMS:', error);
  }
}

/**
 * Crea código de descuento en Shopify
 */
async function createShopifyDiscountCode(code, percentOff) {
  try {
    // Primero crear Price Rule
    const priceRuleResponse = await shopifyService.post('/price_rules.json', {
      price_rule: {
        title: `SMS Welcome - ${code}`,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: 'percentage',
        value: `-${percentOff}`,
        customer_selection: 'all',
        usage_limit: 1,
        once_per_customer: true,
        starts_at: new Date().toISOString()
      }
    });

    const priceRuleId = priceRuleResponse.data.price_rule.id;

    // Luego crear el Discount Code
    const discountResponse = await shopifyService.post(
      `/price_rules/${priceRuleId}/discount_codes.json`,
      {
        discount_code: {
          code: code
        }
      }
    );

    return {
      priceRuleId: priceRuleId.toString(),
      discountId: discountResponse.data.discount_code.id.toString()
    };

  } catch (error) {
    console.error('❌ Error creating Shopify discount:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = smsController;