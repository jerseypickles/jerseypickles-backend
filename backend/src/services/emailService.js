// backend/src/services/emailService.js - PRODUCTION READY
const { Resend } = require('resend');
const CircuitBreaker = require('../utils/circuitBreaker');

const resend = new Resend(process.env.RESEND_API_KEY);

// ========== CIRCUIT BREAKER PARA RESEND API ==========
const resendCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,   // 5 fallos consecutivos
  successThreshold: 2,   // 2 éxitos para cerrar
  timeout: 60000         // 60s en estado OPEN
});

class EmailService {
  constructor() {
    this.fromEmail = 'Jersey Pickles <info@jerseypickles.com>';
    this.appUrl = process.env.APP_URL || 'https://jerseypickles.com';
    
    // Stats de servicio
    this.stats = {
      totalSent: 0,
      totalFailed: 0,
      totalRetries: 0,
      lastError: null,
      lastSuccess: null
    };
  }

  // ==================== ENVÍO SIMPLE CON CIRCUIT BREAKER ====================
  
  async sendEmail({ 
    to, 
    subject, 
    html, 
    from = null, 
    replyTo = null, 
    campaignId = null, 
    customerId = null,
    tags = null,
    retries = 0,
    maxRetries = 3
  }) {
    try {
      // Validación básica
      if (!to || !subject || !html) {
        throw new Error('Faltan campos requeridos: to, subject, html');
      }

      if (!this.isValidEmail(to)) {
        throw new Error(`Email inválido: ${to}`);
      }

      // Preparar tags
      let emailTags = [];
      
      if (tags && Array.isArray(tags)) {
        emailTags = tags;
      } else {
        if (campaignId) emailTags.push({ name: 'campaign_id', value: String(campaignId) });
        if (customerId) emailTags.push({ name: 'customer_id', value: String(customerId) });
      }
      
      // ✅ EJECUTAR CON CIRCUIT BREAKER
      const data = await resendCircuitBreaker.execute(async () => {
        return await resend.emails.send({
          from: from || this.fromEmail,
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          reply_to: replyTo,
          tags: emailTags.length > 0 ? emailTags : undefined
        });
      }, `sendEmail:${to}`);
      
      // ✅ SUCCESS
      this.stats.totalSent++;
      this.stats.lastSuccess = new Date();
      
      return {
        success: true,
        id: data.id,
        email: to
      };
      
    } catch (error) {
      this.stats.totalFailed++;
      this.stats.lastError = {
        message: error.message,
        timestamp: new Date(),
        email: to
      };
      
      // ========== RETRY LOGIC ==========
      const errorType = this.classifyError(error);
      
      if (errorType.shouldRetry && retries < maxRetries) {
        this.stats.totalRetries++;
        
        const backoffDelay = this.calculateBackoff(retries);
        
        console.warn(`⚠️  Retry ${retries + 1}/${maxRetries} para ${to} en ${backoffDelay}ms`);
        console.warn(`   Error: ${error.message}`);
        
        await this.delay(backoffDelay);
        
        return this.sendEmail({
          to,
          subject,
          html,
          from,
          replyTo,
          campaignId,
          customerId,
          tags,
          retries: retries + 1,
          maxRetries
        });
      }
      
      // ========== NO RETRY - RETURN ERROR ==========
      console.error(`❌ Error enviando email a ${to}:`, error.message);
      
      return {
        success: false,
        error: error.message,
        errorType: errorType.type,
        email: to,
        retriesAttempted: retries
      };
    }
  }

  // ==================== BATCH SENDING CON CIRCUIT BREAKER ====================
  
