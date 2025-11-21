// backend/src/routes/tracking.js (ACTUALIZADO CON EMAIL)
const express = require('express');
const router = express.Router();
const EmailEvent = require('../models/EmailEvent');
const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');
const AttributionService = require('../middleware/attributionTracking');

// Open tracking pixel
router.get('/open/:campaignId/:customerId', async (req, res) => {
  try {
    const { campaignId, customerId } = req.params;
    const { email } = req.query; // ✅ Obtener email del query string
    
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

// 🆕 Click tracking redirect CON COOKIE DE ATRIBUCIÓN Y EMAIL
router.get('/click/:campaignId/:customerId', async (req, res) => {
  try {
    const { campaignId, customerId } = req.params;
    const { url, email } = req.query; // ✅ Obtener email del query string
    
    if (!url) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }
    
    console.log(`🖱️  Link clicked - Campaign: ${campaignId}, URL: ${url}`);
    
    // Registrar evento de click
    await EmailEvent.create({
      campaign: campaignId,
      customer: customerId,
      email: email || 'unknown', // ✅ Guardar email para matching posterior
      eventType: 'clicked',
      clickedUrl: decodeURIComponent(url),
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    await Campaign.updateStats(campaignId, 'clicked');
    await Customer.updateEmailStats(customerId, 'clicked');
    
    console.log(`✅ Click event registered`);
    
    // 🍪 ESTABLECER COOKIE DE ATRIBUCIÓN
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

module.exports = router;