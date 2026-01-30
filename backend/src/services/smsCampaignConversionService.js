// backend/src/services/smsCampaignConversionService.js
// 📱 SMS Campaign Conversion Service
// Tracks conversions from SMS campaigns via discount codes and links
const SmsCampaign = require('../models/SmsCampaign');
const SmsMessage = require('../models/SmsMessage');
const SmsSubscriber = require('../models/SmsSubscriber');

const smsCampaignConversionService = {
  
  /**
   * Process order for SMS campaign conversion
   * Called from webhooksController when order is created
   * 
   * @param {Object} shopifyOrder - Shopify order data
   * @returns {Object} - Conversion result
   */
  async processOrderConversion(shopifyOrder) {
    const results = {
      campaignConversion: false,
      subscriberConversion: false,
      details: []
    };
    
    try {
      const discountCodes = shopifyOrder.discount_codes || [];
      
      if (discountCodes.length === 0) {
        return results;
      }
      
      for (const discount of discountCodes) {
        const code = discount.code?.toUpperCase();
        if (!code) continue;
        
        // ========== 1. Check for Campaign Discount Code ==========
        // Campaign codes might be different format (not JP-XXXXX)
        const campaign = await SmsCampaign.findOne({
          discountCode: code,
          status: 'sent'
        });
        
        if (campaign) {
          // Find the message sent to this customer
          const customerPhone = formatPhone(
            shopifyOrder.phone || 
            shopifyOrder.customer?.phone ||
            shopifyOrder.billing_address?.phone ||
            shopifyOrder.shipping_address?.phone
          );
          
          if (customerPhone) {
            const message = await SmsMessage.findOne({
              campaign: campaign._id,
              phone: customerPhone,
              converted: false
            });
            
            if (message) {
              await message.recordConversion({
                orderId: shopifyOrder.id?.toString(),
                orderNumber: shopifyOrder.order_number?.toString() || shopifyOrder.name,
                orderTotal: parseFloat(shopifyOrder.total_price || 0),
                discountAmount: parseFloat(discount.amount || 0)
              });
              
              results.campaignConversion = true;
              results.details.push({
                type: 'campaign',
                campaignId: campaign._id,
                campaignName: campaign.name,
                discountCode: code,
                revenue: parseFloat(shopifyOrder.total_price || 0)
              });
              
              console.log(`📱 SMS Campaign conversion: ${campaign.name} - Order #${shopifyOrder.order_number}`);
            }
          }
        }
        
        // ========== 2. Check for Subscriber Welcome Code (JP-XXXXX) ==========
        if (code.startsWith('JP-')) {
          const subscriber = await SmsSubscriber.findOne({
            discountCode: code,
            converted: false
          });
          
          if (subscriber) {
            // Calculate time to convert
            const timeToConvert = subscriber.welcomeSmsSentAt
              ? Math.round((Date.now() - subscriber.welcomeSmsSentAt.getTime()) / 60000)
              : null;
            
            // Build conversion data
            const conversionData = {
              orderId: shopifyOrder.id?.toString(),
              orderNumber: shopifyOrder.order_number?.toString() || shopifyOrder.name,
              orderTotal: parseFloat(shopifyOrder.total_price || 0),
              subtotal: parseFloat(shopifyOrder.subtotal_price || 0),
              discountAmount: parseFloat(discount.amount || 0),
              currency: shopifyOrder.currency || 'USD',
              convertedAt: new Date(),
              timeToConvert,
              itemCount: shopifyOrder.line_items?.length || 0,
              products: shopifyOrder.line_items?.slice(0, 10).map(item => ({
                productId: item.product_id?.toString(),
                variantId: item.variant_id?.toString(),
                title: item.title,
                quantity: item.quantity,
                price: parseFloat(item.price || 0)
              })),
              customerEmail: shopifyOrder.email || shopifyOrder.customer?.email,
              shippingAddress: shopifyOrder.shipping_address ? {
                city: shopifyOrder.shipping_address.city,
                province: shopifyOrder.shipping_address.province,
                country: shopifyOrder.shipping_address.country,
                zip: shopifyOrder.shipping_address.zip
              } : null
            };
            
            // Update subscriber
            subscriber.converted = true;
            subscriber.conversionData = conversionData;
            subscriber.lastEngagedAt = new Date();
            await subscriber.save();
            
            results.subscriberConversion = true;
            results.details.push({
              type: 'subscriber_welcome',
              subscriberId: subscriber._id,
              phone: subscriber.phone,
              discountCode: code,
              revenue: conversionData.orderTotal,
              timeToConvert: timeToConvert
            });
            
            console.log(`📱 SMS Welcome conversion: ${subscriber.phone} - $${conversionData.orderTotal} - ${formatTimeToConvert(timeToConvert)}`);
          }
        }
      }
      
      return results;
      
    } catch (error) {
      console.error('❌ SMS Conversion Error:', error);
      return { ...results, error: error.message };
    }
  },
  
  /**
   * Process Telnyx webhook for campaign messages
   * Updates SmsMessage status
   * 
   * @param {Object} webhookData - Processed Telnyx webhook data
   */
  async processTelnyxWebhook(webhookData) {
    try {
      if (!webhookData.messageId) return { processed: false };
      
      // Find the campaign message
      const message = await SmsMessage.findOne({ messageId: webhookData.messageId });
      
      if (!message) {
        // Not a campaign message - might be welcome SMS
        return { processed: false, reason: 'not_campaign_message' };
      }
      
      // Update message status
      await message.updateFromWebhook(webhookData);
      
      // Update campaign stats based on status
      if (webhookData.status === 'delivered') {
        await SmsCampaign.findByIdAndUpdate(message.campaign, {
          $inc: { 'stats.delivered': 1 }
        });
      }
      
      console.log(`📱 Campaign SMS status: ${message.phone} -> ${webhookData.status}`);
      
      return { processed: true, messageId: message._id };
      
    } catch (error) {
      console.error('❌ Process Telnyx Webhook Error:', error);
      return { processed: false, error: error.message };
    }
  },
  
  /**
   * Get conversion stats for all campaigns
   * @param {number} days - Days to look back
   */
  async getConversionStats(days = 30) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    // Campaign conversions
    const campaignStats = await SmsMessage.aggregate([
      {
        $match: {
          converted: true,
          convertedAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: '$campaign',
          conversions: { $sum: 1 },
          revenue: { $sum: '$conversionData.orderTotal' }
        }
      },
      {
        $lookup: {
          from: 'smscampaigns',
          localField: '_id',
          foreignField: '_id',
          as: 'campaign'
        }
      },
      { $unwind: '$campaign' },
      {
        $project: {
          campaignName: '$campaign.name',
          conversions: 1,
          revenue: 1
        }
      }
    ]);
    
    // Welcome SMS conversions
    const welcomeStats = await SmsSubscriber.aggregate([
      {
        $match: {
          converted: true,
          'conversionData.convertedAt': { $gte: startDate }
        }
      },
      {
        $group: {
          _id: null,
          conversions: { $sum: 1 },
          revenue: { $sum: '$conversionData.orderTotal' },
          avgTimeToConvert: { $avg: '$conversionData.timeToConvert' }
        }
      }
    ]);
    
    return {
      campaigns: campaignStats,
      welcomeSms: welcomeStats[0] || { conversions: 0, revenue: 0, avgTimeToConvert: 0 },
      period: `${days} days`
    };
  }
};

// ==================== HELPER FUNCTIONS ====================

function formatPhone(phone) {
  if (!phone) return null;
  
  let cleaned = phone.toString().replace(/\D/g, '');
  
  if (cleaned.startsWith('1') && cleaned.length === 11) {
    return '+' + cleaned;
  }
  
  if (cleaned.length === 10) {
    return '+1' + cleaned;
  }
  
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  
  return null;
}

function formatTimeToConvert(minutes) {
  if (!minutes) return 'N/A';
  
  if (minutes < 60) {
    return `${minutes} min`;
  } else if (minutes < 1440) {
    return `${Math.round(minutes / 60)} hours`;
  } else {
    return `${Math.round(minutes / 1440)} days`;
  }
}

module.exports = smsCampaignConversionService;