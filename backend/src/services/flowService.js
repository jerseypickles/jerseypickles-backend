// backend/src/services/flowService.js (CORREGIDO - SIN BUG DE CONDITIONS)
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
      console.log(`📦 Data:`, JSON.stringify(data, null, 2));
      
      // Buscar flows activos con este trigger
      const flows = await Flow.find({
        status: 'active',
        'trigger.type': triggerType
      });
      
      if (flows.length === 0) {
        console.log('⚠️  No active flows found for trigger: ' + triggerType);
        return { triggered: 0 };
      }
      
      console.log(`🔍 Found ${flows.length} active flows for this trigger`);
      
      const results = [];
      
      for (const flow of flows) {
        // Verificar si debe ejecutarse
        if (await this.shouldExecute(flow, data)) {
          const execution = await this.startFlow(flow, data);
          results.push({ flowId: flow._id, executionId: execution._id });
        }
      }
      
      return { triggered: results.length, executions: results };
      
    } catch (error) {
      console.error('❌ Flow trigger error:', error);
      throw error;
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
      console.log(`⏭️  Flow "${flow.name}" already running for customer ${data.customerId}`);
      return false;
    }
    
    return true;
  }
  
  /**
   * Iniciar un flow
   * ✅ CORREGIDO: Ahora copia los steps al execution
   */
  async startFlow(flow, triggerData, options = {}) {
    console.log(`\n🚀 Starting flow: ${flow.name}`);
    console.log(`   Customer: ${triggerData.customerId}`);
    console.log(`   Test mode: ${options.testMode || false}`);
    
    // ✅ IMPORTANTE: Copiar los steps del flow a la ejecución
    // Esto asegura que cambios futuros al flow no afecten esta ejecución
    const stepsCopy = JSON.parse(JSON.stringify(flow.steps));
    
    // Crear ejecución con copia de steps
    const execution = await FlowExecution.create({
      flow: flow._id,
      customer: triggerData.customerId,
      steps: stepsCopy, // ✅ Copia independiente
      triggerData,
      status: 'active',
      currentStep: 0,
      startedAt: new Date(),
      metadata: {
        flowVersion: flow.__v || 0,
        source: triggerData.source || 'webhook',
        testMode: options.testMode || false
      }
    });
    
    // Actualizar métricas
    await Flow.findByIdAndUpdate(flow._id, {
      $inc: { 
        'metrics.totalTriggered': 1,
        'metrics.currentlyActive': 1
      }
    });
    
    console.log(`✅ Execution created: ${execution._id}`);
    
    // Ejecutar primer step inmediatamente
    await this.executeNextStep(execution._id);
    
    return execution;
  }
  
  /**
   * Ejecutar siguiente step
   * ✅ CORREGIDO: Usa los steps de la ejecución, no del flow
   */
  async executeNextStep(executionId) {
    try {
      const execution = await FlowExecution.findById(executionId)
        .populate('flow', 'name _id metrics') // Solo campos necesarios
        .populate('customer');
      
      if (!execution) {
        console.log('⚠️  Execution not found:', executionId);
        return;
      }
      
      if (execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled') {
        console.log(`⏭️  Execution already ${execution.status}`);
        return;
      }
      
      // ✅ IMPORTANTE: Usar steps de la ejecución, no del flow
      const currentStep = execution.steps[execution.currentStep];
      
      if (!currentStep) {
        // Flow completado
        await this.completeFlow(execution);
        return;
      }
      
      const totalSteps = execution.steps.length;
      console.log(`\n⚡ Executing step ${execution.currentStep + 1}/${totalSteps}: ${currentStep.type}`);
      
      const startTime = Date.now();
      let result = { success: true };
      let error = null;
      
      try {
        switch (currentStep.type) {
          case 'send_email':
            result = await this.executeSendEmail(execution, currentStep);
            break;
            
          case 'wait':
            await this.executeWait(execution, currentStep);
            return; // No continuar, esperará
            
          case 'condition':
            // ✅ CORREGIDO: Ya no modifica el flow original
            await this.executeCondition(execution, currentStep);
            break;
            
          case 'add_tag':
            result = await this.executeAddTag(execution, currentStep);
            break;
            
          case 'create_discount':
            result = await this.executeCreateDiscount(execution, currentStep);
            break;
            
          default:
            console.log(`⚠️  Unknown step type: ${currentStep.type}`);
        }
      } catch (stepError) {
        error = stepError.message;
        console.error(`❌ Step failed:`, stepError.message);
      }
      
      const duration = Date.now() - startTime;
      
      // Registrar resultado
      execution.stepResults.push({
        stepIndex: execution.currentStep,
        stepType: currentStep.type,
        executedAt: new Date(),
        result: error ? { success: false } : result,
        error,
        duration
      });
      
      if (error) {
        execution.status = 'failed';
        await execution.save();
        
        // Actualizar métricas del flow
        await Flow.findByIdAndUpdate(execution.flow._id, {
          $inc: { 'metrics.currentlyActive': -1 }
        });
        
        return;
      }
      
      // Avanzar al siguiente step
      execution.currentStep += 1;
      await execution.save();
      
      // Ejecutar siguiente step (con pequeño delay para evitar stack overflow)
      setImmediate(() => this.executeNextStep(executionId));
      
    } catch (error) {
      console.error(`❌ Execute next step error:`, error);
      
      // Marcar como failed
      await FlowExecution.findByIdAndUpdate(executionId, {
        status: 'failed',
        $push: {
          stepResults: {
            executedAt: new Date(),
            error: error.message
          }
        }
      });
    }
  }
  
  // ==================== STEP HANDLERS ====================
  
  /**
   * Enviar email
   */
  async executeSendEmail(execution, step) {
    const { subject, templateId, htmlContent, previewText } = step.config;
    const customer = execution.customer;
    
    const flowId = execution.flow._id ? execution.flow._id.toString() : execution.flow.toString();
    const executionId = execution._id.toString();
    const customerId = customer._id.toString();
    
    console.log(`📧 Sending email to ${customer.email}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Template: ${templateId || 'custom'}`);
    
    let html;
    
    // Usar template si está definido
    if (templateId && templateService[`get${this.capitalize(templateId)}Email`]) {
      html = templateService[`get${this.capitalize(templateId)}Email`](
        customer.firstName || 'Friend',
        execution.triggerData
      );
    } else if (templateId) {
      // Templates predefinidos
      switch (templateId) {
        case 'welcome':
          html = templateService.getWelcomeEmail?.(customer.firstName || 'Friend') || htmlContent;
          break;
        case 'cart_reminder_1':
        case 'abandoned_cart':
          const cartItems = execution.triggerData?.cartItems || [];
          html = templateService.getAbandonedCartEmail?.(
            customer.firstName || 'Friend',
            cartItems,
            'https://jerseypickles.com/cart'
          ) || htmlContent;
          break;
        case 'order_confirmation':
          html = templateService.getOrderConfirmationEmail?.(
            customer.firstName || 'Friend',
            execution.triggerData?.orderNumber
          ) || htmlContent;
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
    
    // Tags para Resend
    const emailTags = [
      { name: 'flow_id', value: flowId },
      { name: 'execution_id', value: executionId },
      { name: 'customer_id', value: customerId }
    ];
    
    // Enviar con Resend
    const result = await emailService.sendEmail({
      to: customer.email,
      subject: personalizedSubject,
      html,
      tags: emailTags
    });
    
    if (result.success) {
      console.log(`✅ Email sent successfully! ID: ${result.id}`);
      
      // Registrar email enviado en la ejecución
      execution.emailsSent.push({
        resendId: result.id,
        subject: personalizedSubject,
        sentAt: new Date()
      });
      
      // Actualizar métricas del flow
      await Flow.findByIdAndUpdate(flowId, {
        $inc: { 'metrics.emailsSent': 1 }
      });
    } else {
      throw new Error(`Failed to send email: ${result.error}`);
    }
    
    return result;
  }
  
  /**
   * Helper para capitalizar
   */
  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1).replace(/_([a-z])/g, (g) => g[1].toUpperCase());
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
    
    const hours = Math.floor(delayMinutes / 60);
    const mins = delayMinutes % 60;
    console.log(`⏰ Waiting ${hours}h ${mins}m until ${resumeAt.toISOString()}`);
    
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
    console.log(`📅 Scheduling resume with setTimeout in ${delay}ms`);
    setTimeout(async () => {
      try {
        console.log(`⏰ Resuming flow execution: ${executionId}`);
        
        // Verificar que aún está en waiting
        const execution = await FlowExecution.findById(executionId);
        if (execution?.status === 'waiting') {
          execution.status = 'active';
          await execution.save();
          await this.executeNextStep(executionId);
        }
      } catch (error) {
        console.error('Error resuming flow:', error);
      }
    }, delay);
  }
  
  /**
   * Evaluar condición
   * ✅ CORREGIDO: Ya no modifica el flow original, solo la ejecución
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
    
    console.log(`🔀 Condition [${conditionType}]: ${conditionMet ? 'TRUE ✅' : 'FALSE ❌'}`);
    
    // Ejecutar branch correspondiente
    const branch = conditionMet ? ifTrue : ifFalse;
    
    if (branch && branch.length > 0) {
      console.log(`   Inserting ${branch.length} steps from ${conditionMet ? 'TRUE' : 'FALSE'} branch`);
      
      // ✅ CORREGIDO: Insertar steps en la EJECUCIÓN, no en el flow
      execution.insertStepsAfterCurrent(branch);
      // No guardamos aquí, se guarda en executeNextStep
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
      return { success: false, error: 'No tag name' };
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
    
    return { success: true, tagName };
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
      
      return { success: true, code, priceRuleId: priceRule.id };
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
    
    const flowId = execution.flow._id || execution.flow;
    
    // Actualizar métricas
    await Flow.findByIdAndUpdate(flowId, {
      $inc: { 
        'metrics.currentlyActive': -1,
        'metrics.completed': 1
      }
    });
    
    const customerEmail = execution.customer?.email || execution.customer;
    console.log(`\n✅ ========== FLOW COMPLETED ==========`);
    console.log(`   Customer: ${customerEmail}`);
    console.log(`   Duration: ${this.formatDuration(execution.completedAt - execution.startedAt)}`);
    console.log(`   Steps executed: ${execution.stepResults.length}`);
    console.log(`   Emails sent: ${execution.emailsSent?.length || 0}`);
  }
  
  /**
   * Formatear duración
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
  
  /**
   * Test flow con cliente específico
   */
  async testFlow(flowId, customerId) {
    console.log(`\n🧪 ========== TEST FLOW ==========`);
    console.log(`   Flow: ${flowId}`);
    console.log(`   Customer: ${customerId}`);
    
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
    
    return await this.startFlow(flow, triggerData, { testMode: true });
  }
  
  /**
   * Cancelar ejecución
   */
  async cancelExecution(executionId) {
    const execution = await FlowExecution.findById(executionId);
    
    if (!execution) {
      throw new Error('Execution not found');
    }
    
    if (execution.status === 'completed' || execution.status === 'cancelled') {
      throw new Error(`Cannot cancel: execution is ${execution.status}`);
    }
    
    execution.status = 'cancelled';
    execution.completedAt = new Date();
    await execution.save();
    
    // Actualizar métricas
    await Flow.findByIdAndUpdate(execution.flow, {
      $inc: { 'metrics.currentlyActive': -1 }
    });
    
    console.log(`🚫 Execution cancelled: ${executionId}`);
    
    return execution;
  }
  
  /**
   * Procesar jobs pendientes (para recovery)
   */
  async processWaitingExecutions() {
    const now = new Date();
    
    const readyExecutions = await FlowExecution.find({
      status: 'waiting',
      resumeAt: { $lte: now }
    });
    
    console.log(`🔄 Found ${readyExecutions.length} waiting executions ready to resume`);
    
    for (const execution of readyExecutions) {
      execution.status = 'active';
      await execution.save();
      
      // Ejecutar con pequeño delay entre cada uno
      setTimeout(() => {
        this.executeNextStep(execution._id);
      }, Math.random() * 1000);
    }
    
    return readyExecutions.length;
  }
}

module.exports = new FlowService();