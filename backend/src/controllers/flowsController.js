// backend/src/controllers/flowsController.js (ACTUALIZADO CON VALIDACIÓN)
const Flow = require('../models/Flow');
const FlowExecution = require('../models/FlowExecution');
const flowService = require('../services/flowService');

class FlowsController {
  
  /**
   * Validar datos del flow
   */
  validateFlowData(data) {
    const errors = [];
    
    if (!data.name || !data.name.trim()) {
      errors.push('Flow name is required');
    }
    
    if (!data.trigger?.type) {
      errors.push('Trigger type is required');
    }
    
    const validTriggers = [
      'customer_created', 'order_placed', 'cart_abandoned',
      'popup_signup', 'customer_tag_added', 'segment_entry',
      'custom_event', 'order_fulfilled', 'order_cancelled',
      'order_refunded', 'product_back_in_stock'
    ];
    
    if (data.trigger?.type && !validTriggers.includes(data.trigger.type)) {
      errors.push(`Invalid trigger type: ${data.trigger.type}`);
    }
    
    // Validar steps
    if (data.steps && Array.isArray(data.steps)) {
      const validStepTypes = ['send_email', 'wait', 'condition', 'add_tag', 'create_discount'];
      
      data.steps.forEach((step, index) => {
        if (!step.type || !validStepTypes.includes(step.type)) {
          errors.push(`Invalid step type at index ${index}: ${step.type}`);
        }
        
        // Validar config según tipo
        switch (step.type) {
          case 'send_email':
            if (!step.config?.subject) {
              errors.push(`Step ${index + 1}: Email subject is required`);
            }
            break;
          case 'wait':
            if (!step.config?.delayMinutes || step.config.delayMinutes < 1) {
              errors.push(`Step ${index + 1}: Wait delay must be at least 1 minute`);
            }
            break;
          case 'add_tag':
            if (!step.config?.tagName) {
              errors.push(`Step ${index + 1}: Tag name is required`);
            }
            break;
        }
      });
    }
    
    return errors;
  }
  
