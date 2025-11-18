// backend/src/routes/tracking.js
const express = require('express');
const router = express.Router();
const EmailEvent = require('../models/EmailEvent');
const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');

// Open tracking pixel
router.get('/open/:campaignId/:customerId', async (req, res) => {
  try {
    const { campaignId, customerId } = req.params;
    
    console.log(`📧 Email opened - Campaign: ${campaignId}, Customer: ${customerId}`);
    
    // Verificar si ya se registró este open (evitar duplicados)
    const existingEvent = await EmailEvent.findOne({
      campaign: campaignId,
      customer: customerId,
      eventType: 'opened'
    });
    
    if (!existingEvent) {
      // Registrar evento en la base de datos
      await EmailEvent.create({
        campaign: campaignId,
        customer: customerId,
        email: req.query.email || 'unknown',
        eventType: 'opened',
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.connection.remoteAddress
      });
      
      // Actualizar stats de campaña
      await Campaign.updateStats(campaignId, 'opened');
      
      // Actualizar stats de cliente
      await Customer.updateEmailStats(customerId, 'opened');
      
      console.log(`✅ Open event registered`);
    } else {
      console.log(`⏭️  Open already registered`);
    }
    
  } catch (error) {
    console.error('❌ Error tracking open:', error);
    // No fallar, simplemente registrar el error
  }
  
  // SIEMPRE devolver pixel transparente 1x1 (incluso si hay error)
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

// Click tracking redirect
router.get('/click/:campaignId/:customerId', async (req, res) => {
  try {
    const { campaignId, customerId } = req.params;
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }
    
    console.log(`🖱️  Link clicked - Campaign: ${campaignId}, URL: ${url}`);
    
    // Registrar evento en la base de datos
    await EmailEvent.create({
      campaign: campaignId,
      customer: customerId,
      email: req.query.email || 'unknown',
      eventType: 'clicked',
      clickedUrl: decodeURIComponent(url),
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    // Actualizar stats de campaña
    await Campaign.updateStats(campaignId, 'clicked');
    
    // Actualizar stats de cliente
    await Customer.updateEmailStats(customerId, 'clicked');
    
    console.log(`✅ Click event registered`);
    
    // Redirigir a la URL original
    res.redirect(decodeURIComponent(url));
    
  } catch (error) {
    console.error('❌ Error tracking click:', error);
    
    // Redirigir aunque haya error (no romper experiencia del usuario)
    if (req.query.url) {
      res.redirect(decodeURIComponent(req.query.url));
    } else {
      res.status(500).json({ error: 'Error tracking click' });
    }
  }
});

module.exports = router;