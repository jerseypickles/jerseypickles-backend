// backend/src/routes/campaigns.js
const express = require('express');
const router = express.Router();
const campaignsController = require('../controllers/campaignsController');
const { auth, authorize } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// ==================== RUTAS SIN PARÁMETROS (PRIMERO) ====================

// Listar campañas
router.get('/', campaignsController.list);

// Crear campaña
router.post('/', authorize('admin', 'manager'), campaignsController.create);

// ==================== RUTAS ESPECÍFICAS (ANTES DE /:id) ====================

// 🆕 Analytics agregados - DEBE IR ANTES DE /:id
router.get('/analytics', authorize('admin', 'manager'), campaignsController.getAnalytics);

// Queue management
router.get('/queue/status', authorize('admin', 'manager'), campaignsController.getQueueStatus);
router.post('/queue/pause', authorize('admin'), campaignsController.pauseQueue);
router.post('/queue/resume', authorize('admin'), campaignsController.resumeQueue);
router.post('/queue/clean', authorize('admin'), campaignsController.cleanQueue);
router.post('/queue/check-campaigns', authorize('admin'), campaignsController.forceCheckCampaigns);

// Crear desde template
router.post('/from-template', authorize('admin', 'manager'), campaignsController.createFromTemplate);

// Limpiar campañas borrador
router.delete('/cleanup/drafts', authorize('admin'), campaignsController.cleanupDrafts);

// Health check
router.get('/health', campaignsController.healthCheck);

// ==================== 🔧 RECALCULATE STATS ====================

/**
 * POST /api/campaigns/recalculate-stats
 * Recalcula stats de campañas usando EmailEvents únicos
 * Corrige el problema de opens/clicks duplicados (200% open rate)
 */
