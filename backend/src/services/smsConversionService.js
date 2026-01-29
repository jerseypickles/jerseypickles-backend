// backend/src/services/smsConversionService.js
// 📊 SMS Conversion Tracking Service
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

      // Find SMS discount codes (they start with JP-)
      const smsDiscountCodes = discountCodes.filter(dc => 
        dc.code && dc.code.toUpperCase().startsWith('JP-')
      );

      if (smsDiscountCodes.length === 0) {
        return { converted: false, reason: 'No SMS discount codes (JP-) found' };
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
   */
  async trackConversion(code, shopifyOrder) {
    try {
      const normalizedCode = code.toUpperCase().trim();
      
      // Find the SMS subscriber with this discount code
      const subscriber = await SmsSubscriber.findOne({ 
        discountCode: normalizedCode 
      });

      if (!subscriber) {
        console.log(`⚠️ No SMS subscriber found for code: ${normalizedCode}`);
        return { 
          success: false, 
          code: normalizedCode, 
          reason: 'Subscriber not found' 
        };
      }

      // Check if already converted (avoid duplicate tracking)
      if (subscriber.converted && subscriber.conversionData?.orderId) {
        console.log(`ℹ️ Subscriber already converted with order: ${subscriber.conversionData.orderId}`);
        return { 
          success: false, 
          code: normalizedCode, 
          reason: 'Already converted',
          existingOrderId: subscriber.conversionData.orderId
        };
      }

      // Calculate time to convert (minutes from SMS sent to order placed)
      let timeToConvert = null;
      if (subscriber.welcomeSmsSentAt) {
        const smsSentTime = new Date(subscriber.welcomeSmsSentAt);
        const orderTime = new Date(shopifyOrder.created_at);
        timeToConvert = Math.round((orderTime - smsSentTime) / (1000 * 60)); // minutes
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
        conversionData: {
          orderId: shopifyOrder.id?.toString(),
          orderNumber: shopifyOrder.order_number?.toString() || shopifyOrder.name,
          orderTotal: parseFloat(shopifyOrder.total_price),
          subtotal: parseFloat(shopifyOrder.subtotal_price || shopifyOrder.total_price),
          discountAmount: discountAmount,
          currency: shopifyOrder.currency || 'USD',
          convertedAt: new Date(shopifyOrder.created_at),
          timeToConvert: timeToConvert, // minutes
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

      console.log(`✅ SMS Conversion tracked!`);
      console.log(`   📱 Phone: ${subscriber.phone}`);
      console.log(`   🏷️ Code: ${normalizedCode}`);
      console.log(`   📦 Order: #${updateData.conversionData.orderNumber}`);
      console.log(`   💵 Total: $${updateData.conversionData.orderTotal}`);
      console.log(`   💰 Discount: $${discountAmount}`);
      console.log(`   ⏱️ Time to convert: ${timeToConvert ? timeToConvert + ' minutes' : 'N/A'}`);

      return {
        success: true,
        code: normalizedCode,
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
   * Get SMS conversion stats
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

      // Get revenue from conversions
      const revenueResult = await SmsSubscriber.aggregate([
        { $match: { ...query, converted: true } },
        { 
          $group: {
            _id: null,
            totalRevenue: { $sum: '$conversionData.orderTotal' },
            totalDiscount: { $sum: '$conversionData.discountAmount' },
            avgOrderValue: { $avg: '$conversionData.orderTotal' },
            avgTimeToConvert: { $avg: '$conversionData.timeToConvert' }
          }
        }
      ]);

      const revenue = revenueResult[0] || {
        totalRevenue: 0,
        totalDiscount: 0,
        avgOrderValue: 0,
        avgTimeToConvert: 0
      };

      // Get recent conversions
      const recentConversions = await SmsSubscriber.find({ 
        ...query, 
        converted: true 
      })
        .sort({ 'conversionData.convertedAt': -1 })
        .limit(10)
        .select('phone discountCode conversionData createdAt');

      // Calculate conversion rate
      const conversionRate = totalSubscribers > 0 
        ? ((convertedSubscribers / totalSubscribers) * 100).toFixed(2) 
        : 0;

      return {
        success: true,
        stats: {
          totalSubscribers,
          convertedSubscribers,
          conversionRate: `${conversionRate}%`,
          totalRevenue: revenue.totalRevenue?.toFixed(2) || '0.00',
          totalDiscountGiven: revenue.totalDiscount?.toFixed(2) || '0.00',
          avgOrderValue: revenue.avgOrderValue?.toFixed(2) || '0.00',
          avgTimeToConvertMinutes: Math.round(revenue.avgTimeToConvert) || 0,
          avgTimeToConvertFormatted: this.formatMinutes(revenue.avgTimeToConvert),
          roi: this.calculateROI(revenue.totalRevenue, revenue.totalDiscount)
        },
        recentConversions: recentConversions.map(s => ({
          phone: this.maskPhone(s.phone),
          code: s.discountCode,
          orderNumber: s.conversionData?.orderNumber,
          orderTotal: s.conversionData?.orderTotal,
          convertedAt: s.conversionData?.convertedAt,
          timeToConvert: this.formatMinutes(s.conversionData?.timeToConvert)
        }))
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
    if (!minutes || minutes <= 0) return 'N/A';
    
    if (minutes < 60) {
      return `${Math.round(minutes)} min`;
    } else if (minutes < 1440) {
      const hours = Math.floor(minutes / 60);
      const mins = Math.round(minutes % 60);
      return `${hours}h ${mins}m`;
    } else {
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      return `${days}d ${hours}h`;
    }
  }

  /**
   * Calculate ROI
   */
  calculateROI(revenue, discountGiven) {
    if (!revenue || revenue <= 0) return '0%';
    // ROI = (Revenue - Discount) / Discount * 100
    // Or simplified: how much revenue per dollar of discount
    if (!discountGiven || discountGiven <= 0) return 'Infinite';
    const roi = ((revenue - discountGiven) / discountGiven * 100).toFixed(0);
    return `${roi}%`;
  }

  /**
   * Mask phone for privacy
   */
  maskPhone(phone) {
    if (!phone) return 'N/A';
    // +1234567890 -> +1***...7890
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length >= 10) {
      return `+${cleaned.slice(0, 1)}***${cleaned.slice(-4)}`;
    }
    return phone;
  }

  /**
   * Get unconverted subscribers (for follow-up campaigns)
   */
  async getUnconvertedSubscribers(options = {}) {
    try {
      const {
        minDaysOld = 1,
        maxDaysOld = 30,
        limit = 100
      } = options;

      const now = new Date();
      const minDate = new Date(now - minDaysOld * 24 * 60 * 60 * 1000);
      const maxDate = new Date(now - maxDaysOld * 24 * 60 * 60 * 1000);

      const subscribers = await SmsSubscriber.find({
        converted: false,
        status: 'active',
        createdAt: { $lte: minDate, $gte: maxDate }
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('phone discountCode discountPercent createdAt welcomeSmsSentAt');

      return {
        success: true,
        count: subscribers.length,
        subscribers: subscribers.map(s => ({
          phone: s.phone,
          discountCode: s.discountCode,
          discountPercent: s.discountPercent,
          signedUpAt: s.createdAt,
          daysSinceSignup: Math.floor((now - s.createdAt) / (24 * 60 * 60 * 1000))
        }))
      };

    } catch (error) {
      console.error('❌ Error getting unconverted subscribers:', error);
      return { success: false, error: error.message };
    }
  }
}

// Singleton instance
const smsConversionService = new SmsConversionService();

module.exports = smsConversionService;