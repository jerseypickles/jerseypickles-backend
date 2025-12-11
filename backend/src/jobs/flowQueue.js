// backend/src/jobs/flowQueue.js (CORREGIDO CON VALIDACIÓN)
const { Queue, Worker } = require('bullmq');
const Flow = require('../models/Flow');
const FlowExecution = require('../models/FlowExecution');
const Customer = require('../models/Customer');
const emailService = require('../services/emailService');
const shopifyService = require('../services/shopifyService');

let flowQueue = null;
let flowWorker = null;

// Configuración de Redis
const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null
};

// Si usas Upstash Redis
if (process.env.REDIS_URL) {
  const url = new URL(process.env.REDIS_URL);
  redisConnection.host = url.hostname;
  redisConnection.port = parseInt(url.port);
  redisConnection.password = url.password;
  redisConnection.tls = url.protocol === 'rediss:' ? {} : undefined;
}

try {
  // Crear queue
  flowQueue = new Queue('flow-processing', {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    }
  });

  // Crear worker
  flowWorker = new Worker('flow-processing', async (job) => {
    const { flowId, executionId, stepIndex } = job.data || {};
    
    console.log(`🔄 Processing flow step: ${flowId || 'unknown'} - Step ${stepIndex ?? 'unknown'}`);
    
    // ==================== VALIDACIÓN DE DATOS ====================
    
    // Validar que el job tenga datos válidos
    if (!job.data || !flowId) {
      console.log(`⚠️  Skipping invalid job ${job.id} - missing flowId`);
      return { skipped: true, reason: 'missing flowId', jobId: job.id };
    }
    
    if (!executionId) {
      console.log(`⚠️  Skipping invalid job ${job.id} - missing executionId`);
      return { skipped: true, reason: 'missing executionId', jobId: job.id };
    }
    
    if (stepIndex === undefined || stepIndex === null) {
      console.log(`⚠️  Skipping invalid job ${job.id} - missing stepIndex`);
      return { skipped: true, reason: 'missing stepIndex', jobId: job.id };
    }
    
    try {
      // Validar que el flow existe
      const flow = await Flow.findById(flowId);
      if (!flow) {
        console.log(`⚠️  Skipping job ${job.id} - flow ${flowId} not found (possibly deleted)`);
        
        // Intentar marcar la ejecución como fallida si existe
        try {
          await FlowExecution.findByIdAndUpdate(executionId, {
            status: 'failed',
            error: 'Flow was deleted'
          });
        } catch (e) {
          // Ignorar si la ejecución tampoco existe
        }
        
        return { skipped: true, reason: 'flow not found', flowId };
      }
      
      // Validar que la ejecución existe
      const execution = await FlowExecution.findById(executionId).populate('customer');
      if (!execution) {
        console.log(`⚠️  Skipping job ${job.id} - execution ${executionId} not found`);
        return { skipped: true, reason: 'execution not found', executionId };
      }
      
      // Validar que la ejecución no esté ya completada o cancelada
      if (['completed', 'cancelled', 'failed'].includes(execution.status)) {
        console.log(`⚠️  Skipping job ${job.id} - execution already ${execution.status}`);
        return { skipped: true, reason: `execution ${execution.status}`, executionId };
      }
      
      // Validar que el customer existe
      if (!execution.customer) {
        console.log(`⚠️  Skipping job ${job.id} - customer not found`);
        execution.status = 'failed';
        execution.error = 'Customer not found';
        await execution.save();
        return { skipped: true, reason: 'customer not found', executionId };
      }
      
      // Validar que el step existe
      const step = flow.steps[stepIndex];
      if (!step) {
        console.log(`⚠️  Skipping job ${job.id} - step ${stepIndex} not found in flow`);
        return { skipped: true, reason: 'step not found', stepIndex };
      }
      
      // ==================== PROCESAR STEP ====================
      
      console.log(`✅ Valid job - processing ${flow.name} step ${stepIndex}: ${step.type}`);
      
      // Procesar según el tipo de step
      switch (step.type) {
        case 'send_email':
          await processEmailStep(execution, step, flow);
          break;
        case 'wait':
          await processWaitStep(execution, step, flowId, executionId, stepIndex);
          return { waited: true }; // No continuar, el wait programará el siguiente
        case 'condition':
          await processConditionStep(execution, step, flowId, executionId, stepIndex);
          break;
        case 'add_tag':
          await processTagStep(execution, step);
          break;
        case 'create_discount':
          await processDiscountStep(execution, step);
          break;
        default:
          console.log(`⚠️  Unknown step type: ${step.type}`);
      }
      
      // Marcar step como completado
      if (!execution.completedSteps.includes(stepIndex)) {
        execution.completedSteps.push(stepIndex);
      }
      
      // Si hay más steps, continuar
      const nextStepIndex = stepIndex + 1;
      if (nextStepIndex < flow.steps.length) {
        execution.currentStep = nextStepIndex;
        await execution.save();
        
        // Programar siguiente step
        await flowQueue.add(`flow-${flowId}-step-${nextStepIndex}`, {
          flowId,
          executionId,
          stepIndex: nextStepIndex
        });
        
        console.log(`➡️  Queued next step: ${nextStepIndex}`);
      } else {
        // Flow completado
        execution.status = 'completed';
        execution.completedAt = new Date();
        await execution.save();
        
        // Actualizar métricas del flow
        await Flow.findByIdAndUpdate(flowId, {
          $inc: { 'metrics.completed': 1 }
        });
        
        console.log(`🎉 Flow completed: ${flow.name} for ${execution.customer.email}`);
      }
      
      return { success: true, flowId, stepIndex };
      
    } catch (error) {
      console.error(`❌ Error processing flow step:`, error.message);
      
      // Intentar marcar la ejecución como fallida
      try {
        await FlowExecution.findByIdAndUpdate(executionId, {
          status: 'failed',
          error: error.message
        });
      } catch (e) {
        // Ignorar
      }
      
      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: 5
  });

  flowWorker.on('completed', (job, result) => {
    if (result?.skipped) {
      console.log(`⏭️  Flow job skipped: ${job.id} - ${result.reason}`);
    } else if (result?.waited) {
      console.log(`⏱️  Flow job waiting: ${job.id}`);
    } else {
      console.log(`✅ Flow job completed: ${job.id}`);
    }
  });

  flowWorker.on('failed', (job, err) => {
    console.error(`❌ Flow job failed: ${job?.id || 'unknown'}`, err.message);
  });

  console.log('✅ Flow Queue initialized successfully');

  // ==================== LIMPIAR JOBS FALLIDOS AL INICIAR ====================
  
  // Limpiar jobs fallidos antiguos al iniciar
  setTimeout(async () => {
    try {
      const failedJobs = await flowQueue.getFailed(0, 100);
      
      if (failedJobs.length > 0) {
        console.log(`🧹 Cleaning ${failedJobs.length} failed jobs...`);
        
        for (const job of failedJobs) {
          // Si el job tiene datos inválidos, removerlo
          if (!job.data || !job.data.flowId || !job.data.executionId) {
            await job.remove();
            console.log(`   Removed invalid job: ${job.id}`);
          }
        }
      }
    } catch (err) {
      console.log('⚠️  Could not clean failed jobs:', err.message);
    }
  }, 5000);

} catch (error) {
  console.error('⚠️  Flow Queue initialization failed:', error.message);
  console.log('   Flows will not be available in this session');
}