router.post('/recalculate-stats', authorize('admin'), async (req, res) => {
  try {
    const Campaign = require('../models/Campaign');
    const EmailEvent = require('../models/EmailEvent');
    
    const { campaignId, fixAll = true } = req.body;
    
    const query = { status: 'sent' };
    if (campaignId) {
      query._id = campaignId;
    }
    
    const campaigns = await Campaign.find(query);
    const results = [];
    let fixed = 0;
    let skipped = 0;
    
    console.log(`\n🔧 Recalculando stats para ${campaigns.length} campaña(s)...\n`);
    
    for (const campaign of campaigns) {
      try {
        // Verificar si tiene EmailEvents (campañas del sistema nuevo)
        const eventCount = await EmailEvent.countDocuments({ campaign: campaign._id });
        
        if (eventCount === 0) {
          // Campaña de Klaviyo - no tiene EmailEvents, saltar
          console.log(`⏭️  ${campaign.name}: Sin EmailEvents (Klaviyo import)`);
          skipped++;
          continue;
        }
        
        // Contar eventos ÚNICOS por email
        const [uniqueDelivered, uniqueOpens, uniqueClicks, uniqueBounced, uniqueComplained] = await Promise.all([
          EmailEvent.aggregate([
            { $match: { campaign: campaign._id, eventType: 'delivered' } },
            { $group: { _id: '$email' } },
            { $count: 'total' }
          ]),
          EmailEvent.aggregate([
            { $match: { campaign: campaign._id, eventType: 'opened' } },
            { $group: { _id: '$email' } },
            { $count: 'total' }
          ]),
          EmailEvent.aggregate([
            { $match: { campaign: campaign._id, eventType: 'clicked' } },
            { $group: { _id: '$email' } },
            { $count: 'total' }
          ]),
          EmailEvent.aggregate([
            { $match: { campaign: campaign._id, eventType: 'bounced' } },
            { $group: { _id: '$email' } },
            { $count: 'total' }
          ]),
          EmailEvent.aggregate([
            { $match: { campaign: campaign._id, eventType: 'complained' } },
            { $group: { _id: '$email' } },
            { $count: 'total' }
          ])
        ]);

        const newDelivered = uniqueDelivered[0]?.total || campaign.stats.delivered;
        const newOpened = uniqueOpens[0]?.total || 0;
        const newClicked = uniqueClicks[0]?.total || 0;
        const newBounced = uniqueBounced[0]?.total || campaign.stats.bounced;
        const newComplained = uniqueComplained[0]?.total || campaign.stats.complained;

        const baseForRates = newDelivered > 0 ? newDelivered : campaign.stats.sent;
        
        const newOpenRate = baseForRates > 0 
          ? parseFloat(((newOpened / baseForRates) * 100).toFixed(2)) 
          : 0;
        const newClickRate = baseForRates > 0 
          ? parseFloat(((newClicked / baseForRates) * 100).toFixed(2)) 
          : 0;
        const newBounceRate = campaign.stats.sent > 0 
          ? parseFloat(((newBounced / campaign.stats.sent) * 100).toFixed(2)) 
          : 0;

        const before = {
          delivered: campaign.stats.delivered,
          opened: campaign.stats.opened,
          clicked: campaign.stats.clicked,
          openRate: campaign.stats.openRate,
          clickRate: campaign.stats.clickRate
        };

        const needsFix = campaign.stats.openRate > 100 || 
                        campaign.stats.clickRate > 100 ||
                        campaign.stats.opened > campaign.stats.delivered * 2;

        if (!needsFix && !fixAll) {
          console.log(`✓ ${campaign.name}: Stats OK`);
          skipped++;
          continue;
        }

        await Campaign.findByIdAndUpdate(campaign._id, {
          $set: {
            'stats.delivered': newDelivered,
            'stats.opened': newOpened,
            'stats.clicked': newClicked,
            'stats.bounced': newBounced,
            'stats.complained': newComplained,
            'stats.openRate': newOpenRate,
            'stats.clickRate': newClickRate,
            'stats.bounceRate': newBounceRate
          }
        });

        results.push({
          campaignId: campaign._id,
          name: campaign.name,
          before,
          after: {
            delivered: newDelivered,
            opened: newOpened,
            clicked: newClicked,
            openRate: newOpenRate,
            clickRate: newClickRate
          },
          eventCount
        });

        console.log(`✅ ${campaign.name}: ${before.openRate}% → ${newOpenRate}%`);
        fixed++;
        
      } catch (err) {
        console.error(`❌ Error en ${campaign.name}:`, err.message);
        results.push({
          campaignId: campaign._id,
          name: campaign.name,
          error: err.message
        });
      }
    }

    res.json({
      success: true,
      message: `Procesadas ${campaigns.length} campañas: ${fixed} corregidas, ${skipped} omitidas`,
      summary: { total: campaigns.length, fixed, skipped, errors: results.filter(r => r.error).length },
      results
    });

  } catch (error) {
    console.error('❌ Error recalculando stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/campaigns/:id/debug-stats
 * Debug: Ver stats actuales vs eventos reales
 */
router.get('/:id/debug-stats', authorize('admin'), async (req, res) => {
  try {
    const Campaign = require('../models/Campaign');
    const EmailEvent = require('../models/EmailEvent');
    
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    const eventCounts = await EmailEvent.aggregate([
      { $match: { campaign: campaign._id } },
      { $group: { _id: '$eventType', total: { $sum: 1 } } }
    ]);
    
    const uniqueCounts = await Promise.all([
      EmailEvent.aggregate([
        { $match: { campaign: campaign._id, eventType: 'delivered' } },
        { $group: { _id: '$email' } },
        { $count: 'total' }
      ]),
      EmailEvent.aggregate([
        { $match: { campaign: campaign._id, eventType: 'opened' } },
        { $group: { _id: '$email' } },
        { $count: 'total' }
      ]),
      EmailEvent.aggregate([
        { $match: { campaign: campaign._id, eventType: 'clicked' } },
        { $group: { _id: '$email' } },
        { $count: 'total' }
      ])
    ]);
    
    res.json({
      campaign: { _id: campaign._id, name: campaign.name, status: campaign.status },
      currentStats: campaign.stats,
      eventCounts: eventCounts.reduce((acc, e) => { acc[e._id] = e.total; return acc; }, {}),
      uniqueCounts: {
        delivered: uniqueCounts[0][0]?.total || 0,
        opened: uniqueCounts[1][0]?.total || 0,
        clicked: uniqueCounts[2][0]?.total || 0
      },
      diagnosis: {
        openRateValid: campaign.stats.openRate <= 100,
        clickRateValid: campaign.stats.clickRate <= 100,
        hasEmailEvents: eventCounts.length > 0
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== RUTAS CON PARÁMETROS /:id (AL FINAL) ====================

// Obtener una campaña
router.get('/:id', campaignsController.getOne);

// Estadísticas de una campaña
router.get('/:id/stats', campaignsController.getStats);

// Obtener eventos de una campaña
router.get('/:id/events', campaignsController.getEvents);

// Actualizar campaña
router.put('/:id', authorize('admin', 'manager'), campaignsController.update);

// Duplicar campaña
router.post('/:id/duplicate', authorize('admin', 'manager'), campaignsController.duplicate);

// Enviar campaña
router.post('/:id/send', authorize('admin', 'manager'), campaignsController.send);

// Eliminar campaña
router.delete('/:id', authorize('admin'), campaignsController.delete);

module.exports = router;