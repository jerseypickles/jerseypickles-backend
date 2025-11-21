// backend/src/services/emailService.js (ACTUALIZADO - INCLUYE EMAIL EN TRACKING)
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

class EmailService {
  constructor() {
    this.fromEmail = 'Jersey Pickles <info@jerseypickles.com>';
    this.appUrl = process.env.APP_URL;
  }

  // ==================== ENVÍO SIMPLE ====================
  
  async sendEmail({ to, subject, html, from = null, replyTo = null, campaignId = null, customerId = null }) {
    try {
      // Preparar tags si existen campaignId y customerId
      const tags = [];
      if (campaignId) tags.push({ name: 'campaign_id', value: String(campaignId) });
      if (customerId) tags.push({ name: 'customer_id', value: String(customerId) });
      
      // Inyectar tracking custom si aplica
      if (campaignId && customerId) {
        html = this.injectTracking(html, campaignId, customerId, to); // ✅ Pasar email también
      }
      
      const data = await resend.emails.send({
        from: from || this.fromEmail,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        reply_to: replyTo,
        tags: tags.length > 0 ? tags : undefined
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

  // 🆕 ==================== BATCH SENDING (hasta 100 emails) ====================
  
  async sendBatch(emailsArray) {
    try {
      if (!Array.isArray(emailsArray) || emailsArray.length === 0) {
        throw new Error('emailsArray debe ser un array no vacío');
      }
      
      if (emailsArray.length > 100) {
        throw new Error('Batch máximo es 100 emails. Recibido: ' + emailsArray.length);
      }
      
      console.log(`📦 Enviando batch de ${emailsArray.length} emails a Resend API...`);
      
      const formattedEmails = emailsArray.map(email => {
        const toArray = Array.isArray(email.to) ? email.to : [email.to];
        
        return {
          from: email.from || this.fromEmail,
          to: toArray,
          subject: email.subject,
          html: email.html,
          reply_to: email.reply_to || undefined,
          tags: email.tags || undefined
        };
      });
      
      const response = await resend.batch.send(formattedEmails);
      
      console.log(`✅ Batch enviado exitosamente: ${emailsArray.length} emails`);
      
      return { 
        success: true, 
        data: response.data
      };
      
    } catch (error) {
      console.error('❌ Error en batch send:', error);
      
      return { 
        success: false, 
        error: error.message,
        statusCode: error.statusCode 
      };
    }
  }

  // ==================== ENVÍO MASIVO (LEGACY) ====================
  
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
      
      if (i + chunkSize < emails.length) {
        await this.delay(delayBetweenChunks);
      }
    }
    
    console.log(`📊 Resultados: ${results.sent} enviados, ${results.failed} fallidos`);
    
    return results;
  }

  // ==================== TRACKING ====================
  
  generateTrackingPixel(campaignId, customerId, email) {
    const trackingUrl = `${this.appUrl}/api/track/open/${campaignId}/${customerId}?email=${encodeURIComponent(email)}`;
    return `<img src="${trackingUrl}" width="1" height="1" alt="" style="display:block" />`;
  }

  wrapLinksWithTracking(html, campaignId, customerId, email) {
    const trackingBaseUrl = `${this.appUrl}/api/track/click/${campaignId}/${customerId}`;
    
    // Reemplazar todos los href
    return html.replace(
      /href=["']([^"']+)["']/gi,
      (match, url) => {
        // No trackear links internos de tracking
        if (url.includes('/api/track/')) return match;
        
        const encodedUrl = encodeURIComponent(url);
        const emailParam = `&email=${encodeURIComponent(email)}`; // ✅ Agregar email
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
}

module.exports = new EmailService();