// backend/src/controllers/trackingController.js
const EmailEvent = require('../models/EmailEvent');
const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');

class TrackingController {
  
  // Tracking de apertura (pixel)
  async trackOpen(req, res) {
    try {
      const { campaignId, customerId } = req.params;
      
      // Verificar si ya se registró este open
      const existingEvent = await EmailEvent.findOne({
        campaign: campaignId,
        customer: customerId,
        eventType: 'opened'
      });
      
      if (!existingEvent) {
        // Registrar evento
        await EmailEvent.create({
          campaign: campaignId,
          customer: customerId,
          email: req.query.email || 'unknown',
          eventType: 'opened',
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip
        });
        
        // Actualizar stats de campaña
        await Campaign.findByIdAndUpdate(campaignId, {
          $inc: { 'stats.opened': 1 }
        });
        
        // Actualizar stats de cliente
        await Customer.findByIdAndUpdate(customerId, {
          $inc: { 'emailStats.opened': 1 },
          'emailStats.lastOpenedAt': new Date()
        });
        
        console.log(`📧 Open tracked - Campaign: ${campaignId}, Customer: ${customerId}`);
      }
      
      // Devolver pixel transparente 1x1
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
      
    } catch (error) {
      console.error('Error tracking open:', error);
      
      // Devolver pixel aunque haya error
      const pixel = Buffer.from(
        'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        'base64'
      );
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': pixel.length
      });
      res.end(pixel);
    }
  }

  // Tracking de click
  async trackClick(req, res) {
    try {
      const { campaignId, customerId } = req.params;
      const { url } = req.query;
      
      if (!url) {
        return res.status(400).json({ error: 'Missing URL parameter' });
      }
      
      // Registrar evento
      await EmailEvent.create({
        campaign: campaignId,
        customer: customerId,
        email: req.query.email || 'unknown',
        eventType: 'clicked',
        clickedUrl: decodeURIComponent(url),
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip
      });
      
      // Actualizar stats de campaña
      await Campaign.findByIdAndUpdate(campaignId, {
        $inc: { 'stats.clicked': 1 }
      });
      
      // Actualizar stats de cliente
      await Customer.findByIdAndUpdate(customerId, {
        $inc: { 'emailStats.clicked': 1 },
        'emailStats.lastClickedAt': new Date()
      });
      
      console.log(`🖱️  Click tracked - Campaign: ${campaignId}, URL: ${url}`);
      
      // Redirigir a la URL original
      res.redirect(decodeURIComponent(url));
      
    } catch (error) {
      console.error('Error tracking click:', error);
      
      // Redirigir aunque haya error
      if (req.query.url) {
        res.redirect(decodeURIComponent(req.query.url));
      } else {
        res.status(500).json({ error: 'Error tracking click' });
      }
    }
  }
}

module.exports = new TrackingController();