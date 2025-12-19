// backend/src/services/telnyxService.js
const axios = require('axios');

class TelnyxService {
  constructor() {
    this.apiKey = process.env.TELNYX_API_KEY;
    this.messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
    this.fromNumber = process.env.TELNYX_FROM_NUMBER; // +1XXXXXXXXXX
    this.webhookUrl = process.env.TELNYX_WEBHOOK_URL; // https://tubackend.com/api/webhooks/telnyx
    
    this.baseUrl = 'https://api.telnyx.com/v2';
    
    this.axios = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  // ==================== ENVIAR SMS ====================
  
  /**
   * Envía un SMS
   * @param {string} to - Número destino en formato E.164 (+1XXXXXXXXXX)
   * @param {string} text - Contenido del mensaje
   * @param {object} options - Opciones adicionales
   * @returns {object} - Respuesta de Telnyx
   */
  async sendSms(to, text, options = {}) {
    try {
      // Validar número
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

      // Agregar opciones extras si existen
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
   * Envía SMS de bienvenida con código de descuento
   */
  async sendWelcomeSms(to, discountCode, discountPercent = 15) {
    const text = `🥒 Jersey Pickles: Gracias por suscribirte! Tu código exclusivo: ${discountCode} para ${discountPercent}% OFF. Úsalo en jerseypickles.com - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'welcome' });
  }

  /**
   * Envía SMS de abandoned cart
   */
  async sendAbandonedCartSms(to, cartValue, discountCode) {
    const text = `🥒 Jersey Pickles: Tu carrito de $${cartValue.toFixed(2)} te espera! Usa ${discountCode} para completar tu pedido con descuento. jerseypickles.com/cart - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'abandoned_cart' });
  }

  /**
   * Envía SMS promocional
   */
  async sendPromoSms(to, message) {
    const text = `🥒 Jersey Pickles: ${message} - Reply STOP to opt out`;
    
    return this.sendSms(to, text, { type: 'promo' });
  }

  // ==================== VERIFICAR NÚMERO ====================
  
  /**
   * Lookup de número para validar y obtener info del carrier
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

  // ==================== OBTENER ESTADO DE MENSAJE ====================
  
  /**
   * Obtiene el estado actual de un mensaje
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

  // ==================== PROCESAR WEBHOOK ====================
  
  /**
   * Procesa los webhooks de Telnyx
   * @param {object} payload - Body del webhook
   * @returns {object} - Datos procesados
   */
  processWebhook(payload) {
    const data = payload?.data;
    
    if (!data) {
      return { valid: false, error: 'Invalid webhook payload' };
    }

    const eventType = data.event_type;
    const messageData = data.payload;

    // Eventos que nos interesan
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

    // Manejar mensaje entrante (ej: STOP para unsubscribe)
    if (eventType === 'message.received') {
      result.isInbound = true;
      result.fromPhone = messageData?.from?.phone_number;
      result.toPhone = messageData?.to?.[0]?.phone_number;
      
      // Detectar opt-out
      const text = (messageData?.text || '').toLowerCase().trim();
      const optOutKeywords = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];
      result.isOptOut = optOutKeywords.includes(text);
    }

    return result;
  }

  // ==================== UTILIDADES ====================
  
  /**
   * Formatea número a E.164
   */
  formatPhoneNumber(phone) {
    if (!phone) return null;
    
    // Limpiar todo excepto números y +
    let cleaned = phone.toString().replace(/[^\d+]/g, '');
    
    // Si ya tiene +1, está bien
    if (cleaned.startsWith('+1') && cleaned.length === 12) {
      return cleaned;
    }
    
    // Si tiene +, verificar formato
    if (cleaned.startsWith('+')) {
      return cleaned.length >= 11 ? cleaned : null;
    }
    
    // Si empieza con 1 y tiene 11 dígitos
    if (cleaned.startsWith('1') && cleaned.length === 11) {
      return '+' + cleaned;
    }
    
    // Si tiene 10 dígitos (USA sin código de país)
    if (cleaned.length === 10) {
      return '+1' + cleaned;
    }
    
    return null;
  }

  /**
   * Formatea número para display
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
   * Valida si es número móvil (básico)
   */
  isValidMobileNumber(phone) {
    const formatted = this.formatPhoneNumber(phone);
    return formatted && formatted.length === 12;
  }

  // ==================== BULK SEND (para campañas) ====================
  
  /**
   * Envía SMS en bulk con rate limiting
   */
  async sendBulkSms(recipients, text, options = {}) {
    const results = {
      total: recipients.length,
      sent: 0,
      failed: 0,
      errors: []
    };

    const delay = options.delayMs || 100; // 100ms entre mensajes = 10/seg

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

  // ==================== HEALTH CHECK ====================
  
  async healthCheck() {
    try {
      // Verificar que podemos hacer requests
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