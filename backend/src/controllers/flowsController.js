// backend/src/controllers/flowsController.js (ACTUALIZADO CON AI)
const Flow = require('../models/Flow');
const FlowExecution = require('../models/FlowExecution');
const Customer = require('../models/Customer');
const flowService = require('../services/flowService');
const aiFlowService = require('../services/aiFlowService');

// ==================== CRUD BÁSICO ====================

exports.getAll = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    
    const query = {};
    if (status) query.status = status;
    
    const flows = await Flow.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();
    
    // Enriquecer con tasas calculadas
    const enrichedFlows = flows.map(flow => ({
      ...flow,
      rates: {
        openRate: flow.metrics?.emailsSent > 0 
          ? ((flow.metrics.opens / flow.metrics.emailsSent) * 100).toFixed(1)
          : 0,
        clickRate: flow.metrics?.emailsSent > 0 
          ? ((flow.metrics.clicks / flow.metrics.emailsSent) * 100).toFixed(1)
          : 0,
        conversionRate: flow.metrics?.totalTriggered > 0
          ? ((flow.metrics.totalOrders / flow.metrics.totalTriggered) * 100).toFixed(1)
          : 0
      }
    }));
    
    const total = await Flow.countDocuments(query);
    
    res.json({
      flows: enrichedFlows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Error fetching flows:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const flow = await Flow.findById(req.params.id);
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    // Agregar métricas calculadas
    const rates = flow.calculateRates ? flow.calculateRates() : {};
    
    res.json({ 
      flow: {
        ...flow.toObject(),
        rates
      }
    });
    
  } catch (error) {
    console.error('Error fetching flow:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { name, description, trigger, steps, status } = req.body;
    
    // Validaciones
    const errors = [];
    if (!name?.trim()) errors.push('Flow name is required');
    if (!trigger?.type) errors.push('Trigger type is required');
    
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }
    
    // Ordenar steps
    const orderedSteps = (steps || []).map((step, index) => ({
      ...step,
      order: index
    }));
    
    const flow = await Flow.create({
      name,
      description,
      trigger,
      steps: orderedSteps,
      status: status || 'draft'
    });
    
    console.log(`✅ Flow created: ${flow.name} (${flow._id})`);
    
    res.status(201).json({ flow });
    
  } catch (error) {
    console.error('Error creating flow:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Si actualizan steps, reordenar
    if (updates.steps) {
      updates.steps = updates.steps.map((step, index) => ({
        ...step,
        order: index
      }));
    }
    
    const flow = await Flow.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    console.log(`✅ Flow updated: ${flow.name}`);
    
    res.json({ flow });
    
  } catch (error) {
    console.error('Error updating flow:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.delete = async (req, res) => {
  try {
    const flow = await Flow.findByIdAndDelete(req.params.id);
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    // Cancelar ejecuciones activas
    await FlowExecution.updateMany(
      { flow: req.params.id, status: { $in: ['active', 'waiting'] } },
      { status: 'cancelled', completedAt: new Date() }
    );
    
    console.log(`🗑️  Flow deleted: ${flow.name}`);
    
    res.json({ message: 'Flow deleted successfully' });
    
  } catch (error) {
    console.error('Error deleting flow:', error);
    res.status(500).json({ error: error.message });
  }
};

// ==================== ACCIONES ====================

exports.toggleStatus = async (req, res) => {
  try {
    const flow = await Flow.findById(req.params.id);
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    // Toggle entre active y paused (o draft)
    if (flow.status === 'active') {
      flow.status = 'paused';
    } else {
      // Validar antes de activar
      const errors = validateFlowForActivation(flow);
      if (errors.length > 0) {
        return res.status(400).json({ errors });
      }
      flow.status = 'active';
    }
    
    await flow.save();
    
    console.log(`🔄 Flow ${flow.status}: ${flow.name}`);
    
    res.json({ flow });
    
  } catch (error) {
    console.error('Error toggling flow:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.pauseFlow = async (req, res) => {
  try {
    const flow = await Flow.findByIdAndUpdate(
      req.params.id,
      { status: 'paused' },
      { new: true }
    );
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    res.json({ flow, message: 'Flow paused' });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.resumeFlow = async (req, res) => {
  try {
    const flow = await Flow.findById(req.params.id);
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    const errors = validateFlowForActivation(flow);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }
    
    flow.status = 'active';
    await flow.save();
    
    res.json({ flow, message: 'Flow resumed' });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.testFlow = async (req, res) => {
  try {
    const { customerId } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID required for testing' });
    }
    
    const execution = await flowService.testFlow(req.params.id, customerId);
    
    res.json({ 
      message: 'Test flow started',
      execution: {
        _id: execution._id,
        status: execution.status,
        startedAt: execution.startedAt
      }
    });
    
  } catch (error) {
    console.error('Error testing flow:', error);
    res.status(500).json({ error: error.message });
  }
};

// ==================== STATS & EXECUTIONS ====================

exports.getStats = async (req, res) => {
  try {
    const flow = await Flow.findById(req.params.id);
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    // Obtener execuciones para stats detallados
    const executions = await FlowExecution.find({ flow: req.params.id })
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    
    // Stats por step
    const stepMetrics = flow.steps.map((step, index) => {
      const stepExecutions = executions.filter(e => 
        e.stepResults?.some(sr => sr.stepIndex === index)
      );
      
      return {
        stepIndex: index,
        type: step.type,
        completed: stepExecutions.filter(e => 
          e.stepResults?.find(sr => sr.stepIndex === index && !sr.error)
        ).length,
        failed: stepExecutions.filter(e => 
          e.stepResults?.find(sr => sr.stepIndex === index && sr.error)
        ).length
      };
    });
    
    // Timeline de últimos 7 días
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const timeline = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dayStr = date.toISOString().split('T')[0];
      
      const dayExecutions = executions.filter(e => 
        e.startedAt && e.startedAt.toISOString().startsWith(dayStr)
      );
      
      timeline.unshift({
        date: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()],
        triggered: dayExecutions.length,
        completed: dayExecutions.filter(e => e.status === 'completed').length,
        revenue: dayExecutions.reduce((sum, e) => sum + (e.attributedRevenue || 0), 0)
      });
    }
    
    res.json({
      flowId: flow._id,
      name: flow.name,
      status: flow.status,
      
      // Métricas generales
      emailsSent: flow.metrics.emailsSent,
      opens: flow.metrics.opens,
      clicks: flow.metrics.clicks,
      conversions: flow.metrics.totalOrders,
      totalRevenue: flow.metrics.totalRevenue,
      
      // Tasas
      openRate: flow.metrics.emailsSent > 0 
        ? ((flow.metrics.opens / flow.metrics.emailsSent) * 100).toFixed(1)
        : 0,
      clickRate: flow.metrics.emailsSent > 0 
        ? ((flow.metrics.clicks / flow.metrics.emailsSent) * 100).toFixed(1)
        : 0,
      
      // Ejecuciones
      activeExecutions: executions.filter(e => 
        e.status === 'active' || e.status === 'waiting'
      ).length,
      
      // Por step
      stepMetrics,
      
      // Timeline
      timeline
    });
    
  } catch (error) {
    console.error('Error fetching flow stats:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.getExecutions = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    
    const query = { flow: req.params.id };
    if (status) query.status = status;
    
    const executions = await FlowExecution.find(query)
      .populate('customer', 'email firstName lastName')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();
    
    const total = await FlowExecution.countDocuments(query);
    
    res.json({
      executions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Error fetching executions:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.cancelExecution = async (req, res) => {
  try {
    const execution = await flowService.cancelExecution(req.params.executionId);
    res.json({ execution, message: 'Execution cancelled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ==================== TEMPLATES ====================

exports.getTemplates = async (req, res) => {
  try {
    const templates = [
      {
        id: 'welcome-series',
        name: 'Welcome Series',
        emoji: '🎉',
        description: 'Welcome new customers with a series of personalized emails',
        trigger: 'customer_created',
        estimatedRevenue: '+15% conversion',
        steps: 5,
        emails: 3,
        popular: true,
        tags: ['Onboarding', 'New Customer'],
        preview: {
          day1: 'Welcome email with brand story',
          day3: 'Product highlights and bestsellers',
          day7: 'First purchase incentive (10% off)'
        }
      },
      {
        id: 'abandoned-cart',
        name: 'Abandoned Cart Recovery',
        emoji: '🛒',
        description: 'Recover lost sales with timely cart reminders',
        trigger: 'cart_abandoned',
        estimatedRevenue: '+20% recovery rate',
        steps: 4,
        emails: 3,
        popular: true,
        tags: ['Recovery', 'Revenue'],
        preview: {
          hour1: 'Gentle reminder with cart contents',
          hour24: 'Social proof and urgency',
          hour72: 'Final reminder with discount'
        }
      },
      {
        id: 'post-purchase',
        name: 'Post-Purchase Flow',
        emoji: '📦',
        description: 'Build loyalty and get reviews after purchase',
        trigger: 'order_placed',
        estimatedRevenue: '+25% repeat purchases',
        steps: 4,
        emails: 3,
        popular: true,
        tags: ['Retention', 'Reviews'],
        preview: {
          immediate: 'Thank you and order confirmation',
          day7: 'Product tips and usage ideas',
          day14: 'Review request with incentive'
        }
      },
      {
        id: 'win-back',
        name: 'Win-Back Campaign',
        emoji: '💔',
        description: 'Re-engage customers who haven\'t purchased recently',
        trigger: 'customer_tag_added',
        triggerConfig: { tagName: 'dormant' },
        estimatedRevenue: '+10% reactivation',
        steps: 4,
        emails: 3,
        popular: false,
        tags: ['Re-engagement', 'Retention'],
        preview: {
          day1: 'We miss you message',
          day7: 'What\'s new + exclusive offer',
          day14: 'Last chance with best offer'
        }
      },
      {
        id: 'vip-program',
        name: 'VIP Program',
        emoji: '💎',
        description: 'Reward and retain your best customers',
        trigger: 'customer_tag_added',
        triggerConfig: { tagName: 'VIP' },
        estimatedRevenue: '+30% LTV',
        steps: 3,
        emails: 2,
        popular: false,
        tags: ['VIP', 'Loyalty'],
        preview: {
          immediate: 'Welcome to VIP status',
          day30: 'Exclusive VIP-only offer'
        }
      },
      {
        id: 'review-request',
        name: 'Review Request',
        emoji: '⭐',
        description: 'Request product reviews after delivery',
        trigger: 'order_fulfilled',
        estimatedRevenue: '+40% review rate',
        steps: 3,
        emails: 2,
        popular: false,
        tags: ['Reviews', 'Social Proof'],
        preview: {
          day3: 'How are you enjoying your order?',
          day10: 'Review reminder with incentive'
        }
      }
    ];
    
    res.json({ templates });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createFromTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    
    // Definir templates completos
    const templateDefinitions = {
      'welcome-series': {
        name: 'Welcome Series',
        description: 'Automated welcome sequence for new customers',
        trigger: { type: 'customer_created', config: {} },
        steps: [
          {
            type: 'send_email',
            config: {
              subject: '🥒 Welcome to Jersey Pickles, {{customer.firstName}}!',
              previewText: 'Your journey to pickle perfection starts here',
              htmlContent: '<!-- Welcome email HTML -->'
            },
            order: 0
          },
          {
            type: 'wait',
            config: { delayMinutes: 4320 }, // 3 days
            order: 1
          },
          {
            type: 'send_email',
            config: {
              subject: 'Our Bestsellers 🏆 (Picked just for you)',
              previewText: 'Discover what everyone\'s crunching about',
              htmlContent: '<!-- Bestsellers email HTML -->'
            },
            order: 2
          },
          {
            type: 'wait',
            config: { delayMinutes: 5760 }, // 4 days
            order: 3
          },
          {
            type: 'condition',
            config: {
              conditionType: 'has_purchased',
              ifTrue: [
                {
                  type: 'add_tag',
                  config: { tagName: 'welcome_converted' }
                }
              ],
              ifFalse: [
                {
                  type: 'send_email',
                  config: {
                    subject: '10% off your first order 🎁',
                    previewText: 'A little something to get you started',
                    htmlContent: '<!-- Discount email HTML -->'
                  }
                },
                {
                  type: 'create_discount',
                  config: {
                    discountCode: 'WELCOME10',
                    discountType: 'percentage',
                    discountValue: 10,
                    expiresInDays: 7
                  }
                }
              ]
            },
            order: 4
          }
        ]
      },
      
      'abandoned-cart': {
        name: 'Abandoned Cart Recovery',
        description: 'Recover abandoned carts with timely reminders',
        trigger: { 
          type: 'cart_abandoned', 
          config: { abandonedAfterMinutes: 60 } 
        },
        steps: [
          {
            type: 'send_email',
            config: {
              subject: '🛒 Forgot something? Your cart misses you!',
              previewText: 'Your pickles are waiting...',
              htmlContent: '<!-- Cart reminder 1 HTML -->'
            },
            order: 0
          },
          {
            type: 'wait',
            config: { delayMinutes: 1440 }, // 24 hours
            order: 1
          },
          {
            type: 'condition',
            config: {
              conditionType: 'has_purchased',
              ifTrue: [],
              ifFalse: [
                {
                  type: 'send_email',
                  config: {
                    subject: '⏰ Your cart expires soon!',
                    previewText: 'Don\'t miss out on these goodies',
                    htmlContent: '<!-- Cart reminder 2 HTML -->'
                  }
                }
              ]
            },
            order: 2
          },
          {
            type: 'wait',
            config: { delayMinutes: 2880 }, // 48 more hours
            order: 3
          },
          {
            type: 'condition',
            config: {
              conditionType: 'has_purchased',
              ifTrue: [],
              ifFalse: [
                {
                  type: 'send_email',
                  config: {
                    subject: '🎁 Final reminder + 15% off just for you',
                    previewText: 'Last chance to grab your goodies',
                    htmlContent: '<!-- Cart reminder 3 with discount HTML -->'
                  }
                },
                {
                  type: 'create_discount',
                  config: {
                    discountCode: 'COMEBACK15',
                    discountType: 'percentage',
                    discountValue: 15,
                    expiresInDays: 3
                  }
                }
              ]
            },
            order: 4
          }
        ]
      },
      
      'post-purchase': {
        name: 'Post-Purchase Flow',
        description: 'Thank customers and build loyalty after purchase',
        trigger: { type: 'order_placed', config: {} },
        steps: [
          {
            type: 'send_email',
            config: {
              subject: '🎉 Thanks for your order, {{customer.firstName}}!',
              previewText: 'Your pickles are on their way',
              htmlContent: '<!-- Thank you email HTML -->'
            },
            order: 0
          },
          {
            type: 'add_tag',
            config: { tagName: 'purchased' },
            order: 1
          },
          {
            type: 'wait',
            config: { delayMinutes: 10080 }, // 7 days
            order: 2
          },
          {
            type: 'send_email',
            config: {
              subject: '💡 Tips for enjoying your pickles',
              previewText: 'Get the most out of your order',
              htmlContent: '<!-- Product tips email HTML -->'
            },
            order: 3
          },
          {
            type: 'wait',
            config: { delayMinutes: 10080 }, // 7 more days
            order: 4
          },
          {
            type: 'send_email',
            config: {
              subject: '⭐ How did we do? Leave a review!',
              previewText: 'Your feedback helps us grow',
              htmlContent: '<!-- Review request email HTML -->'
            },
            order: 5
          }
        ]
      },
      
      'win-back': {
        name: 'Win-Back Campaign',
        description: 'Re-engage dormant customers',
        trigger: { 
          type: 'customer_tag_added', 
          config: { tagName: 'dormant' } 
        },
        steps: [
          {
            type: 'send_email',
            config: {
              subject: '💔 We miss you, {{customer.firstName}}!',
              previewText: 'It\'s been a while...',
              htmlContent: '<!-- Win-back email 1 HTML -->'
            },
            order: 0
          },
          {
            type: 'wait',
            config: { delayMinutes: 10080 }, // 7 days
            order: 1
          },
          {
            type: 'send_email',
            config: {
              subject: '🆕 See what\'s new + a special offer',
              previewText: 'New products you\'ll love',
              htmlContent: '<!-- Win-back email 2 HTML -->'
            },
            order: 2
          },
          {
            type: 'wait',
            config: { delayMinutes: 10080 }, // 7 days
            order: 3
          },
          {
            type: 'send_email',
            config: {
              subject: '🎁 20% off - Our best offer for you',
              previewText: 'We really want you back',
              htmlContent: '<!-- Win-back email 3 HTML -->'
            },
            order: 4
          },
          {
            type: 'create_discount',
            config: {
              discountCode: 'COMEBACK20',
              discountType: 'percentage',
              discountValue: 20,
              expiresInDays: 14
            },
            order: 5
          }
        ]
      },
      
      'vip-program': {
        name: 'VIP Program',
        description: 'Welcome and reward VIP customers',
        trigger: { 
          type: 'customer_tag_added', 
          config: { tagName: 'VIP' } 
        },
        steps: [
          {
            type: 'send_email',
            config: {
              subject: '💎 Welcome to VIP Status, {{customer.firstName}}!',
              previewText: 'You\'re officially a pickle VIP',
              htmlContent: '<!-- VIP welcome email HTML -->'
            },
            order: 0
          },
          {
            type: 'create_discount',
            config: {
              discountCode: 'VIP15',
              discountType: 'percentage',
              discountValue: 15,
              expiresInDays: 30
            },
            order: 1
          },
          {
            type: 'wait',
            config: { delayMinutes: 43200 }, // 30 days
            order: 2
          },
          {
            type: 'send_email',
            config: {
              subject: '🎁 Your monthly VIP exclusive is here',
              previewText: 'A special offer just for VIPs',
              htmlContent: '<!-- VIP monthly email HTML -->'
            },
            order: 3
          }
        ]
      },
      
      'review-request': {
        name: 'Review Request',
        description: 'Request reviews after order delivery',
        trigger: { type: 'order_fulfilled', config: {} },
        steps: [
          {
            type: 'wait',
            config: { delayMinutes: 4320 }, // 3 days after shipping
            order: 0
          },
          {
            type: 'send_email',
            config: {
              subject: '📦 How\'s your order, {{customer.firstName}}?',
              previewText: 'We\'d love to hear from you',
              htmlContent: '<!-- Review request email 1 HTML -->'
            },
            order: 1
          },
          {
            type: 'wait',
            config: { delayMinutes: 10080 }, // 7 days
            order: 2
          },
          {
            type: 'send_email',
            config: {
              subject: '⭐ Share your experience, get 10% off',
              previewText: 'Your review = our growth',
              htmlContent: '<!-- Review request email 2 HTML -->'
            },
            order: 3
          }
        ]
      }
    };
    
    const template = templateDefinitions[templateId];
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Crear flow desde template
    const flow = await Flow.create({
      ...template,
      status: 'draft'
    });
    
    console.log(`✅ Flow created from template: ${templateId} → ${flow._id}`);
    
    res.status(201).json({ flow });
    
  } catch (error) {
    console.error('Error creating from template:', error);
    res.status(500).json({ error: error.message });
  }
};

// ==================== 🧠 AI ENDPOINTS ====================

/**
 * Generar subject lines con AI
 * POST /api/flows/ai/subject-lines
 */
exports.generateSubjectLines = async (req, res) => {
  try {
    const result = await aiFlowService.generateSubjectLines(req.body);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error generating subject lines:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Generar contenido de email con AI
 * POST /api/flows/ai/email-content
 */
exports.generateEmailContent = async (req, res) => {
  try {
    const result = await aiFlowService.generateEmailContent(req.body);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error generating email content:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Generar flow completo desde descripción
 * POST /api/flows/ai/generate
 */
exports.generateFlowFromDescription = async (req, res) => {
  try {
    const { description } = req.body;
    
    if (!description) {
      return res.status(400).json({ error: 'Description is required' });
    }
    
    const result = await aiFlowService.generateFlowFromDescription(description);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error generating flow:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Sugerir siguiente step
 * POST /api/flows/:id/ai/suggest-step
 */
exports.suggestNextStep = async (req, res) => {
  try {
    const flow = await Flow.findById(req.params.id);
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    const result = await aiFlowService.suggestNextStep(flow, flow.steps);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error suggesting step:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Analizar performance de un flow
 * GET /api/flows/:id/ai/analyze
 */
exports.analyzeFlow = async (req, res) => {
  try {
    const result = await aiFlowService.analyzeFlowPerformance(req.params.id);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error analyzing flow:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Optimizar timing de un flow
 * GET /api/flows/:id/ai/optimize-timing
 */
exports.optimizeTiming = async (req, res) => {
  try {
    const result = await aiFlowService.optimizeTiming(req.params.id);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error optimizing timing:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Mejorar template con AI
 * POST /api/flows/ai/enhance-template
 */
exports.enhanceTemplate = async (req, res) => {
  try {
    const { templateId, html, options } = req.body;
    
    const result = await aiFlowService.enhanceTemplate(templateId, html, options);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error enhancing template:', error);
    res.status(500).json({ error: error.message });
  }
};

// ==================== HELPERS ====================

function validateFlowForActivation(flow) {
  const errors = [];
  
  if (!flow.name?.trim()) {
    errors.push('Flow must have a name');
  }
  
  if (!flow.trigger?.type) {
    errors.push('Flow must have a trigger');
  }
  
  if (!flow.steps || flow.steps.length === 0) {
    errors.push('Flow must have at least one step');
  }
  
  // Validar cada email step
  flow.steps.forEach((step, index) => {
    if (step.type === 'send_email') {
      if (!step.config?.subject?.trim()) {
        errors.push(`Step ${index + 1}: Email must have a subject`);
      }
      if (!step.config?.htmlContent?.trim() && !step.config?.templateId) {
        errors.push(`Step ${index + 1}: Email must have content or template`);
      }
    }
    
    if (step.type === 'add_tag' && !step.config?.tagName?.trim()) {
      errors.push(`Step ${index + 1}: Tag step must have a tag name`);
    }
  });
  
  return errors;
}

module.exports = exports;