// backend/src/controllers/campaignsController.js - OPTIMIZADO PARA 100K+
const Campaign = require('../models/Campaign');
const Segment = require('../models/Segment');
const List = require('../models/List');
const Customer = require('../models/Customer');
const EmailSend = require('../models/EmailSend');
const EmailEvent = require('../models/EmailEvent');
const emailService = require('../services/emailService');
const templateService = require('../services/templateService');
const segmentationService = require('../services/segmentationService');
const crypto = require('crypto');

class CampaignsController {
  
  // ==================== CRUD BÁSICO ====================
  
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
        .populate('list', 'name memberCount')
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

  async getOne(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment')
        .populate('list');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      res.json(campaign);
      
    } catch (error) {
      console.error('Error obteniendo campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async create(req, res) {
    try {
      const {
        name,
        subject,
        htmlContent,
        previewText,
        targetType = 'segment',
        segmentId,
        listId,
        fromName,
        fromEmail,
        replyTo,
        scheduledAt,
        tags,
        templateBlocks
      } = req.body;
      
      let totalRecipients = 0;
      
      if (targetType === 'segment') {
        if (!segmentId) {
          return res.status(400).json({ error: 'Debes seleccionar un segmento' });
        }
        const segment = await Segment.findById(segmentId);
        if (!segment) {
          return res.status(404).json({ error: 'Segmento no encontrado' });
        }
        totalRecipients = segment.customerCount;
      } else if (targetType === 'list') {
        if (!listId) {
          return res.status(400).json({ error: 'Debes seleccionar una lista' });
        }
        const list = await List.findById(listId);
        if (!list) {
          return res.status(404).json({ error: 'Lista no encontrada' });
        }
        totalRecipients = list.memberCount;
      }
      
      const campaign = await Campaign.create({
        name,
        subject,
        htmlContent,
        previewText,
        targetType,
        segment: targetType === 'segment' ? segmentId : null,
        list: targetType === 'list' ? listId : null,
        fromName: fromName || 'Jersey Pickles',
        fromEmail: fromEmail || 'info@jerseypickles.com',
        replyTo,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        tags,
        templateBlocks: templateBlocks || [],
        'stats.totalRecipients': totalRecipients
      });
      
      console.log(`✅ Campaña creada: ${name} (${targetType})`);
      
      res.status(201).json(campaign);
      
    } catch (error) {
      console.error('Error creando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async update(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
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
        targetType,
        segmentId,
        listId,
        fromName,
        fromEmail,
        replyTo,
        scheduledAt,
        tags,
        templateBlocks
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
      if (templateBlocks) campaign.templateBlocks = templateBlocks;
      
      if (targetType) {
        campaign.targetType = targetType;
        
        if (targetType === 'segment') {
          if (segmentId && segmentId !== campaign.segment?.toString()) {
            const segment = await Segment.findById(segmentId);
            if (!segment) {
              return res.status(404).json({ error: 'Segmento no encontrado' });
            }
            campaign.segment = segmentId;
            campaign.list = null;
            campaign.stats.totalRecipients = segment.customerCount;
          }
        } else if (targetType === 'list') {
          if (listId && listId !== campaign.list?.toString()) {
            const list = await List.findById(listId);
            if (!list) {
              return res.status(404).json({ error: 'Lista no encontrada' });
            }
            campaign.list = listId;
            campaign.segment = null;
            campaign.stats.totalRecipients = list.memberCount;
          }
        }
      }
      
      await campaign.save();
      
      console.log(`✅ Campaña actualizada: ${campaign.name}`);
      
      res.json(campaign);
      
    } catch (error) {
      console.error('Error actualizando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async delete(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
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
        targetType: original.targetType,
        segment: original.segment,
        list: original.list,
        fromName: original.fromName,
        fromEmail: original.fromEmail,
        replyTo: original.replyTo,
        tags: original.tags,
        templateBlocks: original.templateBlocks || [],
        status: 'draft'
      });
      
      console.log(`📋 Campaña duplicada: ${duplicate.name}`);
      
      res.status(201).json(duplicate);
      
    } catch (error) {
      console.error('Error duplicando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== ENVÍO DE CAMPAÑA - OPTIMIZADO PARA 100K+ ====================
  
  async send(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment')
        .populate('list');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
        return res.status(400).json({ 
          error: `No se puede enviar campaña con estado: ${campaign.status}` 
        });
      }
      
      console.log('\n╔════════════════════════════════════════════════╗');
      console.log(`║  📧 ENVIANDO: ${campaign.name.substring(0, 35)}`);
      console.log('╚════════════════════════════════════════════════╝\n');
      
      const { testMode = false, testEmail = null } = req.body;
      
      // ==================== MODO TEST ====================
      if (testMode && testEmail) {
        return await this.sendTestEmail(campaign, testEmail, res);
      }
      
      // ==================== MODO PRODUCCIÓN ====================
      const { addCampaignToQueue, isAvailable } = require('../jobs/emailQueue');
      
      if (!isAvailable()) {
        return res.status(400).json({
          error: 'Redis no disponible',
          message: 'Configura REDIS_URL (Upstash) para envíos masivos'
        });
      }
      
      const startTime = Date.now();
      
      // ========== PASO 1: Contar destinatarios ==========
      let totalRecipients = 0;
      
      if (campaign.targetType === 'list') {
        const list = await List.findById(campaign.list._id).select('members');
        totalRecipients = list?.members?.length || 0;
      } else {
        totalRecipients = await segmentationService.countSegment(campaign.segment.conditions);
      }
      
      if (totalRecipients === 0) {
        return res.status(400).json({ 
          error: campaign.targetType === 'list' 
            ? 'La lista no tiene miembros' 
            : 'El segmento no tiene clientes' 
        });
      }
      
      console.log(`👥 Total destinatarios: ${totalRecipients.toLocaleString()}`);
      
      // ========== PASO 2: Actualizar campaña a "sending" ==========
      campaign.status = 'sending';
      campaign.stats.totalRecipients = totalRecipients;
      campaign.stats.sent = 0;
      campaign.stats.delivered = 0;
      campaign.stats.failed = 0;
      campaign.sentAt = new Date();
      await campaign.save();
      
      // ========== PASO 3: Responder inmediatamente ==========
      const estimatedSeconds = Math.ceil(totalRecipients / 200); // ~200 emails/s
      const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
      
      res.json({
        success: true,
        campaign: {
          _id: campaign._id,
          name: campaign.name,
          status: 'sending',
          stats: campaign.stats
        },
        queue: {
          totalEmails: totalRecipients,
          processing: true,
          estimatedTime: estimatedMinutes > 1 
            ? `${estimatedMinutes} minutos` 
            : `${estimatedSeconds} segundos`,
          message: `Procesando ${totalRecipients.toLocaleString()} emails...`,
          checkStatusAt: `/api/campaigns/${campaign._id}/stats`
        }
      });
      
      // ========== PASO 4: Procesar en background ==========
      setImmediate(async () => {
        try {
          await this.processCampaignInBackground({
            campaign,
            totalRecipients,
            startTime
          });
        } catch (error) {
          console.error('\n❌ Error en background:', error);
          
          try {
            await Campaign.findByIdAndUpdate(campaign._id, {
              status: 'draft',
              'stats.error': error.message
            });
            console.log('⚠️  Campaña revertida a draft\n');
          } catch (err) {
            console.error('Error revertiendo:', err);
          }
        }
      });
      
    } catch (error) {
      console.error('\n❌ Error enviando campaña:', error);
      
      try {
        await Campaign.findByIdAndUpdate(req.params.id, { 
          status: 'draft',
          'stats.error': error.message
        });
      } catch (err) {
        console.error('Error revertiendo:', err);
      }
      
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }
  
  // ========== PROCESAMIENTO EN BACKGROUND ==========
  
  async processCampaignInBackground(options) {
    const { campaign, totalRecipients, startTime } = options;
    const { addCampaignToQueue } = require('../jobs/emailQueue');
    
    console.log('📥 Procesamiento background iniciado...\n');
    
    const CHUNK_SIZE = 500; // Procesar 500 customers a la vez
    const campaignId = campaign._id.toString();
    const htmlTemplate = campaign.htmlContent;
    const subject = campaign.subject;
    const fromName = campaign.fromName;
    const fromEmail = campaign.fromEmail;
    const replyTo = campaign.replyTo;
    
    let processedCount = 0;
    let createdEmailSends = 0;
    const allRecipients = [];
    
    try {
      // ========== CREAR CURSOR SEGÚN TIPO ==========
      let cursor;
      
      if (campaign.targetType === 'list') {
        const list = await List.findById(campaign.list._id).select('members');
        const memberIds = list?.members || [];
        
        cursor = Customer
          .find({ _id: { $in: memberIds } })
          .select('email firstName lastName _id')
          .lean()
          .cursor({ batchSize: CHUNK_SIZE });
          
      } else {
        // Para segmentos
        cursor = await segmentationService.getCursorForSegment(
          campaign.segment.conditions,
          { select: 'email firstName lastName _id' }
        );
      }
      
      // ========== ITERAR CON CURSOR (memoria eficiente) ==========
      for await (const customer of cursor) {
        processedCount++;
        
        // Generar jobId determinístico
        const jobId = this.generateJobId(campaignId, customer.email);
        
        // ========== Crear EmailSend record (idempotencia) ==========
        try {
          await EmailSend.findOneAndUpdate(
            {
              campaignId,
              recipientEmail: customer.email.toLowerCase().trim()
            },
            {
              $setOnInsert: {
                jobId,
                campaignId,
                recipientEmail: customer.email.toLowerCase().trim(),
                customerId: customer._id,
                status: 'pending',
                attempts: 0,
                createdAt: new Date()
              }
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true
            }
          );
          
          createdEmailSends++;
          
        } catch (error) {
          if (error.code === 11000) {
            // Duplicate - ya existe
            console.log(`   ⚠️  Email duplicado: ${customer.email}, skipping`);
            continue;
          }
          throw error;
        }
        
        // ========== Personalizar email ==========
        let html = htmlTemplate;
        html = emailService.personalize(html, customer);
        html = emailService.injectTracking(
          html,
          campaignId,
          customer._id.toString(),
          customer.email
        );
        
        allRecipients.push({
          email: customer.email,
          subject: subject,
          html: html,
          from: `${fromName} <${fromEmail}>`,
          replyTo: replyTo,
          customerId: customer._id.toString()
        });
        
        // Log progreso
        if (processedCount % 1000 === 0) {
          console.log(`   📊 Procesados: ${processedCount.toLocaleString()} / ${totalRecipients.toLocaleString()}`);
        }
      }
      
      console.log(`\n✅ Preparación completada:`);
      console.log(`   Total procesados: ${processedCount.toLocaleString()}`);
      console.log(`   EmailSend records: ${createdEmailSends.toLocaleString()}`);
      
      // ========== Encolar todos los emails ==========
      if (allRecipients.length === 0) {
        console.log('⚠️  No hay recipientes para encolar\n');
        
        await Campaign.findByIdAndUpdate(campaignId, {
          status: 'sent',
          'stats.error': 'No hay destinatarios válidos'
        });
        
        return;
      }
      
      console.log(`\n📤 Encolando ${allRecipients.length.toLocaleString()} emails...\n`);
      
      const queueResult = await addCampaignToQueue(allRecipients, campaignId);
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('╔════════════════════════════════════════════════╗');
      console.log('║  ✅ CAMPAÑA ENCOLADA EXITOSAMENTE             ║');
      console.log('╚════════════════════════════════════════════════╝');
      console.log(`📊 Total emails: ${queueResult.totalEmails.toLocaleString()}`);
      console.log(`📦 Total batches: ${queueResult.totalJobs}`);
      console.log(`⏱️  Tiempo preparación: ${duration}s`);
      console.log(`🚀 Workers procesando...`);
      console.log('════════════════════════════════════════════════\n');
      
    } catch (error) {
      console.error('❌ Error en procesamiento:', error);
      throw error;
    }
  }
  
  // ========== ENVÍO DE EMAIL DE PRUEBA ==========
  
  async sendTestEmail(campaign, testEmail, res) {
    console.log(`🧪 MODO TEST: Enviando a ${testEmail}\n`);
    
    try {
      let testCustomer;
      
      if (campaign.targetType === 'list') {
        const list = await List.findById(campaign.list._id).select('members');
        if (list && list.members.length > 0) {
          testCustomer = await Customer.findById(list.members[0])
            .select('email firstName lastName _id')
            .lean();
        }
      } else {
        const customers = await segmentationService.evaluateSegment(
          campaign.segment.conditions,
          { select: 'email firstName lastName _id', limit: 1 }
        );
        testCustomer = customers[0];
      }
      
      if (!testCustomer) {
        testCustomer = { 
          firstName: 'Test', 
          lastName: 'User', 
          email: testEmail,
          _id: 'test'
        };
      }
      
      let html = campaign.htmlContent;
      html = emailService.personalize(html, testCustomer);
      html = emailService.injectTracking(
        html,
        campaign._id.toString(),
        testCustomer._id.toString(),
        testEmail
      );
      
      const result = await emailService.sendEmail({
        to: testEmail,
        subject: `[TEST] ${campaign.subject}`,
        html,
        from: `${campaign.fromName} <${campaign.fromEmail}>`,
        replyTo: campaign.replyTo,
        tags: [
          { name: 'campaign_id', value: campaign._id.toString() },
          { name: 'test', value: 'true' }
        ]
      });
      
      if (result.success) {
        console.log('✅ Email de prueba enviado\n');
        return res.json({
          success: true,
          testMode: true,
          message: `Email enviado a ${testEmail}`,
          emailId: result.id
        });
      } else {
        throw new Error(result.error);
      }
      
    } catch (error) {
      console.error('❌ Error enviando test:', error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // ========== UTILIDADES ==========
  
  generateJobId(campaignId, email) {
    const normalized = `${campaignId}:${email.toLowerCase().trim()}`;
    return crypto
      .createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 24);
  }
  
  // ==================== ESTADÍSTICAS ====================
  
  async getStats(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment', 'name')
        .populate('list', 'name');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      // Stats desde EmailSend (más preciso)
      const emailSendStats = await EmailSend.getCampaignStats(req.params.id);
      
      // Eventos
      const events = await EmailEvent.find({ campaign: req.params.id })
        .populate('customer', 'email firstName lastName')
        .sort({ eventDate: -1 });
      
      const stats = {
        total: emailSendStats.total,
        pending: emailSendStats.pending,
        processing: emailSendStats.processing,
        sent: emailSendStats.sent,
        delivered: emailSendStats.delivered,
        failed: emailSendStats.failed,
        bounced: emailSendStats.bounced,
        opened: events.filter(e => e.eventType === 'opened').length,
        clicked: events.filter(e => e.eventType === 'clicked').length,
        complained: events.filter(e => e.eventType === 'complained').length,
        purchased: campaign.stats.purchased || 0,
      };
      
      const totalDelivered = stats.delivered || stats.sent || 1;
      const rates = {
        deliveryRate: stats.sent > 0 ? ((stats.delivered / stats.sent) * 100).toFixed(1) : '0.0',
        openRate: totalDelivered > 0 ? ((stats.opened / totalDelivered) * 100).toFixed(1) : '0.0',
        clickRate: stats.opened > 0 ? ((stats.clicked / stats.opened) * 100).toFixed(1) : '0.0',
        bounceRate: stats.sent > 0 ? ((stats.bounced / stats.sent) * 100).toFixed(1) : '0.0',
        clickToOpenRate: stats.opened > 0 ? ((stats.clicked / stats.opened) * 100).toFixed(1) : '0.0',
        conversionRate: campaign.stats.conversionRate || 0,
      };
      
      // Stats por fuente
      const statsBySource = {
        custom: events.filter(e => e.source === 'custom').length,
        resend: events.filter(e => e.source === 'resend').length,
        shopify: events.filter(e => e.source === 'shopify').length,
      };
      
      // Top links
      const clickEvents = events.filter(e => e.eventType === 'clicked' && e.metadata?.url);
      const linkCounts = {};
      clickEvents.forEach(event => {
        const url = event.metadata.url;
        linkCounts[url] = (linkCounts[url] || 0) + 1;
      });
      const topLinks = Object.entries(linkCounts)
        .map(([url, clicks]) => ({ url, clicks }))
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 10);
      
      // Revenue
      const Order = require('../models/Order');
      const orders = await Order.find({
        'attribution.campaign': req.params.id
      }).populate('customer', 'email firstName lastName');
      
      const productCounts = {};
      const productRevenue = {};
      
      orders.forEach(order => {
        if (order.lineItems && Array.isArray(order.lineItems)) {
          order.lineItems.forEach(item => {
            const key = item.title || item.name;
            if (key) {
              productCounts[key] = (productCounts[key] || 0) + (item.quantity || 1);
              productRevenue[key] = (productRevenue[key] || 0) + (item.price * (item.quantity || 1));
            }
          });
        }
      });
      
      const topProducts = Object.entries(productCounts)
        .map(([title, quantity]) => ({
          title,
          quantity,
          revenue: productRevenue[title] || 0
        }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);
      
      const recentEvents = events.slice(0, 50);
      
      // Timeline
      const last30Days = Array.from({ length: 30 }, (_, i) => {
        const date = new Date();
        date.setDate(date.getDate() - (29 - i));
        date.setHours(0, 0, 0, 0);
        return date;
      });
      
      const timeline = last30Days.map(date => {
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        
        const dayEvents = events.filter(e => {
          const eventDate = new Date(e.eventDate);
          return eventDate >= date && eventDate < nextDay;
        });
        
        const dayOrders = orders.filter(order => {
          const orderDate = new Date(order.createdAt);
          return orderDate >= date && orderDate < nextDay;
        });
        
        const dayRevenue = dayOrders.reduce((sum, order) => 
          sum + (order.totalPrice || 0), 0
        );
        
        return {
          date: date.toISOString().split('T')[0],
          dateLabel: date.toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
          sent: dayEvents.filter(e => e.eventType === 'sent').length,
          opened: dayEvents.filter(e => e.eventType === 'opened').length,
          clicked: dayEvents.filter(e => e.eventType === 'clicked').length,
          bounced: dayEvents.filter(e => e.eventType === 'bounced').length,
          purchased: dayOrders.length,
          revenue: dayRevenue,
        };
      });
      
      // Top customers
      const customerActivity = {};
      
      const validEvents = events.filter(event => 
        event.customer && 
        event.customer._id && 
        (event.eventType === 'opened' || event.eventType === 'clicked')
      );
      
      validEvents.forEach(event => {
        const customerId = event.customer._id.toString();
        
        if (!customerActivity[customerId]) {
          customerActivity[customerId] = {
            customer: event.customer,
            opens: 0,
            clicks: 0,
            purchases: 0,
            revenue: 0,
            total: 0
          };
        }
        
        if (event.eventType === 'opened') customerActivity[customerId].opens++;
        if (event.eventType === 'clicked') customerActivity[customerId].clicks++;
        customerActivity[customerId].total++;
      });
      
      orders.forEach(order => {
        if (order.customer && order.customer._id) {
          const customerId = order.customer._id.toString();
          
          if (!customerActivity[customerId]) {
            customerActivity[customerId] = {
              customer: order.customer,
              opens: 0,
              clicks: 0,
              purchases: 0,
              revenue: 0,
              total: 0
            };
          }
          
          customerActivity[customerId].purchases++;
          customerActivity[customerId].revenue += order.totalPrice || 0;
          customerActivity[customerId].total++;
        }
      });
      
      const topCustomers = Object.values(customerActivity)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);
      
      const revenue = {
        total: campaign.stats.totalRevenue || 0,
        purchases: campaign.stats.purchased || 0,
        averageOrderValue: campaign.stats.averageOrderValue || 0,
        revenuePerEmail: campaign.stats.revenuePerEmail || 0,
        conversionRate: campaign.stats.conversionRate || 0,
      };
      
      res.json({
        campaign: {
          id: campaign._id,
          name: campaign.name,
          subject: campaign.subject,
          status: campaign.status,
          sentAt: campaign.sentAt,
          targetType: campaign.targetType,
          list: campaign.list,
          segment: campaign.segment,
          stats: campaign.stats,
        },
        stats,
        rates,
        statsBySource,
        topLinks,
        topCustomers,
        topProducts,
        recentEvents,
        timeline,
        totalEvents: events.length,
        revenue,
        emailSendStats
      });
      
    } catch (error) {
      console.error('Error obteniendo stats:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async getEvents(req, res) {
    try {
      const { page = 1, limit = 50, eventType, source } = req.query;
      
      const campaign = await Campaign.findById(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      const filter = { campaign: req.params.id };
      if (eventType) filter.eventType = eventType;
      if (source) filter.source = source;
      
      const events = await EmailEvent.find(filter)
        .populate('customer', 'email firstName lastName')
        .sort({ eventDate: -1 })
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit));
      
      const total = await EmailEvent.countDocuments(filter);
      
      res.json({
        events,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      });
      
    } catch (error) {
      console.error('Error obteniendo eventos:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== TEMPLATES Y UTILIDADES ====================

  async createFromTemplate(req, res) {
    try {
      const { 
        templateType, 
        name, 
        subject,
        targetType = 'segment',
        segmentId,
        listId,
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
        targetType,
        segment: targetType === 'segment' ? segmentId : null,
        list: targetType === 'list' ? listId : null,
        status: 'draft'
      });
      
      console.log(`✅ Campaña desde template: ${templateType}`);
      
      res.status(201).json(campaign);
      
    } catch (error) {
      console.error('Error creando desde template:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async cleanupDrafts(req, res) {
    try {
      const result = await Campaign.deleteMany({ status: 'draft' });
      console.log(`🗑️  ${result.deletedCount} borradores eliminados`);
      
      res.json({ 
        success: true, 
        message: `${result.deletedCount} campañas borrador eliminadas`,
        deletedCount: result.deletedCount
      });
      
    } catch (error) {
      console.error('Error limpiando borradores:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== QUEUE MANAGEMENT ====================

  async getQueueStatus(req, res) {
    try {
      const emailQueueModule = require('../jobs/emailQueue');
      const status = await emailQueueModule.getQueueStatus();
      
      if (!status.available) {
        return res.json(status);
      }
      
      let currentCampaign = null;
      
      // Intentar obtener información de campaña actual
      try {
        // Verificar que los métodos existen
        if (typeof emailQueueModule.getActiveJobs !== 'function' || 
            typeof emailQueueModule.getWaitingJobs !== 'function') {
          console.warn('⚠️  getActiveJobs/getWaitingJobs no disponibles');
          return res.json({
            ...status,
            currentCampaign: null,
            timestamp: new Date().toISOString()
          });
        }
        
        const activeJobs = await emailQueueModule.getActiveJobs();
        const waitingJobs = await emailQueueModule.getWaitingJobs();
        
        const job = activeJobs[0] || waitingJobs[0];
        
        if (job && job.data && job.data.campaignId) {
          const campaign = await Campaign.findById(job.data.campaignId);
          
          if (campaign) {
            const totalInQueue = (status.waiting || 0) + (status.active || 0) + (status.delayed || 0);
            const totalCompleted = status.completed || 0;
            const totalRecipients = campaign.stats?.totalRecipients || 0;
            
            currentCampaign = {
              id: campaign._id,
              name: campaign.name,
              subject: campaign.subject,
              status: campaign.status,
              totalRecipients: totalRecipients,
              sent: campaign.stats?.sent || 0,
              delivered: campaign.stats?.delivered || 0,
              failed: campaign.stats?.failed || 0,
              inQueue: totalInQueue,
              completed: totalCompleted,
              createdAt: campaign.createdAt,
              sentAt: campaign.sentAt
            };
            
            console.log(`📊 Campaña activa: ${campaign.name} - ${currentCampaign.sent}/${totalRecipients}`);
          }
        }
      } catch (error) {
        console.error('Error obteniendo campaña activa:', error.message);
        // No fallar el request, solo continuar sin currentCampaign
      }
      
      res.json({
        ...status,
        currentCampaign,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Error obteniendo estado de cola:', error);
      
      res.json({
        available: false,
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
        total: 0,
        currentCampaign: null,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  async pauseQueue(req, res) {
    try {
      const { pauseQueue } = require('../jobs/emailQueue');
      const result = await pauseQueue();
      
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (error) {
      console.error('Error pausando cola:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async resumeQueue(req, res) {
    try {
      const { resumeQueue } = require('../jobs/emailQueue');
      const result = await resumeQueue();
      
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (error) {
      console.error('Error resumiendo cola:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async cleanQueue(req, res) {
    try {
      const { cleanQueue } = require('../jobs/emailQueue');
      const result = await cleanQueue();
      
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (error) {
      console.error('Error limpiando cola:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async forceCheckCampaigns(req, res) {
    try {
      const { checkAllSendingCampaigns } = require('../jobs/emailQueue');
      
      console.log('🔄 Verificación manual iniciada...');
      
      const results = await checkAllSendingCampaigns();
      
      const finalized = results.filter(r => r.finalized);
      const stillSending = results.filter(r => !r.finalized);
      
      res.json({
        success: true,
        message: `Verificación: ${finalized.length} finalizadas, ${stillSending.length} enviando`,
        results: {
          finalized: finalized.map(r => ({
            id: r.id,
            name: r.name,
            sent: r.sent,
            total: r.total
          })),
          stillSending: stillSending.map(r => ({
            id: r.id,
            name: r.name,
            sent: r.sent,
            total: r.total,
            pending: r.total - r.sent
          }))
        }
      });
      
    } catch (error) {
      console.error('Error forzando verificación:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }
}

module.exports = new CampaignsController();