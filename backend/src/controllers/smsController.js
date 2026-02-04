// backend/src/controllers/smsController.js
// 📱 SMS Controller - Con Second Chance SMS Support y Geolocalización
const SmsSubscriber = require('../models/SmsSubscriber');
const SmsConversation = require('../models/SmsConversation');
const telnyxService = require('../services/telnyxService');
const smsConversionService = require('../services/smsConversionService');

// Cargar geoLocationService de forma segura
let geoLocationService = null;
try {
  geoLocationService = require('../services/geoLocationService');
  console.log('📱 SMS Controller: GeoLocation service loaded');
} catch (e) {
  console.log('⚠️  SMS Controller: GeoLocation service not available');
}

// Cargar shopifyService de forma segura
let shopifyService = null;
try {
  shopifyService = require('../services/shopifyService');
  console.log('📱 SMS Controller: Shopify service loaded');
} catch (e) {
  console.log('⚠️  SMS Controller: Shopify service not available');
}

// Cargar secondChanceSmsService de forma segura
let secondChanceSmsService = null;
try {
  secondChanceSmsService = require('../services/secondChanceSmsService');
  console.log('📱 SMS Controller: Second Chance SMS service loaded');
} catch (e) {
  console.log('⚠️  SMS Controller: Second Chance SMS service not available');
}

// Cargar secondChanceSmsJob de forma segura
let secondChanceSmsJob = null;
try {
  secondChanceSmsJob = require('../jobs/secondChanceSmsJob');
} catch (e) {
  // Job not available
}

// Cargar smsTransactionalService de forma segura
let smsTransactionalService = null;
try {
  smsTransactionalService = require('../services/smsTransactionalService');
  console.log('📱 SMS Controller: Transactional SMS service loaded');
} catch (e) {
  console.log('⚠️  SMS Controller: Transactional SMS service not available');
}

// Cargar modelo SmsTransactional
let SmsTransactional = null;
try {
  SmsTransactional = require('../models/SmsTransactional');
} catch (e) {
  // Model not available
}

