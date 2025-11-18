// backend/src/services/templateService.js
class TemplateService {
  
  // ==================== PLANTILLA BASE ====================
  
  getBaseTemplate(content) {
    return `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f4f4f4;
          }
          .email-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
          }
          .header {
            background-color: #2D5016;
            color: #ffffff;
            padding: 30px 20px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: 600;
          }
          .content {
            padding: 40px 30px;
          }
          .content p {
            margin-bottom: 15px;
            font-size: 16px;
            line-height: 1.6;
          }
          .button {
            display: inline-block;
            padding: 15px 30px;
            background-color: #2D5016;
            color: #ffffff !important;
            text-decoration: none;
            border-radius: 5px;
            font-weight: 600;
            margin: 20px 0;
          }
          .button:hover {
            background-color: #234012;
          }
          .discount-code {
            background: #f9f9f9;
            border: 2px dashed #2D5016;
            padding: 20px;
            text-align: center;
            font-size: 24px;
            font-weight: bold;
            letter-spacing: 2px;
            margin: 25px 0;
            color: #2D5016;
          }
          .footer {
            background-color: #f9f9f9;
            padding: 30px;
            text-align: center;
            font-size: 14px;
            color: #666;
          }
          .footer a {
            color: #2D5016;
            text-decoration: none;
          }
          .social-links {
            margin: 20px 0;
          }
          .social-links a {
            display: inline-block;
            margin: 0 10px;
            color: #2D5016;
            text-decoration: none;
          }
          @media only screen and (max-width: 600px) {
            .content {
              padding: 30px 20px;
            }
            .header h1 {
              font-size: 24px;
            }
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          ${content}
          <div class="footer">
            <p><strong>Jersey Pickles</strong></p>
            <div class="social-links">
              <a href="https://instagram.com/jerseypickles">Instagram</a>
              <a href="https://facebook.com/jerseypickles">Facebook</a>
            </div>
            <p>¿Preguntas? Responde a este email o visita nuestro sitio web</p>
            <p style="margin-top: 15px; font-size: 12px;">
              <a href="{{unsubscribeUrl}}">Cancelar suscripción</a>
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // ==================== WELCOME EMAIL ====================
  
  getWelcomeEmail(customerName, discountCode = 'BIENVENIDO15') {
    const content = `
      <div class="header">
        <h1>¡Bienvenido a Jersey Pickles! 🥒</h1>
      </div>
      <div class="content">
        <p>Hola ${customerName},</p>
        
        <p>¡Gracias por unirte a la familia Jersey Pickles! Estamos emocionados de que descubras nuestros pickles artesanales, aceitunas premium y productos gourmet.</p>
        
        <p>Como bienvenida, aquí está tu código de descuento del <strong>15% de descuento</strong> en tu primera compra:</p>
        
        <div class="discount-code">${discountCode}</div>
        
        <p style="text-align: center;">
          <a href="https://jerseypickles.com/collections/all" class="button">Explorar Productos</a>
        </p>
        
        <p>Nuestros productos favoritos:</p>
        <ul>
          <li>🥒 Classic Dill Pickles - El favorito tradicional</li>
          <li>🌶️ Spicy Pickles - Para los amantes del picante</li>
          <li>🫒 Gourmet Olives - Importadas de las mejores regiones</li>
        </ul>
        
        <p>¡Esperamos que disfrutes nuestros productos tanto como nosotros disfrutamos creándolos!</p>
        
        <p style="margin-top: 30px;">
          Saludos,<br>
          <strong>El equipo de Jersey Pickles</strong>
        </p>
      </div>
    `;
    
    return this.getBaseTemplate(content);
  }

  // ==================== ABANDONED CART ====================
  
  getAbandonedCartEmail(customerName, cartItems, cartUrl) {
    const itemsHtml = cartItems.map(item => `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 15px;">
          <img src="${item.image}" width="80" style="border-radius: 5px;" alt="${item.title}">
        </td>
        <td style="padding: 15px;">
          <strong>${item.title}</strong><br>
          <span style="color: #666;">${item.variant || ''}</span>
        </td>
        <td style="padding: 15px; text-align: right;">
          <strong>$${parseFloat(item.price).toFixed(2)}</strong><br>
          <span style="color: #666;">Cant: ${item.quantity}</span>
        </td>
      </tr>
    `).join('');

    const content = `
      <div class="header">
        <h1>¡No olvides tus pickles! 🥒</h1>
      </div>
      <div class="content">
        <p>Hola ${customerName},</p>
        
        <p>Notamos que dejaste algunos productos deliciosos en tu carrito. ¡Están esperando por ti!</p>
        
        <table style="width: 100%; margin: 20px 0; border-collapse: collapse;">
          ${itemsHtml}
        </table>
        
        <p style="text-align: center;">
          <a href="${cartUrl}" class="button">Completar mi Compra</a>
        </p>
        
        <p style="background: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107;">
          💡 <strong>Tip:</strong> Los productos más populares se agotan rápido. ¡No te quedes sin los tuyos!
        </p>
        
        <p>Si tienes alguna pregunta o necesitas ayuda, estamos aquí para ti.</p>
        
        <p style="margin-top: 30px;">
          Saludos,<br>
          <strong>El equipo de Jersey Pickles</strong>
        </p>
      </div>
    `;
    
    return this.getBaseTemplate(content);
  }

  // ==================== ORDER CONFIRMATION ====================
  
  getOrderConfirmationEmail(orderData) {
    const { customerName, orderNumber, totalPrice, lineItems, orderUrl } = orderData;
    
    const itemsHtml = lineItems.map(item => `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 15px;">${item.title}</td>
        <td style="padding: 15px; text-align: center;">${item.quantity}</td>
        <td style="padding: 15px; text-align: right;">$${parseFloat(item.price).toFixed(2)}</td>
      </tr>
    `).join('');

    const content = `
      <div class="header">
        <h1>¡Gracias por tu pedido! 🎉</h1>
      </div>
      <div class="content">
        <p>Hola ${customerName},</p>
        
        <p>¡Tu pedido ha sido confirmado! Estamos preparando tus productos con mucho cuidado.</p>
        
        <div style="background: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Número de Orden:</strong> #${orderNumber}</p>
        </div>
        
        <h2 style="margin-top: 30px; color: #2D5016;">Resumen del Pedido</h2>
        
        <table style="width: 100%; margin: 20px 0; border-collapse: collapse;">
          <thead>
            <tr style="background: #f9f9f9; border-bottom: 2px solid #2D5016;">
              <th style="padding: 15px; text-align: left;">Producto</th>
              <th style="padding: 15px; text-align: center;">Cantidad</th>
              <th style="padding: 15px; text-align: right;">Precio</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
          <tfoot>
            <tr style="background: #f9f9f9; font-weight: bold;">
              <td colspan="2" style="padding: 15px; text-align: right;">Total:</td>
              <td style="padding: 15px; text-align: right; color: #2D5016; font-size: 18px;">$${parseFloat(totalPrice).toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
        
        <p style="text-align: center;">
          <a href="${orderUrl}" class="button">Ver Detalles del Pedido</a>
        </p>
        
        <p>Te notificaremos cuando tu pedido esté en camino. Si tienes alguna pregunta, no dudes en contactarnos.</p>
        
        <p style="margin-top: 30px;">
          ¡Gracias por apoyar a Jersey Pickles!<br>
          <strong>El equipo de Jersey Pickles</strong>
        </p>
      </div>
    `;
    
    return this.getBaseTemplate(content);
  }

  // ==================== PROMOTIONAL ====================
  
  getPromotionalEmail(title, message, ctaText, ctaUrl, imageUrl = null) {
    const imageHtml = imageUrl ? `
      <img src="${imageUrl}" alt="${title}" style="width: 100%; height: auto; display: block; margin: 20px 0;">
    ` : '';

    const content = `
      <div class="header">
        <h1>${title}</h1>
      </div>
      <div class="content">
        <p>Hola {{firstName}},</p>
        
        ${imageHtml}
        
        ${message.split('\n').map(p => `<p>${p}</p>`).join('')}
        
        <p style="text-align: center;">
          <a href="${ctaUrl}" class="button">${ctaText}</a>
        </p>
        
        <p style="margin-top: 30px;">
          Saludos,<br>
          <strong>El equipo de Jersey Pickles</strong>
        </p>
      </div>
    `;
    
    return this.getBaseTemplate(content);
  }

  // ==================== NEWSLETTER ====================
  
  getNewsletterEmail(articles) {
    const articlesHtml = articles.map(article => `
      <div style="margin-bottom: 30px; padding-bottom: 30px; border-bottom: 1px solid #eee;">
        ${article.image ? `<img src="${article.image}" alt="${article.title}" style="width: 100%; height: auto; border-radius: 5px; margin-bottom: 15px;">` : ''}
        <h2 style="color: #2D5016; margin-bottom: 10px;">${article.title}</h2>
        <p>${article.excerpt}</p>
        <a href="${article.url}" style="color: #2D5016; font-weight: 600; text-decoration: none;">Leer más →</a>
      </div>
    `).join('');

    const content = `
      <div class="header">
        <h1>Newsletter de Jersey Pickles 📰</h1>
      </div>
      <div class="content">
        <p>Hola {{firstName}},</p>
        
        <p>¡Aquí está lo más reciente de Jersey Pickles!</p>
        
        ${articlesHtml}
        
        <p style="margin-top: 30px;">
          Saludos,<br>
          <strong>El equipo de Jersey Pickles</strong>
        </p>
      </div>
    `;
    
    return this.getBaseTemplate(content);
  }
}

module.exports = new TemplateService();