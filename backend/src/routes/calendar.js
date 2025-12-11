// backend/src/routes/calendar.js
// 📅 Business Calendar Routes - API para objetivos y promociones
const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const BusinessCalendar = require('../models/BusinessCalendar');
const businessCalendarService = require('../services/businessCalendarService');

router.use(auth);

// ==================== DASHBOARD ====================

/**
 * GET /api/calendar/dashboard
 * Obtener resumen para dashboard
 */
router.get('/dashboard', authorize('admin', 'manager'), async (req, res) => {
  try {
    const summary = await BusinessCalendar.getDashboardSummary();
    
    res.json({
      success: true,
      ...summary
    });
    
  } catch (error) {
    console.error('Error getting calendar dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/calendar/context
 * Obtener contexto actual para AI
 */
router.get('/context', authorize('admin', 'manager'), async (req, res) => {
  try {
    const context = await businessCalendarService.getBusinessContextForClaude();
    
    res.json({
      success: true,
      context
    });
    
  } catch (error) {
    console.error('Error getting calendar context:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== REVENUE GOALS ====================

/**
 * GET /api/calendar/goals/current
 * Obtener goal de revenue actual
 */
router.get('/goals/current', authorize('admin', 'manager'), async (req, res) => {
  try {
    const progress = await businessCalendarService.getCurrentGoalProgress();
    
    res.json({
      success: true,
      ...progress
    });
    
  } catch (error) {
    console.error('Error getting current goal:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/calendar/goals/monthly
 * Crear o actualizar goal mensual
 */
router.post('/goals/monthly', authorize('admin'), async (req, res) => {
  try {
    const { targetAmount, month, year } = req.body;
    
    if (!targetAmount || targetAmount <= 0) {
      return res.status(400).json({ 
        error: 'targetAmount es requerido y debe ser mayor a 0' 
      });
    }
    
    const goal = await businessCalendarService.setMonthlyGoal(
      targetAmount,
      month !== undefined ? month : null,
      year !== undefined ? year : null
    );
    
    res.json({
      success: true,
      message: 'Objetivo mensual configurado',
      goal: {
        id: goal._id,
        name: goal.name,
        target: goal.revenueGoal.targetAmount,
        startDate: goal.startDate,
        endDate: goal.endDate
      }
    });
    
  } catch (error) {
    console.error('Error setting monthly goal:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/calendar/goals/sync
 * Sincronizar goal con órdenes reales
 */
router.post('/goals/sync', authorize('admin'), async (req, res) => {
  try {
    const goal = await businessCalendarService.syncGoalWithOrders();
    
    if (!goal) {
      return res.json({
        success: false,
        message: 'No hay objetivo activo para sincronizar'
      });
    }
    
    res.json({
      success: true,
      message: 'Objetivo sincronizado con órdenes',
      goal: {
        target: goal.revenueGoal.targetAmount,
        current: goal.revenueGoal.currentAmount,
        percentComplete: goal.revenueGoal.percentComplete
      }
    });
    
  } catch (error) {
    console.error('Error syncing goal:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== PROMOTIONS ====================

/**
 * GET /api/calendar/promotions
 * Listar todas las promociones
 */
router.get('/promotions', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    
    const query = { type: 'promotion' };
    if (status !== 'all') {
      query.status = status;
    }
    
    const promotions = await BusinessCalendar.find(query)
      .sort({ startDate: -1 })
      .populate('promotion.targetLists', 'name memberCount')
      .lean();
    
    res.json({
      success: true,
      count: promotions.length,
      promotions
    });
    
  } catch (error) {
    console.error('Error listing promotions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/calendar/promotions/active
 * Obtener promociones activas
 */
router.get('/promotions/active', authorize('admin', 'manager'), async (req, res) => {
  try {
    const promotions = await businessCalendarService.getActivePromotions();
    
    res.json({
      success: true,
      count: promotions.length,
      promotions
    });
    
  } catch (error) {
    console.error('Error getting active promotions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/calendar/promotions
 * Crear nueva promoción
 */
router.post('/promotions', authorize('admin'), async (req, res) => {
  try {
    const {
      name,
      startDate,
      endDate,
      discountCode,
      discountType,
      discountValue,
      targetLists,
      expectedRevenue,
      description
    } = req.body;
    
    // Validaciones básicas
    if (!name || !startDate || !endDate || !discountCode) {
      return res.status(400).json({
        error: 'name, startDate, endDate y discountCode son requeridos'
      });
    }
    
    const promotion = await businessCalendarService.createPromotion({
      name,
      startDate,
      endDate,
      discountCode,
      discountType: discountType || 'percentage',
      discountValue: discountValue || 0,
      targetLists: targetLists || [],
      expectedRevenue: expectedRevenue || 0
    });
    
    if (description) {
      promotion.description = description;
      await promotion.save();
    }
    
    res.json({
      success: true,
      message: 'Promoción creada',
      promotion
    });
    
  } catch (error) {
    console.error('Error creating promotion:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/calendar/promotions/:code/redeem
 * Registrar uso de código de descuento (llamado desde webhook de orden)
 */
router.post('/promotions/:code/redeem', authorize('admin'), async (req, res) => {
  try {
    const { code } = req.params;
    const { orderAmount } = req.body;
    
    const promotion = await businessCalendarService.recordPromoRedemption(
      code,
      orderAmount || 0
    );
    
    res.json({
      success: !!promotion,
      message: promotion ? 'Canje registrado' : 'Promoción no encontrada'
    });
    
  } catch (error) {
    console.error('Error recording redemption:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== EVENTS ====================

/**
 * GET /api/calendar/events
 * Listar todos los eventos
 */
router.get('/events', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 90 } = req.query;
    
    const events = await businessCalendarService.getUpcomingEvents(parseInt(days));
    
    res.json({
      success: true,
      count: events.length,
      events
    });
    
  } catch (error) {
    console.error('Error listing events:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/calendar/events
 * Crear nuevo evento
 */
router.post('/events', authorize('admin'), async (req, res) => {
  try {
    const { name, startDate, endDate, eventType, keywords, relatedProducts } = req.body;
    
    if (!name || !startDate) {
      return res.status(400).json({
        error: 'name y startDate son requeridos'
      });
    }
    
    const event = await businessCalendarService.createEvent({
      name,
      startDate,
      endDate: endDate || startDate,
      eventType: eventType || 'custom',
      keywords: keywords || [],
      relatedProducts: relatedProducts || []
    });
    
    res.json({
      success: true,
      message: 'Evento creado',
      event
    });
    
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/calendar/events/initialize
 * Inicializar eventos comunes del año
 */
router.post('/events/initialize', authorize('admin'), async (req, res) => {
  try {
    const { year } = req.body;
    
    const created = await businessCalendarService.initializeCommonEvents(
      year || new Date().getFullYear()
    );
    
    res.json({
      success: true,
      message: `${created.length} eventos inicializados`,
      events: created
    });
    
  } catch (error) {
    console.error('Error initializing events:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CRUD GENÉRICO ====================

/**
 * GET /api/calendar/:id
 * Obtener detalle de una entrada
 */
router.get('/:id', authorize('admin', 'manager'), async (req, res) => {
  try {
    const entry = await BusinessCalendar.findById(req.params.id)
      .populate('promotion.targetLists', 'name memberCount')
      .populate('productLaunch.product', 'title')
      .lean();
    
    if (!entry) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    
    res.json({
      success: true,
      entry
    });
    
  } catch (error) {
    console.error('Error getting calendar entry:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/calendar/:id
 * Actualizar entrada
 */
router.put('/:id', authorize('admin'), async (req, res) => {
  try {
    const entry = await BusinessCalendar.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!entry) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    
    res.json({
      success: true,
      message: 'Entrada actualizada',
      entry
    });
    
  } catch (error) {
    console.error('Error updating calendar entry:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/calendar/:id
 * Eliminar entrada
 */
router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const entry = await BusinessCalendar.findByIdAndDelete(req.params.id);
    
    if (!entry) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    
    res.json({
      success: true,
      message: 'Entrada eliminada'
    });
    
  } catch (error) {
    console.error('Error deleting calendar entry:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;