// backend/src/controllers/campaignsController.js - OPTIMIZADO v2.1
// ═══════════════════════════════════════════════════════════════════════════
// CAMBIOS IMPLEMENTADOS:
// 1. ✅ Bulk claim preparation (no más claims individuales en worker)
// 2. ✅ TTL lock + re-claim seguro (5 min timeout)
// 3. ✅ Estados: preparing → sending → sent
// 4. ✅ Fix upsert peligroso (usa $setOnInsert)
// 8. ✅ Concurrency fija (sin cambios en caliente)
// 9. ✅ Debounce de checkAndFinalizeCampaign
// 11. ✅ Timers por etapa para debugging
// 12. ✅ FIX: Ajustar totalRecipients después de deduplicación
// ═══════════════════════════════════════════════════════════════════════════

const Campaign = require('../models/Campaign');
const Segment = require('../models/Segment');
const List = require('../models/List');
const Customer = require('../models/Customer');
const EmailSend = require('../models/EmailSend');
const EmailEvent = require('../models/EmailEvent');
const emailService = require('../services/emailService');
const templateService = require('../services/templateService');
const segmentationService = require('../services/segmentationService');

// ==================== HELPER FUNCTIONS ====================

// Tracker global de índices de batch por campaña
const batchIndexTracker = new Map();

function getNextBatchIndex(campaignId) {
  const current = batchIndexTracker.get(campaignId) || 0;
  batchIndexTracker.set(campaignId, current + 1);
  return current;
}

function resetBatchTracker(campaignId) {
  batchIndexTracker.set(campaignId, 0);
}

/**
 * Timer helper para medir etapas
 */
class StageTimer {
  constructor(name) {
    this.name = name;
    this.stages = {};
    this.current = null;
    this.startTime = Date.now();
  }
  
  start(stage) {
    if (this.current) {
      this.end(this.current);
    }
    this.current = stage;
    this.stages[stage] = { start: Date.now(), end: null, duration: null };
  }
  
  end(stage) {
    if (this.stages[stage]) {
      this.stages[stage].end = Date.now();
      this.stages[stage].duration = this.stages[stage].end - this.stages[stage].start;
    }
    if (this.current === stage) {
      this.current = null;
    }
  }
  
  log() {
    const total = Date.now() - this.startTime;
    console.log(`\n   ⏱️  ════════ TIMERS: ${this.name} ════════`);
    Object.entries(this.stages).forEach(([stage, data]) => {
      if (data.duration !== null) {
        const pct = ((data.duration / total) * 100).toFixed(1);
        console.log(`      ${stage}: ${data.duration}ms (${pct}%)`);
      }
    });
    console.log(`      TOTAL: ${total}ms`);
    console.log(`   ═══════════════════════════════════════════\n`);
  }
}

/**
 * Intenta agregar UN batch a BullMQ con retry automático
 */