  async sendBatch(emailsArray, options = {}) {
    try {
      const {
        maxRetries = 3,
        validateEmails = true
      } = options;

      if (!Array.isArray(emailsArray) || emailsArray.length === 0) {
        throw new Error('emailsArray debe ser un array no vacío');
      }
      
      if (emailsArray.length > 100) {
        throw new Error(`Batch máximo es 100 emails. Recibido: ${emailsArray.length}`);
      }
      
      // Validar emails si está habilitado
      if (validateEmails) {
        for (const email of emailsArray) {
          const toArray = Array.isArray(email.to) ? email.to : [email.to];
          for (const recipient of toArray) {
            if (!this.isValidEmail(recipient)) {
              throw new Error(`Email inválido en batch: ${recipient}`);
            }
          }
        }
      }
      
      console.log(`📦 Enviando batch de ${emailsArray.length} emails...`);
      
      const formattedEmails = emailsArray.map(email => {
        const toArray = Array.isArray(email.to) ? email.to : [email.to];
        
        return {
          from: email.from || this.fromEmail,
          to: toArray,
          subject: email.subject,
          html: email.html,
          reply_to: email.replyTo || email.reply_to || undefined,
          tags: email.tags || undefined
        };
      });
      
      // ✅ EJECUTAR BATCH CON CIRCUIT BREAKER
      const response = await resendCircuitBreaker.execute(async () => {
        return await resend.batch.send(formattedEmails);
      }, `sendBatch:${emailsArray.length}emails`);
      
      this.stats.totalSent += emailsArray.length;
      this.stats.lastSuccess = new Date();
      
      console.log(`✅ Batch enviado: ${emailsArray.length} emails`);
      
      return { 
        success: true, 
        data: response.data,
        count: emailsArray.length
      };
      
    } catch (error) {
      this.stats.totalFailed += emailsArray?.length || 0;
      this.stats.lastError = {
        message: error.message,
        timestamp: new Date(),
        context: 'batch'
      };
      
      console.error('❌ Error en batch send:', error.message);
      
      const errorType = this.classifyError(error);
      
      return { 
        success: false, 
        error: error.message,
        errorType: errorType.type,
        statusCode: error.statusCode 
      };
    }
  }

  // ==================== ENVÍO MASIVO (CHUNKED) ====================
  
