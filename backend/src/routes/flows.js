// backend/src/routes/flows.js
const express = require('express');
const router = express.Router();
const Flow = require('../models/Flow');
const FlowExecution = require('../models/FlowExecution');

// Listar flows
router.get('/', async (req, res) => {
  const flows = await Flow.find().sort({ createdAt: -1 });
  res.json(flows);
});

// Crear flow
router.post('/', async (req, res) => {
  const flow = await Flow.create(req.body);
  res.json(flow);
});

// Activar/desactivar
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  const flow = await Flow.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true }
  );
  res.json(flow);
});

// Ver ejecuciones
router.get('/:id/executions', async (req, res) => {
  const executions = await FlowExecution.find({ 
    flow: req.params.id 
  })
  .populate('customer', 'email firstName lastName')
  .sort({ createdAt: -1 })
  .limit(100);
  
  res.json(executions);
});

// Métricas
router.get('/:id/metrics', async (req, res) => {
  const flow = await Flow.findById(req.params.id);
  
  // Calcular revenue attribution
  const executions = await FlowExecution.find({ 
    flow: req.params.id,
    'attributedOrders.0': { $exists: true }
  });
  
  const totalRevenue = executions.reduce((sum, exec) => {
    return sum + exec.attributedOrders.reduce((s, o) => s + o.amount, 0);
  }, 0);
  
  res.json({
    ...flow.metrics.toObject(),
    totalRevenue,
    conversionRate: flow.metrics.completed > 0 
      ? ((totalRevenue > 0 ? executions.length : 0) / flow.metrics.completed * 100).toFixed(2)
      : 0
  });
});

module.exports = router;