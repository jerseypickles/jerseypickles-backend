// backend/src/services/flowService.js (COMPLETO Y ACTUALIZADO CON TAGS)
const Flow = require('../models/Flow');
const FlowExecution = require('../models/FlowExecution');
const Customer = require('../models/Customer');
const emailService = require('./emailService');
const shopifyService = require('./shopifyService');
const templateService = require('./templateService');

class FlowService {
  
  /**
   * Procesar trigger desde webhooks
   */
  async processTrigger(triggerType, data) {
    try {
      console.log(`\n🎯 ========== FLOW TRIGGER ==========`);
      console.log(`📌 Type: ${triggerType}`);
      console.log(`📦 Data:`, data);
      
      // Buscar flows activos con este trigger
      const flows = await Flow.find({
        status: 'active',
        'trigger.type': triggerType
      });
      
      if (flows.length === 0) {
        console.log('⚠️  No active flows found for trigger: ' + triggerType);
        return;
      }
      
      console.log(`🔍 Found ${flows.length} active flows for this trigger`);
      
      for (const flow of flows) {
        // Verificar si debe ejecutarse
        if (await this.shouldExecute(flow, data)) {
          await this.startFlow(flow, data);
        }
      }
      
    } catch (error) {
      console.error('❌ Flow trigger error:', error);
    }
  }
  
  /**
   * Verificar condiciones del flow
   */
  async shouldExecute(flow, data) {
    // Verificar config específica del trigger
    const config = flow.trigger.config || {};
    
    // Para triggers con tag específico
    if (config.tagName && data.tag !== config.tagName) {
      console.log(`⏭️  Tag mismatch: expected ${config.tagName}, got ${data.tag}`);
      return false;
    }
    
    // Para triggers con segmento
    if (config.segmentId && data.segmentId !== config.segmentId.toString()) {
      console.log(`⏭️  Segment mismatch`);
      return false;
    }
    
    // Verificar si ya está ejecutándose para este cliente
    const existing = await FlowExecution.findOne({
      flow: flow._id,
      customer: data.customerId,
      status: { $in: ['active', 'waiting'] }
    });
    
    if (existing) {
      console.log('⏭️  Flow already running for this customer');
      return false;
    }
    
    return true;
  }
  
  /**
   * Iniciar un flow
   */
  async startFlow(flow, triggerData) {
    console.log(`\n🚀 Starting flow: ${flow.name}`);
    
    // Crear ejecución
    const execution = await FlowExecution.create({
      flow: flow._id,
      customer: triggerData.customerId,
      triggerData,
      status: 'active',
      currentStep: 0,
      startedAt: new Date()
    });
    
    // Actualizar métricas
    await Flow.findByIdAndUpdate(flow._id, {
      $inc: { 
        'metrics.totalTriggered': 1,
        'metrics.currentlyActive': 1
      }
    });
    
    // Ejecutar primer step inmediatamente
    await this.executeNextStep(execution._id);
    
    return execution;
  }
  
  /**
   * Ejecutar siguiente step
   */
  async executeNextStep(executionId) {
    try {
      const execution = await FlowExecution.findById(executionId)
        .populate('flow')
        .populate('customer');
      
      if (!execution) {
        console.log('⚠️  Execution not found:', executionId);
        return;
      }
      
      if (execution.status === 'completed' || execution.status === 'failed') {
        console.log(`⏭️  Execution already ${execution.status}`);
        return;
      }
      
      const flow = execution.flow;
      const currentStep = flow.steps[execution.currentStep];
      
      if (!currentStep) {
        // Flow completado
        await this.completeFlow(execution);
        return;
      }
      
      console.log(`⚡ Executing step ${execution.currentStep + 1}/${flow.steps.length}: ${currentStep.type}`);
      
      switch (currentStep.type) {
        case 'send_email':
          await this.executeSendEmail(execution, currentStep);
          break;
          
        case 'wait':
          await this.executeWait(execution, currentStep);
          return; // No continuar, esperará
          
        case 'condition':
          await this.executeCondition(execution, currentStep);
          break;
          
        case 'add_tag':
          await this.executeAddTag(execution, currentStep);
          break;
          
        case 'create_discount':
          await this.executeCreateDiscount(execution, currentStep);
          break;
          
        default:
          console.log(`⚠️  Unknown step type: ${currentStep.type}`);
      }
      
      // Registrar resultado exitoso
      execution.stepResults.push({
        stepIndex: execution.currentStep,
        executedAt: new Date(),
        result: { success: true }
      });
      
      // Avanzar al siguiente step
      execution.currentStep += 1;
      await execution.save();
      
      // Ejecutar siguiente step recursivamente
      await this.executeNextStep(executionId);
      
    } catch (error) {
      console.error(`❌ Step failed:`, error);
      
      // Registrar error
      const execution = await FlowExecution.findById(executionId);
      if (execution) {
        execution.stepResults.push({
          stepIndex: execution.currentStep,
          executedAt: new Date(),
          error: error.message
        });
        
        execution.status = 'failed';
        await execution.save();
        
        // Actualizar métricas del flow
        await Flow.findByIdAndUpdate(execution.flow, {
          $inc: { 'metrics.currentlyActive': -1 }
        });
      }
    }
  }
  
