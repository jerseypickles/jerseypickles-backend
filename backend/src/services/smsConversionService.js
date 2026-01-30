// backend/src/services/smsConversionService.js
// 📊 SMS Conversion Tracking Service - Con First vs Second SMS Detection
// Tracks when customers use their SMS discount codes

const SmsSubscriber = require('../models/SmsSubscriber');

class SmsConversionService {
  
  /**
   * Process an order to check for SMS discount code usage
   * Call this from your orders/create webhook
   * 
   * @param {object} shopifyOrder - The Shopify order object from webhook
   * @returns {object} - Conversion result
   */
  async processOrderConversion(shopifyOrder) {
    try {
      // Extract discount codes from the order
      const discountCodes = shopifyOrder.discount_codes || [];
      
      if (discountCodes.length === 0) {
        return { converted: false, reason: 'No discount codes used' };
      }

      // Find SMS discount codes (JP- for first, JP2- for second)
      const smsDiscountCodes = discountCodes.filter(dc => 
        dc.code && (
          dc.code.toUpperCase().startsWith('JP-') || 
          dc.code.toUpperCase().startsWith('JP2-')
        )
      );

      if (smsDiscountCodes.length === 0) {
        return { converted: false, reason: 'No SMS discount codes (JP- or JP2-) found' };
      }

      console.log(`🎯 SMS Discount Code detected in order #${shopifyOrder.order_number}:`, 
        smsDiscountCodes.map(dc => dc.code).join(', '));

      const results = [];

      // Process each SMS discount code
      for (const discountCode of smsDiscountCodes) {
        const result = await this.trackConversion(discountCode.code, shopifyOrder);
        results.push(result);
      }

      // Return summary
      const successfulConversions = results.filter(r => r.success);
      
      return {
        converted: successfulConversions.length > 0,
        codesProcessed: results.length,
        successfulConversions: successfulConversions.length,
        results
      };

    } catch (error) {
      console.error('❌ SMS Conversion tracking error:', error);
      return { 
        converted: false, 
        error: error.message 
      };
    }
  }

