// backend/src/controllers/campaignsController.js
const Campaign = require('../models/Campaign');
const Segment = require('../models/Segment');
const Customer = require('../models/Customer');
const EmailEvent = require('../models/EmailEvent');
const emailService = require('../services/emailService');
const templateService = require('../services/templateService');
const segmentationService = require('../services/segmentationService');
const emailQueue = require('../jobs/emailQueue');

class CampaignsController {
  
  // Listar campañas
  async list(req, res) {
    try {
      const { 
        page = 1, 
        limit = 20,
        status = null 
      } = req.query;
      
      const query = {};
      if (status) {
        query.status = status;
      }
      
      const campaigns = await Campaign.find(query)
        .populate('segment', 'name customerCount')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);
      
      const total = await Campaign.countDocuments(query);
      
      res.json({
        campaigns,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      });
      
    } catch (error) {
      console.error('Error listando campañas:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener una campaña
  async getOne(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      res.json(campaign);
      
    } catch (error) {
      console.error('Error obteniendo campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Crear campaña
  async create(req, res) {
    try {
      const {
        name,
        subject,
        htmlContent,
        previewText,
        segmentId,
        fromName,
        fromEmail,
        replyTo,
        scheduledAt,
        tags
      } = req.body;
      
      // Validar que el segmento existe
      const segment = await Segment.findById(segmentId);
      if (!segment) {
        return res.status(404).json({ error: 'Segmento no encontrado' });
      }
      
      const campaign = await Campaign.create({
        name,
        subject,
        htmlContent,
        previewText,
        segment: segmentId,
        fromName: fromName || 'Jersey Pickles',
        fromEmail: fromEmail || 'orders@jerseypickles.com',
        replyTo,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        tags,
        'stats.totalRecipients': segment.customerCount
      });
      
      console.log(`✅ Campaña creada: ${name}`);
      
      res.status(201).json(campaign);
      
    } catch (error) {
      console.error('Error creando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Actualizar campaña
  async update(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      // Solo se puede editar si está en draft
      if (campaign.status !== 'draft') {
        return res.status(400).json({ 
          error: 'Solo se pueden editar campañas en borrador' 
        });
      }
      
      const {
        name,
        subject,
        htmlContent,
        previewText,
        segmentId,
        fromName,
        fromEmail,
        replyTo,
        scheduledAt,
        tags
      } = req.body;
      
      if (name) campaign.name = name;
      if (subject) campaign.subject = subject;
      if (htmlContent) campaign.htmlContent = htmlContent;
      if (previewText !== undefined) campaign.previewText = previewText;
      if (fromName) campaign.fromName = fromName;
      if (fromEmail) campaign.fromEmail = fromEmail;
      if (replyTo !== undefined) campaign.replyTo = replyTo;
      if (scheduledAt !== undefined) campaign.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
      if (tags) campaign.tags = tags;
      
      if (segmentId && segmentId !== campaign.segment.toString()) {
        const segment = await Segment.findById(segmentId);
        if (!segment) {
          return res.status(404).json({ error: 'Segmento no encontrado' });
        }
        campaign.segment = segmentId;
        campaign.stats.totalRecipients = segment.customerCount;
      }
      
      await campaign.save();
      
      console.log(`✅ Campaña actualizada: ${campaign.name}`);
      
      res.json(campaign);
      
    } catch (error) {
      console.error('Error actualizando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Eliminar campaña
  async delete(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      // No se puede eliminar si ya fue enviada
      if (campaign.status === 'sent') {
        return res.status(400).json({ 
          error: 'No se pueden eliminar campañas que ya fueron enviadas' 
        });
      }
      
      await Campaign.findByIdAndDelete(req.params.id);
      
      console.log(`🗑️  Campaña eliminada: ${campaign.name}`);
      
      res.json({ 
        success: true, 
        message: 'Campaña eliminada correctamente' 
      });
      
    } catch (error) {
      console.error('Error eliminando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Enviar campaña (el más importante)
  async send(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      // Validar estado
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
        return res.status(400).json({ 
          error: `No se puede enviar campaña con estado: ${campaign.status}` 
        });
      }
      
      console.log('\n╔═══════════════════════════════════════════════╗');
      console.log(`║  📧 ENVIANDO CAMPAÑA: ${campaign.name}`);
      console.log('╚═══════════════════════════════════════════════╝\n');
      
      // Obtener clientes del segmento
      const customers = await segmentationService.evaluateSegment(
        campaign.segment.conditions,
        { select: 'email firstName lastName _id' }
      );
      
      if (customers.length === 0) {
        return res.status(400).json({ 
          error: 'El segmento no tiene clientes' 
        });
      }
      
      console.log(`👥 Destinatarios: ${customers.length} clientes`);
      
      // Actualizar estado de campaña
      campaign.status = 'sending';
      campaign.stats.totalRecipients = customers.length;
      await campaign.save();
      
      // Opciones de envío
      const { testMode = false, testEmail = null } = req.body;
      
      if (testMode && testEmail) {
        // MODO TEST: Enviar solo a email de prueba
        console.log(`🧪 MODO TEST: Enviando a ${testEmail}\n`);
        
        const testCustomer = customers[0] || { 
          firstName: 'Test', 
          lastName: 'User',
          email: testEmail 
        };
        
        let html = campaign.htmlContent;
        html = emailService.personalize(html, testCustomer);
        html = emailService.injectTracking(html, campaign._id, testCustomer._id || 'test');
        
        const result = await emailService.sendEmail({
          to: testEmail,
          subject: `[TEST] ${campaign.subject}`,
          html,
          from: `${campaign.fromName} <${campaign.fromEmail}>`,
          replyTo: campaign.replyTo
        });
        
        if (result.success) {
          console.log('✅ Email de prueba enviado\n');
          return res.json({
            success: true,
            testMode: true,
            message: `Email de prueba enviado a ${testEmail}`,
            emailId: result.id
          });
        } else {
          throw new Error(result.error);
        }
      }
      
      // MODO PRODUCCIÓN: Envío masivo
      console.log('🚀 Iniciando envío masivo...\n');
      
      const startTime = Date.now();
      let sent = 0;
      let failed = 0;
      
      // Preparar emails
      const emails = customers.map(customer => {
        let html = campaign.htmlContent;
        html = emailService.personalize(html, customer);
        html = emailService.injectTracking(html, campaign._id, customer._id);
        
        return {
          to: customer.email,
          subject: campaign.subject,
          html,
          from: `${campaign.fromName} <${campaign.fromEmail}>`,
          replyTo: campaign.replyTo,
          customerId: customer._id,
          campaignId: campaign._id
        };
      });
      
      // Enviar en lotes de 10 con delays
      const results = await emailService.sendBulkEmails(emails, {
        chunkSize: 10,
        delayBetweenChunks: 1000
      });
      
      // Registrar eventos
      for (const detail of results.details) {
        try {
          const customer = customers.find(c => c.email === detail.email);
          
          if (detail.status === 'sent' && customer) {
            // Registrar como enviado
            await EmailEvent.create({
              campaign: campaign._id,
              customer: customer._id,
              email: customer.email,
              eventType: 'sent',
              resendId: detail.id
            });
            sent++;
          } else {
            failed++;
          }
        } catch (error) {
          console.error('Error registrando evento:', error.message);
        }
      }
      
      // Actualizar estadísticas de campaña
      campaign.status = 'sent';
      campaign.sentAt = new Date();
      campaign.stats.sent = sent;
      campaign.stats.delivered = sent; // Asumimos que si se envió, se entregó
      campaign.updateRates();
      await campaign.save();
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('\n╔═══════════════════════════════════════════════╗');
      console.log('║  ✅ CAMPAÑA ENVIADA                           ║');
      console.log('╚═══════════════════════════════════════════════╝');
      console.log(`📊 Total destinatarios: ${customers.length}`);
      console.log(`✅ Enviados: ${sent}`);
      console.log(`❌ Fallidos: ${failed}`);
      console.log(`⏱️  Tiempo: ${duration}s`);
      console.log('═══════════════════════════════════════════════\n');
      
      res.json({
        success: true,
        campaign: campaign.toObject(),
        results: {
          sent,
          failed,
          total: customers.length,
          duration: `${duration}s`
        }
      });
      
    } catch (error) {
      console.error('\n❌ Error enviando campaña:', error);
      
      // Marcar campaña como fallida
      try {
        await Campaign.findByIdAndUpdate(req.params.id, {
          status: 'draft'
        });
      } catch (err) {
        console.error('Error actualizando estado:', err);
      }
      
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  // Duplicar campaña
  async duplicate(req, res) {
    try {
      const original = await Campaign.findById(req.params.id);
      
      if (!original) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      const duplicate = await Campaign.create({
        name: `${original.name} (Copia)`,
        subject: original.subject,
        htmlContent: original.htmlContent,
        previewText: original.previewText,
        segment: original.segment,
        fromName: original.fromName,
        fromEmail: original.fromEmail,
        replyTo: original.replyTo,
        tags: original.tags,
        status: 'draft'
      });
      
      console.log(`📋 Campaña duplicada: ${duplicate.name}`);
      
      res.status(201).json(duplicate);
      
    } catch (error) {
      console.error('Error duplicando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Estadísticas de una campaña
  async getStats(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      // Obtener eventos agrupados
      const eventStats = await EmailEvent.aggregate([
        {
          $match: { campaign: campaign._id }
        },
        {
          $group: {
            _id: '$eventType',
            count: { $sum: 1 }
          }
        }
      ]);
      
      // Últimos eventos
      const recentEvents = await EmailEvent.find({ campaign: campaign._id })
        .populate('customer', 'email firstName lastName')
        .sort({ eventDate: -1 })
        .limit(50);
      
      res.json({
        campaign: {
          id: campaign._id,
          name: campaign.name,
          status: campaign.status,
          stats: campaign.stats
        },
        eventStats,
        recentEvents
      });
      
    } catch (error) {
      console.error('Error obteniendo stats de campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Crear campaña rápida con template
  async createFromTemplate(req, res) {
    try {
      const { 
        templateType, 
        name, 
        subject,
        segmentId,
        templateData = {}
      } = req.body;
      
      let htmlContent;
      
      switch (templateType) {
        case 'welcome':
          htmlContent = templateService.getWelcomeEmail(
            '{{firstName}}',
            templateData.discountCode || 'BIENVENIDO15'
          );
          break;
          
        case 'abandoned_cart':
          htmlContent = templateService.getAbandonedCartEmail(
            '{{firstName}}',
            templateData.cartItems || [],
            templateData.cartUrl || 'https://jerseypickles.com/cart'
          );
          break;
          
        case 'promotional':
          htmlContent = templateService.getPromotionalEmail(
            templateData.title || 'Oferta Especial',
            templateData.message || 'No te pierdas esta increíble oferta',
            templateData.ctaText || 'Comprar Ahora',
            templateData.ctaUrl || 'https://jerseypickles.com',
            templateData.imageUrl
          );
          break;
          
        default:
          return res.status(400).json({ 
            error: 'Tipo de template no válido',
            validTypes: ['welcome', 'abandoned_cart', 'promotional']
          });
      }
      
      const campaign = await Campaign.create({
        name: name || `Campaña ${templateType}`,
        subject: subject || `Mensaje de Jersey Pickles`,
        htmlContent,
        segment: segmentId,
        status: 'draft'
      });
      
      console.log(`✅ Campaña creada desde template: ${templateType}`);
      
      res.status(201).json(campaign);
      
    } catch (error) {
      console.error('Error creando campaña desde template:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new CampaignsController();