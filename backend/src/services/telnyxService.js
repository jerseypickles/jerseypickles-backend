// backend/src/services/telnyxService.js
const axios = require('axios');

class TelnyxService {
  constructor() {
    this.apiKey = process.env.TELNYX_API_KEY;
    this.messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
    this.fromNumber = process.env.TELNYX_FROM_NUMBER; // +1XXXXXXXXXX
    this.webhookUrl = process.env.TELNYX_WEBHOOK_URL; // https://jerseypickles-backend.onrender.com/api/webhooks/telnyx
    
    this.baseUrl = 'https://api.telnyx.com/v2';
    
    this.axios = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  // ==================== SEND SMS ====================
  
  /**
   * Send an SMS
   * @param {string} to - Destination number in E.164 format (+1XXXXXXXXXX)
   * @param {string} text - Message content
   * @param {object} options - Additional options
   * @returns {object} - Telnyx response
   */
  async sendSms(to, text, options = {}) {
    try {
      // Validate number
      const formattedTo = this.formatPhoneNumber(to);
      if (!formattedTo) {
        throw new Error('Invalid phone number format');
      }

      const payload = {
        from: this.fromNumber,
        to: formattedTo,
        text: text,
        messaging_profile_id: this.messagingProfileId,
        webhook_url: this.webhookUrl,
        webhook_failover_url: this.webhookUrl
      };

      // Add extra options if they exist
      if (options.mediaUrls) {
        payload.media_urls = options.mediaUrls;
        payload.type = 'MMS';
      }

      console.log(`📱 Sending SMS to ${formattedTo}`);
      
      const response = await this.axios.post('/messages', payload);
      
      const data = response.data?.data;
      
      console.log(`✅ SMS queued - ID: ${data?.id}, Status: ${data?.to?.[0]?.status}`);
      
      return {
        success: true,
        messageId: data?.id,
        status: data?.to?.[0]?.status || 'queued',
        cost: data?.cost?.amount ? parseFloat(data.cost.amount) : null,
        carrier: data?.to?.[0]?.carrier,
        lineType: data?.to?.[0]?.line_type,
        parts: data?.parts || 1,
        encoding: data?.encoding
      };
      
    } catch (error) {
      console.error('❌ Telnyx SMS Error:', error.response?.data || error.message);
      
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.detail || error.message,
        errorCode: error.response?.data?.errors?.[0]?.code
      };
    }
  }

  // ==================== SMS TEMPLATES ====================
  
