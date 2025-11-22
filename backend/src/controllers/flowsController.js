// backend/src/controllers/flowsController.js (métrica)
async getMetrics(req, res) {
  const flowId = req.params.id;
  
  const metrics = await FlowExecution.aggregate([
    { $match: { flow: mongoose.Types.ObjectId(flowId) } },
    { 
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalRevenue: { $sum: '$attributedRevenue' }
      }
    }
  ]);
  
  const actionMetrics = await FlowExecution.aggregate([
    { $match: { flow: mongoose.Types.ObjectId(flowId) } },
    { $unwind: '$executionLog' },
    {
      $group: {
        _id: {
          actionType: '$executionLog.actionType',
          status: '$executionLog.status'
        },
        count: { $sum: 1 }
      }
    }
  ]);
  
  res.json({ 
    overall: metrics, 
    byAction: actionMetrics,
    // Agregar timeline, conversion rates, etc.
  });
}