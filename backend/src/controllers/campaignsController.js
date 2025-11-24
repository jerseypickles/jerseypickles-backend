// backend/src/controllers/campaignsController.js
const Campaign = require('../models/Campaign');
const Segment = require('../models/Segment');
const List = require('../models/List');
const Customer = require('../models/Customer');
const EmailEvent = require('../models/EmailEvent');
const emailService = require('../services/emailService');
const templateService = require('../services/templateService');
const segmentationService = require('../services/segmentationService');

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

  // Obtener una campaña
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

  // Crear campaña
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
      
      // Validar según targetType
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
      
      // Actualizar targetType y referencias
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

  // ============================================================
  // ENVIAR CAMPAÑA - OPTIMIZADO PARA ALTO VOLUMEN (80K+ emails)
  // ============================================================
  async send(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment')
        .populate('list');
      
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
      
      // Opciones de envío
      const { testMode = false, testEmail = null } = req.body;
      
      // ==================== MODO TEST ====================
      if (testMode && testEmail) {
        console.log(`🧪 MODO TEST: Enviando a ${testEmail}\n`);
        
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
          testCustomer = { firstName: 'Test', lastName: 'User', email: testEmail };
        }
        
        let html = campaign.htmlContent;
        html = emailService.personalize(html, testCustomer);
        html = emailService.injectTracking(
          html, 
          campaign._id.toString(), 
          testCustomer._id ? testCustomer._id.toString() : 'test',
          testEmail
        );
        
        const result = await emailService.sendEmail({
          to: testEmail,
          subject: `[TEST] ${campaign.subject}`,
          html,
          from: `${campaign.fromName} <${campaign.fromEmail}>`,
          replyTo: campaign.replyTo,
          campaignId: campaign._id.toString(),
          customerId: testCustomer._id ? testCustomer._id.toString() : 'test'
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
      
      // ==================== MODO PRODUCCIÓN ====================
      const { addEmailsToQueue, isAvailable } = require('../jobs/emailQueue');
      
      if (!isAvailable()) {
        return res.status(400).json({
          error: 'Redis no está disponible. Configura REDIS_URL para envíos masivos.',
          message: 'La cola de emails requiere Redis para manejar grandes volúmenes.'
        });
      }
      
      console.log('🚀 Iniciando envío optimizado para alto volumen...\n');
      
      const startTime = Date.now();
      
      // ============================================================
      // PASO 1: Contar total (query ligera, no carga datos)
      // ============================================================
      let totalCustomers = 0;
      let memberIds = [];
      
      if (campaign.targetType === 'list') {
        const list = await List.findById(campaign.list._id).select('members');
        memberIds = list ? list.members : [];
        totalCustomers = memberIds.length;
      } else {
        totalCustomers = await segmentationService.countSegment(campaign.segment.conditions);
      }
      
      if (totalCustomers === 0) {
        return res.status(400).json({ 
          error: campaign.targetType === 'list' 
            ? 'La lista no tiene miembros' 
            : 'El segmento no tiene clientes' 
        });
      }
      
      console.log(`👥 Total destinatarios: ${totalCustomers.toLocaleString()}`);
      
      // ============================================================
      // PASO 2: Actualizar campaña a "sending"
      // ============================================================
      campaign.status = 'sending';
      campaign.stats.totalRecipients = totalCustomers;
      campaign.stats.sent = 0;
      campaign.stats.delivered = 0;
      campaign.stats.failed = 0;
      await campaign.save();
      
      // ============================================================
      // PASO 3: Responder inmediatamente (no bloquear request)
      // ============================================================
      const estimatedMinutes = Math.ceil(totalCustomers / 60000);
      
      res.json({
        success: true,
        campaign: {
          _id: campaign._id,
          name: campaign.name,
          status: 'sending',
          stats: campaign.stats
        },
        queue: {
          totalEmails: totalCustomers,
          processing: true,
          estimatedTime: estimatedMinutes > 1 ? `${estimatedMinutes} minutos` : 'menos de 1 minuto',
          message: `Procesando ${totalCustomers.toLocaleString()} emails en background...`,
          checkStatusAt: `/api/campaigns/${campaign._id}/stats`
        }
      });
      
      // ============================================================
      // PASO 4: Procesar en background (después de responder)
      // ============================================================
      const CUSTOMER_BATCH_SIZE = 500;
      const campaignId = campaign._id.toString();
      const htmlTemplate = campaign.htmlContent;
      const subject = campaign.subject;
      const fromName = campaign.fromName;
      const fromEmail = campaign.fromEmail;
      const replyTo = campaign.replyTo;
      const segmentConditions = campaign.segment ? campaign.segment.conditions : null;
      const targetType = campaign.targetType;
      
      // Función async que corre en background
      setImmediate(async () => {
        let totalQueued = 0;
        let totalBatches = 0;
        let skip = 0;
        
        try {
          console.log('📥 Procesamiento background iniciado...\n');
          
          while (true) {
            // ✅ Obtener solo un batch de customers
            let customerBatch;
            
            if (targetType === 'list') {
              const batchIds = memberIds.slice(skip, skip + CUSTOMER_BATCH_SIZE);
              
              if (batchIds.length === 0) break;
              
              customerBatch = await Customer.find({ _id: { $in: batchIds } })
                .select('email firstName lastName _id')
                .lean();
                
            } else {
              customerBatch = await segmentationService.evaluateSegment(
                segmentConditions,
                { 
                  select: 'email firstName lastName _id',
                  skip: skip,
                  limit: CUSTOMER_BATCH_SIZE
                }
              );
            }
            
            if (!customerBatch || customerBatch.length === 0) {
              console.log('✅ No hay más customers para procesar');
              break;
            }
            
            const batchNum = Math.floor(skip / CUSTOMER_BATCH_SIZE) + 1;
            console.log(`📦 Batch ${batchNum}: ${customerBatch.length} customers (skip: ${skip})`);
            
            // ✅ Preparar emails SOLO para este batch
            const emails = [];
            
            for (const customer of customerBatch) {
              let html = htmlTemplate;
              html = emailService.personalize(html, customer);
              html = emailService.injectTracking(
                html, 
                campaignId, 
                customer._id.toString(),
                customer.email
              );
              
              emails.push({
                to: customer.email,
                subject: subject,
                html: html,
                from: `${fromName} <${fromEmail}>`,
                replyTo: replyTo,
                campaignId: campaignId,
                customerId: customer._id.toString()
              });
            }
            
            // ✅ Agregar batch a la cola de Redis
            const queueResult = await addEmailsToQueue(emails, campaignId);
            
            totalQueued += customerBatch.length;
            totalBatches += queueResult.batches;
            skip += CUSTOMER_BATCH_SIZE;
            
            // ✅ Liberar memoria
            customerBatch = null;
            emails.length = 0;
            
            // Pequeña pausa para no saturar MongoDB
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          
          console.log('\n╔═══════════════════════════════════════════════╗');
          console.log('║  ✅ EMAILS ENCOLADOS EXITOSAMENTE             ║');
          console.log('╚═══════════════════════════════════════════════╝');
          console.log(`📊 Total emails encolados: ${totalQueued.toLocaleString()}`);
          console.log(`📦 Total batches de Redis: ${totalBatches}`);
          console.log(`⏱️  Tiempo de preparación: ${duration}s`);
          console.log(`🚀 Worker de Redis enviando emails...`);
          console.log('═══════════════════════════════════════════════\n');
          
        } catch (error) {
          console.error('\n❌ Error en procesamiento background:', error);
          
          try {
            await Campaign.findByIdAndUpdate(campaignId, {
              status: 'draft',
              'stats.error': error.message
            });
            console.log('⚠️  Campaña revertida a draft debido a error');
          } catch (err) {
            console.error('Error actualizando estado:', err);
          }
        }
      });
      
    } catch (error) {
      console.error('\n❌ Error enviando campaña:', error);
      
      try {
        await Campaign.findByIdAndUpdate(req.params.id, { status: 'draft' });
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

  // ESTADÍSTICAS DETALLADAS DE UNA CAMPAÑA CON REVENUE
  async getStats(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment', 'name')
        .populate('list', 'name');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      // Obtener todos los eventos de esta campaña
      const events = await EmailEvent.find({ campaign: req.params.id })
        .populate('customer', 'email firstName lastName')
        .sort({ eventDate: -1 });
      
      // Calcular estadísticas por tipo de evento
      const stats = {
        sent: events.filter(e => e.eventType === 'sent').length,
        delivered: events.filter(e => e.eventType === 'delivered').length,
        opened: events.filter(e => e.eventType === 'opened').length,
        clicked: events.filter(e => e.eventType === 'clicked').length,
        bounced: events.filter(e => e.eventType === 'bounced').length,
        complained: events.filter(e => e.eventType === 'complained').length,
        purchased: campaign.stats.purchased || 0,
      };
      
      // Calcular tasas
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
      
      // Top links clickeados
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
      
      // Obtener órdenes con revenue attribution
      const Order = require('../models/Order');
      const orders = await Order.find({
        'attribution.campaign': req.params.id
      }).populate('customer', 'email firstName lastName');
      
      // Calcular top productos vendidos
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
      
      // Eventos recientes (últimos 50)
      const recentEvents = events.slice(0, 50);
      
      // Timeline por día (últimos 30 días) con revenue
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
      
      // Clientes más activos con revenue
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
      
      // Agregar compras y revenue por cliente
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
      
      // Objeto de revenue consolidado
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
      });
      
    } catch (error) {
      console.error('Error obteniendo stats de campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // OBTENER EVENTOS CON PAGINACIÓN Y FILTROS
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

  // Crear campaña rápida con template
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
      
      console.log(`✅ Campaña creada desde template: ${templateType}`);
      
      res.status(201).json(campaign);
      
    } catch (error) {
      console.error('Error creando campaña desde template:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // LIMPIAR CAMPAÑAS BORRADOR
  async cleanupDrafts(req, res) {
    try {
      const result = await Campaign.deleteMany({ status: 'draft' });
      console.log(`🗑️  ${result.deletedCount} campañas borrador eliminadas`);
      
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

  // Obtener estado de la cola
  async getQueueStatus(req, res) {
    try {
      const { getQueueStatus, getActiveJobs, getWaitingJobs } = require('../jobs/emailQueue');
      const status = await getQueueStatus();
      
      // Si no hay queue disponible, devolver estado básico
      if (!status.available) {
        return res.json(status);
      }
      
      // Obtener información de campaña actual si hay trabajos activos
      let currentCampaign = null;
      
      try {
        const activeJobs = await getActiveJobs();
        const waitingJobs = await getWaitingJobs();
        
        const job = activeJobs[0] || waitingJobs[0];
        
        if (job && job.data && job.data.campaignId) {
          const campaign = await Campaign.findById(job.data.campaignId);
          
          if (campaign) {
            const totalInQueue = (status.waiting || 0) + (status.active || 0) + (status.delayed || 0);
            const totalCompleted = status.completed || 0;
            const totalFailed = status.failed || 0;
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
        error: error.message || 'Error obteniendo estado de la cola',
        timestamp: new Date().toISOString()
      });
    }
  }

  // Pausar cola
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

  // Resumir cola
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

  // Limpiar cola
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

  // Forzar verificación de campañas
  async forceCheckCampaigns(req, res) {
    try {
      const { checkAllSendingCampaigns } = require('../jobs/emailQueue');
      
      console.log('🔄 Verificación manual de campañas iniciada...');
      
      const results = await checkAllSendingCampaigns();
      
      const finalized = results.filter(r => r.finalized);
      const stillSending = results.filter(r => !r.finalized);
      
      res.json({
        success: true,
        message: `Verificación completada: ${finalized.length} finalizadas, ${stillSending.length} aún enviando`,
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