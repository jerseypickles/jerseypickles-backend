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
      const discountCode = await generateDiscountCode();
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
      }

      // Normalizar source para que sea válido en el enum
      const validSources = ['popup', 'checkout', 'manual', 'import', 'landing_page', 'website-popup-sms', 'api', 'test'];
      const normalizedSource = validSources.includes(source) ? source : 'popup';

      // Crear subscriber
      subscriber = new SmsSubscriber({
        phone: formattedPhone,
        phoneFormatted: telnyxService.formatForDisplay ? telnyxService.formatForDisplay(formattedPhone) : formattedPhone,
        discountCode,
        discountPercent: 15,
        status: 'active',
        source: normalizedSource,
        shopifyPriceRuleId: shopifyDiscount?.priceRuleId || null,
        shopifyDiscountCodeId: shopifyDiscount?.discountId || null,
        ipAddress: req.ip || req.headers['x-forwarded-for']?.split(',')[0],
        userAgent: req.headers['user-agent']
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
        subscriber.welcomeSmsMessageId = smsResult.messageId;
        subscriber.welcomeSmsStatus = smsResult.status || 'sent';
        subscriber.carrier = smsResult.carrier;
        // Map Telnyx lineType to model enum values
        const lineTypeMap = { 'wireless': 'mobile', 'mobile': 'mobile', 'landline': 'landline', 'voip': 'voip' };
        subscriber.lineType = lineTypeMap[smsResult.lineType?.toLowerCase()] || 'unknown';
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
    }
  },

  // ==================== ESTADÍSTICAS GENERALES ====================
  
  /**
   * GET /api/sms/stats
   * Obtiene estadísticas generales de SMS
   */
  async getStats(req, res) {
    try {
      // Conteos básicos
      const [total, active, unsubscribed, converted] = await Promise.all([
        SmsSubscriber.countDocuments(),
        SmsSubscriber.countDocuments({ status: 'active' }),
        SmsSubscriber.countDocuments({ status: 'unsubscribed' }),
        SmsSubscriber.countDocuments({ converted: true })
      ]);

      // SMS delivery stats
      const deliveryStats = await SmsSubscriber.aggregate([
        {
          $group: {
            _id: null,
            totalSmsSent: { $sum: '$totalSmsSent' },
            totalSmsDelivered: { $sum: '$totalSmsDelivered' },
            totalSmsFailed: { $sum: '$totalSmsFailed' }
          }
        }
      ]);

      const delivery = deliveryStats[0] || { totalSmsSent: 0, totalSmsDelivered: 0, totalSmsFailed: 0 };

      // Subscribers últimas 24h
      const recentSubscribers = await SmsSubscriber.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      });

      // Pending delivery
      const pendingDelivery = await SmsSubscriber.countDocuments({
        welcomeSmsStatus: { $in: ['pending', 'queued', 'sending', 'sent'] }
      });

      res.json({
        success: true,
        total,
        active,
        unsubscribed,
        converted,
        conversionRate: total > 0 ? ((converted / total) * 100).toFixed(1) : 0,
        totalSmsSent: delivery.totalSmsSent || 0,
        totalSmsDelivered: delivery.totalSmsDelivered || 0,
        totalSmsFailed: delivery.totalSmsFailed || 0,
        recentSubscribers24h: recentSubscribers,
        pendingDelivery
      });

    } catch (error) {
      console.error('❌ SMS Stats Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting statistics'
      });
    }
  },

  // ==================== 🆕 ESTADÍSTICAS DE CONVERSIONES ====================
  
  /**
   * GET /api/sms/stats/conversions
   * Obtiene estadísticas detalladas de conversiones
   */
  async getConversionStats(req, res) {
    try {
      const { from, to } = req.query;
      
      // Build date filter
      const dateFilter = {};
      if (from) dateFilter.$gte = new Date(from);
      if (to) dateFilter.$lte = new Date(to);
      
      const matchStage = { converted: true };
      if (Object.keys(dateFilter).length > 0) {
        matchStage['conversionData.convertedAt'] = dateFilter;
      }

      // Get totals
      const totalSubscribers = await SmsSubscriber.countDocuments();
      const convertedSubscribers = await SmsSubscriber.countDocuments(matchStage);
      
      // Revenue aggregation
      const revenueAgg = await SmsSubscriber.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$conversionData.orderTotal' },
            totalDiscountGiven: { $sum: '$conversionData.discountAmount' },
            avgOrderValue: { $avg: '$conversionData.orderTotal' },
            avgTimeToConvert: { $avg: '$conversionData.timeToConvert' },
            totalOrders: { $sum: 1 }
          }
        }
      ]);

      const revenue = revenueAgg[0] || {
        totalRevenue: 0,
        totalDiscountGiven: 0,
        avgOrderValue: 0,
        avgTimeToConvert: 0,
        totalOrders: 0
      };

      // Get recent conversions
      const recentConversions = await SmsSubscriber.find({ converted: true })
        .sort({ 'conversionData.convertedAt': -1 })
        .limit(20)
        .select('phone discountCode conversionData')
        .lean();

      // Format recent conversions for frontend
      const formattedConversions = recentConversions.map(sub => ({
        phone: sub.phone,
        discountCode: sub.discountCode,
        orderId: sub.conversionData?.orderId,
        orderNumber: sub.conversionData?.orderNumber,
        orderTotal: sub.conversionData?.orderTotal || 0,
        discountAmount: sub.conversionData?.discountAmount || 0,
        convertedAt: sub.conversionData?.convertedAt,
        timeToConvert: sub.conversionData?.timeToConvert
      }));

      // Calculate ROI (simplified: revenue / estimated SMS cost)
      const estimatedSmsCost = totalSubscribers * 0.015; // ~$0.015 per SMS
      const roi = estimatedSmsCost > 0 
        ? (((revenue.totalRevenue - estimatedSmsCost) / estimatedSmsCost) * 100).toFixed(0)
        : 0;

      // Format avg time to convert
      let avgTimeFormatted = 'N/A';
      if (revenue.avgTimeToConvert) {
        const mins = Math.round(revenue.avgTimeToConvert);
        if (mins < 60) {
          avgTimeFormatted = `${mins} min`;
        } else if (mins < 1440) {
          avgTimeFormatted = `${Math.round(mins / 60)} hours`;
        } else {
          avgTimeFormatted = `${Math.round(mins / 1440)} days`;
        }
      }

      res.json({
        success: true,
        totalSubscribers,
        convertedSubscribers,
        conversionRate: totalSubscribers > 0 
          ? ((convertedSubscribers / totalSubscribers) * 100).toFixed(1)
          : 0,
        totalRevenue: revenue.totalRevenue || 0,
        totalDiscountGiven: revenue.totalDiscountGiven || 0,
        avgOrderValue: revenue.avgOrderValue || 0,
        avgTimeToConvert: avgTimeFormatted,
        avgTimeToConvertMinutes: revenue.avgTimeToConvert || 0,
        roi: parseInt(roi) || 0,
        recentConversions: formattedConversions
      });

    } catch (error) {
      console.error('❌ Conversion Stats Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting conversion statistics'
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
        limit = 20,
        status,
        converted,
        search,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      const query = {};
      
      if (status && status !== 'all') {
        query.status = status;
      }
      
      if (converted !== undefined && converted !== 'all') {
        query.converted = converted === 'true';
      }
      
      if (search) {
        query.$or = [
          { phone: { $regex: search, $options: 'i' } },
          { discountCode: { $regex: search.toUpperCase(), $options: 'i' } }
        ];
      }

      const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [subscribers, total] = await Promise.all([
        SmsSubscriber.find(query)
          .sort(sort)
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        SmsSubscriber.countDocuments(query)
      ]);

      res.json({
        success: true,
        subscribers,
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
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
        subscriber.totalSmsSent = (subscriber.totalSmsSent || 0) + 1;
        subscriber.lastSmsAt = new Date();
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
      let telnyxHealthy = false;
      let telnyxError = null;
      
      try {
        const health = await telnyxService.healthCheck();
        telnyxHealthy = health?.healthy || health?.success || true;
      } catch (e) {
        telnyxError = e.message;
      }

      res.json({
        success: true,
        healthy: telnyxHealthy,
        telnyx: {
          connected: telnyxHealthy,
          error: telnyxError
        },
        shopify: shopifyService ? 'connected' : 'not available',
        database: 'connected'
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        healthy: false,
        error: error.message
      });
    }
  }
};

// ==================== FUNCIONES AUXILIARES ====================

/**
 * Genera código de descuento único JP-XXXXX
 */
async function generateDiscountCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin I, O, 0, 1 para evitar confusión
  let code;
  let exists = true;
  
  while (exists) {
    let random = '';
    for (let i = 0; i < 5; i++) {
      random += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    code = `JP-${random}`;
    
    // Verificar que no exista
    const existing = await SmsSubscriber.findOne({ discountCode: code });
    exists = !!existing;
  }
  
  return code;
}

/**
 * Crea código de descuento en Shopify
 */
async function createShopifyDiscountCode(code, percentOff) {
  if (!shopifyService) {
    console.log('⚠️  Shopify service not available - skipping discount creation');
    return null;
  }
  
  if (typeof shopifyService.createPriceRule !== 'function' || 
      typeof shopifyService.createDiscountCode !== 'function') {
    console.log('⚠️  Shopify service missing required methods - skipping discount creation');
    return null;
  }
  
  try {
    const endsAt = new Date();
    endsAt.setDate(endsAt.getDate() + 30);
    
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
    let subscriber = await SmsSubscriber.findOne({ 
      welcomeSmsMessageId: webhookData.messageId 
    });

    if (subscriber) {
      subscriber.welcomeSmsStatus = webhookData.status;
      
      if (webhookData.status === 'delivered') {
        subscriber.totalSmsDelivered = (subscriber.totalSmsDelivered || 0) + 1;
      }

      if (webhookData.errors?.length > 0) {
        subscriber.welcomeSmsError = webhookData.errors[0]?.detail || 'Unknown error';
      }

      await subscriber.save();
      console.log(`✅ Updated SMS status: ${subscriber.phone} -> ${webhookData.status}`);
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

    const text = (webhookData.text || '').toLowerCase().trim();
    const stopKeywords = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];
    const startKeywords = ['start', 'yes', 'unstop'];

    if (stopKeywords.includes(text)) {
      subscriber.status = 'unsubscribed';
      subscriber.unsubscribedAt = new Date();
      subscriber.unsubscribeReason = 'stop_keyword';
      await subscriber.save();
      console.log(`🚫 Unsubscribed via SMS STOP: ${fromPhone}`);
      
      try {
        await telnyxService.sendSms(fromPhone, 
          'Jersey Pickles: You have been unsubscribed. Reply START to resubscribe.'
        );
      } catch (e) {
        console.log('⚠️  Could not send opt-out confirmation');
      }
    } else if (startKeywords.includes(text) && subscriber.status === 'unsubscribed') {
      subscriber.status = 'active';
      subscriber.unsubscribedAt = null;
      subscriber.unsubscribeReason = null;
      await subscriber.save();
      console.log(`✅ Re-subscribed via SMS START: ${fromPhone}`);
      
      try {
        await telnyxService.sendSms(fromPhone, 
          `Jersey Pickles: Welcome back! Your discount code is ${subscriber.discountCode} for 15% off.`
        );
      } catch (e) {
        console.log('⚠️  Could not send re-subscribe confirmation');
      }
    } else {
      console.log(`📨 Inbound SMS from ${fromPhone}: ${webhookData.text}`);
    }

  } catch (error) {
    console.error('❌ Error handling inbound SMS:', error);
  }
}

module.exports = smsController;