async function addBatchWithRetry(batch, campaignId, batchIndex, retries = 3) {
  const { emailQueue, generateBatchJobId } = require('../jobs/emailQueue');
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // El worker espera { campaignId, recipients, chunkIndex }
      await emailQueue.add('process-batch', {
        campaignId,
        chunkIndex: batchIndex,
        recipients: batch
      }, {
        jobId: generateBatchJobId(campaignId, batchIndex),
        priority: 1,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        }
      });
      
      return { success: true, count: batch.length };
      
    } catch (error) {
      if (attempt === retries) {
        console.error(`      ❌ Failed after ${retries} attempts: ${error.message}`);
        return { success: false, count: 0, error: error.message };
      }
      
      const backoff = Math.pow(2, attempt) * 1000;
      console.log(`      ⚠️  Attempt ${attempt}/${retries} failed, retry in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
}

/**
 * Encola jobs en batches con retry
 */
async function enqueueBulkWithRetry(jobs, campaignId, batchSize = 100) {
  const results = {
    total: jobs.length,
    enqueued: 0,
    failed: 0,
    batches: 0,
    errors: []
  };
  
  const totalBatches = Math.ceil(jobs.length / batchSize);
  
  console.log(`\n   🔄 ════════ ENCOLANDO CON RETRY ════════`);
  console.log(`      Total emails: ${jobs.length.toLocaleString()}`);
  console.log(`      Batch size: ${batchSize}`);
  console.log(`      Total batches: ${totalBatches}`);
  console.log(`   ═══════════════════════════════════════\n`);
  
  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    const batchIndex = getNextBatchIndex(campaignId);
    const batchNum = Math.floor(i / batchSize) + 1;
    
    if (batchNum === 1 || batchNum % 10 === 0 || batchNum === totalBatches) {
      console.log(`   📦 Batch ${batchNum}/${totalBatches} (${batch.length} emails, idx=${batchIndex})...`);
    }
    
    const result = await addBatchWithRetry(batch, campaignId, batchIndex, 3);
    
    if (result.success) {
      results.enqueued += result.count;
      results.batches++;
    } else {
      results.failed += batch.length;
      results.errors.push({
        batch: batchNum,
        count: batch.length,
        error: result.error
      });
      console.log(`      ❌ Batch ${batchNum} falló: ${result.error}`);
    }
    
    // Delay entre batches para no saturar Redis
    if (i + batchSize < jobs.length) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  
  console.log(`\n   ✅ ════════ ENCOLADO COMPLETO ═════════`);
  console.log(`      Total: ${results.total.toLocaleString()}`);
  console.log(`      ✅ Exitosos: ${results.enqueued.toLocaleString()}`);
  console.log(`      ❌ Fallidos: ${results.failed.toLocaleString()}`);
  console.log(`      📦 Batches OK: ${results.batches}/${totalBatches}`);
  
  if (results.errors.length > 0) {
    console.log(`      ⚠️  Batches fallidos: ${results.errors.map(e => e.batch).join(', ')}`);
  }
  console.log(`   ═══════════════════════════════════════\n`);
  
  return results;
}

// ==================== ADAPTIVE CONFIGURATION ====================

/**
 * Configuración dinámica según tamaño de campaña
 * NOTA: concurrency es FIJA, solo ajustamos delays
 */
function getOptimalConfig(totalEmails) {
  // Con 10 req/s y batch de 100 emails:
  // Throughput máximo teórico: 1000 emails/s
  // Throughput realista: 500-800 emails/s
  
  if (totalEmails < 5000) {
    return {
      name: 'FAST',
      cursorBatch: 1000,
      bulkWriteBatch: 1000,
      enqueueChunk: 5000,
      delayBetweenBatches: 50,
      description: 'Campañas pequeñas: máxima velocidad'
    };
  } else if (totalEmails < 50000) {
    return {
      name: 'BALANCED',
      cursorBatch: 500,
      bulkWriteBatch: 500,
      enqueueChunk: 3000,
      delayBetweenBatches: 75,
      description: 'Campañas medianas: balance velocidad/estabilidad'
    };
  } else if (totalEmails < 200000) {
    return {
      name: 'STABLE',
      cursorBatch: 300,
      bulkWriteBatch: 300,
      enqueueChunk: 2000,
      delayBetweenBatches: 100,
      description: 'Campañas grandes: prioridad estabilidad'
    };
  } else {
    return {
      name: 'ULTRA_STABLE',
      cursorBatch: 200,
      bulkWriteBatch: 200,
      enqueueChunk: 1000,
      delayBetweenBatches: 150,
      description: 'Campañas masivas: máxima estabilidad'
    };
  }
}

class CampaignsController {
  
  // ==================== CONSTRUCTOR ====================
  constructor() {
    this.list = this.list.bind(this);
    this.getOne = this.getOne.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
    this.duplicate = this.duplicate.bind(this);
    this.send = this.send.bind(this);
    this.sendTestEmail = this.sendTestEmail.bind(this);
    this.getStats = this.getStats.bind(this);
    this.getEvents = this.getEvents.bind(this);
    this.getAnalytics = this.getAnalytics.bind(this);
    this.createFromTemplate = this.createFromTemplate.bind(this);
    this.cleanupDrafts = this.cleanupDrafts.bind(this);
    this.healthCheck = this.healthCheck.bind(this);
    this.getQueueStatus = this.getQueueStatus.bind(this);
    this.pauseQueue = this.pauseQueue.bind(this);
    this.resumeQueue = this.resumeQueue.bind(this);
    this.cleanQueue = this.cleanQueue.bind(this);
    this.forceCheckCampaigns = this.forceCheckCampaigns.bind(this);
  }
  
  // ==================== CRUD BÁSICO ====================
  
  async list(req, res) {
    try {
      const { 
        page = 1, 
        limit = 20,
        status = null 
      } = req.query;
      
      const query = {};
      if (status) {
        query.status = status;
      }
      
      const campaigns = await Campaign.find(query)
        .populate('segment', 'name customerCount')
        .populate('list', 'name memberCount')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);
      
      const total = await Campaign.countDocuments(query);
      
      res.json({
        campaigns,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      });
      
    } catch (error) {
      console.error('Error listando campañas:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async getOne(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment')
        .populate('list');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      res.json(campaign);
      
    } catch (error) {
      console.error('Error obteniendo campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async create(req, res) {
    try {
      const {
        name,
        subject,
        htmlContent,
        previewText,
        targetType = 'segment',
        segmentId,
        listId,
        fromName,
        fromEmail,
        replyTo,
        scheduledAt,
        tags,
        templateBlocks
      } = req.body;
      
      let totalRecipients = 0;
      
      if (targetType === 'segment') {
        if (!segmentId) {
          return res.status(400).json({ error: 'Debes seleccionar un segmento' });
        }
        const segment = await Segment.findById(segmentId);
        if (!segment) {
          return res.status(404).json({ error: 'Segmento no encontrado' });
        }
        totalRecipients = segment.customerCount;
      } else if (targetType === 'list') {
        if (!listId) {
          return res.status(400).json({ error: 'Debes seleccionar una lista' });
        }
        const list = await List.findById(listId);
        if (!list) {
          return res.status(404).json({ error: 'Lista no encontrada' });
        }
        totalRecipients = list.memberCount;
      }
      
      const campaign = await Campaign.create({
        name,
        subject,
        htmlContent,
        previewText,
        targetType,
        segment: targetType === 'segment' ? segmentId : null,
        list: targetType === 'list' ? listId : null,
        fromName: fromName || 'Jersey Pickles',
        fromEmail: fromEmail || 'info@jerseypickles.com',
        replyTo,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        tags,
        templateBlocks: templateBlocks || [],
        'stats.totalRecipients': totalRecipients
      });
      
      console.log(`✅ Campaña creada: ${name} (${targetType})`);
      
      res.status(201).json(campaign);
      
    } catch (error) {
      console.error('Error creando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async update(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      if (campaign.status !== 'draft') {
        return res.status(400).json({ 
          error: 'Solo se pueden editar campañas en borrador' 
        });
      }
      
      const {
        name,
        subject,
        htmlContent,
        previewText,
        targetType,
        segmentId,
        listId,
        fromName,
        fromEmail,
        replyTo,
        scheduledAt,
        tags,
        templateBlocks
      } = req.body;
      
      if (name) campaign.name = name;
      if (subject) campaign.subject = subject;
      if (htmlContent) campaign.htmlContent = htmlContent;
      if (previewText !== undefined) campaign.previewText = previewText;
      if (fromName) campaign.fromName = fromName;
      if (fromEmail) campaign.fromEmail = fromEmail;
      if (replyTo !== undefined) campaign.replyTo = replyTo;
      if (scheduledAt !== undefined) campaign.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
      if (tags) campaign.tags = tags;
      if (templateBlocks) campaign.templateBlocks = templateBlocks;
      
      if (targetType) {
        campaign.targetType = targetType;
        
        if (targetType === 'segment') {
          if (segmentId && segmentId !== campaign.segment?.toString()) {
            const segment = await Segment.findById(segmentId);
            if (!segment) {
              return res.status(404).json({ error: 'Segmento no encontrado' });
            }
            campaign.segment = segmentId;
            campaign.list = null;
            campaign.stats.totalRecipients = segment.customerCount;
          }
        } else if (targetType === 'list') {
          if (listId && listId !== campaign.list?.toString()) {
            const list = await List.findById(listId);
            if (!list) {
              return res.status(404).json({ error: 'Lista no encontrada' });
            }
            campaign.list = listId;
            campaign.segment = null;
            campaign.stats.totalRecipients = list.memberCount;
          }
        }
      }
      
      await campaign.save();
      
      console.log(`✅ Campaña actualizada: ${campaign.name}`);
      
      res.json(campaign);
      
    } catch (error) {
      console.error('Error actualizando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async delete(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      if (campaign.status === 'sent') {
        return res.status(400).json({ 
          error: 'No se pueden eliminar campañas que ya fueron enviadas' 
        });
      }
      
      await Campaign.findByIdAndDelete(req.params.id);
      
      console.log(`🗑️  Campaña eliminada: ${campaign.name}`);
      
      res.json({ 
        success: true, 
        message: 'Campaña eliminada correctamente' 
      });
      
    } catch (error) {
      console.error('Error eliminando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async duplicate(req, res) {
    try {
      const original = await Campaign.findById(req.params.id);
      
      if (!original) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      const duplicate = await Campaign.create({
        name: `${original.name} (Copia)`,
        subject: original.subject,
        htmlContent: original.htmlContent,
        previewText: original.previewText,
        targetType: original.targetType,
        segment: original.segment,
        list: original.list,
        fromName: original.fromName,
        fromEmail: original.fromEmail,
        replyTo: original.replyTo,
        tags: original.tags,
        templateBlocks: original.templateBlocks || [],
        status: 'draft'
      });
      
      console.log(`📋 Campaña duplicada: ${duplicate.name}`);
      
      res.status(201).json(duplicate);
      
    } catch (error) {
      console.error('Error duplicando campaña:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== ENVÍO DE CAMPAÑA - OPTIMIZADO v2.1 ====================
  
  async send(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment')
        .populate('list');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
        return res.status(400).json({ 
          error: `No se puede enviar campaña con estado: ${campaign.status}` 
        });
      }
      
      console.log('\n╔════════════════════════════════════════════════╗');
      console.log(`║  📧 ENVIANDO: ${campaign.name.substring(0, 35).padEnd(35)} ║`);
      console.log('╚════════════════════════════════════════════════╝\n');
      
      const { testMode = false, testEmail = null } = req.body;
      
      // ==================== MODO TEST ====================
      if (testMode && testEmail) {
        return await this.sendTestEmail(campaign, testEmail, res);
      }
      
      // ==================== MODO PRODUCCIÓN ====================
      const { isAvailable, generateJobId } = require('../jobs/emailQueue');
      
      if (!isAvailable()) {
        return res.status(400).json({
          error: 'Redis no disponible',
          message: 'Configura REDIS_URL (Upstash) para envíos masivos'
        });
      }
      
      const timer = new StageTimer(campaign.name);
      timer.start('count_recipients');
      
      // ========== PASO 1: Contar destinatarios ==========
      let totalRecipients = 0;
      
      if (campaign.targetType === 'list') {
        const list = await List.findById(campaign.list._id).select('members');
        totalRecipients = list?.members?.length || 0;
      } else {
        totalRecipients = await segmentationService.countSegment(campaign.segment.conditions);
      }
      
      timer.end('count_recipients');
      
      if (totalRecipients === 0) {
        return res.status(400).json({ 
          error: campaign.targetType === 'list' 
            ? 'La lista no tiene miembros' 
            : 'El segmento no tiene clientes' 
        });
      }
      
      console.log(`👥 Total destinatarios (estimado): ${totalRecipients.toLocaleString()}`);
      
      // Configuración adaptativa
      const config = getOptimalConfig(totalRecipients);
      console.log(`⚙️  Modo seleccionado: ${config.name}`);
      console.log(`   ${config.description}`);
      console.log(`   Batch sizes: cursor=${config.cursorBatch}, bulk=${config.bulkWriteBatch}`);
      
      // ========== PASO 2: Cambiar estado a "preparing" ==========
      campaign.status = 'preparing';
      campaign.stats.totalRecipients = totalRecipients;
      campaign.stats.sent = 0;
      campaign.stats.delivered = 0;
      campaign.stats.failed = 0;
      campaign.stats.skipped = 0;
      await campaign.save();
      
      // ========== PASO 3: Responder inmediatamente ==========
      const estimatedSeconds = Math.ceil(totalRecipients / 600);
      const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
      
      res.json({
        success: true,
        campaign: {
          _id: campaign._id,
          name: campaign.name,
          status: 'preparing',
          stats: campaign.stats
        },
        queue: {
          totalEmails: totalRecipients,
          processing: true,
          mode: config.name,
          estimatedTime: estimatedMinutes > 1 
            ? `${estimatedMinutes} minutos` 
            : `${estimatedSeconds} segundos`,
          message: `Preparando ${totalRecipients.toLocaleString()} emails en modo ${config.name}...`,
          checkStatusAt: `/api/campaigns/${campaign._id}/stats`
        }
      });
      
      // ========== PASO 4: Procesar en background ==========
      const campaignId = campaign._id.toString();
      const htmlTemplate = campaign.htmlContent;
      const subject = campaign.subject;
      const fromName = campaign.fromName;
      const fromEmail = campaign.fromEmail;
      const replyTo = campaign.replyTo;
      const targetType = campaign.targetType;
      const listId = campaign.list?._id;
      const segmentConditions = campaign.segment?.conditions;
      
      setImmediate(async () => {
        console.log('╔════════════════════════════════════════════════╗');
        console.log('║  📥 BACKGROUND - PREPARACIÓN OPTIMIZADA v2.1   ║');
        console.log('╚════════════════════════════════════════════════╝');
        console.log(`   Modo: ${config.name}`);
        console.log(`   Cambios: Bulk claim, Estados, Debounce, Timers, Fix duplicados`);
        console.log('════════════════════════════════════════════════\n');
        
        // Resetear tracker de batches
        resetBatchTracker(campaignId);
        
        // Configuración
        const CURSOR_BATCH_SIZE = config.cursorBatch;
        const BULK_WRITE_BATCH = config.bulkWriteBatch;
        const ENQUEUE_CHUNK_SIZE = config.enqueueChunk;
        
        let processedCount = 0;
        let createdEmailSends = 0;
        let skippedDuplicates = 0;
        let bulkWriteCount = 0;
        
        // Arrays temporales
        let tempRecipients = [];
        let bulkOperations = [];
        const seenEmails = new Set();
        
        try {
          timer.start('create_cursor');
          
          // ========== CREAR CURSOR SEGÚN TIPO ==========
          let cursor;
          
          if (targetType === 'list') {
            const list = await List.findById(listId).select('members');
            const memberIds = list?.members || [];
            
            cursor = Customer
              .find({ _id: { $in: memberIds } })
              .select('email firstName lastName _id')
              .lean()
              .cursor({ batchSize: CURSOR_BATCH_SIZE });
              
          } else {
            cursor = await segmentationService.getCursorForSegment(
              segmentConditions,
              { select: 'email firstName lastName _id' }
            );
          }
          
          timer.end('create_cursor');
          timer.start('process_customers');
          
          console.log('🔄 Procesando clientes...\n');
          
          // ========== ITERAR CON CURSOR + BATCH WRITES ==========
          for await (const customer of cursor) {
            processedCount++;
            
            // Normalización
            const normalizedEmail = customer.email.toLowerCase().trim();
            
            // Deduplicación en memoria
            const emailKey = `${campaignId}:${normalizedEmail}`;
            if (seenEmails.has(emailKey)) {
              skippedDuplicates++;
              continue;
            }
            seenEmails.add(emailKey);
            
            // Generar jobId
            const jobId = generateJobId(campaignId, normalizedEmail);
            
            // DEBUG: Solo primer email
            if (processedCount === 1) {
              console.log(`🔍 ════════ VERIFICACIÓN ════════`);
              console.log(`   Email: "${normalizedEmail}"`);
              console.log(`   JobId: ${jobId}`);
              console.log(`════════════════════════════════\n`);
            }
            
            // ✅ CAMBIO #4: Fix upsert - usar $setOnInsert para campos requeridos
            bulkOperations.push({
              updateOne: {
                filter: {
                  campaignId: campaignId,
                  recipientEmail: normalizedEmail
                },
                update: {
                  $setOnInsert: {
                    jobId,
                    campaignId: campaignId,
                    recipientEmail: normalizedEmail,
                    customerId: customer._id,
                    status: 'pending',
                    attempts: 0,
                    createdAt: new Date(),
                    lockedBy: null,
                    lockedAt: null
                  }
                },
                upsert: true
              }
            });
            
            // Personalizar email
            let html = htmlTemplate;
            html = emailService.personalize(html, customer);
            
            // Inyectar unsubscribe link
            html = emailService.injectUnsubscribeLink(
              html,
              customer._id.toString(),
              normalizedEmail,
              campaignId
            );
            
            // Inyectar tracking
            html = emailService.injectTracking(
              html,
              campaignId,
              customer._id.toString(),
              normalizedEmail
            );
            
            // Agregar a tempRecipients
            tempRecipients.push({
              email: normalizedEmail,
              subject: subject,
              html: html,
              from: `${fromName} <${fromEmail}>`,
              replyTo: replyTo,
              customerId: customer._id.toString(),
              jobId: jobId
            });
            
            // ========== BATCH WRITE A MONGODB ==========
            if (bulkOperations.length >= BULK_WRITE_BATCH) {
              bulkWriteCount++;
              
              try {
                const bulkResult = await EmailSend.bulkWrite(bulkOperations, {
                  ordered: false
                });
                
                createdEmailSends += bulkResult.upsertedCount || 0;
                
                if (bulkWriteCount === 1 || bulkWriteCount % 20 === 0) {
                  console.log(`   💾 BulkWrite #${bulkWriteCount}: ${bulkOperations.length} ops → ${bulkResult.upsertedCount || 0} nuevos`);
                }
                
              } catch (error) {
                if (error.code !== 11000) {
                  console.error(`   ❌ Error en bulkWrite #${bulkWriteCount}:`, error.message);
                  throw error;
                }
              }
              
              bulkOperations = [];
            }
            
            // ========== ENCOLAR CHUNK ==========
            if (tempRecipients.length >= ENQUEUE_CHUNK_SIZE) {
              timer.end('process_customers');
              timer.start('enqueue_chunk');
              
              console.log(`\n   📤 ════════ ENCOLANDO ${tempRecipients.length} emails ════════`);
              console.log(`      Progreso: ${processedCount.toLocaleString()} / ${totalRecipients.toLocaleString()}`);
              
              const enqueueResult = await enqueueBulkWithRetry(
                tempRecipients, 
                campaignId, 
                100
              );
              
              console.log(`      ✅ Encolados: ${enqueueResult.enqueued.toLocaleString()}`);
              
              // Liberar memoria
              tempRecipients = [];
              
              timer.end('enqueue_chunk');
              timer.start('process_customers');
              
              await new Promise(resolve => setTimeout(resolve, config.delayBetweenBatches));
            }
            
            // Log progreso cada 5000
            if (processedCount % 5000 === 0) {
              const memoryUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
              const elapsed = ((Date.now() - timer.startTime) / 1000).toFixed(1);
              const rate = Math.round(processedCount / parseFloat(elapsed));
              
              console.log(`   📊 Progreso: ${processedCount.toLocaleString()} / ${totalRecipients.toLocaleString()} (${rate}/s)`);
              console.log(`      Memoria: ${memoryUsed} MB | Buffers: bulk=${bulkOperations.length}, queue=${tempRecipients.length}`);
            }
          }
          
          timer.end('process_customers');
          timer.start('residual_operations');
          
          // ========== PROCESAR OPERACIONES RESIDUALES ==========
          
          // 1. BulkWrite residual
          if (bulkOperations.length > 0) {
            bulkWriteCount++;
            console.log(`\n   💾 BulkWrite FINAL #${bulkWriteCount}: ${bulkOperations.length} ops`);
            
            try {
              const bulkResult = await EmailSend.bulkWrite(bulkOperations, {
                ordered: false
              });
              
              createdEmailSends += bulkResult.upsertedCount || 0;
              console.log(`      ✅ Creados: ${bulkResult.upsertedCount || 0}`);
              
            } catch (error) {
              if (error.code !== 11000) {
                console.error(`      ❌ Error en bulkWrite final:`, error.message);
              }
            }
            
            bulkOperations = [];
          }
          
          // 2. Encolar residuales
          if (tempRecipients.length > 0) {
            console.log(`\n   📤 ════════ ENCOLANDO CHUNK FINAL ════════`);
            console.log(`      Emails: ${tempRecipients.length.toLocaleString()}`);
            
            const enqueueResult = await enqueueBulkWithRetry(
              tempRecipients, 
              campaignId, 
              100
            );
            
            console.log(`      ✅ Encolados: ${enqueueResult.enqueued.toLocaleString()}`);
            
            tempRecipients = [];
          }
          
          timer.end('residual_operations');
          
          // ═══════════════════════════════════════════════════════════════════
          // ✅ CAMBIO #12: Ajustar totalRecipients después de deduplicación
          // Este es el FIX principal - sin esto, checkAndFinalizeCampaign
          // nunca puede completar porque totalProcessed < totalRecipients
          // ═══════════════════════════════════════════════════════════════════
          const actualRecipients = processedCount - skippedDuplicates;
          
          await Campaign.findByIdAndUpdate(campaignId, {
            status: 'sending',
            sentAt: new Date(),
            'stats.totalRecipients': actualRecipients  // ← FIX: Ajustar al número real
          });
          
          console.log(`\n   📊 Recipients ajustados: ${processedCount} → ${actualRecipients} (${skippedDuplicates} duplicados omitidos)`);
          
          // ========== RESUMEN FINAL ==========
          const duration = ((Date.now() - timer.startTime) / 1000).toFixed(2);
          const finalMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          const prepRate = Math.round(processedCount / parseFloat(duration));
          
          console.log('\n╔════════════════════════════════════════════════╗');
          console.log('║  ✅ PREPARACIÓN COMPLETADA                     ║');
          console.log('╚════════════════════════════════════════════════╝');
          console.log(`   Total procesados: ${processedCount.toLocaleString()}`);
          console.log(`   Recipients reales: ${actualRecipients.toLocaleString()}`);
          console.log(`   EmailSend creados: ${createdEmailSends.toLocaleString()}`);
          console.log(`   Duplicados omitidos: ${skippedDuplicates.toLocaleString()}`);
          console.log(`   BulkWrites ejecutados: ${bulkWriteCount}`);
          console.log(`   Tiempo: ${duration}s (${prepRate}/s)`);
          console.log(`   Memoria pico: ${finalMemory} MB`);
          console.log(`   Modo: ${config.name}`);
          console.log(`   Estado: preparing → sending`);
          console.log('════════════════════════════════════════════════\n');
          
          // Mostrar timers
          timer.log();
          
          console.log('╔════════════════════════════════════════════════╗');
          console.log('║  🚀 WORKERS PROCESANDO AUTOMÁTICAMENTE        ║');
          console.log('╚════════════════════════════════════════════════╝\n');
          
        } catch (error) {
          console.error('\n╔════════════════════════════════════════════════╗');
          console.error('║  ❌ ERROR EN BACKGROUND                        ║');
          console.error('╚════════════════════════════════════════════════╝');
          console.error(`   Error: ${error.message}`);
          console.error(`   Stack: ${error.stack}`);
          console.error('════════════════════════════════════════════════\n');
          
          try {
            await Campaign.findByIdAndUpdate(campaignId, {
              status: 'draft',
              'stats.error': error.message
            });
            console.log('⚠️  Campaña revertida a draft\n');
          } catch (err) {
            console.error('❌ Error revertiendo campaña:', err.message);
          }
        } finally {
          bulkOperations = null;
          tempRecipients = null;
          seenEmails.clear();
          batchIndexTracker.delete(campaignId);
        }
      });
      
    } catch (error) {
      console.error('\n❌ Error enviando campaña:', error);
      
      try {
        await Campaign.findByIdAndUpdate(req.params.id, { 
          status: 'draft',
          'stats.error': error.message
        });
      } catch (err) {
        console.error('Error revertiendo:', err);
      }
      
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }
  
  // ========== ENVÍO DE EMAIL DE PRUEBA ==========
  
  async sendTestEmail(campaign, testEmail, res) {
    console.log(`🧪 ════════ MODO TEST ════════`);
    console.log(`   Enviando a: ${testEmail}`);
    console.log(`════════════════════════════\n`);
    
    try {
      let testCustomer;
      
      if (campaign.targetType === 'list') {
        const list = await List.findById(campaign.list._id).select('members');
        if (list && list.members.length > 0) {
          testCustomer = await Customer.findById(list.members[0])
            .select('email firstName lastName _id')
            .lean();
        }
      } else {
        const customers = await segmentationService.evaluateSegment(
          campaign.segment.conditions,
          { select: 'email firstName lastName _id', limit: 1 }
        );
        testCustomer = customers[0];
      }
      
      if (!testCustomer) {
        testCustomer = { 
          firstName: 'Test', 
          lastName: 'User', 
          email: testEmail,
          _id: 'test'
        };
      }
      
      let html = campaign.htmlContent;
      html = emailService.personalize(html, testCustomer);
      
      html = emailService.injectUnsubscribeLink(
        html,
        testCustomer._id.toString(),
        testEmail,
        campaign._id.toString()
      );
      
      html = emailService.injectTracking(
        html,
        campaign._id.toString(),
        testCustomer._id.toString(),
        testEmail
      );
      
      const result = await emailService.sendEmail({
        to: testEmail,
        subject: `[TEST] ${campaign.subject}`,
        html,
        from: `${campaign.fromName} <${campaign.fromEmail}>`,
        replyTo: campaign.replyTo,
        tags: [
          { name: 'campaign_id', value: campaign._id.toString() },
          { name: 'test', value: 'true' }
        ]
      });
      
      if (result.success) {
        console.log('✅ Email de prueba enviado correctamente\n');
        return res.json({
          success: true,
          testMode: true,
          message: `Email de prueba enviado a ${testEmail}`,
          emailId: result.id
        });
      } else {
        throw new Error(result.error);
      }
      
    } catch (error) {
      console.error('❌ Error enviando test:', error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // ==================== ESTADÍSTICAS ====================
  
  async getStats(req, res) {
    try {
      const campaign = await Campaign.findById(req.params.id)
        .populate('segment', 'name')
        .populate('list', 'name');
      
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      const emailSendStats = await EmailSend.getCampaignStats(req.params.id);
      
      const events = await EmailEvent.find({ campaign: req.params.id })
        .populate('customer', 'email firstName lastName')
        .sort({ eventDate: -1 });
      
      // Unsubscribe events
      const unsubscribedEvents = events.filter(e => e.eventType === 'unsubscribed');
      const unsubscribedCustomers = unsubscribedEvents.map(event => ({
        customer: event.customer,
        email: event.customer?.email || event.metadata?.email,
        createdAt: event.eventDate
      }));
      
      const stats = {
        total: emailSendStats.total,
        pending: emailSendStats.pending,
        processing: emailSendStats.processing,
        sent: emailSendStats.sent,
        delivered: emailSendStats.delivered,
        failed: emailSendStats.failed,
        bounced: emailSendStats.bounced,
        skipped: emailSendStats.skipped || 0,
        opened: events.filter(e => e.eventType === 'opened').length,
        clicked: events.filter(e => e.eventType === 'clicked').length,
        complained: events.filter(e => e.eventType === 'complained').length,
        unsubscribed: unsubscribedEvents.length,
        purchased: campaign.stats.purchased || 0,
      };
      
      const totalDelivered = stats.delivered || stats.sent || 1;
      const rates = {
        deliveryRate: stats.sent > 0 ? ((stats.delivered / stats.sent) * 100).toFixed(1) : '0.0',
        openRate: totalDelivered > 0 ? ((stats.opened / totalDelivered) * 100).toFixed(1) : '0.0',
        clickRate: stats.opened > 0 ? ((stats.clicked / stats.opened) * 100).toFixed(1) : '0.0',
        bounceRate: stats.sent > 0 ? ((stats.bounced / stats.sent) * 100).toFixed(1) : '0.0',
        unsubscribeRate: stats.sent > 0 ? ((stats.unsubscribed / stats.sent) * 100).toFixed(2) : '0.00',
        clickToOpenRate: stats.opened > 0 ? ((stats.clicked / stats.opened) * 100).toFixed(1) : '0.0',
        conversionRate: campaign.stats.conversionRate || 0,
      };
      
      const statsBySource = {
        custom: events.filter(e => e.source === 'custom').length,
        resend: events.filter(e => e.source === 'resend').length,
        shopify: events.filter(e => e.source === 'shopify').length,
      };
      
      const clickEvents = events.filter(e => e.eventType === 'clicked' && (e.clickedUrl || e.metadata?.url));
      const linkCounts = {};
      clickEvents.forEach(event => {
        const url = event.clickedUrl || event.metadata?.url;
        if (url) {
          linkCounts[url] = (linkCounts[url] || 0) + 1;
        }
      });
      const topLinks = Object.entries(linkCounts)
        .map(([url, clicks]) => ({ url, clicks }))
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 10);
      
      const Order = require('../models/Order');
      const orders = await Order.find({
        'attribution.campaign': req.params.id
      }).populate('customer', 'email firstName lastName');
      
      const productCounts = {};
      const productRevenue = {};
      
      orders.forEach(order => {
        if (order.lineItems && Array.isArray(order.lineItems)) {
          order.lineItems.forEach(item => {
            const key = item.title || item.name;
            if (key) {
              productCounts[key] = (productCounts[key] || 0) + (item.quantity || 1);
              productRevenue[key] = (productRevenue[key] || 0) + (item.price * (item.quantity || 1));
            }
          });
        }
      });
      
      const topProducts = Object.entries(productCounts)
        .map(([title, quantity]) => ({
          title,
          quantity,
          revenue: productRevenue[title] || 0
        }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);
      
      const recentEvents = events.slice(0, 50);
      
      const last30Days = Array.from({ length: 30 }, (_, i) => {
        const date = new Date();
        date.setDate(date.getDate() - (29 - i));
        date.setHours(0, 0, 0, 0);
        return date;
      });
      
      const timeline = last30Days.map(date => {
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        
        const dayEvents = events.filter(e => {
          const eventDate = new Date(e.eventDate);
          return eventDate >= date && eventDate < nextDay;
        });
        
        const dayOrders = orders.filter(order => {
          const orderDate = new Date(order.createdAt);
          return orderDate >= date && orderDate < nextDay;
        });
        
        const dayRevenue = dayOrders.reduce((sum, order) => 
          sum + (order.totalPrice || 0), 0
        );
        
        return {
          date: date.toISOString().split('T')[0],
          dateLabel: date.toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
          sent: dayEvents.filter(e => e.eventType === 'sent').length,
          opened: dayEvents.filter(e => e.eventType === 'opened').length,
          clicked: dayEvents.filter(e => e.eventType === 'clicked').length,
          bounced: dayEvents.filter(e => e.eventType === 'bounced').length,
          unsubscribed: dayEvents.filter(e => e.eventType === 'unsubscribed').length,
          purchased: dayOrders.length,
          revenue: dayRevenue,
        };
      });
      
      const customerActivity = {};
      
      const validEvents = events.filter(event => 
        event.customer && 
        event.customer._id && 
        (event.eventType === 'opened' || event.eventType === 'clicked')
      );
      
      validEvents.forEach(event => {
        const customerId = event.customer._id.toString();
        
        if (!customerActivity[customerId]) {
          customerActivity[customerId] = {
            customer: event.customer,
            opens: 0,
            clicks: 0,
            purchases: 0,
            revenue: 0,
            total: 0
          };
        }
        
        if (event.eventType === 'opened') customerActivity[customerId].opens++;
        if (event.eventType === 'clicked') customerActivity[customerId].clicks++;
        customerActivity[customerId].total++;
      });
      
      orders.forEach(order => {
        if (order.customer && order.customer._id) {
          const customerId = order.customer._id.toString();
          
          if (!customerActivity[customerId]) {
            customerActivity[customerId] = {
              customer: order.customer,
              opens: 0,
              clicks: 0,
              purchases: 0,
              revenue: 0,
              total: 0
            };
          }
          
          customerActivity[customerId].purchases++;
          customerActivity[customerId].revenue += order.totalPrice || 0;
          customerActivity[customerId].total++;
        }
      });
      
      const topCustomers = Object.values(customerActivity)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);
      
      const revenue = {
        total: campaign.stats.totalRevenue || 0,
        purchases: campaign.stats.purchased || 0,
        averageOrderValue: campaign.stats.averageOrderValue || 0,
        revenuePerEmail: campaign.stats.revenuePerEmail || 0,
        conversionRate: campaign.stats.conversionRate || 0,
      };
      
      res.json({
        campaign: {
          id: campaign._id,
          name: campaign.name,
          subject: campaign.subject,
          status: campaign.status,
          sentAt: campaign.sentAt,
          targetType: campaign.targetType,
          list: campaign.list,
          segment: campaign.segment,
          stats: campaign.stats,
        },
        stats,
        rates,
        statsBySource,
        topLinks,
        topCustomers,
        topProducts,
        recentEvents,
        timeline,
        totalEvents: events.length,
        revenue,
        emailSendStats,
        unsubscribedCustomers
      });
      
    } catch (error) {
      console.error('Error obteniendo stats:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async getEvents(req, res) {
    try {
      const { page = 1, limit = 50, eventType, source } = req.query;
      
      const campaign = await Campaign.findById(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      
      const filter = { campaign: req.params.id };
      if (eventType) filter.eventType = eventType;
      if (source) filter.source = source;
      
      const events = await EmailEvent.find(filter)
        .populate('customer', 'email firstName lastName')
        .sort({ eventDate: -1 })
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit));
      
      const total = await EmailEvent.countDocuments(filter);
      
      res.json({
        events,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      });
      
    } catch (error) {
      console.error('Error obteniendo eventos:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== ANALYTICS AGREGADOS ====================

  async getAnalytics(req, res) {
    try {
      const { range = '30d' } = req.query;
      
      const now = new Date();
      let startDate = new Date();
      let rangeDays = 30;
      
      switch (range) {
        case '7d':
          rangeDays = 7;
          startDate.setDate(now.getDate() - 7);
          break;
        case '90d':
          rangeDays = 90;
          startDate.setDate(now.getDate() - 90);
          break;
        case '30d':
        default:
          rangeDays = 30;
          startDate.setDate(now.getDate() - 30);
          break;
      }
      
      const campaigns = await Campaign.find({
        status: 'sent',
        sentAt: { $gte: startDate }
      }).sort({ sentAt: -1 });
      
      const totalSent = campaigns.reduce((sum, c) => sum + (c.stats?.sent || 0), 0);
      const totalDelivered = campaigns.reduce((sum, c) => sum + (c.stats?.delivered || 0), 0);
      const totalOpened = campaigns.reduce((sum, c) => sum + (c.stats?.opened || 0), 0);
      const totalClicked = campaigns.reduce((sum, c) => sum + (c.stats?.clicked || 0), 0);
      const totalBounced = campaigns.reduce((sum, c) => sum + (c.stats?.bounced || 0), 0);
      const totalUnsubs = campaigns.reduce((sum, c) => sum + (c.stats?.unsubscribed || 0), 0);
      const totalRevenue = campaigns.reduce((sum, c) => sum + (c.stats?.totalRevenue || 0), 0);
      const totalPurchases = campaigns.reduce((sum, c) => sum + (c.stats?.purchased || 0), 0);
      
      const avgOpenRate = totalSent > 0 ? (totalOpened / totalSent) * 100 : 0;
      const avgClickRate = totalOpened > 0 ? (totalClicked / totalOpened) * 100 : 0;
      const avgBounceRate = totalSent > 0 ? (totalBounced / totalSent) * 100 : 0;
      const avgUnsubRate = totalSent > 0 ? (totalUnsubs / totalSent) * 100 : 0;
      
      const previousStartDate = new Date(startDate);
      previousStartDate.setDate(previousStartDate.getDate() - rangeDays);
      
      const previousCampaigns = await Campaign.find({
        status: 'sent',
        sentAt: { 
          $gte: previousStartDate,
          $lt: startDate 
        }
      });
      
      const prevSent = previousCampaigns.reduce((sum, c) => sum + (c.stats?.sent || 0), 0);
      const prevOpened = previousCampaigns.reduce((sum, c) => sum + (c.stats?.opened || 0), 0);
      const prevClicked = previousCampaigns.reduce((sum, c) => sum + (c.stats?.clicked || 0), 0);
      const prevRevenue = previousCampaigns.reduce((sum, c) => sum + (c.stats?.totalRevenue || 0), 0);
      
      const calcChange = (current, previous) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return ((current - previous) / previous) * 100;
      };
      
      const prevOpenRate = prevSent > 0 ? (prevOpened / prevSent) * 100 : 0;
      const prevClickRate = prevOpened > 0 ? (prevClicked / prevOpened) * 100 : 0;
      
      const timeline = [];
      
      for (let i = 0; i < rangeDays; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        date.setHours(0, 0, 0, 0);
        
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        
        const dayCampaigns = campaigns.filter(c => {
          const sentDate = new Date(c.sentAt);
          return sentDate >= date && sentDate < nextDay;
        });
        
        timeline.push({
          date: date.toISOString().split('T')[0],
          dateLabel: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          campaigns: dayCampaigns.length,
          sent: dayCampaigns.reduce((sum, c) => sum + (c.stats?.sent || 0), 0),
          opened: dayCampaigns.reduce((sum, c) => sum + (c.stats?.opened || 0), 0),
          clicked: dayCampaigns.reduce((sum, c) => sum + (c.stats?.clicked || 0), 0),
          revenue: dayCampaigns.reduce((sum, c) => sum + (c.stats?.totalRevenue || 0), 0),
        });
      }
      
      res.json({
        range,
        period: {
          start: startDate.toISOString(),
          end: now.toISOString()
        },
        summary: {
          totalCampaigns: campaigns.length,
          totalSent,
          totalDelivered,
          totalOpened,
          totalClicked,
          totalBounced,
          totalUnsubs,
          totalRevenue,
          totalPurchases,
          avgOpenRate: parseFloat(avgOpenRate.toFixed(2)),
          avgClickRate: parseFloat(avgClickRate.toFixed(2)),
          avgBounceRate: parseFloat(avgBounceRate.toFixed(2)),
          avgUnsubRate: parseFloat(avgUnsubRate.toFixed(2)),
          sentChange: parseFloat(calcChange(totalSent, prevSent).toFixed(1)),
          openRateChange: parseFloat((avgOpenRate - prevOpenRate).toFixed(1)),
          clickRateChange: parseFloat((avgClickRate - prevClickRate).toFixed(1)),
          revenueChange: parseFloat(calcChange(totalRevenue, prevRevenue).toFixed(1)),
        },
        timeline,
        topCampaigns: campaigns
          .sort((a, b) => (b.stats?.totalRevenue || 0) - (a.stats?.totalRevenue || 0))
          .slice(0, 5)
          .map(c => ({
            _id: c._id,
            name: c.name,
            sentAt: c.sentAt,
            stats: c.stats
          }))
      });
      
    } catch (error) {
      console.error('Error obteniendo analytics:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== TEMPLATES Y UTILIDADES ====================

  async createFromTemplate(req, res) {
    try {
      const { 
        templateType, 
        name, 
        subject,
        targetType = 'segment',
        segmentId,
        listId,
        templateData = {}
      } = req.body;
      
      let htmlContent;
      
      switch (templateType) {
        case 'welcome':
          htmlContent = templateService.getWelcomeEmail(
            '{{firstName}}',
            templateData.discountCode || 'BIENVENIDO15'
          );
          break;
          
        case 'abandoned_cart':
          htmlContent = templateService.getAbandonedCartEmail(
            '{{firstName}}',
            templateData.cartItems || [],
            templateData.cartUrl || 'https://jerseypickles.com/cart'
          );
          break;
          
        case 'promotional':
          htmlContent = templateService.getPromotionalEmail(
            templateData.title || 'Oferta Especial',
            templateData.message || 'No te pierdas esta increíble oferta',
            templateData.ctaText || 'Comprar Ahora',
            templateData.ctaUrl || 'https://jerseypickles.com',
            templateData.imageUrl
          );
          break;
          
        default:
          return res.status(400).json({ 
            error: 'Tipo de template no válido',
            validTypes: ['welcome', 'abandoned_cart', 'promotional']
          });
      }
      
      const campaign = await Campaign.create({
        name: name || `Campaña ${templateType}`,
        subject: subject || `Mensaje de Jersey Pickles`,
        htmlContent,
        targetType,
        segment: targetType === 'segment' ? segmentId : null,
        list: targetType === 'list' ? listId : null,
        status: 'draft'
      });
      
      console.log(`✅ Campaña desde template: ${templateType}`);
      
      res.status(201).json(campaign);
      
    } catch (error) {
      console.error('Error creando desde template:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async cleanupDrafts(req, res) {
    try {
      const result = await Campaign.deleteMany({ status: 'draft' });
      console.log(`🗑️  ${result.deletedCount} borradores eliminados`);
      
      res.json({ 
        success: true, 
        message: `${result.deletedCount} campañas borrador eliminadas`,
        deletedCount: result.deletedCount
      });
      
    } catch (error) {
      console.error('Error limpiando borradores:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== HEALTH CHECK ====================

  async healthCheck(req, res) {
    try {
      const { isAvailable, getQueueStatus } = require('../jobs/emailQueue');
      
      const queueAvailable = isAvailable();
      if (!queueAvailable) {
        return res.status(503).json({
          healthy: false,
          error: 'Queue no disponible',
          message: 'Redis/BullMQ no está conectado',
          timestamp: new Date().toISOString()
        });
      }
      
      const queueStatus = await getQueueStatus();
      
      const pendingJobs = await EmailSend.countDocuments({ status: 'pending' });
      const processingJobs = await EmailSend.countDocuments({ status: 'processing' });
      
      const LOCK_TTL_MS = 5 * 60 * 1000;
      const stuckJobs = await EmailSend.countDocuments({
        status: 'processing',
        lockedAt: { $lt: new Date(Date.now() - LOCK_TTL_MS) }
      });
      
      const preparingCampaigns = await Campaign.countDocuments({ status: 'preparing' });
      const sendingCampaigns = await Campaign.countDocuments({ status: 'sending' });
      
      const health = {
        healthy: true,
        timestamp: new Date().toISOString(),
        queue: {
          available: queueAvailable,
          waiting: queueStatus.waiting || 0,
          active: queueStatus.active || 0,
          completed: queueStatus.completed || 0,
          failed: queueStatus.failed || 0,
          paused: queueStatus.paused || false,
          total: queueStatus.total || 0
        },
        emailSends: {
          pending: pendingJobs,
          processing: processingJobs,
          stuck: stuckJobs
        },
        campaigns: {
          preparing: preparingCampaigns,
          sending: sendingCampaigns
        },
        config: {
          mode: 'OPTIMIZED v2.1',
          features: [
            'Bulk claim (1 query/batch)',
            'TTL locks (5 min)',
            'Estados: preparing → sending',
            'Debounce finalize',
            'Timers por etapa',
            'Fix: totalRecipients ajustado post-deduplicación'
          ],
          resend: {
            rateLimit: '10 req/s',
            batchSize: 100,
            theoreticalThroughput: '1000 emails/s',
            realisticThroughput: '600-800 emails/s'
          }
        }
      };
      
      const warnings = [];
      
      if (stuckJobs > 0) {
        warnings.push(`${stuckJobs} jobs bloqueados >5min (serán re-claimed)`);
      }
      
      if (queueStatus.failed > 100) {
        warnings.push(`${queueStatus.failed} jobs fallidos`);
      }
      
      if (queueStatus.waiting > 10000) {
        warnings.push(`${queueStatus.waiting} jobs esperando`);
      }
      
      if (warnings.length > 0) {
        health.warnings = warnings;
      }
      
      res.json(health);
      
    } catch (error) {
      console.error('Error en health check:', error);
      res.status(500).json({
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  // ==================== QUEUE MANAGEMENT ====================

  async getQueueStatus(req, res) {
    try {
      const emailQueueModule = require('../jobs/emailQueue');
      const status = await emailQueueModule.getQueueStatus();
      
      if (!status.available) {
        return res.json(status);
      }
      
      let currentCampaign = null;
      
      try {
        if (typeof emailQueueModule.getActiveJobs !== 'function' || 
            typeof emailQueueModule.getWaitingJobs !== 'function') {
          return res.json({
            ...status,
            currentCampaign: null,
            timestamp: new Date().toISOString()
          });
        }
        
        const activeJobs = await emailQueueModule.getActiveJobs();
        const waitingJobs = await emailQueueModule.getWaitingJobs();
        
        const job = activeJobs[0] || waitingJobs[0];
        
        if (job && job.data && job.data.campaignId) {
          const campaign = await Campaign.findById(job.data.campaignId);
          
          if (campaign) {
            const totalInQueue = (status.waiting || 0) + (status.active || 0) + (status.delayed || 0);
            const totalCompleted = status.completed || 0;
            const totalRecipients = campaign.stats?.totalRecipients || 0;
            
            currentCampaign = {
              id: campaign._id,
              name: campaign.name,
              subject: campaign.subject,
              status: campaign.status,
              totalRecipients: totalRecipients,
              sent: campaign.stats?.sent || 0,
              delivered: campaign.stats?.delivered || 0,
              failed: campaign.stats?.failed || 0,
              inQueue: totalInQueue,
              completed: totalCompleted,
              createdAt: campaign.createdAt,
              sentAt: campaign.sentAt
            };
          }
        }
      } catch (error) {
        console.error('Error obteniendo campaña activa:', error.message);
      }
      
      res.json({
        ...status,
        currentCampaign,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Error obteniendo estado de cola:', error);
      
      res.json({
        available: false,
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
        total: 0,
        currentCampaign: null,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  async pauseQueue(req, res) {
    try {
      const { pauseQueue } = require('../jobs/emailQueue');
      const result = await pauseQueue();
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async resumeQueue(req, res) {
    try {
      const { resumeQueue } = require('../jobs/emailQueue');
      const result = await resumeQueue();
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async cleanQueue(req, res) {
    try {
      const { cleanQueue } = require('../jobs/emailQueue');
      const result = await cleanQueue();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async forceCheckCampaigns(req, res) {
    try {
      const { checkAllSendingCampaigns } = require('../jobs/emailQueue');
      
      console.log('🔄 Verificación manual iniciada...');
      
      const results = await checkAllSendingCampaigns();
      
      const finalized = results.filter(r => r.finalized);
      const stillSending = results.filter(r => !r.finalized);
      
      res.json({
        success: true,
        message: `Verificación: ${finalized.length} finalizadas, ${stillSending.length} enviando`,
        results: {
          finalized: finalized.map(r => ({
            id: r.id,
            name: r.name,
            sent: r.sent,
            total: r.total
          })),
          stillSending: stillSending.map(r => ({
            id: r.id,
            name: r.name,
            sent: r.sent,
            total: r.total,
            pending: r.total - r.sent
          }))
        }
      });
      
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }
}

module.exports = new CampaignsController();