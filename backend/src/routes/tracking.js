// backend/src/routes/tracking.js (ACTUALIZADO CON UNSUBSCRIBE)
const express = require('express');
const router = express.Router();
const EmailEvent = require('../models/EmailEvent');
const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');
const AttributionService = require('../middleware/attributionTracking');
const { verifyUnsubscribeToken } = require('../utils/unsubscribeToken');

// ==================== OPEN TRACKING ====================

router.get('/open/:campaignId/:customerId', async (req, res) => {
  try {
    const { campaignId, customerId } = req.params;
    const { email } = req.query;
    
    console.log(`📧 Email opened - Campaign: ${campaignId}, Customer: ${customerId}`);
    
    const existingEvent = await EmailEvent.findOne({
      campaign: campaignId,
      customer: customerId,
      eventType: 'opened'
    });
    
    if (!existingEvent) {
      await EmailEvent.create({
        campaign: campaignId,
        customer: customerId,
        email: email || 'unknown',
        eventType: 'opened',
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.connection.remoteAddress
      });
      
      await Campaign.updateStats(campaignId, 'opened');
      await Customer.updateEmailStats(customerId, 'opened');
      
      console.log(`✅ Open event registered`);
    } else {
      console.log(`⏭️  Open already registered`);
    }
    
  } catch (error) {
    console.error('❌ Error tracking open:', error);
  }
  
  // Retornar pixel transparente
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache'
  });
  
  res.end(pixel);
});

// ==================== CLICK TRACKING ====================

router.get('/click/:campaignId/:customerId', async (req, res) => {
  try {
    const { campaignId, customerId } = req.params;
    const { url, email } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }
    
    console.log(`🖱️  Link clicked - Campaign: ${campaignId}, URL: ${url}`);
    
    await EmailEvent.create({
      campaign: campaignId,
      customer: customerId,
      email: email || 'unknown',
      eventType: 'clicked',
      clickedUrl: decodeURIComponent(url),
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    await Campaign.updateStats(campaignId, 'clicked');
    await Customer.updateEmailStats(customerId, 'clicked');
    
    console.log(`✅ Click event registered`);
    
    // Establecer cookie de atribución
    AttributionService.setAttribution(res, campaignId, customerId);
    
    // Redirigir a la URL original
    res.redirect(decodeURIComponent(url));
    
  } catch (error) {
    console.error('❌ Error tracking click:', error);
    
    if (req.query.url) {
      res.redirect(decodeURIComponent(req.query.url));
    } else {
      res.status(500).json({ error: 'Error tracking click' });
    }
  }
});

// ==================== UNSUBSCRIBE ====================

/**
 * GET /api/track/unsubscribe/:token
 * Procesa el unsubscribe y muestra página de confirmación
 */
router.get('/unsubscribe/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    console.log(`\n🚫 Unsubscribe request received`);
    
    // Verificar y decodificar token
    const tokenData = verifyUnsubscribeToken(token);
    
    if (!tokenData) {
      console.log('❌ Token inválido o expirado');
      return res.status(400).send(generateErrorPage('Invalid or expired link'));
    }
    
    const { customerId, email, campaignId } = tokenData;  // 🆕 Extraer campaignId
    console.log(`   Email: ${email}`);
    console.log(`   Customer ID: ${customerId}`);
    console.log(`   Campaign ID: ${campaignId || 'N/A'}`);
    
    // Buscar cliente
    const customer = await Customer.findById(customerId);
    
    if (!customer) {
      // Intentar buscar por email como fallback
      const customerByEmail = await Customer.findOne({ email: email.toLowerCase() });
      
      if (!customerByEmail) {
        console.log('❌ Cliente no encontrado');
        return res.status(404).send(generateErrorPage('We could not find your subscription'));
      }
      
      // Usar el encontrado por email
      await processUnsubscribe(customerByEmail);
      return res.send(generateSuccessPage(customerByEmail.email));
    }
    
    // Verificar que el email coincida
    if (customer.email.toLowerCase() !== email.toLowerCase()) {
      console.log('⚠️ Email no coincide, pero procesando de todas formas');
    }
    
    // Verificar si ya está unsubscribed
    if (customer.emailStatus === 'unsubscribed') {
      console.log('ℹ️ Cliente ya estaba unsubscribed');
      return res.send(generateAlreadyUnsubscribedPage(customer.email));
    }
    
    // Procesar unsubscribe
    await processUnsubscribe(customer);
    
    // Registrar evento
    try {
      const eventData = {
        customer: customer._id,
        email: customer.email,
        eventType: 'unsubscribed',
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.connection.remoteAddress,
        metadata: {
          source: 'email_link',
          previousStatus: customer.emailStatus
        }
      };
      
      // 🆕 Incluir campaignId si existe
      if (campaignId) {
        eventData.campaign = campaignId;
      }
      
      await EmailEvent.create(eventData);
      
      // 🆕 Actualizar stats de la campaña si existe
      if (campaignId) {
        try {
          await Campaign.updateStats(campaignId, 'unsubscribed');
        } catch (statsError) {
          console.log('⚠️ Could not update campaign unsubscribe stats:', statsError.message);
        }
      }
    } catch (eventError) {
      console.log('⚠️ No se pudo registrar evento de unsubscribe:', eventError.message);
    }
    
    console.log(`✅ Unsubscribe completado para: ${customer.email}\n`);
    
    // Mostrar página de confirmación
    res.send(generateSuccessPage(customer.email));
    
  } catch (error) {
    console.error('❌ Error procesando unsubscribe:', error);
    res.status(500).send(generateErrorPage('An error occurred. Please try again.'));
  }
});