  // ==================== STEP HANDLERS ====================
  
  /**
   * Enviar email
   */
  async executeSendEmail(execution, step) {
    const { subject, templateId, htmlContent } = step.config;
    const customer = execution.customer;
    
    // IMPORTANTE: Obtener el ID del flow correctamente
    const flowId = execution.flow._id ? execution.flow._id.toString() : execution.flow.toString();
    const executionId = execution._id.toString();
    const customerId = customer._id.toString();
    
    console.log(`📧 Sending email to ${customer.email}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Template: ${templateId || 'custom'}`);
    console.log(`   Flow ID: ${flowId}`);
    console.log(`   Execution ID: ${executionId}`);
    
    let html;
    
    // Usar template si está definido
    if (templateId) {
      switch (templateId) {
        case 'welcome':
          html = templateService.getWelcomeEmail(customer.firstName || 'Friend');
          break;
        case 'cart_reminder_1':
        case 'abandoned_cart':
          const cartItems = execution.triggerData?.cartItems || [];
          html = templateService.getAbandonedCartEmail(
            customer.firstName || 'Friend',
            cartItems,
            'https://jerseypickles.com/cart'
          );
          break;
        case 'order_confirmation':
          html = templateService.getOrderConfirmationEmail(
            customer.firstName || 'Friend',
            execution.triggerData?.orderNumber
          );
          break;
        case 'products_showcase':
          html = templateService.getProductShowcaseEmail(customer.firstName || 'Friend');
          break;
        case 'cart_discount':
          html = templateService.getDiscountEmail(
            customer.firstName || 'Friend',
            '10%',
            'COMEBACK10'
          );
          break;
        default:
          html = htmlContent || '<p>Email content</p>';
      }
    } else {
      html = htmlContent || '<p>Email content</p>';
    }
    
    // Personalizar variables
    html = emailService.personalize(html, customer);
    const personalizedSubject = emailService.personalize(subject, customer);
    
    // Agregar tracking
    html = emailService.injectTracking(
      html,
      flowId,
      customerId,
      customer.email
    );
    
    // ✅ Preparar tags para Resend
    const emailTags = [
      { name: 'flow_id', value: flowId },
      { name: 'execution_id', value: executionId },
      { name: 'customer_id', value: customerId }
    ];
    
    console.log(`📋 Email tags:`, emailTags);
    
    // Enviar con Resend
    const result = await emailService.sendEmail({
      to: customer.email,
      subject: personalizedSubject,
      html,
      tags: emailTags  // ✅ Pasar tags directamente
    });
    
    // ✅ Mejor logging del resultado
    if (result.success) {
      console.log(`✅ Email sent successfully!`);
      console.log(`   Resend ID: ${result.id || 'N/A'}`);
      console.log(`   To: ${result.email}`);
    } else {
      console.error(`❌ Email failed to send: ${result.error}`);
      throw new Error(`Failed to send email: ${result.error}`);
    }
    
    // Actualizar métricas del flow
    await Flow.findByIdAndUpdate(flowId, {
      $inc: { 'metrics.emailsSent': 1 }
    });
    
    return result;
  }
  
  /**
   * Esperar X minutos
   */
  async executeWait(execution, step) {
    const { delayMinutes } = step.config;
    const resumeAt = new Date();
    resumeAt.setMinutes(resumeAt.getMinutes() + delayMinutes);
    
    execution.status = 'waiting';
    execution.resumeAt = resumeAt;
    execution.currentStep += 1; // Preparar para siguiente step
    await execution.save();
    
    console.log(`⏰ Waiting ${delayMinutes} minutes until ${resumeAt.toISOString()}`);
    
    // Intentar agregar a cola
    try {
      const flowQueue = require('../jobs/flowQueue');
      
      if (flowQueue.flowQueue && typeof flowQueue.flowQueue.add === 'function') {
        await flowQueue.flowQueue.add(
          'resume-flow',
          { executionId: execution._id.toString() },
          { delay: delayMinutes * 60 * 1000 }
        );
        console.log('✅ Flow job scheduled in Redis queue');
      } else {
        console.log('⚠️  Flow queue not available, using setTimeout fallback');
        this.scheduleWithTimeout(execution._id.toString(), delayMinutes * 60 * 1000);
      }
    } catch (error) {
      console.log('⚠️  Flow queue error, using setTimeout fallback:', error.message);
      this.scheduleWithTimeout(execution._id.toString(), delayMinutes * 60 * 1000);
    }
  }
  