// Cargar delayedShipmentJob de forma segura
let delayedShipmentJob = null;
try {
  delayedShipmentJob = require('../jobs/delayedShipmentJob');
  console.log('📱 SMS Controller: Delayed Shipment Job loaded');
} catch (e) {
  console.log('⚠️  SMS Controller: Delayed Shipment Job not available');
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
            subscriber.discountPercent,
            subscriber._id // Pass subscriber ID for logging
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
      
      // Generar código de descuento único (15% OFF)
      const discountCode = await generateDiscountCode();
      console.log(`🎟️  Generated discount code: ${discountCode}`);
      
      // Crear código en Shopify (sin expiración para el primero)
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

      // 🆕 Obtener geolocalización por IP
      // Prioridad: CF-Connecting-IP (Cloudflare) > X-Real-IP > X-Forwarded-For > req.ip
      const clientIp =
        req.headers['cf-connecting-ip'] ||  // Cloudflare real IP
        req.headers['x-real-ip'] ||          // Nginx real IP
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.ip ||
        req.connection?.remoteAddress;
      let location = null;
      if (geoLocationService && clientIp) {
        try {
          location = await geoLocationService.getLocationByIp(clientIp);
          console.log(`🌍 Geolocated ${clientIp} -> ${location.city}, ${location.regionName}`);
        } catch (geoError) {
          console.log('⚠️  Could not geolocate IP:', geoError.message);
        }
      }

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
        ipAddress: clientIp,
        userAgent: req.headers['user-agent'],
        // 🆕 Geolocalización
        location: location ? {
          country: location.country,
          countryCode: location.countryCode,
          region: location.region || geoLocationService.getUsState(location),
          regionName: location.regionName,
          city: location.city,
          zip: location.zip,
          lat: location.lat,
          lng: location.lng,
          timezone: location.timezone,
          source: location.source,
          resolvedAt: location.resolvedAt
        } : null,
        // 🆕 Initialize second SMS fields
        secondSmsSent: false,
        converted: false,
        convertedWith: null
      });

      await subscriber.save();
      console.log(`📱 New SMS subscriber created: ${formattedPhone}`);

      // Enviar SMS de bienvenida (15% OFF)
      const smsResult = await telnyxService.sendWelcomeSms(
        formattedPhone,
        subscriber.discountCode,
        subscriber.discountPercent,
        subscriber._id // Pass subscriber ID for logging
      );

      if (smsResult.success) {
        subscriber.welcomeSmsSent = true;
        subscriber.welcomeSmsAt = new Date(); // 🆕 Renamed from welcomeSmsSentAt
        subscriber.welcomeSmsMessageId = smsResult.messageId;
        subscriber.welcomeSmsStatus = smsResult.status || 'sent';
        subscriber.carrier = smsResult.carrier;
        // Map Telnyx lineType to model enum values
        const lineTypeMap = { 'wireless': 'mobile', 'mobile': 'mobile', 'landline': 'landline', 'voip': 'voip' };
        subscriber.lineType = lineTypeMap[smsResult.lineType?.toLowerCase()] || 'unknown';
        subscriber.totalSmsSent = 1;
        subscriber.totalSmsReceived = 1;
        console.log(`✅ Welcome SMS (15% OFF) sent to ${formattedPhone} - ID: ${smsResult.messageId}`);
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

      // Actualizar estado del SMS saliente (first or second)
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
   * Obtiene estadísticas generales de SMS con breakdown first/second
   */
  async getStats(req, res) {
    try {
      // Get full breakdown from conversion service
      const breakdown = await smsConversionService.getConversionBreakdown();
      
      // Conteos básicos
      const [total, active, unsubscribed] = await Promise.all([
        SmsSubscriber.countDocuments(),
        SmsSubscriber.countDocuments({ status: 'active' }),
        SmsSubscriber.countDocuments({ status: 'unsubscribed' })
      ]);

      // SMS delivery stats (both first and second)
      const deliveryStats = await SmsSubscriber.aggregate([
        {
          $group: {
            _id: null,
            totalSmsSent: { 
              $sum: { 
                $add: [
                  { $cond: ['$welcomeSmsSent', 1, 0] },
                  { $cond: ['$secondSmsSent', 1, 0] }
                ]
              }
            },
            totalSmsDelivered: { 
              $sum: {
                $add: [
                  { $cond: [{ $eq: ['$welcomeSmsStatus', 'delivered'] }, 1, 0] },
                  { $cond: [{ $eq: ['$secondSmsStatus', 'delivered'] }, 1, 0] }
                ]
              }
            },
            totalSmsFailed: { 
              $sum: {
                $add: [
                  { $cond: [{ $eq: ['$welcomeSmsStatus', 'failed'] }, 1, 0] },
                  { $cond: [{ $eq: ['$secondSmsStatus', 'failed'] }, 1, 0] }
                ]
              }
            }
          }
        }
      ]);

      const delivery = deliveryStats[0] || { totalSmsSent: 0, totalSmsDelivered: 0, totalSmsFailed: 0 };

      // Subscribers últimas 24h
      const recentSubscribers24h = await SmsSubscriber.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      });

      // Calculate conversion rate
      const totalConverted = breakdown?.conversions?.total || 0;
      const conversionRate = total > 0 ? ((totalConverted / total) * 100).toFixed(1) : '0';

      // 🆕 First SMS stats
      const firstSmsDelivered = breakdown?.firstSms?.delivered || 0;
      const firstConverted = breakdown?.conversions?.first || 0;
      const firstConversionRate = firstSmsDelivered > 0 
        ? ((firstConverted / firstSmsDelivered) * 100).toFixed(1) 
        : '0';

      // 🆕 Second SMS stats
      const secondSmsSent = breakdown?.secondSms?.sent || 0;
      const secondSmsDelivered = breakdown?.secondSms?.delivered || 0;
      const secondConverted = breakdown?.conversions?.second || 0;
      const recoveryRate = secondSmsDelivered > 0
        ? ((secondConverted / secondSmsDelivered) * 100).toFixed(1)
        : '0';

      res.json({
        success: true,
        total,
        active,
        unsubscribed,
        converted: totalConverted,
        conversionRate,
        
        // SMS delivery stats
        totalSmsSent: delivery.totalSmsSent || 0,
        totalSmsDelivered: delivery.totalSmsDelivered || 0,
        totalSmsFailed: delivery.totalSmsFailed || 0,
        
        // 🆕 First SMS (15% OFF)
        firstSms: {
          delivered: firstSmsDelivered,
          converted: firstConverted,
          conversionRate: firstConversionRate
        },
        
        // 🆕 Second SMS (20% OFF) - Recovery
        secondSms: {
          sent: secondSmsSent,
          delivered: secondSmsDelivered,
          converted: secondConverted,
          pending: breakdown?.secondSms?.pending || 0,
          recoveryRate
        },
        
        // 🆕 Revenue breakdown
        revenue: breakdown?.revenue || { total: 0, first: 0, second: 0 },
        
        // 🆕 No conversion after both SMS
        noConversion: breakdown?.conversions?.none || 0,
        
        recentSubscribers24h
      });

    } catch (error) {
      console.error('❌ SMS Stats Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting statistics'
      });
    }
  },

  // ==================== ESTADÍSTICAS DE CONVERSIONES ====================
  
  /**
   * GET /api/sms/stats/conversions
   * Obtiene estadísticas detalladas de conversiones con first/second breakdown
   */
  async getConversionStats(req, res) {
    try {
      const { from, to } = req.query;
      
      const dateRange = {};
      if (from) dateRange.from = from;
      if (to) dateRange.to = to;
      
      const stats = await smsConversionService.getConversionStats(dateRange);
      
      if (!stats.success) {
        return res.status(500).json(stats);
      }

      res.json({
        success: true,
        ...stats.stats,
        recentConversions: stats.recentConversions
      });

    } catch (error) {
      console.error('❌ Conversion Stats Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting conversion statistics'
      });
    }
  },

  // ==================== 🆕 SECOND CHANCE SMS STATS ====================
  
  /**
   * GET /api/sms/stats/second-chance
   * Estadísticas específicas del Second Chance SMS
   */
  async getSecondChanceStats(req, res) {
    try {
      if (!secondChanceSmsService) {
        return res.status(503).json({
          success: false,
          error: 'Second Chance SMS service not available'
        });
      }

      const stats = await secondChanceSmsService.getSecondChanceStats();
      const jobStatus = secondChanceSmsJob?.getStatus() || { initialized: false };
      
      res.json({
        success: true,
        ...stats,
        job: jobStatus
      });

    } catch (error) {
      console.error('❌ Second Chance Stats Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting second chance statistics'
      });
    }
  },

  // ==================== 🆕 TRIGGER SECOND CHANCE SMS ====================
  
  /**
   * POST /api/sms/second-chance/trigger
   * POST /api/sms/second-chance/trigger/:subscriberId
   * Trigger manual para testing
   */
  async triggerSecondChance(req, res) {
    try {
      if (!secondChanceSmsService) {
        return res.status(503).json({
          success: false,
          error: 'Second Chance SMS service not available'
        });
      }

      const { subscriberId } = req.params;
      
      if (subscriberId) {
        // Process specific subscriber
        const subscriber = await SmsSubscriber.findById(subscriberId);
        
        if (!subscriber) {
          return res.status(404).json({ 
            success: false, 
            error: 'Subscriber not found' 
          });
        }
        
        // Check eligibility
        if (subscriber.converted) {
          return res.status(400).json({
            success: false,
            error: 'Subscriber already converted'
          });
        }
        
        if (subscriber.secondSmsSent) {
          return res.status(400).json({
            success: false,
            error: 'Second SMS already sent'
          });
        }
        
        const result = await secondChanceSmsService.processSubscriberForSecondSms(subscriber);
        
        return res.json({
          success: result.success,
          ...result
        });
      }
      
      // Process batch
      const result = await secondChanceSmsService.processSecondChanceBatch(10);
      
      res.json({
        success: true,
        ...result
      });
      
    } catch (error) {
      console.error('❌ Trigger Second Chance Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error triggering second chance SMS'
      });
    }
  },

  // ==================== 🆕 SECOND CHANCE JOB STATUS ====================

  /**
   * GET /api/sms/second-chance/status
   */
  async getSecondChanceJobStatus(req, res) {
    try {
      const status = secondChanceSmsJob?.getStatus() || {
        initialized: false,
        running: false,
        withinSendingHours: false,
        nextSendingWindow: null
      };

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Get pending count - subscribers eligible for second SMS (24h after first)
      const pendingSecondSms = await SmsSubscriber.countDocuments({
        status: 'active',
        converted: false,
        secondSmsSent: { $ne: true },
        welcomeSmsStatus: 'delivered',
        $or: [
          { welcomeSmsAt: { $lte: twentyFourHoursAgo } },
          { welcomeSmsSentAt: { $lte: twentyFourHoursAgo } }
        ]
      });

      // 🆕 Get second SMS stats for alerts
      const [secondSmsSent, secondSmsDelivered, secondSmsConverted] = await Promise.all([
        SmsSubscriber.countDocuments({ secondSmsSent: true }),
        SmsSubscriber.countDocuments({ secondSmsSent: true, secondSmsStatus: 'delivered' }),
        SmsSubscriber.countDocuments({ secondSmsSent: true, converted: true, convertedFromSecondSms: true })
      ]);

      res.json({
        success: true,
        ...status,
        pendingSecondSms,
        // 🆕 Stats for frontend alerts
        stats: {
          secondSmsSent,
          secondSmsDelivered,
          secondSmsConverted,
          deliveryRate: secondSmsSent > 0 ? ((secondSmsDelivered / secondSmsSent) * 100).toFixed(1) : 0,
          conversionRate: secondSmsDelivered > 0 ? ((secondSmsConverted / secondSmsDelivered) * 100).toFixed(1) : 0
        }
      });

    } catch (error) {
      console.error('❌ Job Status Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting job status'
      });
    }
  },