  async sendBulkEmails(emails, options = {}) {
    const {
      chunkSize = 10,
      delayBetweenChunks = 1000,
      stopOnCircuitBreak = true
    } = options;
    
    const results = {
      total: emails.length,
      sent: 0,
      failed: 0,
      circuitBroken: false,
      details: []
    };
    
    for (let i = 0; i < emails.length; i += chunkSize) {
      const chunk = emails.slice(i, i + chunkSize);
      const chunkNum = Math.floor(i/chunkSize) + 1;
      const totalChunks = Math.ceil(emails.length/chunkSize);
      
      console.log(`📧 Chunk ${chunkNum}/${totalChunks} (${chunk.length} emails)`);
      
      // Verificar estado del circuit breaker
      const cbState = resendCircuitBreaker.getState();
      if (cbState.state === 'OPEN') {
        console.error(`🔴 Circuit breaker OPEN - deteniendo envío masivo`);
        results.circuitBroken = true;
        
        if (stopOnCircuitBreak) {
          break;
        }
      }
      
      const promises = chunk.map(email => this.sendEmail(email));
      const chunkResults = await Promise.allSettled(promises);
      
      chunkResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.success) {
          results.sent++;
          results.details.push({
            email: chunk[index].to,
            status: 'sent',
            id: result.value.id
          });
        } else {
          results.failed++;
          results.details.push({
            email: chunk[index].to,
            status: 'failed',
            error: result.reason?.message || result.value?.error
          });
        }
      });
      
      if (i + chunkSize < emails.length) {
        await this.delay(delayBetweenChunks);
      }
    }
    
    console.log(`📊 Bulk results: ${results.sent} sent, ${results.failed} failed`);
    
    return results;
  }

  // ==================== ERROR CLASSIFICATION ====================
  
  classifyError(error) {
    const message = error.message || '';
    const statusCode = error.statusCode || error.status;
    
    // Rate Limit (429)
    if (statusCode === 429 || message.toLowerCase().includes('rate limit') || message.toLowerCase().includes('too many requests')) {
      return {
        type: 'rate_limit',
        shouldRetry: true,
        isFatal: false,
        backoffMultiplier: 3 // Más tiempo de espera
      };
    }
    
    // Service Errors (500+)
    if (statusCode >= 500) {
      return {
        type: 'service_error',
        shouldRetry: true,
        isFatal: false,
        backoffMultiplier: 2
      };
    }
    
    // Network Errors
    if (message.includes('timeout') || message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
      return {
        type: 'network_error',
        shouldRetry: true,
        isFatal: false,
        backoffMultiplier: 2
      };
    }
    
    // Client Errors (400-499) - NO RETRY
    if (statusCode >= 400 && statusCode < 500) {
      return {
        type: 'client_error',
        shouldRetry: false,
        isFatal: true,
        backoffMultiplier: 0
      };
    }
    
    // Invalid Email
    if (message.toLowerCase().includes('invalid email') || message.toLowerCase().includes('invalid recipient')) {
      return {
        type: 'invalid_email',
        shouldRetry: false,
        isFatal: true,
        backoffMultiplier: 0
      };
    }
    
    // Circuit Breaker Open
    if (message.includes('Circuit breaker OPEN')) {
      return {
        type: 'circuit_open',
        shouldRetry: false,
        isFatal: false,
        backoffMultiplier: 0
      };
    }
    
    // Unknown - Retry por defecto
    return {
      type: 'unknown',
      shouldRetry: true,
      isFatal: false,
      backoffMultiplier: 2
    };
  }

  // ==================== BACKOFF CALCULATION ====================
  
  calculateBackoff(retryCount) {
    // Exponential backoff: 2^retry * 1000ms
    // Retry 0: 1s
    // Retry 1: 2s
    // Retry 2: 4s
    // Retry 3: 8s
    const baseDelay = 1000;
    const exponentialDelay = Math.pow(2, retryCount) * baseDelay;
    
    // Max 30s
    return Math.min(exponentialDelay, 30000);
  }

  // ==================== TRACKING ====================
  
  generateTrackingPixel(campaignId, customerId, email) {
    const trackingUrl = `${this.appUrl}/api/track/open/${campaignId}/${customerId}?email=${encodeURIComponent(email)}`;
    return `<img src="${trackingUrl}" width="1" height="1" alt="" style="display:block" />`;
  }

  wrapLinksWithTracking(html, campaignId, customerId, email) {
    const trackingBaseUrl = `${this.appUrl}/api/track/click/${campaignId}/${customerId}`;
    
    return html.replace(
      /href=["']([^"']+)["']/gi,
      (match, url) => {
        // No trackear links internos de tracking
        if (url.includes('/api/track/')) return match;
        
        const encodedUrl = encodeURIComponent(url);
        const emailParam = `&email=${encodeURIComponent(email)}`;
        return `href="${trackingBaseUrl}?url=${encodedUrl}${emailParam}"`;
      }
    );
  }

  injectTracking(html, campaignId, customerId, email) {
    // Agregar pixel al final del body
    const pixel = this.generateTrackingPixel(campaignId, customerId, email);
    
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${pixel}</body>`);
    } else {
      html += pixel;
    }
    
    // Wrap links con tracking
    html = this.wrapLinksWithTracking(html, campaignId, customerId, email);
    
    return html;
  }

  // ==================== PERSONALIZACIÓN ====================
  
  personalize(html, customer) {
    const variables = {
      '{{firstName}}': customer.firstName || '',
      '{{lastName}}': customer.lastName || '',
      '{{fullName}}': `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Cliente',
      '{{email}}': customer.email || ''
    };
    
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(key, 'g');
      html = html.replace(regex, variables[key]);
    });
    
    return html;
  }

  // ==================== UTILIDADES ====================
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isValidEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  }

  // ==================== HEALTH & STATS ====================
  
  getStats() {
    return {
      ...this.stats,
      circuitBreaker: resendCircuitBreaker.getState()
    };
  }

  getCircuitBreakerState() {
    return resendCircuitBreaker.getState();
  }

  resetCircuitBreaker() {
    resendCircuitBreaker.reset();
    console.log('🔄 Circuit breaker reseteado manualmente');
  }

  async healthCheck() {
    try {
      const cbState = resendCircuitBreaker.getState();
      
      const health = {
        healthy: cbState.state !== 'OPEN',
        circuitBreaker: cbState,
        stats: this.stats,
        timestamp: new Date()
      };
      
      if (cbState.state === 'OPEN') {
        health.warning = 'Circuit breaker está OPEN - servicio degradado';
      }
      
      return health;
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date()
      };
    }
  }
}

module.exports = new EmailService();