  /**
   * Send welcome SMS with discount code
   */
  async sendWelcomeSms(to, discountCode, discountPercent = 15) {
    const text = `🥒 Jersey Pickles: Thanks for joining our VIP Text Club! Your exclusive code: ${discountCode} for ${discountPercent}% OFF your order. Shop now: jerseypickles.com - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'welcome' });
  }

  /**
   * Send abandoned cart SMS
   */
  async sendAbandonedCartSms(to, cartValue, discountCode) {
    const text = `🥒 Jersey Pickles: Your $${cartValue.toFixed(2)} cart is waiting! Use code ${discountCode} to complete your order with a special discount. Shop: jerseypickles.com/cart - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'abandoned_cart' });
  }

  /**
   * Send promotional SMS
   */
  async sendPromoSms(to, message) {
    const text = `🥒 Jersey Pickles: ${message} - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'promo' });
  }

  /**
   * Send order confirmation SMS
   */
  async sendOrderConfirmationSms(to, orderNumber, orderTotal) {
    const text = `🥒 Jersey Pickles: Thanks for your order #${orderNumber}! Total: $${orderTotal.toFixed(2)}. We'll notify you when it ships. Questions? Reply to this text! - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'order_update' });
  }

  /**
   * Send shipping notification SMS
   */
  async sendShippingNotificationSms(to, orderNumber, trackingUrl) {
    const text = `🥒 Jersey Pickles: Great news! Order #${orderNumber} has shipped! Track it here: ${trackingUrl} - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'order_update' });
  }

  /**
   * Send back in stock SMS
   */
  async sendBackInStockSms(to, productName) {
    const text = `🥒 Jersey Pickles: ${productName} is back in stock! Get yours before it sells out again: jerseypickles.com - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'promo' });
  }

  // ==================== NUMBER VERIFICATION ====================
  
  /**
   * Number lookup to validate and get carrier info
   */
  async lookupNumber(phoneNumber) {
    try {
      const formattedNumber = this.formatPhoneNumber(phoneNumber);
      if (!formattedNumber) {
        return { valid: false, error: 'Invalid format' };
      }

      const response = await this.axios.get(`/number_lookup/${formattedNumber}`);
      const data = response.data?.data;

      return {
        valid: true,
        phoneNumber: data?.phone_number,
        carrier: data?.carrier?.name,
        lineType: data?.carrier?.type, // mobile, landline, voip
        countryCode: data?.country_code,
        nationalFormat: data?.national_format
      };

    } catch (error) {
      console.error('❌ Number lookup error:', error.response?.data || error.message);
      return {
        valid: false,
        error: error.response?.data?.errors?.[0]?.detail || error.message
      };
    }
  }

  // ==================== GET MESSAGE STATUS ====================
  
  /**
   * Get current status of a message
   */
  async getMessageStatus(messageId) {
    try {
      const response = await this.axios.get(`/messages/${messageId}`);
      const data = response.data?.data;

      return {
        success: true,
        id: data?.id,
        status: data?.to?.[0]?.status,
        direction: data?.direction,
        from: data?.from?.phone_number,
        to: data?.to?.[0]?.phone_number,
        text: data?.text,
        cost: data?.cost?.amount ? parseFloat(data.cost.amount) : null,
        sentAt: data?.sent_at,
        completedAt: data?.completed_at,
        errors: data?.errors || []
      };

    } catch (error) {
      console.error('❌ Get message error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.detail || error.message
      };
    }
  }

  // ==================== PROCESS WEBHOOK ====================
  
  /**
   * Process Telnyx webhooks
   * @param {object} payload - Webhook body
   * @returns {object} - Processed data
   */
  processWebhook(payload) {
    const data = payload?.data;
    
    if (!data) {
      return { valid: false, error: 'Invalid webhook payload' };
    }

    const eventType = data.event_type;
    const messageData = data.payload;

    // Events we care about
    const relevantEvents = [
      'message.sent',
      'message.finalized',
      'message.received'
    ];

    if (!relevantEvents.includes(eventType)) {
      return { valid: true, ignored: true, eventType };
    }

    const result = {
      valid: true,
      eventType,
      messageId: messageData?.id,
      direction: messageData?.direction, // inbound / outbound
      from: messageData?.from?.phone_number,
      to: messageData?.to?.[0]?.phone_number,
      status: messageData?.to?.[0]?.status,
      text: messageData?.text,
      cost: messageData?.cost?.amount ? parseFloat(messageData.cost.amount) : null,
      carrier: messageData?.to?.[0]?.carrier || messageData?.from?.carrier,
      lineType: messageData?.to?.[0]?.line_type || messageData?.from?.line_type,
      sentAt: messageData?.sent_at,
      completedAt: messageData?.completed_at,
      errors: messageData?.errors || []
    };

    // Handle inbound message (e.g., STOP for unsubscribe)
    if (eventType === 'message.received') {
      result.isInbound = true;
      result.fromPhone = messageData?.from?.phone_number;
      result.toPhone = messageData?.to?.[0]?.phone_number;
      
      // Detect opt-out
      const text = (messageData?.text || '').toLowerCase().trim();
      const optOutKeywords = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];
      result.isOptOut = optOutKeywords.includes(text);
      
      // Detect help request
      const helpKeywords = ['help', 'info'];
      result.isHelpRequest = helpKeywords.includes(text);
    }

    return result;
  }

  // ==================== UTILITIES ====================
  
  /**
   * Format number to E.164
   */
  formatPhoneNumber(phone) {
    if (!phone) return null;
    
    // Clean everything except numbers and +
    let cleaned = phone.toString().replace(/[^\d+]/g, '');
    
    // If it already has +1, it's good
    if (cleaned.startsWith('+1') && cleaned.length === 12) {
      return cleaned;
    }
    
    // If it has +, verify format
    if (cleaned.startsWith('+')) {
      return cleaned.length >= 11 ? cleaned : null;
    }
    
    // If it starts with 1 and has 11 digits
    if (cleaned.startsWith('1') && cleaned.length === 11) {
      return '+' + cleaned;
    }
    
    // If it has 10 digits (USA without country code)
    if (cleaned.length === 10) {
      return '+1' + cleaned;
    }
    
    return null;
  }

  /**
   * Format number for display
   */
  formatForDisplay(phone) {
    const cleaned = this.formatPhoneNumber(phone);
    if (!cleaned) return phone;
    
    // +1 (908) 555-1234
    const match = cleaned.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
    if (match) {
      return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
    }
    
    return cleaned;
  }

  /**
   * Validate if it's a mobile number (basic)
   */
  isValidMobileNumber(phone) {
    const formatted = this.formatPhoneNumber(phone);
    return formatted && formatted.length === 12;
  }

  // ==================== BULK SEND (for campaigns) ====================
  
  /**
   * Send SMS in bulk with rate limiting
   */
  async sendBulkSms(recipients, text, options = {}) {
    const results = {
      total: recipients.length,
      sent: 0,
      failed: 0,
      errors: []
    };

    const delay = options.delayMs || 100; // 100ms between messages = 10/sec

    for (const recipient of recipients) {
      try {
        const result = await this.sendSms(recipient.phone, text);
        
        if (result.success) {
          results.sent++;
          recipient.messageId = result.messageId;
          recipient.status = 'sent';
        } else {
          results.failed++;
          recipient.status = 'failed';
          recipient.error = result.error;
          results.errors.push({ phone: recipient.phone, error: result.error });
        }

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, delay));
        
      } catch (error) {
        results.failed++;
        recipient.status = 'failed';
        recipient.error = error.message;
        results.errors.push({ phone: recipient.phone, error: error.message });
      }
    }

    return results;
  }

  // ==================== AUTO RESPONSES ====================
  
  /**
   * Send STOP confirmation (required by 10DLC)
   */
  async sendStopConfirmation(to) {
    const text = `Jersey Pickles: You have been unsubscribed and will no longer receive messages from us. Reply START to resubscribe.`;
    
    return this.sendSms(to, text, { type: 'system' });
  }

  /**
   * Send HELP response (required by 10DLC)
   */
  async sendHelpResponse(to) {
    const text = `Jersey Pickles: For help, contact support@jerseypickles.com or call (551) 400-9394. Msg&data rates may apply. Reply STOP to opt out.`;
    
    return this.sendSms(to, text, { type: 'system' });
  }

  /**
   * Send START confirmation (resubscribe)
   */
  async sendStartConfirmation(to) {
    const text = `🥒 Jersey Pickles: Welcome back! You're now subscribed to our VIP Text Club. Reply STOP to opt out anytime.`;
    
    return this.sendSms(to, text, { type: 'system' });
  }

  // ==================== HEALTH CHECK ====================
  
  async healthCheck() {
    try {
      // Verify we can make requests
      const response = await this.axios.get('/messaging_profiles');
      
      return {
        healthy: true,
        profilesCount: response.data?.data?.length || 0,
        apiKey: this.apiKey ? '✅ Configured' : '❌ Missing',
        fromNumber: this.fromNumber || '❌ Missing',
        messagingProfileId: this.messagingProfileId || '❌ Missing'
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.response?.data?.errors?.[0]?.detail || error.message
      };
    }
  }
}

// Singleton instance
const telnyxService = new TelnyxService();

module.exports = telnyxService;