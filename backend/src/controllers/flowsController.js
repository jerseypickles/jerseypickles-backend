// backend/src/controllers/flowsController.js
const Flow = require('../models/Flow');
const FlowExecution = require('../models/FlowExecution');
const flowService = require('../services/flowService');

class FlowsController {
  
  // Obtener todos los flows
  async getAll(req, res) {
    try {
      const flows = await Flow.find()
        .sort({ createdAt: -1 })
        .lean();
      
      // Agregar métricas en vivo
      for (let flow of flows) {
        const activeExecutions = await FlowExecution.countDocuments({
          flow: flow._id,
          status: 'active'
        });
        
        flow.metrics = {
          ...flow.metrics,
          activeExecutions,
          emailsSent: flow.metrics?.emailsSent || 0,
          opens: flow.metrics?.opens || 0,
          clicks: flow.metrics?.clicks || 0,
          totalRevenue: flow.metrics?.totalRevenue || 0
        };
      }
      
      res.json({ flows });
    } catch (error) {
      console.error('Error fetching flows:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener un flow
  async getOne(req, res) {
    try {
      const flow = await Flow.findById(req.params.id);
      
      if (!flow) {
        return res.status(404).json({ error: 'Flow not found' });
      }
      
      res.json({ flow });
    } catch (error) {
      console.error('Error fetching flow:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Crear flow
  async create(req, res) {
    try {
      const flow = new Flow(req.body);
      await flow.save();
      
      res.status(201).json({ 
        success: true,
        flow 
      });
    } catch (error) {
      console.error('Error creating flow:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Actualizar flow
  async update(req, res) {
    try {
      const flow = await Flow.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true }
      );
      
      if (!flow) {
        return res.status(404).json({ error: 'Flow not found' });
      }
      
      res.json({ 
        success: true,
        flow 
      });
    } catch (error) {
      console.error('Error updating flow:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Eliminar flow
  async delete(req, res) {
    try {
      const flow = await Flow.findByIdAndDelete(req.params.id);
      
      if (!flow) {
        return res.status(404).json({ error: 'Flow not found' });
      }
      
      // También eliminar ejecuciones asociadas
      await FlowExecution.deleteMany({ flow: req.params.id });
      
      res.json({ 
        success: true,
        message: 'Flow deleted successfully' 
      });
    } catch (error) {
      console.error('Error deleting flow:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Toggle status (activar/desactivar)
  async toggleStatus(req, res) {
    try {
      const flow = await Flow.findById(req.params.id);
      
      if (!flow) {
        return res.status(404).json({ error: 'Flow not found' });
      }
      
      flow.status = flow.status === 'active' ? 'inactive' : 'active';
      await flow.save();
      
      res.json({ 
        success: true,
        flow 
      });
    } catch (error) {
      console.error('Error toggling flow status:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener templates
  async getTemplates(req, res) {
    try {
      const templates = [
        {
          id: 'welcome-series',
          name: '🎉 Welcome Series',
          description: 'Welcome new customers with a series of emails',
          trigger: 'customer_created',
          estimatedRevenue: '+15% conversion',
          steps: 5,
          emails: 3
        },
        {
          id: 'abandoned-cart',
          name: '🛒 Abandoned Cart Recovery',
          description: 'Recover lost sales from abandoned carts',
          trigger: 'cart_abandoned',
          estimatedRevenue: '+20% recovery',
          steps: 4,
          emails: 2
        },
        {
          id: 'post-purchase',
          name: '📦 Post-Purchase',
          description: 'Thank customers after purchase',
          trigger: 'order_placed',
          estimatedRevenue: '+25% repeat',
          steps: 6,
          emails: 3
        },
        {
          id: 'win-back',
          name: '💔 Win-Back Campaign',
          description: 'Re-engage inactive customers',
          trigger: 'customer_inactive',
          estimatedRevenue: '+10% reactivation',
          steps: 3,
          emails: 2
        },
        {
          id: 'vip-program',
          name: '💎 VIP Program',
          description: 'Reward your best customers',
          trigger: 'customer_tag_added',
          estimatedRevenue: '+30% LTV',
          steps: 4,
          emails: 2
        },
        {
          id: 'product-review',
          name: '⭐ Review Request',
          description: 'Ask for reviews after delivery',
          trigger: 'order_fulfilled',
          estimatedRevenue: '+5% trust',
          steps: 2,
          emails: 1
        }
      ];
      
      res.json({ templates });
    } catch (error) {
      console.error('Error fetching templates:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Crear desde template
  async createFromTemplate(req, res) {
    try {
      const { templateId } = req.params;
      
      const templates = {
        'welcome-series': {
          name: '🎉 Welcome Series',
          description: 'Welcome email series for new customers',
          trigger: { type: 'customer_created' },
          status: 'draft',
          steps: [
            {
              type: 'send_email',
              order: 1,
              config: {
                subject: 'Welcome to Jersey Pickles! 🥒',
                templateId: 'welcome'
              }
            },
            {
              type: 'wait',
              order: 2,
              config: { delayMinutes: 1440 }
            },
            {
              type: 'send_email',
              order: 3,
              config: {
                subject: 'Discover Our Best Sellers ⭐',
                templateId: 'products_showcase'
              }
            },
            {
              type: 'wait',
              order: 4,
              config: { delayMinutes: 4320 }
            },
            {
              type: 'condition',
              order: 5,
              config: {
                conditionType: 'has_purchased',
                ifFalse: [
                  {
                    type: 'create_discount',
                    config: {
                      discountCode: 'WELCOME15',
                      discountType: 'percentage',
                      discountValue: 15,
                      expiresInDays: 7
                    }
                  }
                ]
              }
            }
          ]
        },
        'abandoned-cart': {
          name: '🛒 Abandoned Cart Recovery',
          description: 'Recover abandoned carts',
          trigger: { 
            type: 'cart_abandoned',
            config: { abandonedAfterMinutes: 60 }
          },
          status: 'draft',
          steps: [
            {
              type: 'wait',
              order: 1,
              config: { delayMinutes: 60 }
            },
            {
              type: 'send_email',
              order: 2,
              config: {
                subject: 'Did You Forget Something? 🥒',
                templateId: 'cart_reminder_1'
              }
            },
            {
              type: 'wait',
              order: 3,
              config: { delayMinutes: 1440 }
            },
            {
              type: 'send_email',
              order: 4,
              config: {
                subject: '10% OFF - Complete Your Order!',
                templateId: 'cart_discount'
              }
            }
          ]
        }
      };
      
      const template = templates[templateId];
      
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }
      
      const flow = new Flow(template);
      await flow.save();
      
      res.status(201).json({ 
        success: true,
        flow 
      });
    } catch (error) {
      console.error('Error creating from template:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener estadísticas
  async getStats(req, res) {
    try {
      const flowId = req.params.id;
      
      const executions = await FlowExecution.find({ flow: flowId });
      
      const stats = {
        emailsSent: 0,
        opens: 0,
        clicks: 0,
        conversions: 0,
        totalRevenue: 0,
        activeExecutions: 0,
        completedExecutions: 0,
        failedExecutions: 0
      };
      
      executions.forEach(exec => {
        if (exec.status === 'active') stats.activeExecutions++;
        if (exec.status === 'completed') stats.completedExecutions++;
        if (exec.status === 'failed') stats.failedExecutions++;
        
        stats.totalRevenue += exec.attributedRevenue || 0;
      });
      
      // Obtener métricas del flow
      const flow = await Flow.findById(flowId);
      if (flow?.metrics) {
        stats.emailsSent = flow.metrics.emailsSent || 0;
        stats.opens = flow.metrics.opens || 0;
        stats.clicks = flow.metrics.clicks || 0;
      }
      
      res.json(stats);
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener ejecuciones
  async getExecutions(req, res) {
    try {
      const { limit = 50, offset = 0 } = req.query;
      
      const executions = await FlowExecution
        .find({ flow: req.params.id })
        .populate('customer', 'email firstName lastName')
        .sort({ startedAt: -1 })
        .limit(parseInt(limit))
        .skip(parseInt(offset));
      
      res.json({ executions });
    } catch (error) {
      console.error('Error fetching executions:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Test flow
  async testFlow(req, res) {
    try {
      const { customerId } = req.body;
      
      // Simular ejecución del flow
      await flowService.testFlow(req.params.id, customerId);
      
      res.json({ 
        success: true,
        message: 'Test flow started' 
      });
    } catch (error) {
      console.error('Error testing flow:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Pausar flow
  async pauseFlow(req, res) {
    try {
      const flow = await Flow.findByIdAndUpdate(
        req.params.id,
        { status: 'paused' },
        { new: true }
      );
      
      res.json({ 
        success: true,
        flow 
      });
    } catch (error) {
      console.error('Error pausing flow:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Resumir flow
  async resumeFlow(req, res) {
    try {
      const flow = await Flow.findByIdAndUpdate(
        req.params.id,
        { status: 'active' },
        { new: true }
      );
      
      res.json({ 
        success: true,
        flow 
      });
    } catch (error) {
      console.error('Error resuming flow:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new FlowsController();