// ==================== 🆕 RECOVER MISSED SUBSCRIBERS ====================

  /**
   * POST /api/sms/second-chance/recover
   * Procesa todos los suscriptores que se perdieron (>6h sin segundo SMS)
   */
  async recoverMissedSubscribers(req, res) {
    try {
      if (!secondChanceSmsService) {
        return res.status(503).json({
          success: false,
          error: 'Second Chance SMS service not available'
        });
      }

      const { limit = 50, dryRun = false } = req.body;
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Find all eligible subscribers that were missed (24h after first SMS)
      const missedSubscribers = await SmsSubscriber.find({
        status: 'active',
        converted: false,
        secondSmsSent: { $ne: true },
        welcomeSmsStatus: 'delivered',
        $or: [
          { welcomeSmsAt: { $lte: twentyFourHoursAgo } },
          { welcomeSmsSentAt: { $lte: twentyFourHoursAgo } }
        ]
      })
      .sort({ welcomeSmsAt: 1, welcomeSmsSentAt: 1 })
      .limit(parseInt(limit));

      if (dryRun) {
        // Just return info without processing
        const subscriberInfo = missedSubscribers.map(sub => {
          const smsTime = sub.welcomeSmsAt || sub.welcomeSmsSentAt;
          const hoursSinceFirst = smsTime
            ? ((Date.now() - new Date(smsTime).getTime()) / (1000 * 60 * 60)).toFixed(1)
            : 'unknown';
          return {
            id: sub._id,
            phone: sub.phone.replace(/(\+1\d{3})\d{4}(\d{4})/, '$1****$2'), // Mask phone
            discountCode: sub.discountCode,
            welcomeSmsAt: smsTime,
            hoursSinceFirstSms: hoursSinceFirst,
            status: sub.status
          };
        });

        return res.json({
          success: true,
          dryRun: true,
          message: `Found ${missedSubscribers.length} subscribers eligible for recovery`,
          totalEligible: missedSubscribers.length,
          subscribers: subscriberInfo
        });
      }

      // Check if within sending hours
      if (!secondChanceSmsService.isWithinSendingHours()) {
        return res.status(400).json({
          success: false,
          error: 'Outside sending hours (9am-9pm). Use dryRun=true to preview.',
          nextSendingTime: secondChanceSmsService.getNextSendingTime()
        });
      }

      // Process subscribers
      const results = {
        processed: 0,
        success: 0,
        failed: 0,
        details: []
      };

      console.log(`\n🔄 Starting recovery of ${missedSubscribers.length} missed subscribers...`);

      for (const subscriber of missedSubscribers) {
        const result = await secondChanceSmsService.processSubscriberForSecondSms(subscriber);

        results.processed++;
        results.details.push({
          phone: subscriber.phone.replace(/(\+1\d{3})\d{4}(\d{4})/, '$1****$2'),
          success: result.success,
          code: result.code || null,
          error: result.error || null
        });

        if (result.success) {
          results.success++;
        } else {
          results.failed++;
        }

        // Rate limit: wait 1.2 seconds between SMS
        if (results.processed < missedSubscribers.length) {
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
      }

      console.log(`✅ Recovery complete: ${results.success} sent, ${results.failed} failed`);

      res.json({
        success: true,
        message: `Processed ${results.processed} subscribers`,
        ...results
      });

    } catch (error) {
      console.error('❌ Recover Missed Subscribers Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error recovering missed subscribers'
      });
    }
  },

  // ==================== 🆕 SECOND CHANCE QUEUE DETAILS ====================

  /**
   * GET /api/sms/second-chance/queue
   * Get detailed queue visibility for Second Chance SMS
   * Shows exactly when each SMS is scheduled and will be sent
   */
  async getSecondChanceQueue(req, res) {
    try {
      if (!secondChanceSmsService) {
        return res.status(503).json({
          success: false,
          error: 'Second Chance SMS service not available'
        });
      }

      const { limit = 50 } = req.query;
      const queueDetails = await secondChanceSmsService.getQueueDetails({
        limit: parseInt(limit)
      });

      // Add job status
      const jobStatus = secondChanceSmsJob?.getStatus() || { initialized: false };

      res.json({
        success: true,
        job: {
          ...jobStatus,
          schedule: '30 * * * *', // Every hour at :30
          description: 'Runs every hour to process scheduled Second Chance SMS'
        },
        ...queueDetails
      });

    } catch (error) {
      console.error('❌ Second Chance Queue Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting queue details'
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
        convertedWith, // 🆕 Filter by 'first' or 'second'
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
      
      // 🆕 Filter by conversion type
      if (convertedWith && ['first', 'second'].includes(convertedWith)) {
        query.convertedWith = convertedWith;
      }
      
      if (search) {
        query.$or = [
          { phone: { $regex: search, $options: 'i' } },
          { discountCode: { $regex: search.toUpperCase(), $options: 'i' } },
          { secondDiscountCode: { $regex: search.toUpperCase(), $options: 'i' } } // 🆕
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

      // 🆕 Add computed conversionStatus for each subscriber
      const formattedSubscribers = subscribers.map(sub => ({
        ...sub,
        conversionStatus: getConversionStatus(sub)
      }));

      res.json({
        success: true,
        subscribers: formattedSubscribers,
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
      const subscriber = await SmsSubscriber.findById(req.params.id).lean();
      
      if (!subscriber) {
        return res.status(404).json({
          success: false,
          error: 'Subscriber not found'
        });
      }

      // 🆕 Add conversion status
      subscriber.conversionStatus = getConversionStatus(subscriber);

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
        subscriber.discountPercent,
        subscriber._id // Pass subscriber ID for logging
      );

      if (smsResult.success) {
        subscriber.totalSmsSent = (subscriber.totalSmsSent || 0) + 1;
        subscriber.totalSmsReceived = (subscriber.totalSmsReceived || 0) + 1;
        subscriber.lastSmsAt = new Date();
        subscriber.welcomeSmsStatus = 'sent';
        subscriber.welcomeSmsMessageId = smsResult.messageId;
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
        secondChanceSms: secondChanceSmsService ? 'available' : 'not available', // 🆕
        secondChanceJob: secondChanceSmsJob?.getStatus()?.initialized || false, // 🆕
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
 * 🆕 Get conversion status label for frontend
 */
function getConversionStatus(sub) {
  // Legacy data (converted sin convertedWith) se trata como 'first' (converted)
  if (sub.converted && sub.convertedWith === 'second') return 'recovered';
  if (sub.converted) return 'converted'; // first o legacy
  if (sub.secondSmsSent && !sub.converted) return 'no_conversion';
  if (!sub.secondSmsSent && sub.welcomeSmsStatus === 'delivered' && !sub.converted) {
    const smsTime = sub.welcomeSmsAt || sub.welcomeSmsSentAt;
    const hoursSinceFirst = smsTime
      ? (Date.now() - new Date(smsTime).getTime()) / (1000 * 60 * 60)
      : 0;
    if (hoursSinceFirst >= 24) return 'pending_second';
    return 'waiting';
  }
  return 'waiting';
}

/**
 * Genera código de descuento único JP-XXXXX (first) o JP2-XXXXX (second)
 */
async function generateDiscountCode(prefix = 'JP') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin I, O, 0, 1 para evitar confusión
  let code;
  let exists = true;
  
  while (exists) {
    let random = '';
    for (let i = 0; i < 5; i++) {
      random += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    code = `${prefix}-${random}`;
    
    // Verificar que no exista en ninguno de los campos de código
    const existing = await SmsSubscriber.findOne({ 
      $or: [
        { discountCode: code },
        { secondDiscountCode: code }
      ]
    });
    exists = !!existing;
  }
  
  return code;
}

/**
 * Crea código de descuento en Shopify
 * @param {string} code - Código de descuento
 * @param {number} percentOff - Porcentaje de descuento
 * @param {Date} expiresAt - Fecha de expiración (opcional, para second code)
 */
async function createShopifyDiscountCode(code, percentOff, expiresAt = null) {
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
    // Default expiration: 30 days (for first code)
    // For second code: expiresAt is passed (2 hours)
    const endsAt = expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    const priceRule = await shopifyService.createPriceRule({
      title: `SMS ${code.startsWith('JP2') ? 'Recovery' : 'Welcome'} - ${code}`,
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
      discountId: discountCodeResult.id.toString(),
      expiresAt: endsAt
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
 * Actualiza el estado de un SMS en la DB (first or second)
 */
async function updateSmsStatus(webhookData) {
  try {
    // Try to find by welcomeSmsMessageId (first SMS)
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
      console.log(`✅ Updated first SMS status: ${subscriber.phone} -> ${webhookData.status}`);
      return;
    }

    // 🆕 Try to find by secondSmsMessageId (second SMS)
    subscriber = await SmsSubscriber.findOne({ 
      secondSmsMessageId: webhookData.messageId 
    });

    if (subscriber) {
      subscriber.secondSmsStatus = webhookData.status;
      
      if (webhookData.status === 'delivered') {
        subscriber.totalSmsDelivered = (subscriber.totalSmsDelivered || 0) + 1;
      }

      if (webhookData.errors?.length > 0) {
        subscriber.secondSmsError = webhookData.errors[0]?.detail || 'Unknown error';
      }

      await subscriber.save();
      console.log(`✅ Updated second SMS status: ${subscriber.phone} -> ${webhookData.status}`);
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
      subscriber.unsubscribeKeyword = text.toUpperCase(); // Track which keyword they used
      subscriber.unsubscribeSource = 'reply_stop'; // They replied via SMS

      // Track which SMS triggered the unsubscribe
      if (subscriber.secondSmsSent) {
        subscriber.unsubscribeAfterSms = 'second_chance';
      } else if (subscriber.welcomeSmsSent) {
        subscriber.unsubscribeAfterSms = 'welcome';
      } else {
        subscriber.unsubscribeAfterSms = 'none';
      }

      // Track SMS count before unsubscribe
      subscriber.smsCountBeforeUnsub = subscriber.totalSmsReceived || (subscriber.secondSmsSent ? 2 : 1);

      // Track time to unsubscribe (in minutes)
      if (subscriber.createdAt) {
        subscriber.timeToUnsubscribe = Math.round((Date.now() - new Date(subscriber.createdAt).getTime()) / (1000 * 60));
      }

      await subscriber.save();
      console.log(`🚫 Unsubscribed via SMS STOP: ${fromPhone} (after ${subscriber.unsubscribeAfterSms} SMS)`);

      try {
        await telnyxService.sendStopConfirmation(fromPhone, subscriber._id);
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
        await telnyxService.sendStartConfirmation(fromPhone, subscriber._id);
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

// Export helper for second chance service
smsController.generateDiscountCode = generateDiscountCode;
smsController.createShopifyDiscountCode = createShopifyDiscountCode;

// ==================== 📱 SMS TRANSACTIONAL TRIGGERS ====================

/**
 * GET /api/sms/triggers/settings
 * Get trigger settings and stats
 */
smsController.getTriggersSettings = async (req, res) => {
  try {
    if (!smsTransactionalService) {
      return res.status(503).json({
        success: false,
        error: 'SMS Transactional service not available'
      });
    }

    const settings = smsTransactionalService.getSettings();
    const stats = await smsTransactionalService.getStats(30);

    res.json({
      success: true,
      settings,
      stats
    });

  } catch (error) {
    console.error('❌ Get Triggers Settings Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting trigger settings'
    });
  }
};

/**
 * PUT /api/sms/triggers/settings
 * Update trigger settings (enable/disable, custom templates)
 * Supports both old format { triggerType, enabled } and new format { [triggerType]: { enabled, template } }
 */
smsController.updateTriggersSettings = async (req, res) => {
  try {
    if (!smsTransactionalService) {
      return res.status(503).json({
        success: false,
        error: 'SMS Transactional service not available'
      });
    }

    const body = req.body;

    // Check if old format (single trigger)
    if (body.triggerType) {
      const { triggerType, enabled } = body;
      const success = smsTransactionalService.toggleTrigger(triggerType, enabled);

      if (!success) {
        return res.status(400).json({
          success: false,
          error: `Invalid trigger type: ${triggerType}`
        });
      }
    } else {
      // New format: { [triggerType]: { enabled, template } }
      const validTriggers = ['order_confirmation', 'shipping_notification', 'delivery_confirmation'];

      for (const [triggerType, config] of Object.entries(body)) {
        if (!validTriggers.includes(triggerType)) continue;

        // Update settings via updateSettings
        const newSettings = {};
        newSettings[triggerType] = {
          ...smsTransactionalService.getSettings()[triggerType],
          ...config
        };
        smsTransactionalService.updateSettings(newSettings);
      }
    }

    const settings = smsTransactionalService.getSettings();

    res.json({
      success: true,
      message: 'Settings updated',
      settings
    });

  } catch (error) {
    console.error('❌ Update Triggers Settings Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error updating trigger settings'
    });
  }
};

/**
 * GET /api/sms/triggers/stats
 * Get transactional SMS statistics
 */
smsController.getTriggersStats = async (req, res) => {
  try {
    if (!smsTransactionalService) {
      return res.status(503).json({
        success: false,
        error: 'SMS Transactional service not available'
      });
    }

    const { days = 30 } = req.query;
    const stats = await smsTransactionalService.getStats(parseInt(days));

    res.json({
      success: true,
      ...stats
    });

  } catch (error) {
    console.error('❌ Get Triggers Stats Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting trigger statistics'
    });
  }
};

/**
 * GET /api/sms/triggers/history
 * Get recent transactional SMS history
 */
smsController.getTriggersHistory = async (req, res) => {
  try {
    if (!SmsTransactional) {
      return res.status(503).json({
        success: false,
        error: 'SmsTransactional model not available'
      });
    }

    const { limit = 50, triggerType, status } = req.query;

    const query = {};
    if (triggerType) query.triggerType = triggerType;
    if (status) query.status = status;

    const history = await SmsTransactional.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    // Mask phone numbers
    const maskedHistory = history.map(sms => ({
      ...sms,
      phone: sms.phone ? `***-***-${sms.phone.slice(-4)}` : null
    }));

    res.json({
      success: true,
      count: maskedHistory.length,
      history: maskedHistory
    });

  } catch (error) {
    console.error('❌ Get Triggers History Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting trigger history'
    });
  }
};

/**
 * GET /api/sms/triggers/templates
 * Get message templates preview
 */
smsController.getTriggersTemplates = async (req, res) => {
  try {
    if (!smsTransactionalService) {
      return res.status(503).json({
        success: false,
        error: 'SMS Transactional service not available'
      });
    }

    const templates = smsTransactionalService.TEMPLATES;
    const defaultTemplates = smsTransactionalService.DEFAULT_TEMPLATES;
    const settings = smsTransactionalService.getSettings();

    // Generate previews with sample data
    const sampleData = {
      customerName: 'John',
      orderNumber: '1234',
      orderTotal: '49.99',
      trackingNumber: 'USPS123456789',
      trackingUrl: 'https://track.usps.com/123456789',
      cancelReason: 'Customer requested cancellation'
    };

    const previews = {
      order_confirmation: {
        name: 'Order Confirmation',
        description: 'Sent when a new order is placed',
        preview: templates.order_confirmation(sampleData),
        template: settings.order_confirmation?.template || defaultTemplates.order_confirmation,
        isCustom: !!settings.order_confirmation?.template,
        length: templates.order_confirmation(sampleData).length
      },
      shipping_notification: {
        name: 'Shipping Notification',
        description: 'Sent when order ships with tracking',
        preview: templates.shipping_notification(sampleData),
        template: settings.shipping_notification?.template || defaultTemplates.shipping_notification,
        isCustom: !!settings.shipping_notification?.template,
        length: templates.shipping_notification(sampleData).length
      },
      delivery_confirmation: {
        name: 'Delivery Confirmation',
        description: 'Sent when package is delivered',
        preview: templates.delivery_confirmation(sampleData),
        template: settings.delivery_confirmation?.template || defaultTemplates.delivery_confirmation,
        isCustom: !!settings.delivery_confirmation?.template,
        length: templates.delivery_confirmation(sampleData).length
      },
      order_cancelled: {
        name: 'Order Cancelled',
        description: 'Sent when an order is cancelled',
        preview: templates.order_cancelled(sampleData),
        template: settings.order_cancelled?.template || defaultTemplates.order_cancelled,
        isCustom: !!settings.order_cancelled?.template,
        length: templates.order_cancelled(sampleData).length
      },
      delayed_shipment: {
        name: 'Delayed Shipment',
        description: 'Sent when order is unfulfilled for 72+ hours',
        preview: templates.delayed_shipment(sampleData),
        template: settings.delayed_shipment?.template || defaultTemplates.delayed_shipment,
        isCustom: !!settings.delayed_shipment?.template,
        length: templates.delayed_shipment(sampleData).length,
        delayHours: settings.delayed_shipment?.delayHours || 72
      }
    };

    res.json({
      success: true,
      templates: previews
    });

  } catch (error) {
    console.error('❌ Get Templates Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting templates'
    });
  }
};

// ==================== DELAYED SHIPMENT QUEUE ====================

/**
 * GET /api/sms/triggers/delayed-queue/status
 * Get delayed shipment job status and queue stats
 */
smsController.getDelayedQueueStatus = async (req, res) => {
  try {
    if (!delayedShipmentJob) {
      return res.status(503).json({
        success: false,
        error: 'Delayed shipment job not available'
      });
    }

    const status = await delayedShipmentJob.getStatus();

    res.json({
      success: true,
      ...status
    });

  } catch (error) {
    console.error('❌ Get Delayed Queue Status Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting queue status'
    });
  }
};

/**
 * GET /api/sms/triggers/delayed-queue/items
 * Get delayed shipment queue items
 */
smsController.getDelayedQueueItems = async (req, res) => {
  try {
    if (!delayedShipmentJob) {
      return res.status(503).json({
        success: false,
        error: 'Delayed shipment job not available'
      });
    }

    const { status = 'all', limit = 50, skip = 0 } = req.query;

    const result = await delayedShipmentJob.getQueueItems({
      status,
      limit: parseInt(limit),
      skip: parseInt(skip)
    });

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('❌ Get Delayed Queue Items Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting queue items'
    });
  }
};

/**
 * POST /api/sms/triggers/delayed-queue/sync
 * Manually sync orders to queue
 */
smsController.syncDelayedQueue = async (req, res) => {
  try {
    if (!delayedShipmentJob) {
      return res.status(503).json({
        success: false,
        error: 'Delayed shipment job not available'
      });
    }

    const result = await delayedShipmentJob.syncNow();

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('❌ Sync Delayed Queue Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error syncing queue'
    });
  }
};

/**
 * POST /api/sms/triggers/delayed-queue/run
 * Manually run the delayed shipment job
 */
smsController.runDelayedJob = async (req, res) => {
  try {
    if (!delayedShipmentJob) {
      return res.status(503).json({
        success: false,
        error: 'Delayed shipment job not available'
      });
    }

    const result = await delayedShipmentJob.runNow();

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('❌ Run Delayed Job Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error running job'
    });
  }
};

// ==================== 💬 CONVERSATIONS (MESSAGE HISTORY) ====================

/**
 * GET /api/sms/conversations
 * Get all SMS conversations (inbound + outbound)
 */
smsController.getConversations = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      direction = null,
      messageType = null,
      phone = null
    } = req.query;

    const result = await SmsConversation.getRecent({
      page: parseInt(page),
      limit: parseInt(limit),
      direction,
      messageType,
      phone
    });

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('❌ Get Conversations Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting conversations'
    });
  }
};

/**
 * GET /api/sms/conversations/stats
 * Get conversation stats (inbound vs outbound)
 */
smsController.getConversationStats = async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const stats = await SmsConversation.getStats(parseInt(days));

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('❌ Get Conversation Stats Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting stats'
    });
  }
};

/**
 * GET /api/sms/conversations/thread/:phone
 * Get conversation thread for a specific phone number
 */
smsController.getConversationThread = async (req, res) => {
  try {
    const { phone } = req.params;
    const { limit = 50 } = req.query;

    // Format phone number
    const formattedPhone = telnyxService.formatPhoneNumber(phone);
    if (!formattedPhone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number'
      });
    }

    const messages = await SmsConversation.getThread(formattedPhone, parseInt(limit));

    // Get subscriber info
    const subscriber = await SmsSubscriber.findOne({ phone: formattedPhone })
      .select('phone phoneFormatted firstName lastName status discountCode secondDiscountCode converted convertedWith')
      .lean();

    res.json({
      success: true,
      phone: formattedPhone,
      subscriber,
      messages,
      count: messages.length
    });

  } catch (error) {
    console.error('❌ Get Conversation Thread Error:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting thread'
    });
  }
};

module.exports = smsController;