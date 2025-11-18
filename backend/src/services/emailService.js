// backend/src/services/emailService.js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

class EmailService {
  constructor() {
    this.fromEmail = 'Jersey Pickles <orders@jerseypickles.com>';
    this.appUrl = process.env.APP_URL;
  }

  // ==================== ENVÍO SIMPLE ====================
  
  async sendEmail({ to, subject, html, from = null, replyTo = null }) {
    try {
      const data = await resend.emails.send({
        from: from || this.fromEmail,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        reply_to: replyTo
      });
      
      console.log(`✅ Email enviado a ${to}: ${data.id}`);
      
      return {
        success: true,
        id: data.id,
        email: to
      };
      
    } catch (error) {
      console.error('❌ Error enviando email:', error);
      
      return {
        success: false,
        error: error.message,
        email: to
      };
    }
  }

  // ==================== ENVÍO MASIVO ====================
  
  async sendBulkEmails(emails, options = {}) {
    const {
      chunkSize = 10,
      delayBetweenChunks = 1000
    } = options;
    
    const results = {
      total: emails.length,
      sent: 0,
      failed: 0,
      details: []
    };
    
    // Procesar en chunks
    for (let i = 0; i < emails.length; i += chunkSize) {
      const chunk = emails.slice(i, i + chunkSize);
      
      console.log(`📧 Procesando chunk ${Math.floor(i/chunkSize) + 1}/${Math.ceil(emails.length/chunkSize)}`);
      
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
            error: result.reason || result.value?.error
          });
        }
      });
      
      // Delay entre chunks
      if (i + chunkSize < emails.length) {
        await this.delay(delayBetweenChunks);
      }
    }
    
    console.log(`📊 Resultados: ${results.sent} enviados, ${results.failed} fallidos`);
    
    return results;
  }

  // ==================== TRACKING ====================
  
  generateTrackingPixel(campaignId, customerId) {
    const trackingUrl = `${this.appUrl}/api/track/open/${campaignId}/${customerId}`;
    return `<img src="${trackingUrl}" width="1" height="1" alt="" style="display:block" />`;
  }

  wrapLinksWithTracking(html, campaignId, customerId) {
    const trackingBaseUrl = `${this.appUrl}/api/track/click/${campaignId}/${customerId}`;
    
    // Reemplazar todos los href
    return html.replace(
      /href=["']([^"']+)["']/gi,
      (match, url) => {
        // No trackear links internos de tracking
        if (url.includes('/api/track/')) return match;
        
        const encodedUrl = encodeURIComponent(url);
        return `href="${trackingBaseUrl}?url=${encodedUrl}"`;
      }
    );
  }

  injectTracking(html, campaignId, customerId) {
    // Agregar pixel al final del body
    const pixel = this.generateTrackingPixel(campaignId, customerId);
    
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${pixel}</body>`);
    } else {
      html += pixel;
    }
    
    // Wrap links con tracking
    html = this.wrapLinksWithTracking(html, campaignId, customerId);
    
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

  // Validar email
  isValidEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  }
}

module.exports = new EmailService();