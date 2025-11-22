// backend/src/jobs/flowQueue.js (CORREGIDO)
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
    const { flowId, executionId, stepIndex } = job.data;
    
    console.log(`🔄 Processing flow step: ${flowId} - Step ${stepIndex}`);
    
    try {
      const execution = await FlowExecution.findById(executionId).populate('customer');
      if (!execution) throw new Error('Execution not found');
      
      const flow = await Flow.findById(flowId);
      if (!flow) throw new Error('Flow not found');
      
      const step = flow.steps[stepIndex];
      if (!step) throw new Error('Step not found');
      
      // Procesar según el tipo de step
      switch (step.type) {
        case 'send_email':
          await processEmailStep(execution, step);
          break;
        case 'wait':
          await processWaitStep(execution, step, flowId, executionId, stepIndex);
          break;
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
          console.log(`Unknown step type: ${step.type}`);
      }
      
      // Marcar step como completado
      execution.completedSteps.push(stepIndex);
      
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
      } else {
        // Flow completado
        execution.status = 'completed';
        execution.completedAt = new Date();
        await execution.save();
        
        console.log(`✅ Flow completed: ${flow.name}`);
      }
      
    } catch (error) {
      console.error(`❌ Error processing flow step:`, error);
      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: 5
  });

  flowWorker.on('completed', job => {
    console.log(`✅ Flow job completed: ${job.id}`);
  });

  flowWorker.on('failed', (job, err) => {
    console.error(`❌ Flow job failed: ${job.id}`, err);
  });

  console.log('✅ Flow Queue initialized successfully');

} catch (error) {
  console.error('⚠️  Flow Queue initialization failed:', error.message);
  console.log('   Flows will not be available in this session');
}

// Funciones de procesamiento
async function processEmailStep(execution, step) {
  console.log(`📧 Sending email: ${step.config.subject}`);
  
  const customer = execution.customer;
  await emailService.sendFlowEmail({
    to: customer.email,
    subject: step.config.subject,
    templateId: step.config.templateId,
    flowId: execution.flow,
    executionId: execution._id,
    customerId: customer._id
  });
}

async function processWaitStep(execution, step, flowId, executionId, stepIndex) {
  console.log(`⏱️  Waiting ${step.config.delayMinutes} minutes`);
  
  // Programar siguiente step después del delay
  const delay = step.config.delayMinutes * 60 * 1000;
  
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
  await execution.save();
}

async function processConditionStep(execution, step, flowId, executionId, stepIndex) {
  console.log(`🔍 Evaluating condition: ${step.config.conditionType}`);
  
  let conditionMet = false;
  
  switch (step.config.conditionType) {
    case 'has_purchased':
      const Order = require('../models/Order');
      const orderCount = await Order.countDocuments({ 
        customer: execution.customer._id 
      });
      conditionMet = orderCount > 0;
      break;
    case 'has_tag':
      conditionMet = execution.customer.tags?.includes(step.config.tagName);
      break;
    default:
      console.log(`Unknown condition type: ${step.config.conditionType}`);
  }
  
  // Ejecutar acciones según el resultado
  const actions = conditionMet ? step.config.ifTrue : step.config.ifFalse;
  
  if (actions && actions.length > 0) {
    for (const action of actions) {
      await processAction(execution, action);
    }
  }
}

async function processTagStep(execution, step) {
  console.log(`🏷️  Adding tag: ${step.config.tagName}`);
  
  const customer = await Customer.findById(execution.customer._id);
  if (!customer.tags.includes(step.config.tagName)) {
    customer.tags.push(step.config.tagName);
    await customer.save();
    
    // Actualizar en Shopify si tiene shopifyId
    if (customer.shopifyId) {
      await shopifyService.addCustomerTag(customer.shopifyId, step.config.tagName);
    }
  }
}

async function processDiscountStep(execution, step) {
  console.log(`🎟️  Creating discount: ${step.config.discountCode}`);
  
  // Crear código de descuento personalizado
  const code = `${step.config.discountCode}_${execution.customer._id}`.toUpperCase();
  
  // Aquí implementarías la creación del descuento en Shopify
  // Por ahora solo lo registramos
  console.log(`   Discount created: ${code} - ${step.config.discountValue}%`);
}

async function processAction(execution, action) {
  switch (action.type) {
    case 'send_email':
      await processEmailStep(execution, action);
      break;
    case 'add_tag':
      await processTagStep(execution, action);
      break;
    case 'create_discount':
      await processDiscountStep(execution, action);
      break;
    default:
      console.log(`Unknown action type: ${action.type}`);
  }
}

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
  }
};