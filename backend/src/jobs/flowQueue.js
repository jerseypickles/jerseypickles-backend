// backend/src/jobs/flowQueue.js
const Bull = require('bull');
const flowService = require('../services/flowService');

const flowQueue = new Bull('flow-processing', process.env.REDIS_URL);

// Procesar flows después de delays
flowQueue.process('resume-flow', async (job) => {
  const { executionId } = job.data;
  
  console.log(`🔄 Resuming flow execution: ${executionId}`);
  
  const FlowExecution = require('../models/FlowExecution');
  const execution = await FlowExecution.findById(executionId);
  
  if (!execution) {
    throw new Error(`Execution ${executionId} not found`);
  }
  
  if (execution.status === 'waiting') {
    execution.status = 'active';
    await execution.save();
    
    await flowService.executeNextStep(executionId);
  }
  
  return { success: true };
});

// Job periódico para cart abandonment (cada 10 minutos)
flowQueue.add('check-abandoned-carts', {}, {
  repeat: { cron: '*/10 * * * *' }
});

flowQueue.process('check-abandoned-carts', async () => {
  console.log('🛒 Checking for abandoned carts...');
  
  const Customer = require('../models/Customer');
  const sixtyMinutesAgo = new Date();
  sixtyMinutesAgo.setMinutes(sixtyMinutesAgo.getMinutes() - 60);
  
  // Buscar clientes con carritos abandonados
  const customersWithAbandonedCarts = await Customer.find({
    lastCartActivity: { 
      $gte: sixtyMinutesAgo,
      $lt: new Date(Date.now() - 60 * 60 * 1000)
    },
    'cartItems.0': { $exists: true }
  });
  
  for (const customer of customersWithAbandonedCarts) {
    await flowService.processTrigger('cart_abandoned', {
      customerId: customer._id,
      cartItems: customer.cartItems,
      cartValue: customer.cartValue
    });
  }
});

module.exports = {
  flowQueue,
  addFlowJob: (data, options = {}) => {
    return flowQueue.add('resume-flow', data, options);
  }
};