/**
 * POST /api/track/unsubscribe/:token
 * Alternativa POST para formularios
 */
router.post('/unsubscribe/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { reason } = req.body; // Opcional: razón del unsubscribe
    
    const tokenData = verifyUnsubscribeToken(token);
    
    if (!tokenData) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      });
    }
    
    const customer = await Customer.findById(tokenData.customerId);
    
    if (!customer) {
      return res.status(404).json({ 
        success: false, 
        error: 'Customer not found' 
      });
    }
    
    await processUnsubscribe(customer, reason);
    
    res.json({ 
      success: true, 
      message: 'You have been successfully unsubscribed',
      email: customer.email
    });
    
  } catch (error) {
    console.error('❌ Error en POST unsubscribe:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error processing request' 
    });
  }
});

/**
 * GET /api/track/resubscribe/:token
 * Permite al usuario volver a suscribirse
 */
router.get('/resubscribe/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const tokenData = verifyUnsubscribeToken(token);
    
    if (!tokenData) {
      return res.status(400).send(generateErrorPage('Invalid or expired link'));
    }
    
    const customer = await Customer.findById(tokenData.customerId);
    
    if (!customer) {
      return res.status(404).send(generateErrorPage('Customer not found'));
    }
    
    // Reactivar suscripción
    customer.emailStatus = 'active';
    customer.acceptsMarketing = true;
    await customer.save();
    
    console.log(`✅ Resubscribe completado para: ${customer.email}`);
    
    res.send(generateResubscribePage(customer.email));
    
  } catch (error) {
    console.error('❌ Error en resubscribe:', error);
    res.status(500).send(generateErrorPage('An error occurred'));
  }
});

// ==================== HELPER FUNCTIONS ====================

async function processUnsubscribe(customer, reason = null) {
  // Actualizar estado
  customer.emailStatus = 'unsubscribed';
  customer.acceptsMarketing = false;
  
  // Guardar razón si se proporcionó
  if (reason) {
    customer.unsubscribeReason = reason;
    customer.unsubscribedAt = new Date();
  }
  
  await customer.save();
  
  console.log(`   ✅ emailStatus: unsubscribed`);
  console.log(`   ✅ acceptsMarketing: false`);
  
  // Opcional: Remover de listas activas
  try {
    const mongoose = require('mongoose');
    if (mongoose.modelNames().includes('List')) {
      const List = mongoose.model('List');
      const listsWithMember = await List.find({ members: customer._id });
      
      for (const list of listsWithMember) {
        if (typeof list.removeMember === 'function') {
          await list.removeMember(customer._id);
        }
      }
      
      if (listsWithMember.length > 0) {
        console.log(`   ✅ Removido de ${listsWithMember.length} lista(s)`);
      }
    }
  } catch (listError) {
    console.log(`   ⚠️ No se pudo remover de listas: ${listError.message}`);
  }
}

