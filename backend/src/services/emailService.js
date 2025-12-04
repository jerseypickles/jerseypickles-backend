// backend/src/services/emailService.js - PRODUCTION READY CON UNSUBSCRIBE
const { Resend } = require('resend');
const CircuitBreaker = require('../utils/circuitBreaker');
const { generateUnsubscribeToken } = require('../utils/unsubscribeToken');

const resend = new Resend(process.env.RESEND_API_KEY);

// ========== CIRCUIT BREAKER PARA RESEND API ==========
const resendCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60000
});

class EmailService {
  constructor() {
    this.fromEmail = 'Jersey Pickles <info@jerseypickles.com>';
    this.appUrl = process.env.APP_URL || 'https://jerseypickles.com';
    
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
    maxRetries = 3,
    includeUnsubscribe = true // 🆕 Por defecto incluir unsubscribe
  }) {
    try {
      if (!to || !subject || !html) {
        throw new Error('Faltan campos requeridos: to, subject, html');
      }

      if (!this.isValidEmail(to)) {
        throw new Error(`Email inválido: ${to}`);
      }

      // 🆕 Inyectar link de unsubscribe si está habilitado
      if (includeUnsubscribe && customerId) {
        html = this.injectUnsubscribeLink(html, customerId, to, campaignId);
      }

      let emailTags = [];
      
      if (tags && Array.isArray(tags)) {
        emailTags = tags;
      } else {
        if (campaignId) emailTags.push({ name: 'campaign_id', value: String(campaignId) });
        if (customerId) emailTags.push({ name: 'customer_id', value: String(customerId) });
      }
      
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
      
      const errorType = this.classifyError(error);
      
      if (errorType.shouldRetry && retries < maxRetries) {
        this.stats.totalRetries++;
        
        const backoffDelay = this.calculateBackoff(retries);
        
        console.warn(`⚠️  Retry ${retries + 1}/${maxRetries} para ${to} en ${backoffDelay}ms`);
        
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
          maxRetries,
          includeUnsubscribe: false // Ya se inyectó en el primer intento
        });
      }
      
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

  // ==================== BATCH SENDING ====================
  
  async sendBatch(emailsArray, options = {}) {
    try {
      const {
        maxRetries = 3,
        validateEmails = true,
        includeUnsubscribe = true // 🆕
      } = options;

      if (!Array.isArray(emailsArray) || emailsArray.length === 0) {
        throw new Error('emailsArray debe ser un array no vacío');
      }
      
      if (emailsArray.length > 100) {
        throw new Error(`Batch máximo es 100 emails. Recibido: ${emailsArray.length}`);
      }
      
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
        let htmlContent = email.html;
        
        // 🆕 Inyectar unsubscribe en cada email del batch
        if (includeUnsubscribe && email.customerId) {
          htmlContent = this.injectUnsubscribeLink(htmlContent, email.customerId, toArray[0]);
        }
        
        return {
          from: email.from || this.fromEmail,
          to: toArray,
          subject: email.subject,
          html: htmlContent,
          reply_to: email.replyTo || email.reply_to || undefined,
          tags: email.tags || undefined
        };
      });
      
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

  // ==================== BULK EMAILS (CHUNKED) ====================
  
  async sendBulkEmails(emails, options = {}) {
    const {
      chunkSize = 10,
      delayBetweenChunks = 1000,
      stopOnCircuitBreak = true,
      includeUnsubscribe = true // 🆕
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
      
      const cbState = resendCircuitBreaker.getState();
      if (cbState.state === 'OPEN') {
        console.error(`🔴 Circuit breaker OPEN - deteniendo envío masivo`);
        results.circuitBroken = true;
        
        if (stopOnCircuitBreak) {
          break;
        }
      }
      
      const promises = chunk.map(email => this.sendEmail({
        ...email,
        includeUnsubscribe
      }));
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

  // ==================== 🆕 UNSUBSCRIBE LINK GENERATION ====================
  
  /**
   * Genera el link de unsubscribe para un cliente
   * @param {string} customerId - ID del cliente
   * @param {string} email - Email del cliente
   * @param {string} campaignId - ID de la campaña (opcional, para tracking)
   */
  generateUnsubscribeLink(customerId, email, campaignId = null) {
    const token = generateUnsubscribeToken(customerId, email, campaignId);
    return `${this.appUrl}/api/track/unsubscribe/${token}`;
  }

  /**
   * Genera el HTML del footer con link de unsubscribe
   */
  /**
   * Genera el HTML del footer con link de unsubscribe
   * @param {string} customerId - ID del cliente
   * @param {string} email - Email del cliente  
   * @param {string} campaignId - ID de la campaña (opcional, para tracking)
   */
  generateUnsubscribeFooter(customerId, email, campaignId = null) {
    const unsubscribeLink = this.generateUnsubscribeLink(customerId, email, campaignId);
    
    return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 40px; border-top: 1px solid #e0e0e0;">
      <tr>
        <td style="padding: 24px; text-align: center;">
          <p style="margin: 0 0 8px 0; font-size: 12px; color: #999; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            Jersey Pickles • New Jersey's Finest Pickles
          </p>
          <p style="margin: 0; font-size: 11px; color: #bbb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            You're receiving this email because you subscribed to our offers and updates.
          </p>
          <p style="margin: 12px 0 0 0; font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <a href="${unsubscribeLink}" style="color: #666; text-decoration: underline;">
              Unsubscribe
            </a>
            &nbsp;•&nbsp;
            <a href="https://jerseypickles.com" style="color: #666; text-decoration: underline;">
              Visit store
            </a>
          </p>
        </td>
      </tr>
    </table>`;
  }

  /**
   * Inyecta el link de unsubscribe en el HTML del email
   * Busca {{unsubscribe_link}} o lo añade al final
   * @param {string} html - HTML del email
   * @param {string} customerId - ID del cliente
   * @param {string} email - Email del cliente
   * @param {string} campaignId - ID de la campaña (opcional, para tracking)
   */
  injectUnsubscribeLink(html, customerId, email, campaignId = null) {
    const unsubscribeLink = this.generateUnsubscribeLink(customerId, email, campaignId);
    
    // Reemplazar placeholder si existe
    if (html.includes('{{unsubscribe_link}}')) {
      return html.replace(/\{\{unsubscribe_link\}\}/g, unsubscribeLink);
    }
    
    // Reemplazar otros placeholders comunes
    if (html.includes('{{unsubscribe_url}}')) {
      return html.replace(/\{\{unsubscribe_url\}\}/g, unsubscribeLink);
    }
    
    if (html.includes('%unsubscribe_link%')) {
      return html.replace(/%unsubscribe_link%/g, unsubscribeLink);
    }
    
    // Si el email ya tiene un footer con unsubscribe, no añadir otro
    if (html.toLowerCase().includes('unsubscribe')) {
      return html;
    }
    
    // Añadir footer antes del cierre de </body> o al final
    const footer = this.generateUnsubscribeFooter(customerId, email);
    
    if (html.includes('</body>')) {
      return html.replace('</body>', `${footer}</body>`);
    } else if (html.includes('</table>')) {
      // Buscar la última tabla y añadir después
      const lastTableIndex = html.lastIndexOf('</table>');
      return html.slice(0, lastTableIndex + 8) + footer + html.slice(lastTableIndex + 8);
    } else {
      return html + footer;
    }
  }

  // ==================== ERROR CLASSIFICATION ====================
  
  classifyError(error) {
    const message = error.message || '';
    const statusCode = error.statusCode || error.status;
    
    if (statusCode === 429 || message.toLowerCase().includes('rate limit')) {
      return { type: 'rate_limit', shouldRetry: true, isFatal: false, backoffMultiplier: 3 };
    }
    
    if (statusCode >= 500) {
      return { type: 'service_error', shouldRetry: true, isFatal: false, backoffMultiplier: 2 };
    }
    
    if (message.includes('timeout') || message.includes('ECONNREFUSED')) {
      return { type: 'network_error', shouldRetry: true, isFatal: false, backoffMultiplier: 2 };
    }
    
    if (statusCode >= 400 && statusCode < 500) {
      return { type: 'client_error', shouldRetry: false, isFatal: true, backoffMultiplier: 0 };
    }
    
    if (message.toLowerCase().includes('invalid email')) {
      return { type: 'invalid_email', shouldRetry: false, isFatal: true, backoffMultiplier: 0 };
    }
    
    if (message.includes('Circuit breaker OPEN')) {
      return { type: 'circuit_open', shouldRetry: false, isFatal: false, backoffMultiplier: 0 };
    }
    
    return { type: 'unknown', shouldRetry: true, isFatal: false, backoffMultiplier: 2 };
  }

  // ==================== BACKOFF CALCULATION ====================
  
  calculateBackoff(retryCount) {
    const baseDelay = 1000;
    const exponentialDelay = Math.pow(2, retryCount) * baseDelay;
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
        // No trackear links de tracking o unsubscribe
        if (url.includes('/api/track/')) return match;
        
        const encodedUrl = encodeURIComponent(url);
        const emailParam = `&email=${encodeURIComponent(email)}`;
        return `href="${trackingBaseUrl}?url=${encodedUrl}${emailParam}"`;
      }
    );
  }

  injectTracking(html, campaignId, customerId, email) {
    const pixel = this.generateTrackingPixel(campaignId, customerId, email);
    
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${pixel}</body>`);
    } else {
      html += pixel;
    }
    
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
      
      return {
        healthy: cbState.state !== 'OPEN',
        circuitBreaker: cbState,
        stats: this.stats,
        timestamp: new Date()
      };
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