  /**
   * Obtener todos los flows con métricas optimizadas
   */
  async getAll(req, res) {
    try {
      // Usar aggregation para mejor rendimiento
      const flows = await Flow.aggregate([
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: 'flowexecutions',
            let: { flowId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$flow', '$$flowId'] },
                      { $eq: ['$status', 'active'] }
                    ]
                  }
                }
              },
              { $count: 'count' }
            ],
            as: 'activeExecutions'
          }
        },
        {
          $addFields: {
            'metrics.activeExecutions': {
              $ifNull: [{ $arrayElemAt: ['$activeExecutions.count', 0] }, 0]
            }
          }
        },
        { $project: { activeExecutions: 0 } }
      ]);
      
      res.json({ 
        success: true,
        flows,
        total: flows.length
      });
    } catch (error) {
      console.error('Error fetching flows:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Obtener un flow por ID
   */
  async getOne(req, res) {
    try {
      const flow = await Flow.findById(req.params.id);
      
      if (!flow) {
        return res.status(404).json({ 
          success: false,
          error: 'Flow not found' 
        });
      }
      
      // Agregar conteo de ejecuciones activas
      const activeExecutions = await FlowExecution.countDocuments({
        flow: flow._id,
        status: { $in: ['active', 'waiting'] }
      });
      
      const flowObj = flow.toObject();
      flowObj.metrics = {
        ...flowObj.metrics,
        activeExecutions
      };
      
      res.json({ 
        success: true,
        flow: flowObj 
      });
    } catch (error) {
      console.error('Error fetching flow:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Crear nuevo flow con validación
   */
  async create(req, res) {
    try {
      // Validar datos
      const errors = this.validateFlowData(req.body);
      if (errors.length > 0) {
        return res.status(400).json({
          success: false,
          errors
        });
      }
      
      // Asegurar que los steps tengan orden correcto
      if (req.body.steps) {
        req.body.steps = req.body.steps.map((step, index) => ({
          ...step,
          order: index
        }));
      }
      
      const flow = new Flow(req.body);
      await flow.save();
      
      console.log(`✅ Flow created: ${flow.name} (${flow._id})`);
      
      res.status(201).json({ 
        success: true,
        flow,
        message: 'Flow created successfully'
      });
    } catch (error) {
      console.error('Error creating flow:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Actualizar flow
   */
  async update(req, res) {
    try {
      // No validar todo si solo se actualiza status
      if (Object.keys(req.body).length > 1 || !req.body.status) {
        const errors = this.validateFlowData(req.body);
        if (errors.length > 0) {
          return res.status(400).json({
            success: false,
            errors
          });
        }
      }
      
      // Asegurar orden de steps
      if (req.body.steps) {
        req.body.steps = req.body.steps.map((step, index) => ({
          ...step,
          order: index
        }));
      }
      
      const flow = await Flow.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true, runValidators: true }
      );
      
      if (!flow) {
        return res.status(404).json({ 
          success: false,
          error: 'Flow not found' 
        });
      }
      
      console.log(`✅ Flow updated: ${flow.name} (${flow._id})`);
      
      res.json({ 
        success: true,
        flow,
        message: 'Flow updated successfully'
      });
    } catch (error) {
      console.error('Error updating flow:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Eliminar flow
   */
  async delete(req, res) {
    try {
      const flow = await Flow.findById(req.params.id);
      
      if (!flow) {
        return res.status(404).json({ 
          success: false,
          error: 'Flow not found' 
        });
      }
      
      // Verificar si hay ejecuciones activas
      const activeCount = await FlowExecution.countDocuments({
        flow: req.params.id,
        status: { $in: ['active', 'waiting'] }
      });
      
      if (activeCount > 0) {
        return res.status(400).json({
          success: false,
          error: `Cannot delete flow with ${activeCount} active executions. Please wait or cancel them first.`
        });
      }
      
      // Eliminar flow y ejecuciones
      await Flow.findByIdAndDelete(req.params.id);
      await FlowExecution.deleteMany({ flow: req.params.id });
      
      console.log(`🗑️  Flow deleted: ${flow.name} (${req.params.id})`);
      
      res.json({ 
        success: true,
        message: 'Flow deleted successfully' 
      });
    } catch (error) {
      console.error('Error deleting flow:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Toggle status (activar/desactivar)
   */
  async toggleStatus(req, res) {
    try {
      const flow = await Flow.findById(req.params.id);
      
      if (!flow) {
        return res.status(404).json({ 
          success: false,
          error: 'Flow not found' 
        });
      }
      
      // Validar antes de activar
      if (flow.status !== 'active') {
        if (!flow.steps || flow.steps.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Cannot activate flow without steps'
          });
        }
        
        // Verificar que hay al menos un email
        const hasEmail = flow.steps.some(s => s.type === 'send_email');
        if (!hasEmail) {
          return res.status(400).json({
            success: false,
            error: 'Flow must have at least one email step'
          });
        }
      }
      
      const newStatus = flow.status === 'active' ? 'paused' : 'active';
      flow.status = newStatus;
      await flow.save();
      
      console.log(`🔄 Flow ${newStatus}: ${flow.name}`);
      
      res.json({ 
        success: true,
        flow,
        message: `Flow ${newStatus === 'active' ? 'activated' : 'paused'} successfully`
      });
    } catch (error) {
      console.error('Error toggling flow status:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Obtener templates disponibles
   */
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
          emails: 3,
          popular: true,
          tags: ['Onboarding', 'New Customer']
        },
        {
          id: 'abandoned-cart',
          name: '🛒 Abandoned Cart Recovery',
          description: 'Recover lost sales from abandoned carts',
          trigger: 'cart_abandoned',
          estimatedRevenue: '+20% recovery',
          steps: 4,
          emails: 2,
          popular: true,
          tags: ['Recovery', 'Revenue']
        },
        {
          id: 'post-purchase',
          name: '📦 Post-Purchase',
          description: 'Thank customers after purchase',
          trigger: 'order_placed',
          estimatedRevenue: '+25% repeat',
          steps: 6,
          emails: 3,
          popular: false,
          tags: ['Retention', 'Loyalty']
        },
        {
          id: 'win-back',
          name: '💔 Win-Back Campaign',
          description: 'Re-engage inactive customers',
          trigger: 'customer_inactive',
          estimatedRevenue: '+10% reactivation',
          steps: 3,
          emails: 2,
          popular: false,
          tags: ['Re-engagement']
        },
        {
          id: 'vip-program',
          name: '💎 VIP Program',
          description: 'Reward your best customers',
          trigger: 'customer_tag_added',
          estimatedRevenue: '+30% LTV',
          steps: 4,
          emails: 2,
          popular: true,
          tags: ['VIP', 'Loyalty']
        },
        {
          id: 'product-review',
          name: '⭐ Review Request',
          description: 'Ask for reviews after delivery',
          trigger: 'order_fulfilled',
          estimatedRevenue: '+5% trust',
          steps: 2,
          emails: 1,
          popular: false,
          tags: ['Reviews', 'Social Proof']
        }
      ];
      
      res.json({ 
        success: true,
        templates 
      });
    } catch (error) {
      console.error('Error fetching templates:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Crear flow desde template
   */
  async createFromTemplate(req, res) {
    try {
      const { templateId } = req.params;
      
      const templates = {
        'welcome-series': {
          name: '🎉 Welcome Series',
          description: 'Welcome email series for new customers',
          trigger: { type: 'customer_created', config: {} },
          status: 'draft',
          steps: [
            {
              type: 'send_email',
              order: 0,
              config: {
                subject: 'Welcome to Jersey Pickles! 🥒',
                previewText: 'Thank you for joining our pickle family!',
                htmlContent: this.getWelcomeEmailTemplate()
              }
            },
            {
              type: 'wait',
              order: 1,
              config: { delayMinutes: 1440 } // 24 hours
            },
            {
              type: 'send_email',
              order: 2,
              config: {
                subject: 'Discover Our Best Sellers ⭐',
                previewText: 'Explore customer favorites',
                htmlContent: this.getProductShowcaseTemplate()
              }
            },
            {
              type: 'wait',
              order: 3,
              config: { delayMinutes: 4320 } // 3 days
            },
            {
              type: 'condition',
              order: 4,
              config: {
                conditionType: 'has_purchased',
                ifTrue: [],
                ifFalse: [
                  {
                    type: 'send_email',
                    config: {
                      subject: 'Here\'s 15% Off Your First Order! 🎁',
                      previewText: 'Don\'t miss this special welcome discount',
                      htmlContent: this.getDiscountEmailTemplate('WELCOME15', '15%')
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
              order: 0,
              config: { delayMinutes: 60 } // 1 hour
            },
            {
              type: 'send_email',
              order: 1,
              config: {
                subject: 'Did You Forget Something? 🥒',
                previewText: 'Your cart is waiting for you',
                htmlContent: this.getCartReminderTemplate(1)
              }
            },
            {
              type: 'wait',
              order: 2,
              config: { delayMinutes: 1440 } // 24 hours
            },
            {
              type: 'send_email',
              order: 3,
              config: {
                subject: '10% OFF - Complete Your Order! 🎉',
                previewText: 'Special discount just for you',
                htmlContent: this.getDiscountEmailTemplate('COMEBACK10', '10%')
              }
            }
          ]
        },
        'post-purchase': {
          name: '📦 Post-Purchase',
          description: 'Thank customers and encourage repeat purchases',
          trigger: { type: 'order_placed', config: {} },
          status: 'draft',
          steps: [
            {
              type: 'send_email',
              order: 0,
              config: {
                subject: 'Thank You for Your Order! 🎉',
                previewText: 'Your order confirmation',
                htmlContent: this.getThankYouTemplate()
              }
            },
            {
              type: 'wait',
              order: 1,
              config: { delayMinutes: 10080 } // 7 days
            },
            {
              type: 'send_email',
              order: 2,
              config: {
                subject: 'How Are You Enjoying Your Pickles? ⭐',
                previewText: 'We\'d love to hear from you',
                htmlContent: this.getReviewRequestTemplate()
              }
            }
          ]
        }
      };
      
      const template = templates[templateId];
      
      if (!template) {
        return res.status(404).json({ 
          success: false,
          error: 'Template not found' 
        });
      }
      
      const flow = new Flow(template);
      await flow.save();
      
      console.log(`✅ Flow created from template "${templateId}": ${flow._id}`);
      
      res.status(201).json({ 
        success: true,
        flow,
        message: `Flow created from "${templateId}" template`
      });
    } catch (error) {
      console.error('Error creating from template:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  // ==================== TEMPLATE HELPERS ====================
  
  getWelcomeEmailTemplate() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: #2D5016; color: #fff; padding: 30px 20px; text-align: center; }
    .content { padding: 40px 30px; }
    .button { display: inline-block; padding: 15px 30px; background: #2D5016; color: #fff !important; text-decoration: none; border-radius: 5px; font-weight: 600; }
    .footer { background: #f9f9f9; padding: 30px; text-align: center; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🥒 Welcome to Jersey Pickles!</h1>
    </div>
    <div class="content">
      <p>Hi {{firstName}},</p>
      <p>Welcome to the Jersey Pickles family! We're thrilled to have you join our community of pickle lovers.</p>
      <p>Here's what makes us special:</p>
      <ul>
        <li>🥒 Handcrafted artisanal pickles</li>
        <li>🌿 Fresh, quality ingredients</li>
        <li>❤️ Made with love in New Jersey</li>
      </ul>
      <p style="text-align: center; margin: 30px 0;">
        <a href="https://jerseypickles.com/collections/all" class="button">Start Shopping</a>
      </p>
      <p>Questions? Just reply to this email - we're here to help!</p>
      <p>Best,<br><strong>The Jersey Pickles Team</strong></p>
    </div>
    <div class="footer">
      <p>Jersey Pickles | Kissimmee, FL</p>
      <p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;
  }

  getProductShowcaseTemplate() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: #2D5016; color: #fff; padding: 30px; text-align: center; }
    .content { padding: 40px 30px; }
    .product { background: #f9f9f9; padding: 20px; border-radius: 10px; margin: 20px 0; text-align: center; }
    .button { display: inline-block; padding: 15px 30px; background: #2D5016; color: #fff !important; text-decoration: none; border-radius: 5px; }
    .footer { background: #f9f9f9; padding: 30px; text-align: center; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⭐ Customer Favorites</h1>
    </div>
    <div class="content">
      <p>Hi {{firstName}},</p>
      <p>Wondering what to try first? Here are our most popular products:</p>
      <div class="product">
        <h3>🥒 Build Your Box</h3>
        <p>Create your perfect pickle combination!</p>
        <a href="https://jerseypickles.com/products/build-your-box" class="button">Build Now</a>
      </div>
      <div class="product">
        <h3>🫒 Premium Olives</h3>
        <p>Imported Mediterranean olives</p>
        <a href="https://jerseypickles.com/collections/olives" class="button">Shop Olives</a>
      </div>
      <p style="text-align: center; margin-top: 30px;">
        <a href="https://jerseypickles.com/collections/all" class="button">View All Products</a>
      </p>
    </div>
    <div class="footer">
      <p>Jersey Pickles | Kissimmee, FL</p>
      <p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;
  }

  getDiscountEmailTemplate(code, discount) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: linear-gradient(135deg, #2D5016, #4a7c23); color: #fff; padding: 40px; text-align: center; }
    .content { padding: 40px 30px; text-align: center; }
    .discount-box { background: #fff3cd; border: 2px dashed #2D5016; padding: 20px; margin: 20px 0; border-radius: 10px; }
    .code { font-size: 32px; font-weight: bold; color: #2D5016; letter-spacing: 2px; }
    .button { display: inline-block; padding: 18px 40px; background: #2D5016; color: #fff !important; text-decoration: none; border-radius: 5px; font-size: 18px; }
    .footer { background: #f9f9f9; padding: 30px; text-align: center; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎁 Special Gift For You!</h1>
      <p style="font-size: 24px; margin: 0;">${discount} OFF</p>
    </div>
    <div class="content">
      <p>Hi {{firstName}},</p>
      <p>We noticed you haven't placed an order yet, so here's a special discount just for you!</p>
      <div class="discount-box">
        <p style="margin: 0 0 10px 0;">Use code:</p>
        <p class="code">${code}</p>
      </div>
      <p>This offer expires in 7 days, so don't wait!</p>
      <p style="margin: 30px 0;">
        <a href="https://jerseypickles.com" class="button">Shop Now & Save</a>
      </p>
    </div>
    <div class="footer">
      <p>Jersey Pickles | Kissimmee, FL</p>
      <p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;
  }

  getCartReminderTemplate(reminderNumber) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: #2D5016; color: #fff; padding: 30px; text-align: center; }
    .content { padding: 40px 30px; }
    .button { display: inline-block; padding: 18px 40px; background: #2D5016; color: #fff !important; text-decoration: none; border-radius: 5px; font-size: 16px; }
    .footer { background: #f9f9f9; padding: 30px; text-align: center; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛒 Your Cart Misses You!</h1>
    </div>
    <div class="content">
      <p>Hi {{firstName}},</p>
      <p>Looks like you left some delicious items in your cart. Don't let them get away!</p>
      <p>Your hand-selected pickles and olives are waiting to be shipped right to your door.</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="https://jerseypickles.com/cart" class="button">Complete Your Order</a>
      </p>
      <p><em>Questions about your order? Just reply to this email!</em></p>
    </div>
    <div class="footer">
      <p>Jersey Pickles | Kissimmee, FL</p>
      <p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;
  }

  getThankYouTemplate() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: linear-gradient(135deg, #2D5016, #4a7c23); color: #fff; padding: 40px; text-align: center; }
    .content { padding: 40px 30px; }
    .footer { background: #f9f9f9; padding: 30px; text-align: center; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎉 Thank You!</h1>
      <p>Your order is confirmed</p>
    </div>
    <div class="content">
      <p>Hi {{firstName}},</p>
      <p>Thank you for your order! We're already getting your pickles ready for shipment.</p>
      <p>You'll receive a tracking email as soon as your order ships.</p>
      <p>In the meantime, follow us on social media for recipes, tips, and special offers:</p>
      <p style="text-align: center;">
        📱 Instagram: @jerseypickles<br>
        📘 Facebook: Jersey Pickles
      </p>
      <p>Thanks again for being part of the Jersey Pickles family!</p>
      <p>Best,<br><strong>The Jersey Pickles Team</strong></p>
    </div>
    <div class="footer">
      <p>Jersey Pickles | Kissimmee, FL</p>
      <p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;
  }

  getReviewRequestTemplate() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: #2D5016; color: #fff; padding: 30px; text-align: center; }
    .content { padding: 40px 30px; text-align: center; }
    .stars { font-size: 48px; margin: 20px 0; }
    .button { display: inline-block; padding: 15px 30px; background: #2D5016; color: #fff !important; text-decoration: none; border-radius: 5px; }
    .footer { background: #f9f9f9; padding: 30px; text-align: center; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⭐ How Did We Do?</h1>
    </div>
    <div class="content">
      <p>Hi {{firstName}},</p>
      <p>We hope you're loving your pickles! Your feedback helps us improve and helps other pickle lovers discover us.</p>
      <div class="stars">⭐⭐⭐⭐⭐</div>
      <p>Would you mind taking a minute to leave a review?</p>
      <p style="margin: 30px 0;">
        <a href="https://jerseypickles.com/pages/reviews" class="button">Leave a Review</a>
      </p>
      <p><em>Thank you for being part of our pickle family!</em></p>
    </div>
    <div class="footer">
      <p>Jersey Pickles | Kissimmee, FL</p>
      <p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Obtener estadísticas del flow
   */
  async getStats(req, res) {
    try {
      const flowId = req.params.id;
      
      // Usar aggregation para mejor rendimiento
      const [stats] = await FlowExecution.aggregate([
        { $match: { flow: require('mongoose').Types.ObjectId(flowId) } },
        {
          $group: {
            _id: null,
            totalExecutions: { $sum: 1 },
            activeExecutions: {
              $sum: { $cond: [{ $in: ['$status', ['active', 'waiting']] }, 1, 0] }
            },
            completedExecutions: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
            },
            failedExecutions: {
              $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
            },
            totalRevenue: { $sum: '$attributedRevenue' }
          }
        }
      ]);
      
      // Obtener métricas del flow
      const flow = await Flow.findById(flowId);
      
      const result = {
        emailsSent: flow?.metrics?.emailsSent || 0,
        opens: flow?.metrics?.opens || 0,
        clicks: flow?.metrics?.clicks || 0,
        bounced: flow?.metrics?.bounced || 0,
        delivered: flow?.metrics?.delivered || 0,
        totalExecutions: stats?.totalExecutions || 0,
        activeExecutions: stats?.activeExecutions || 0,
        completedExecutions: stats?.completedExecutions || 0,
        failedExecutions: stats?.failedExecutions || 0,
        totalRevenue: (stats?.totalRevenue || 0) + (flow?.metrics?.totalRevenue || 0)
      };
      
      res.json(result);
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Obtener ejecuciones del flow
   */
  async getExecutions(req, res) {
    try {
      const { limit = 50, offset = 0, status } = req.query;
      
      const query = { flow: req.params.id };
      if (status) {
        query.status = status;
      }
      
      const [executions, total] = await Promise.all([
        FlowExecution.find(query)
          .populate('customer', 'email firstName lastName')
          .sort({ startedAt: -1 })
          .limit(parseInt(limit))
          .skip(parseInt(offset))
          .lean(),
        FlowExecution.countDocuments(query)
      ]);
      
      res.json({ 
        success: true,
        executions,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    } catch (error) {
      console.error('Error fetching executions:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Test flow con cliente específico
   */
  async testFlow(req, res) {
    try {
      const { customerId, email } = req.body;
      
      if (!customerId && !email) {
        return res.status(400).json({
          success: false,
          error: 'Customer ID or email is required'
        });
      }
      
      const execution = await flowService.testFlow(req.params.id, customerId);
      
      res.json({ 
        success: true,
        execution,
        message: 'Test flow started successfully'
      });
    } catch (error) {
      console.error('Error testing flow:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Pausar flow
   */
  async pauseFlow(req, res) {
    try {
      const flow = await Flow.findByIdAndUpdate(
        req.params.id,
        { status: 'paused' },
        { new: true }
      );
      
      if (!flow) {
        return res.status(404).json({ 
          success: false,
          error: 'Flow not found' 
        });
      }
      
      res.json({ 
        success: true,
        flow,
        message: 'Flow paused successfully'
      });
    } catch (error) {
      console.error('Error pausing flow:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Resumir flow
   */
  async resumeFlow(req, res) {
    try {
      const flow = await Flow.findByIdAndUpdate(
        req.params.id,
        { status: 'active' },
        { new: true }
      );
      
      if (!flow) {
        return res.status(404).json({ 
          success: false,
          error: 'Flow not found' 
        });
      }
      
      res.json({ 
        success: true,
        flow,
        message: 'Flow resumed successfully'
      });
    } catch (error) {
      console.error('Error resuming flow:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  /**
   * Cancelar ejecución específica
   */
  async cancelExecution(req, res) {
    try {
      const execution = await flowService.cancelExecution(req.params.executionId);
      
      res.json({
        success: true,
        execution,
        message: 'Execution cancelled successfully'
      });
    } catch (error) {
      console.error('Error cancelling execution:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new FlowsController();