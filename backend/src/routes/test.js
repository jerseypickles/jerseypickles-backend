// backend/src/routes/test.js
const express = require('express');
const router = express.Router();
const emailService = require('../services/emailService');
const EmailEvent = require('../models/EmailEvent');

// Enviar email de prueba
router.post('/send-test-email', async (req, res) => {
  try {
    const { email } = req.body;
    
    const testEmail = email || 'tu-email@gmail.com'; // Cambia esto por tu email
    const campaignId = 'test_campaign_' + Date.now();
    const customerId = 'test_customer_' + Date.now();
    
    const result = await emailService.sendEmail({
      to: testEmail,
      subject: '🧪 Test de Tracking - Jersey Pickles',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; }
            .button { 
              background: #4CAF50; 
              color: white; 
              padding: 10px 20px; 
              text-decoration: none;
              border-radius: 5px;
              display: inline-block;
              margin: 10px 0;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🥒 Test de Email Tracking</h1>
            <p>Este es un email de prueba para verificar el sistema de tracking.</p>
            
            <h3>¿Qué se está probando?</h3>
            <ul>
              <li>✅ Envío del email con tags</li>
              <li>📧 Tracking de apertura (pixel custom + webhook Resend)</li>
              <li>🖱️ Tracking de clicks (redirect custom + webhook Resend)</li>
            </ul>
            
            <h3>Prueba estos links:</h3>
            <p>
              <a href="https://jerseypickles.com" class="button">Ver Tienda</a>
            </p>
            <p>
              <a href="https://jerseypickles.com/products" class="button">Ver Productos</a>
            </p>
            
            <hr style="margin: 30px 0;">
            
            <p style="font-size: 12px; color: #666;">
              <strong>IDs de tracking:</strong><br>
              Campaign ID: ${campaignId}<br>
              Customer ID: ${customerId}
            </p>
          </div>
        </body>
        </html>
      `,
      campaignId: campaignId,
      customerId: customerId
    });
    
    res.json({
      success: true,
      message: '✅ Email enviado! Revisa tu bandeja de entrada',
      details: {
        email: testEmail,
        campaignId: campaignId,
        customerId: customerId,
        resendId: result.id
      },
      instructions: [
        '1. Abre el email en tu bandeja',
        '2. Haz click en los links',
        '3. Revisa los eventos en /api/test/check-events'
      ]
    });
    
  } catch (error) {
    console.error('Error enviando test email:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Ver eventos registrados recientes
router.get('/check-events', async (req, res) => {
  try {
    const recentEvents = await EmailEvent.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('customer', 'email firstName lastName')
      .populate('campaign', 'name subject');
    
    const summary = {
      total: recentEvents.length,
      byType: {},
      bySource: {}
    };
    
    recentEvents.forEach(event => {
      summary.byType[event.eventType] = (summary.byType[event.eventType] || 0) + 1;
      summary.bySource[event.source] = (summary.bySource[event.source] || 0) + 1;
    });
    
    res.json({
      summary,
      events: recentEvents
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verificar conectividad del webhook
router.get('/webhook-test', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Webhook endpoint is accessible',
    webhookUrl: 'https://jerseypickles-backend.onrender.com/api/webhooks/resend',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;