  /**
   * Fallback para scheduling sin Redis
   */
  scheduleWithTimeout(executionId, delay) {
    setTimeout(async () => {
      try {
        console.log(`⏰ Resuming flow execution: ${executionId}`);
        await this.executeNextStep(executionId);
      } catch (error) {
        console.error('Error resuming flow:', error);
      }
    }, delay);
  }
  
  /**
   * Evaluar condición
   */
  async executeCondition(execution, step) {
    const { conditionType, conditionValue, ifTrue, ifFalse } = step.config;
    const customer = execution.customer;
    
    let conditionMet = false;
    
    switch (conditionType) {
      case 'has_purchased':
        conditionMet = customer.ordersCount > 0;
        break;
        
      case 'tag_exists':
        conditionMet = customer.tags?.includes(conditionValue);
        break;
        
      case 'total_spent_greater':
        conditionMet = customer.totalSpent > parseFloat(conditionValue);
        break;
        
      case 'orders_count_greater':
        conditionMet = customer.ordersCount > parseInt(conditionValue);
        break;
        
      default:
        console.log(`⚠️  Unknown condition type: ${conditionType}`);
    }
    
    console.log(`🔀 Condition [${conditionType}]: ${conditionMet ? 'TRUE' : 'FALSE'}`);
    
    // Ejecutar branch correspondiente
    const branch = conditionMet ? ifTrue : ifFalse;
    
    if (branch && branch.length > 0) {
      // Insertar los steps del branch después del step actual
      const flow = execution.flow;
      const nextStepIndex = execution.currentStep + 1;
      
      console.log(`   Inserting ${branch.length} steps from ${conditionMet ? 'TRUE' : 'FALSE'} branch`);
      
      // Insertar steps del branch en el flow
      flow.steps.splice(nextStepIndex, 0, ...branch);
      await flow.save();
    }
  }
  
  /**
   * Agregar tag
   */
  async executeAddTag(execution, step) {
    const { tagName } = step.config;
    const customer = execution.customer;
    
    if (!tagName) {
      console.log('⚠️  No tag name specified');
      return;
    }
    
    // Actualizar en Shopify si tiene ID
    if (customer.shopifyId) {
      try {
        await shopifyService.addCustomerTag(customer.shopifyId, tagName);
        console.log(`✅ Tag added in Shopify: ${tagName}`);
      } catch (error) {
        console.log(`⚠️  Could not add tag in Shopify: ${error.message}`);
      }
    }
    
    // Actualizar localmente
    await Customer.findByIdAndUpdate(customer._id, {
      $addToSet: { tags: tagName }
    });
    
    console.log(`🏷️  Tag added locally: ${tagName}`);
  }
  
  /**
   * Crear código de descuento
   */
  async executeCreateDiscount(execution, step) {
    const { discountCode, discountType, discountValue, expiresInDays } = step.config;
    
    const code = discountCode || `FLOW${Date.now()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expiresInDays || 7));
    
    try {
      // Crear en Shopify
      const priceRule = await shopifyService.createPriceRule({
        title: `Flow discount: ${code}`,
        value_type: discountType === 'percentage' ? 'percentage' : 'fixed_amount',
        value: `-${discountValue}`,
        customer_selection: 'all',
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        once_per_customer: true,
        starts_at: new Date().toISOString(),
        ends_at: expiresAt.toISOString()
      });
      
      await shopifyService.createDiscountCode(priceRule.id, code);
      
      console.log(`🎫 Discount created: ${code} (${discountValue}${discountType === 'percentage' ? '%' : '$'})`);
      
      return { code, priceRuleId: priceRule.id };
    } catch (error) {
      console.error('❌ Error creating discount:', error.message);
      throw error;
    }
  }
  
  /**
   * Completar flow
   */
  async completeFlow(execution) {
    execution.status = 'completed';
    execution.completedAt = new Date();
    await execution.save();
    
    // Actualizar métricas
    await Flow.findByIdAndUpdate(execution.flow._id || execution.flow, {
      $inc: { 
        'metrics.currentlyActive': -1,
        'metrics.completed': 1
      }
    });
    
    const customer = execution.customer;
    console.log(`✅ Flow completed for customer ${customer.email || customer._id}`);
  }
  
  /**
   * Test flow con cliente específico
   */
  async testFlow(flowId, customerId) {
    console.log(`\n🧪 Testing flow ${flowId} with customer ${customerId}`);
    
    const flow = await Flow.findById(flowId);
    if (!flow) {
      throw new Error('Flow not found');
    }
    
    const customer = await Customer.findById(customerId);
    if (!customer) {
      throw new Error('Customer not found');
    }
    
    // Simular trigger data
    const triggerData = {
      customerId: customer._id,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      source: 'test'
    };
    
    return await this.startFlow(flow, triggerData);
  }
}

module.exports = new FlowService();