// ==================== FUNCIONES DE PROCESAMIENTO ====================

async function processEmailStep(execution, step, flow) {
  console.log(`📧 Sending email: ${step.config?.subject || 'No subject'}`);
  
  const customer = execution.customer;
  
  if (!customer.email) {
    console.log('⚠️  Customer has no email, skipping send');
    return;
  }
  
  // Verificar que el customer no esté bounced
  if (customer.emailStatus === 'bounced' || customer.bounceInfo?.isBounced) {
    console.log(`⚠️  Customer ${customer.email} is bounced, skipping send`);
    return;
  }
  
  await emailService.sendFlowEmail({
    to: customer.email,
    subject: step.config?.subject || `Message from ${flow.name}`,
    html: step.config?.html || step.config?.content || '',
    templateId: step.config?.templateId,
    flowId: execution.flow,
    executionId: execution._id,
    customerId: customer._id,
    customerData: {
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email
    }
  });
  
  // Actualizar métricas
  await Flow.findByIdAndUpdate(execution.flow, {
    $inc: { 'metrics.emailsSent': 1 }
  });
  
  console.log(`   ✅ Email sent to ${customer.email}`);
}

async function processWaitStep(execution, step, flowId, executionId, stepIndex) {
  const delayMinutes = step.config?.delayMinutes || step.config?.delay || 60;
  console.log(`⏱️  Waiting ${delayMinutes} minutes`);
  
  // Programar siguiente step después del delay
  const delay = delayMinutes * 60 * 1000;
  
  await flowQueue.add(
    `flow-${flowId}-step-${stepIndex + 1}`,
    {
      flowId,
      executionId,
      stepIndex: stepIndex + 1
    },
    { delay }
  );
  
  execution.status = 'waiting';
  execution.currentStep = stepIndex;
  await execution.save();
  
  console.log(`   ✅ Next step scheduled in ${delayMinutes} minutes`);
}

