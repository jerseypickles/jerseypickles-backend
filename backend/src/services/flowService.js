// backend/src/services/flowService.js
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
        console.log('⚠️  No active flows found');
        return;
      }
      
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
    const config = flow.trigger.config;
    
    // Para triggers con tag
    if (config.tagName && data.tag !== config.tagName) {
      return false;
    }
    
    // Para triggers con segmento
    if (config.segmentId && data.segmentId !== config.segmentId.toString()) {
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
      currentStep: 0
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
    const execution = await FlowExecution.findById(executionId)
      .populate('flow')
      .populate('customer');
    
    if (!execution || execution.status === 'completed') {
      return;
    }
    
    const flow = execution.flow;
    const currentStep = flow.steps[execution.currentStep];
    
    if (!currentStep) {
      // Flow completado
      await this.completeFlow(execution);
      return;
    }
    
    console.log(`\n⚡ Executing step ${execution.currentStep + 1}/${flow.steps.length}: ${currentStep.type}`);
    
    try {
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
      }
      
      // Registrar resultado
      execution.stepResults.push({
        stepIndex: execution.currentStep,
        executedAt: new Date(),
        result: { success: true }
      });
      
      // Avanzar al siguiente step
      execution.currentStep += 1;
      await execution.save();
      
      // Ejecutar siguiente step
      await this.executeNextStep(executionId);
      
    } catch (error) {
      console.error(`❌ Step failed:`, error);
      
      execution.stepResults.push({
        stepIndex: execution.currentStep,
        executedAt: new Date(),
        error: error.message
      });
      
      execution.status = 'failed';
      await execution.save();
    }
  }
  
  // ==================== STEP HANDLERS ====================
  
  /**
   * Enviar email con Resend (usando tu sistema actual)
   */
  async executeSendEmail(execution, step) {
    const { subject, templateId, htmlContent } = step.config;
    const customer = execution.customer;
    
    let html;
    
    // Usar template si está definido
    if (templateId) {
      switch (templateId) {
        case 'welcome':
          html = templateService.getWelcomeEmail(customer.firstName);
          break;
        case 'abandoned_cart':
          // Obtener items del cart desde triggerData
          const cartItems = execution.triggerData.cartItems || [];
          html = templateService.getAbandonedCartEmail(
            customer.firstName,
            cartItems,
            'https://jerseypickles.com/cart'
          );
          break;
        default:
          html = htmlContent;
      }
    } else {
      html = htmlContent;
    }
    
    // Personalizar
    html = emailService.personalize(html, customer);
    
    // Agregar tracking (para attribution)
    html = emailService.injectTracking(
      html,
      execution.flow.toString(),  // Usar flowId como campaignId
      customer._id.toString(),
      customer.email
    );
    
    // Enviar con Resend
    const result = await emailService.sendEmail({
      to: customer.email,
      subject: emailService.personalize(subject, customer),
      html,
      tags: [
        { name: 'flow_id', value: execution.flow.toString() },
        { name: 'execution_id', value: execution._id.toString() },
        { name: 'customer_id', value: customer._id.toString() }
      ]
    });
    
    console.log(`📧 Email sent to ${customer.email}: ${result.id}`);
    
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
    
    // Agregar a cola para procesar después
    const { addFlowJob } = require('../jobs/flowQueue');
    await addFlowJob(
      { executionId: execution._id.toString() },
      { delay: delayMinutes * 60 * 1000 }
    );
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
        conditionMet = customer.tags.includes(conditionValue);
        break;
        
      case 'total_spent_greater':
        conditionMet = customer.totalSpent > conditionValue;
        break;
        
      case 'orders_count_greater':
        conditionMet = customer.ordersCount > conditionValue;
        break;
    }
    
    console.log(`🔀 Condition [${conditionType}]: ${conditionMet ? 'TRUE' : 'FALSE'}`);
    
    // Ejecutar branch correspondiente
    const branch = conditionMet ? ifTrue : ifFalse;
    
    if (branch && branch.length > 0) {
      // Insertar los steps del branch en el flow
      const flow = execution.flow;
      const nextStepIndex = execution.currentStep + 1;
      
      // Insertar steps del branch
      flow.steps.splice(nextStepIndex, 0, ...branch);
      await flow.save();
    }
  }
  
  /**
   * Agregar tag en Shopify
   */
  async executeAddTag(execution, step) {
    const { tagName } = step.config;
    const customer = execution.customer;
    
    if (customer.shopifyId) {
      // Llamar a Shopify API (necesitas implementar este método)
      // await shopifyService.addCustomerTag(customer.shopifyId, tagName);
    }
    
    // Actualizar localmente
    await Customer.findByIdAndUpdate(customer._id, {
      $addToSet: { tags: tagName }
    });
    
    console.log(`🏷️  Tag added: ${tagName}`);
  }
  
  /**
   * Crear código de descuento
   */
  async executeCreateDiscount(execution, step) {
    const { discountCode, discountType, discountValue, expiresInDays } = step.config;
    
    const code = discountCode || `FLOW${Date.now()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expiresInDays || 7));
    
    // Crear en Shopify
    const priceRule = await shopifyService.createPriceRule({
      title: `Flow discount: ${code}`,
      value_type: discountType === 'percentage' ? 'percentage' : 'fixed_amount',
      value: `-${discountValue}`,
      once_per_customer: true,
      starts_at: new Date().toISOString(),
      ends_at: expiresAt.toISOString()
    });
    
    await shopifyService.createDiscountCode(priceRule.id, code);
    
    console.log(`🎫 Discount created: ${code} (${discountValue}${discountType === 'percentage' ? '%' : '$'})`);
    
    return { code, priceRuleId: priceRule.id };
  }
  
  /**
   * Completar flow
   */
  async completeFlow(execution) {
    execution.status = 'completed';
    await execution.save();
    
    // Actualizar métricas
    await Flow.findByIdAndUpdate(execution.flow, {
      $inc: { 
        'metrics.currentlyActive': -1,
        'metrics.completed': 1
      }
    });
    
    console.log(`✅ Flow completed for customer ${execution.customer.email}`);
  }
}

module.exports = new FlowService();