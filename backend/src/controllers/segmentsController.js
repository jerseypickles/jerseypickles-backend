// backend/src/controllers/segmentsController.js - ACTUALIZADO
const Segment = require('../models/Segment');
const Customer = require('../models/Customer');
const segmentationService = require('../services/segmentationService');

/**
 * Listar todos los segmentos
 */
exports.list = async (req, res) => {
  try {
    const { category, type, active } = req.query;
    
    const filter = {};
    if (category) filter.category = category;
    if (type) filter.type = type;
    if (active !== undefined) filter.isActive = active === 'true';
    
    const segments = await Segment.find(filter)
      .sort({ category: 1, name: 1 });
    
    res.json({
      success: true,
      segments,
      count: segments.length
    });
  } catch (error) {
    console.error('Error listing segments:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al listar segmentos',
      error: error.message 
    });
  }
};

/**
 * Obtener un segmento por ID
 */
exports.getOne = async (req, res) => {
  try {
    const segment = await Segment.findById(req.params.id);
    
    if (!segment) {
      return res.status(404).json({ 
        success: false, 
        message: 'Segmento no encontrado' 
      });
    }
    
    res.json({ success: true, segment });
  } catch (error) {
    console.error('Error getting segment:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener segmento',
      error: error.message 
    });
  }
};

/**
 * Crear un nuevo segmento
 */
exports.create = async (req, res) => {
  try {
    const { name, description, conditions, category } = req.body;
    
    if (!name || !conditions || conditions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Nombre y condiciones son requeridos' 
      });
    }
    
    const segment = new Segment({
      name,
      description,
      conditions,
      category: category || 'custom',
      type: 'custom',
      isPredefined: false
    });
    
    await segment.save();
    
    // Calcular count inicial
    await segment.recalculate();
    
    res.status(201).json({ success: true, segment });
  } catch (error) {
    console.error('Error creating segment:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al crear segmento',
      error: error.message 
    });
  }
};

/**
 * Actualizar un segmento
 */
exports.update = async (req, res) => {
  try {
    const { name, description, conditions, category, isActive } = req.body;
    
    const segment = await Segment.findById(req.params.id);
    
    if (!segment) {
      return res.status(404).json({ 
        success: false, 
        message: 'Segmento no encontrado' 
      });
    }
    
    // No permitir editar segmentos predefinidos (solo activar/desactivar)
    if (segment.isPredefined && (name || description || conditions)) {
      // Solo actualizar isActive para predefinidos
      if (isActive !== undefined) {
        segment.isActive = isActive;
        await segment.save();
      }
      return res.json({ 
        success: true, 
        segment,
        message: 'Los segmentos predefinidos solo pueden activarse/desactivarse'
      });
    }
    
    if (name) segment.name = name;
    if (description !== undefined) segment.description = description;
    if (conditions) segment.conditions = conditions;
    if (category) segment.category = category;
    if (isActive !== undefined) segment.isActive = isActive;
    
    await segment.save();
    
    // Recalcular si cambiaron las condiciones
    if (conditions) {
      await segment.recalculate();
    }
    
    res.json({ success: true, segment });
  } catch (error) {
    console.error('Error updating segment:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al actualizar segmento',
      error: error.message 
    });
  }
};

/**
 * Eliminar un segmento
 */
exports.delete = async (req, res) => {
  try {
    const segment = await Segment.findById(req.params.id);
    
    if (!segment) {
      return res.status(404).json({ 
        success: false, 
        message: 'Segmento no encontrado' 
      });
    }
    
    // No permitir eliminar segmentos predefinidos
    if (segment.isPredefined) {
      return res.status(400).json({ 
        success: false, 
        message: 'No se pueden eliminar segmentos predefinidos. Puedes desactivarlos.' 
      });
    }
    
    await segment.deleteOne();
    
    res.json({ 
      success: true, 
      message: 'Segmento eliminado correctamente' 
    });
  } catch (error) {
    console.error('Error deleting segment:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar segmento',
      error: error.message 
    });
  }
};

/**
 * Preview de un segmento (antes de guardar)
 */
exports.preview = async (req, res) => {
  try {
    const { conditions, onlyMarketing } = req.body;
    
    if (!conditions || conditions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Las condiciones son requeridas' 
      });
    }
    
    const result = await segmentationService.previewSegment(conditions, {
      limit: 10,
      onlyMarketing: onlyMarketing || false
    });
    
    res.json({
      success: true,
      count: result.count,
      preview: result.customers
    });
  } catch (error) {
    console.error('Error previewing segment:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error en preview',
      error: error.message 
    });
  }
};

/**
 * Obtener clientes de un segmento
 */
exports.getCustomers = async (req, res) => {
  try {
    const segment = await Segment.findById(req.params.id);
    
    if (!segment) {
      return res.status(404).json({ 
        success: false, 
        message: 'Segmento no encontrado' 
      });
    }
    
    const { page = 1, limit = 50, onlyMarketing } = req.query;
    
    const result = await segmentationService.getSegmentCustomers(segment, {
      page: parseInt(page),
      limit: parseInt(limit),
      onlyMarketing: onlyMarketing === 'true'
    });
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error getting segment customers:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener clientes',
      error: error.message 
    });
  }
};