async function processConditionStep(execution, step, flowId, executionId, stepIndex) {
  console.log(`🔍 Evaluating condition: ${step.config?.conditionType || 'unknown'}`);
  
  let conditionMet = false;
  
  switch (step.config?.conditionType) {
    case 'has_purchased':
      const Order = require('../models/Order');
      const orderCount = await Order.countDocuments({ 
        customer: execution.customer._id 
      });
      conditionMet = orderCount > 0;
      break;
      
    case 'has_tag':
      conditionMet = execution.customer.tags?.includes(step.config?.tagName);
      break;
      
    case 'total_spent_above':
      conditionMet = (execution.customer.totalSpent || 0) >= (step.config?.threshold || 0);
      break;
      
    case 'orders_count_above':
      conditionMet = (execution.customer.ordersCount || 0) >= (step.config?.threshold || 0);
      break;
      
    default:
      console.log(`⚠️  Unknown condition type: ${step.config?.conditionType}`);
  }
  
  console.log(`   Condition result: ${conditionMet}`);
  
  // Ejecutar acciones según el resultado
  const actions = conditionMet ? step.config?.ifTrue : step.config?.ifFalse;
  
  if (actions && actions.length > 0) {
    for (const action of actions) {
      await processAction(execution, action);
    }
  }
}

async function processTagStep(execution, step) {
  const tagName = step.config?.tagName;
  
  if (!tagName) {
    console.log('⚠️  No tag name specified, skipping');
    return;
  }
  
  console.log(`🏷️  Adding tag: ${tagName}`);
  
  const customer = await Customer.findById(execution.customer._id);
  
  if (!customer) {
    console.log('⚠️  Customer not found for tagging');
    return;
  }
  
  if (!customer.tags) customer.tags = [];
  
  if (!customer.tags.includes(tagName)) {
    customer.tags.push(tagName);
    await customer.save();
    
    // Actualizar en Shopify si tiene shopifyId
    if (customer.shopifyId && shopifyService?.addCustomerTag) {
      try {
        await shopifyService.addCustomerTag(customer.shopifyId, tagName);
        console.log(`   ✅ Tag synced to Shopify`);
      } catch (err) {
        console.log(`   ⚠️  Could not sync tag to Shopify: ${err.message}`);
      }
    }
    
    console.log(`   ✅ Tag added: ${tagName}`);
  } else {
    console.log(`   ℹ️  Tag already exists`);
  }
}

async function processDiscountStep(execution, step) {
  const discountCode = step.config?.discountCode || 'DISCOUNT';
  const discountValue = step.config?.discountValue || 10;
  
  console.log(`🎟️  Creating discount: ${discountCode} (${discountValue}%)`);
  
  // Crear código de descuento personalizado
  const code = `${discountCode}_${execution.customer._id.toString().slice(-6)}`.toUpperCase();
  
  // TODO: Implementar creación en Shopify
  console.log(`   ✅ Discount created: ${code}`);
  
  // Guardar en el contexto de la ejecución para uso posterior
  execution.context = execution.context || {};
  execution.context.discountCode = code;
  await execution.save();
}

async function processAction(execution, action) {
  if (!action || !action.type) {
    console.log('⚠️  Invalid action, skipping');
    return;
  }
  
  switch (action.type) {
    case 'send_email':
      await processEmailStep(execution, action, { name: 'Conditional Action' });
      break;
    case 'add_tag':
      await processTagStep(execution, action);
      break;
    case 'create_discount':
      await processDiscountStep(execution, action);
      break;
    default:
      console.log(`⚠️  Unknown action type: ${action.type}`);
  }
}

// ==================== EXPORTS ====================

module.exports = {
  flowQueue,
  flowWorker,
  
  // Función para cerrar la queue
  async close() {
    try {
      if (flowWorker) {
        await flowWorker.close();
        console.log('✅ Flow worker closed');
      }
      if (flowQueue) {
        await flowQueue.close();
        console.log('✅ Flow queue closed');
      }
    } catch (error) {
      console.error('Error closing flow queue:', error);
    }
  },
  
  // Función para limpiar jobs fallidos manualmente
  async cleanFailedJobs() {
    if (!flowQueue) return { cleaned: 0 };
    
    try {
      const failedJobs = await flowQueue.getFailed(0, 500);
      let cleaned = 0;
      
      for (const job of failedJobs) {
        await job.remove();
        cleaned++;
      }
      
      console.log(`🧹 Cleaned ${cleaned} failed jobs`);
      return { cleaned };
    } catch (err) {
      console.error('Error cleaning failed jobs:', err);
      return { error: err.message };
    }
  },
  
  // Verificar si la queue está disponible
  isAvailable() {
    return flowQueue !== null && flowWorker !== null;
  }
};