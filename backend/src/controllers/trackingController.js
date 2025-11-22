// backend/src/controllers/trackingController.js (ACTUALIZADO PARA FLOWS)
const EmailEvent = require('../models/EmailEvent');
const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');
const Flow = require('../models/Flow');

class TrackingController {
  
  // Tracking de apertura (pixel)
  async trackOpen(req, res) {
    try {
      const { campaignId, customerId } = req.params;
      const { email } = req.query;
      
      console.log(`📧 Email opened - Campaign: ${campaignId}, Customer: ${customerId}`);
      
      // Detectar si es un Flow ID o Campaign ID
      const isObjectId = /^[0-9a-fA-F]{24}$/.test(campaignId);
      let isFlow = false;
      
      if (isObjectId) {
        // Verificar si existe como Flow
        const flowExists = await Flow.exists({ _id: campaignId });
        isFlow = flowExists;
      }
      
      // Verificar si ya se registró este open
      const query = isFlow 
        ? { flow: campaignId, customer: customerId, eventType: 'opened' }
        : { campaign: campaignId, customer: customerId, eventType: 'opened' };
      
      const existingEvent = await EmailEvent.findOne(query);
      
      if (!existingEvent) {
        // Crear evento según el tipo
        const eventData = {
          customer: customerId,
          email: email || 'unknown',
          eventType: 'opened',
          source: isFlow ? 'flow' : 'campaign',
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip
        };
        
        if (isFlow) {
          eventData.flow = campaignId;
        } else {
          eventData.campaign = campaignId;
        }
        
        await EmailEvent.create(eventData);
        
        // Actualizar stats
        if (isFlow) {
          await Flow.findByIdAndUpdate(campaignId, {
            $inc: { 'metrics.opens': 1 }
          });
          console.log(`✅ Flow open tracked: ${campaignId}`);
        } else {
          try {
            await Campaign.updateStats(campaignId, 'opened');
            console.log(`✅ Campaign open tracked: ${campaignId}`);
          } catch (error) {
            console.error('Error actualizando stats de campaña:', error);
          }
        }
        
        // Actualizar stats de cliente
        await Customer.updateEmailStats(customerId, 'opened');
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
      console.error('❌ Error tracking open:', error);
      
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
      const { url, email } = req.query;
      
      if (!url) {
        return res.status(400).json({ error: 'Missing URL parameter' });
      }
      
      console.log(`🖱️ Click tracked - Campaign: ${campaignId}, URL: ${url}`);
      
      // Detectar si es Flow o Campaign
      const isObjectId = /^[0-9a-fA-F]{24}$/.test(campaignId);
      let isFlow = false;
      
      if (isObjectId) {
        const flowExists = await Flow.exists({ _id: campaignId });
        isFlow = flowExists;
      }
      
      // Crear evento
      const eventData = {
        customer: customerId,
        email: email || 'unknown',
        eventType: 'clicked',
        clickedUrl: decodeURIComponent(url),
        source: isFlow ? 'flow' : 'campaign',
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip
      };
      
      if (isFlow) {
        eventData.flow = campaignId;
      } else {
        eventData.campaign = campaignId;
      }
      
      await EmailEvent.create(eventData);
      
      // Actualizar stats
      if (isFlow) {
        await Flow.findByIdAndUpdate(campaignId, {
          $inc: { 'metrics.clicks': 1 }
        });
      } else {
        await Campaign.updateStats(campaignId, 'clicked');
      }
      
      // Actualizar stats de cliente
      await Customer.updateEmailStats(customerId, 'clicked');
      
      // Redirigir a la URL original
      res.redirect(decodeURIComponent(url));
      
    } catch (error) {
      console.error('❌ Error tracking click:', error);
      
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