/**
 * Recalcular conteo de un segmento
 */
exports.recalculate = async (req, res) => {
  try {
    const segment = await Segment.findById(req.params.id);
    
    if (!segment) {
      return res.status(404).json({ 
        success: false, 
        message: 'Segmento no encontrado' 
      });
    }
    
    const count = await segment.recalculate();
    
    res.json({
      success: true,
      segment,
      customerCount: count
    });
  } catch (error) {
    console.error('Error recalculating segment:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al recalcular',
      error: error.message 
    });
  }
};

/**
 * Obtener segmentos predefinidos por categoría
 */
exports.getPredefined = async (req, res) => {
  try {
    const { type } = req.params;
    
    let segments;
    if (type === 'all') {
      segments = segmentationService.getAllPredefinedSegments();
    } else {
      segments = segmentationService.getPredefinedByCategory(type);
    }
    
    res.json({
      success: true,
      segments,
      categories: ['purchase', 'engagement', 'popup', 'lifecycle', 'cleanup']
    });
  } catch (error) {
    console.error('Error getting predefined segments:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener segmentos predefinidos',
      error: error.message 
    });
  }
};

/**
 * Crear todos los segmentos predefinidos en la BD
 */
exports.createPredefinedSegments = async (req, res) => {
  try {
    const results = await segmentationService.createAllPredefinedSegments();
    
    const created = results.filter(r => r.action === 'created').length;
    const updated = results.filter(r => r.action === 'updated').length;
    const errors = results.filter(r => r.action === 'error').length;
    
    res.json({
      success: true,
      message: `Segmentos predefinidos: ${created} creados, ${updated} actualizados, ${errors} errores`,
      results,
      summary: { created, updated, errors }
    });
  } catch (error) {
    console.error('Error creating predefined segments:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al crear segmentos predefinidos',
      error: error.message 
    });
  }
};

/**
 * Recalcular TODOS los segmentos
 */
exports.recalculateAll = async (req, res) => {
  try {
    const segments = await Segment.find({ isActive: true });
    const results = [];
    
    for (const segment of segments) {
      try {
        const count = await segment.recalculate();
        results.push({ 
          id: segment._id, 
          name: segment.name, 
          count,
          success: true 
        });
      } catch (error) {
        results.push({ 
          id: segment._id, 
          name: segment.name, 
          error: error.message,
          success: false 
        });
      }
    }
    
    res.json({
      success: true,
      message: `${results.filter(r => r.success).length} de ${segments.length} segmentos recalculados`,
      results
    });
  } catch (error) {
    console.error('Error recalculating all segments:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al recalcular segmentos',
      error: error.message 
    });
  }
};

/**
 * Diagnóstico de datos para segmentación
 */
exports.diagnose = async (req, res) => {
  try {
    const results = {};
    
    // Total customers
    results.totalCustomers = await Customer.countDocuments();
    results.acceptsMarketing = await Customer.countDocuments({ acceptsMarketing: true });
    
    // Compradores
    results.withOrders = await Customer.countDocuments({ ordersCount: { $gt: 0 } });
    results.withoutOrders = await Customer.countDocuments({ ordersCount: 0 });
    results.repeatBuyers = await Customer.countDocuments({ ordersCount: { $gte: 2 } });
    results.vipBuyers = await Customer.countDocuments({ totalSpent: { $gte: 200 } });
    
    // Popup
    results.fromPopup = await Customer.countDocuments({ 
      popupDiscountCode: { $exists: true, $ne: null, $ne: '' } 
    });
    results.popupNoOrder = await Customer.countDocuments({ 
      popupDiscountCode: { $exists: true, $ne: null, $ne: '' },
      ordersCount: 0
    });
    
    // Email engagement
    results.opened = await Customer.countDocuments({ 'emailStats.opened': { $gt: 0 } });
    results.openedNoOrder = await Customer.countDocuments({ 
      'emailStats.opened': { $gt: 0 },
      ordersCount: 0
    });
    results.clicked = await Customer.countDocuments({ 'emailStats.clicked': { $gt: 0 } });
    results.clickedNoOrder = await Customer.countDocuments({ 
      'emailStats.clicked': { $gt: 0 },
      ordersCount: 0
    });
    
    // Bounces
    results.bounced = await Customer.countDocuments({ 'bounceInfo.isBounced': true });
    results.hardBounce = await Customer.countDocuments({ 'bounceInfo.bounceType': 'hard' });
    
    // Por source
    results.bySource = await Customer.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({
      success: true,
      diagnosis: results,
      suggestedSegments: [
        { name: 'Compradores', count: results.withOrders },
        { name: 'No han comprado', count: results.withoutOrders },
        { name: 'Popup sin convertir', count: results.popupNoOrder },
        { name: 'Engaged sin compra', count: results.openedNoOrder },
        { name: 'Clickers sin compra', count: results.clickedNoOrder },
        { name: 'VIP ($200+)', count: results.vipBuyers },
        { name: 'Bounced', count: results.bounced }
      ]
    });
  } catch (error) {
    console.error('Error in diagnose:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error en diagnóstico',
      error: error.message 
    });
  }
};