  /**
   * Track a single discount code conversion
   * Detects if it's first (JP-) or second (JP2-) code
   */
  async trackConversion(code, shopifyOrder) {
    try {
      const normalizedCode = code.toUpperCase().trim();
      
      // Determine if it's first or second code
      const isSecondCode = normalizedCode.startsWith('JP2-');
      const codeType = isSecondCode ? 'second' : 'first';
      
      // Find the SMS subscriber with this discount code
      let subscriber;
      
      if (isSecondCode) {
        // Search in secondDiscountCode field
        subscriber = await SmsSubscriber.findOne({ 
          secondDiscountCode: normalizedCode 
        });
      } else {
        // Search in discountCode field (first code)
        subscriber = await SmsSubscriber.findOne({ 
          discountCode: normalizedCode 
        });
      }

      if (!subscriber) {
        console.log(`⚠️ No SMS subscriber found for code: ${normalizedCode}`);
        return { 
          success: false, 
          code: normalizedCode, 
          codeType,
          reason: 'Subscriber not found' 
        };
      }

      // Check if already converted (avoid duplicate tracking)
      if (subscriber.converted && subscriber.conversionData?.orderId) {
        console.log(`ℹ️ Subscriber already converted with order: ${subscriber.conversionData.orderId}`);
        return { 
          success: false, 
          code: normalizedCode,
          codeType,
          reason: 'Already converted',
          existingOrderId: subscriber.conversionData.orderId
        };
      }

      // 🆕 Check if second code has expired
      if (isSecondCode && subscriber.secondDiscountExpiresAt) {
        if (new Date() > new Date(subscriber.secondDiscountExpiresAt)) {
          console.log(`⚠️ Second discount code expired: ${normalizedCode}`);
          // Note: Shopify should also reject expired codes, but we log it here
        }
      }

      // Calculate time to convert (minutes from SMS sent to order placed)
      let timeToConvert = null;
      
      // Para second code usa secondSmsAt, para first code busca en welcomeSmsAt O welcomeSmsSentAt (legacy)
      let smsSentTime;
      if (isSecondCode) {
        smsSentTime = subscriber.secondSmsAt;
      } else {
        smsSentTime = subscriber.welcomeSmsAt || subscriber.welcomeSmsSentAt;
      }
      
      if (smsSentTime) {
        const orderTime = new Date(shopifyOrder.created_at);
        timeToConvert = Math.round((orderTime - new Date(smsSentTime)) / (1000 * 60)); // minutes
      } else if (subscriber.createdAt) {
        // Fallback: usar fecha de creación del subscriber si no hay fecha de SMS
        const orderTime = new Date(shopifyOrder.created_at);
        timeToConvert = Math.round((orderTime - new Date(subscriber.createdAt)) / (1000 * 60));
      }

      // Calculate discount amount
      const discountInfo = shopifyOrder.discount_codes.find(
        dc => dc.code.toUpperCase() === normalizedCode
      );
      const discountAmount = discountInfo ? parseFloat(discountInfo.amount) : 0;

      // Extract product info
      const products = (shopifyOrder.line_items || []).map(item => ({
        productId: item.product_id?.toString(),
        variantId: item.variant_id?.toString(),
        title: item.title,
        quantity: item.quantity,
        price: parseFloat(item.price)
      }));

      // Update subscriber with conversion data
      const updateData = {
        converted: true,
        convertedWith: codeType, // 🆕 'first' or 'second'
        convertedAt: new Date(shopifyOrder.created_at),
        timeToConvert: timeToConvert,
        conversionData: {
          orderId: shopifyOrder.id?.toString(),
          orderNumber: shopifyOrder.order_number?.toString() || shopifyOrder.name,
          orderTotal: parseFloat(shopifyOrder.total_price),
          subtotal: parseFloat(shopifyOrder.subtotal_price || shopifyOrder.total_price),
          discountAmount: discountAmount,
          discountCodeUsed: normalizedCode, // 🆕 Track which code was used
          currency: shopifyOrder.currency || 'USD',
          convertedAt: new Date(shopifyOrder.created_at),
          timeToConvert: timeToConvert,
          products: products,
          itemCount: products.reduce((sum, p) => sum + p.quantity, 0),
          customerEmail: shopifyOrder.email,
          shippingAddress: shopifyOrder.shipping_address ? {
            city: shopifyOrder.shipping_address.city,
            province: shopifyOrder.shipping_address.province,
            country: shopifyOrder.shipping_address.country,
            zip: shopifyOrder.shipping_address.zip
          } : null
        }
      };

      await SmsSubscriber.findByIdAndUpdate(subscriber._id, updateData);

      // 🆕 Log with conversion type
      const conversionLabel = isSecondCode ? '🟣 RECOVERED (20%)' : '🟢 CONVERTED (15%)';
      console.log(`✅ SMS Conversion tracked! ${conversionLabel}`);
      console.log(`   📱 Phone: ${subscriber.phone}`);
      console.log(`   🏷️ Code: ${normalizedCode} (${codeType})`);
      console.log(`   📦 Order: #${updateData.conversionData.orderNumber}`);
      console.log(`   💵 Total: $${updateData.conversionData.orderTotal}`);
      console.log(`   💰 Discount: $${discountAmount}`);
      console.log(`   ⏱️ Time to convert: ${timeToConvert ? timeToConvert + ' minutes' : 'N/A'}`);

      return {
        success: true,
        code: normalizedCode,
        codeType, // 🆕 'first' or 'second'
        convertedWith: codeType,
        subscriberId: subscriber._id,
        phone: subscriber.phone,
        orderNumber: updateData.conversionData.orderNumber,
        orderTotal: updateData.conversionData.orderTotal,
        discountAmount: discountAmount,
        timeToConvert: timeToConvert
      };

    } catch (error) {
      console.error(`❌ Error tracking conversion for code ${code}:`, error);
      return { 
        success: false, 
        code, 
        error: error.message 
      };
    }
  }