// ==================== HTML PAGES ====================

function generateSuccessPage(email) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed - Jersey Pickles</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a5d1a 0%, #2e7d32 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #e8f5e9;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h1 {
      color: #1a5d1a;
      font-size: 24px;
      margin-bottom: 16px;
    }
    p {
      color: #666;
      line-height: 1.6;
      margin-bottom: 16px;
    }
    .email {
      background: #f5f5f5;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: monospace;
      color: #333;
      margin: 20px 0;
      word-break: break-all;
    }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      background: #1a5d1a;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      margin-top: 20px;
      transition: background 0.3s;
    }
    .btn:hover { background: #2e7d32; }
    .logo {
      margin-bottom: 24px;
      font-size: 32px;
    }
    .footer {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #eee;
      font-size: 14px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🥒</div>
    <div class="icon">✓</div>
    <h1>You've Been Unsubscribed</h1>
    <p>We've removed your email from our mailing list:</p>
    <div class="email">${email}</div>
    <p>You will no longer receive promotional emails from Jersey Pickles.</p>
    <p style="font-size: 14px; color: #888;">
      Changed your mind? You can always resubscribe.
    </p>
    <a href="https://jerseypickles.com" class="btn">Visit Store</a>
    <div class="footer">
      Jersey Pickles • New Jersey's Finest Pickles<br>
      <a href="mailto:info@jerseypickles.com" style="color: #1a5d1a;">info@jerseypickles.com</a>
    </div>
  </div>
</body>
</html>`;
}

function generateAlreadyUnsubscribedPage(email) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Already Unsubscribed - Jersey Pickles</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a5d1a 0%, #2e7d32 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #fff3e0;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h1 { color: #e65100; font-size: 24px; margin-bottom: 16px; }
    p { color: #666; line-height: 1.6; margin-bottom: 16px; }
    .email {
      background: #f5f5f5;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: monospace;
      color: #333;
      margin: 20px 0;
    }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      background: #1a5d1a;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      margin-top: 20px;
    }
    .logo { margin-bottom: 24px; font-size: 32px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🥒</div>
    <div class="icon">ℹ️</div>
    <h1>Already Unsubscribed</h1>
    <p>The email <strong>${email}</strong> is not subscribed to our mailing list.</p>
    <p>You won't receive promotional emails from Jersey Pickles.</p>
    <a href="https://jerseypickles.com" class="btn">Visit Store</a>
  </div>
</body>
</html>`;
}

function generateResubscribePage(email) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome Back! - Jersey Pickles</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a5d1a 0%, #2e7d32 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #e8f5e9;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h1 { color: #1a5d1a; font-size: 24px; margin-bottom: 16px; }
    p { color: #666; line-height: 1.6; margin-bottom: 16px; }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      background: #1a5d1a;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      margin-top: 20px;
    }
    .logo { margin-bottom: 24px; font-size: 32px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🥒</div>
    <div class="icon">🎉</div>
    <h1>Welcome Back!</h1>
    <p>The email <strong>${email}</strong> has been reactivated.</p>
    <p>You'll receive our exclusive offers and updates again.</p>
    <a href="https://jerseypickles.com" class="btn">Go to Store</a>
  </div>
</body>
</html>`;
}

function generateErrorPage(message) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Jersey Pickles</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #c62828 0%, #e53935 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #ffebee;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h1 { color: #c62828; font-size: 24px; margin-bottom: 16px; }
    p { color: #666; line-height: 1.6; margin-bottom: 16px; }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      background: #1a5d1a;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      margin-top: 20px;
    }
    .logo { margin-bottom: 24px; font-size: 32px; }
    .contact {
      margin-top: 24px;
      font-size: 14px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🥒</div>
    <div class="icon">⚠️</div>
    <h1>Something Went Wrong</h1>
    <p>${message}</p>
    <a href="https://jerseypickles.com" class="btn">Go to Store</a>
    <div class="contact">
      Need help? Contact us at<br>
      <a href="mailto:info@jerseypickles.com" style="color: #1a5d1a;">info@jerseypickles.com</a>
    </div>
  </div>
</body>
</html>`;
}

module.exports = router;