  /**
   * Get SMS conversion stats with first vs second breakdown
   */
  async getConversionStats(dateRange = {}) {
    try {
      const query = {};
      
      if (dateRange.from || dateRange.to) {
        query.createdAt = {};
        if (dateRange.from) query.createdAt.$gte = new Date(dateRange.from);
        if (dateRange.to) query.createdAt.$lte = new Date(dateRange.to);
      }

      const totalSubscribers = await SmsSubscriber.countDocuments(query);
      const convertedSubscribers = await SmsSubscriber.countDocuments({ 
        ...query, 
        converted: true 
      });

      // Breakdown by conversion type
      // FIRST = convertedWith es 'first' O convertedWith no existe/null (datos legacy)
      const convertedFirst = await SmsSubscriber.countDocuments({
        ...query,
        converted: true,
        $or: [
          { convertedWith: 'first' },
          { convertedWith: { $exists: false } },
          { convertedWith: null }
        ]
      });
      
      const convertedSecond = await SmsSubscriber.countDocuments({
        ...query,
        converted: true,
        convertedWith: 'second'
      });

      // Get revenue from conversions with breakdown
      // Usar $ifNull para tratar null/undefined como 'first' (legacy)
      const revenueResult = await SmsSubscriber.aggregate([
        { $match: { ...query, converted: true } },
        { 
          $group: {
            _id: { 
              $ifNull: ['$convertedWith', 'first'] // Legacy data sin convertedWith = first
            },
            totalRevenue: { $sum: '$conversionData.orderTotal' },
            totalDiscount: { $sum: '$conversionData.discountAmount' },
            avgOrderValue: { $avg: '$conversionData.orderTotal' },
            avgTimeToConvert: { $avg: '$conversionData.timeToConvert' },
            count: { $sum: 1 }
          }
        }
      ]);

      // Parse revenue by type
      const revenueByType = {
        first: { totalRevenue: 0, totalDiscount: 0, avgOrderValue: 0, avgTimeToConvert: 0, count: 0 },
        second: { totalRevenue: 0, totalDiscount: 0, avgOrderValue: 0, avgTimeToConvert: 0, count: 0 }
      };
      
      revenueResult.forEach(r => {
        if (r._id === 'first' || r._id === 'second') {
          revenueByType[r._id] = r;
        }
      });

      const totalRevenue = revenueByType.first.totalRevenue + revenueByType.second.totalRevenue;
      const totalDiscount = revenueByType.first.totalDiscount + revenueByType.second.totalDiscount;

      // Get recent conversions with type
      const recentConversions = await SmsSubscriber.find({ 
        ...query, 
        converted: true 
      })
        .sort({ 'conversionData.convertedAt': -1, 'convertedAt': -1 })
        .limit(20)
        .select('phone discountCode secondDiscountCode convertedWith convertedAt timeToConvert conversionData createdAt welcomeSmsAt welcomeSmsSentAt secondSmsAt');

      // Calculate conversion rate
      const conversionRate = totalSubscribers > 0 
        ? ((convertedSubscribers / totalSubscribers) * 100).toFixed(2) 
        : 0;

      // 🆕 Get second SMS stats
      const secondSmsSent = await SmsSubscriber.countDocuments({
        ...query,
        secondSmsSent: true
      });
      
      const secondSmsDelivered = await SmsSubscriber.countDocuments({
        ...query,
        secondSmsStatus: 'delivered'
      });

      return {
        success: true,
        stats: {
          totalSubscribers,
          convertedSubscribers,
          conversionRate: `${conversionRate}%`,
          
          // 🆕 Breakdown
          conversions: {
            total: convertedSubscribers,
            first: convertedFirst,
            second: convertedSecond
          },
          
          // 🆕 Revenue breakdown
          revenue: {
            total: totalRevenue?.toFixed(2) || '0.00',
            first: revenueByType.first.totalRevenue?.toFixed(2) || '0.00',
            second: revenueByType.second.totalRevenue?.toFixed(2) || '0.00'
          },
          
          totalDiscountGiven: totalDiscount?.toFixed(2) || '0.00',
          
          // 🆕 Avg values by type
          avgOrderValue: {
            overall: ((revenueByType.first.avgOrderValue + revenueByType.second.avgOrderValue) / 2)?.toFixed(2) || '0.00',
            first: revenueByType.first.avgOrderValue?.toFixed(2) || '0.00',
            second: revenueByType.second.avgOrderValue?.toFixed(2) || '0.00'
          },
          
          avgTimeToConvert: {
            first: this.formatMinutes(revenueByType.first.avgTimeToConvert),
            second: this.formatMinutes(revenueByType.second.avgTimeToConvert)
          },
          
          // 🆕 Second SMS stats
          secondSms: {
            sent: secondSmsSent,
            delivered: secondSmsDelivered,
            converted: convertedSecond,
            recoveryRate: secondSmsDelivered > 0 
              ? ((convertedSecond / secondSmsDelivered) * 100).toFixed(1) + '%'
              : '0%'
          },
          
          roi: this.calculateROI(totalRevenue, totalDiscount)
        },
        recentConversions: recentConversions.map(s => {
          // Determinar el código usado - prioridad: discountCodeUsed > secondDiscountCode (si es second) > discountCode
          let usedCode = s.conversionData?.discountCodeUsed;
          if (!usedCode) {
            usedCode = s.convertedWith === 'second' ? s.secondDiscountCode : s.discountCode;
          }
          
          // Obtener timeToConvert de múltiples fuentes o calcularlo
          let ttc = s.timeToConvert || s.conversionData?.timeToConvert;
          
          // Si no hay timeToConvert guardado, calcularlo
          if (ttc === null || ttc === undefined) {
            const convertedAt = s.conversionData?.convertedAt || s.convertedAt;
            
            // Primero intentar con fecha de SMS
            let startTime;
            if (s.convertedWith === 'second' && s.secondSmsAt) {
              startTime = new Date(s.secondSmsAt);
            } else if (s.welcomeSmsAt || s.welcomeSmsSentAt) {
              startTime = new Date(s.welcomeSmsAt || s.welcomeSmsSentAt);
            } else if (s.createdAt) {
              // Fallback: usar fecha de creación
              startTime = new Date(s.createdAt);
            }
            
            if (startTime && convertedAt) {
              const endTime = new Date(convertedAt);
              ttc = Math.round((endTime - startTime) / (1000 * 60)); // minutos
            }
          }
          
          return {
            phone: this.maskPhone(s.phone),
            code: usedCode || s.discountCode || '-',
            discountCode: usedCode || s.discountCode || '-',
            // Legacy data (sin convertedWith) se considera 'first'
            convertedWith: s.convertedWith || 'first',
            orderNumber: s.conversionData?.orderNumber,
            orderTotal: s.conversionData?.orderTotal,
            convertedAt: s.conversionData?.convertedAt || s.convertedAt,
            timeToConvert: this.formatMinutes(ttc)
          };
        })
      };

    } catch (error) {
      console.error('❌ Error getting conversion stats:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Format minutes to human readable
   */
  formatMinutes(minutes) {
    // Handle null, undefined, empty string, NaN
    if (minutes === null || minutes === undefined || minutes === '') return '-';
    
    const mins = Number(minutes);
    if (isNaN(mins) || mins < 0) return '-';
    
    if (mins < 60) {
      return `${Math.round(mins)} min`;
    } else if (mins < 1440) {
      const hours = Math.floor(mins / 60);
      const remainingMins = Math.round(mins % 60);
      return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
    } else {
      const days = Math.floor(mins / 1440);
      const hours = Math.floor((mins % 1440) / 60);
      return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
  }

  /**
   * Calculate ROI
   */
  calculateROI(revenue, discountGiven) {
    if (!revenue || revenue <= 0) return '0%';
    if (!discountGiven || discountGiven <= 0) return 'Infinite';
    const roi = ((revenue - discountGiven) / discountGiven * 100).toFixed(0);
    return `${roi}%`;
  }

  /**
   * Mask phone for privacy
   */
  maskPhone(phone) {
    if (!phone) return 'N/A';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length >= 10) {
      return `+${cleaned.slice(0, 1)}***${cleaned.slice(-4)}`;
    }
    return phone;
  }

  /**
   * Get unconverted subscribers eligible for second chance SMS
   */
  async getUnconvertedForSecondChance(options = {}) {
    try {
      const {
        minHoursOld = 6,
        maxHoursOld = 8,
        limit = 50
      } = options;

      const now = new Date();
      const minDate = new Date(now - minHoursOld * 60 * 60 * 1000);
      const maxDate = new Date(now - maxHoursOld * 60 * 60 * 1000);

      const subscribers = await SmsSubscriber.find({
        converted: false,
        status: 'active',
        secondSmsSent: { $ne: true }, // Haven't received second SMS
        welcomeSmsStatus: 'delivered', // First SMS was delivered
        welcomeSmsAt: { $lte: minDate, $gte: maxDate }
      })
        .sort({ welcomeSmsAt: 1 }) // Oldest first
        .limit(limit)
        .select('phone discountCode discountPercent createdAt welcomeSmsAt');

      return {
        success: true,
        count: subscribers.length,
        subscribers: subscribers.map(s => ({
          _id: s._id,
          phone: s.phone,
          discountCode: s.discountCode,
          discountPercent: s.discountPercent,
          signedUpAt: s.createdAt,
          welcomeSmsAt: s.welcomeSmsAt,
          hoursSinceFirstSms: Math.round((now - s.welcomeSmsAt) / (60 * 60 * 1000))
        }))
      };

    } catch (error) {
      console.error('❌ Error getting unconverted subscribers:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get conversion breakdown stats (for dashboard)
   */
  async getConversionBreakdown() {
    try {
      const stats = await SmsSubscriber.aggregate([
        {
          $facet: {
            total: [{ $count: 'count' }],
            active: [{ $match: { status: 'active' } }, { $count: 'count' }],
            
            // First SMS stats
            firstSmsDelivered: [
              { $match: { welcomeSmsStatus: 'delivered' } },
              { $count: 'count' }
            ],
            
            // Second SMS stats
            secondSmsSent: [
              { $match: { secondSmsSent: true } },
              { $count: 'count' }
            ],
            secondSmsDelivered: [
              { $match: { secondSmsStatus: 'delivered' } },
              { $count: 'count' }
            ],
            pendingSecondSms: [
              { 
                $match: { 
                  status: 'active',
                  converted: false, 
                  secondSmsSent: { $ne: true },
                  welcomeSmsStatus: 'delivered'
                } 
              },
              { $count: 'count' }
            ],
            
            // Conversion breakdown
            // First = convertedWith es 'first' O converted es true pero convertedWith no existe (legacy)
            convertedFirst: [
              { 
                $match: { 
                  converted: true, 
                  $or: [
                    { convertedWith: 'first' },
                    { convertedWith: { $exists: false } },
                    { convertedWith: null }
                  ]
                } 
              },
              { $count: 'count' }
            ],
            convertedSecond: [
              { $match: { converted: true, convertedWith: 'second' } },
              { $count: 'count' }
            ],
            totalConverted: [
              { $match: { converted: true } },
              { $count: 'count' }
            ],
            
            // Revenue breakdown - incluir legacy en first
            revenueFirst: [
              { 
                $match: { 
                  converted: true, 
                  $or: [
                    { convertedWith: 'first' },
                    { convertedWith: { $exists: false } },
                    { convertedWith: null }
                  ]
                } 
              },
              { $group: { _id: null, total: { $sum: '$conversionData.orderTotal' } } }
            ],
            revenueSecond: [
              { $match: { converted: true, convertedWith: 'second' } },
              { $group: { _id: null, total: { $sum: '$conversionData.orderTotal' } } }
            ],
            
            // No conversion after both SMS
            noConversion: [
              { 
                $match: { 
                  converted: false, 
                  secondSmsSent: true,
                  secondSmsStatus: 'delivered'
                } 
              },
              { $count: 'count' }
            ]
          }
        }
      ]);
      
      const s = stats[0];
      
      return {
        total: s.total[0]?.count || 0,
        active: s.active[0]?.count || 0,
        
        firstSms: {
          delivered: s.firstSmsDelivered[0]?.count || 0
        },
        
        secondSms: {
          sent: s.secondSmsSent[0]?.count || 0,
          delivered: s.secondSmsDelivered[0]?.count || 0,
          pending: s.pendingSecondSms[0]?.count || 0
        },
        
        conversions: {
          total: s.totalConverted[0]?.count || 0,
          first: s.convertedFirst[0]?.count || 0,
          second: s.convertedSecond[0]?.count || 0,
          none: s.noConversion[0]?.count || 0
        },
        
        revenue: {
          total: (s.revenueFirst[0]?.total || 0) + (s.revenueSecond[0]?.total || 0),
          first: s.revenueFirst[0]?.total || 0,
          second: s.revenueSecond[0]?.total || 0
        }
      };

    } catch (error) {
      console.error('❌ Error getting conversion breakdown:', error);
      return null;
    }
  }
}

// Singleton instance
const smsConversionService = new SmsConversionService();

module.exports = smsConversionService;