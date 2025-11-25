// backend/src/scripts/migrate-email-campaigns.js
/**
 * MIGRACIÓN: Email Campaigns System v2.0
 * 
 * Este script:
 * 1. Crea la colección EmailSend con índices únicos
 * 2. Migra datos existentes si es necesario
 * 3. Agrega índice único a EmailEvent
 * 4. Verifica integridad de datos
 * 
 * EJECUTAR:
 * node src/scripts/migrate-email-campaigns.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI no configurado en .env');
  process.exit(1);
}

async function runMigration() {
  try {
    console.log('\n╔═══════════════════════════════════════════════╗');
    console.log('║  📦 MIGRACIÓN: Email Campaigns v2.0          ║');
    console.log('╚═══════════════════════════════════════════════╝\n');
    
    // Conectar a MongoDB
    console.log('🔄 Conectando a MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Conectado a MongoDB\n');
    
    const db = mongoose.connection.db;
    
    // ========== PASO 1: Crear colección EmailSend ==========
    console.log('📊 PASO 1: Creando colección email_sends...\n');
    
    const collections = await db.listCollections({ name: 'email_sends' }).toArray();
    
    if (collections.length === 0) {
      await db.createCollection('email_sends');
      console.log('   ✅ Colección email_sends creada');
    } else {
      console.log('   ℹ️  Colección email_sends ya existe');
    }
    
    // ========== PASO 2: Crear índices en EmailSend ==========
    console.log('\n📊 PASO 2: Creando índices en email_sends...\n');
    
    const emailSendsCollection = db.collection('email_sends');
    
    // Índice 1: jobId único
    try {
      await emailSendsCollection.createIndex(
        { jobId: 1 },
        { 
          unique: true, 
          name: 'jobId_unique',
          background: true 
        }
      );
      console.log('   ✅ Índice único: jobId');
    } catch (error) {
      if (error.code === 85 || error.code === 11000) {
        console.log('   ℹ️  Índice jobId ya existe');
      } else {
        throw error;
      }
    }
    
    // Índice 2: campaignId + recipientEmail único (CRÍTICO)
    try {
      await emailSendsCollection.createIndex(
        { campaignId: 1, recipientEmail: 1 },
        { 
          unique: true, 
          name: 'campaign_recipient_unique',
          background: true 
        }
      );
      console.log('   ✅ Índice único: campaignId + recipientEmail (PREVIENE DUPLICADOS)');
    } catch (error) {
      if (error.code === 85 || error.code === 11000) {
        console.log('   ℹ️  Índice campaign_recipient ya existe');
      } else {
        throw error;
      }
    }
    
    // Índice 3: campaignId
    try {
      await emailSendsCollection.createIndex(
        { campaignId: 1 },
        { 
          name: 'campaignId_lookup',
          background: true 
        }
      );
      console.log('   ✅ Índice: campaignId');
    } catch (error) {
      if (error.code === 85) {
        console.log('   ℹ️  Índice campaignId ya existe');
      } else {
        throw error;
      }
    }
    
    // Índice 4: status + lockedAt (para recuperación de locks)
    try {
      await emailSendsCollection.createIndex(
        { status: 1, lockedAt: 1 },
        { 
          name: 'status_locked_recovery',
          background: true 
        }
      );
      console.log('   ✅ Índice: status + lockedAt');
    } catch (error) {
      if (error.code === 85) {
        console.log('   ℹ️  Índice status_locked ya existe');
      } else {
        throw error;
      }
    }
    
    // Índice 5: externalMessageId (para webhooks)
    try {
      await emailSendsCollection.createIndex(
        { externalMessageId: 1 },
        { 
          name: 'externalMessageId_lookup',
          background: true,
          sparse: true // Solo indexar documentos que tienen este campo
        }
      );
      console.log('   ✅ Índice: externalMessageId');
    } catch (error) {
      if (error.code === 85) {
        console.log('   ℹ️  Índice externalMessageId ya existe');
      } else {
        throw error;
      }
    }
    
    // ========== PASO 3: Crear índice único en EmailEvent ==========
    console.log('\n📊 PASO 3: Creando índices en email_events...\n');
    
    const emailEventsCollection = db.collection('email_events');
    
    // Índice único: eventId (previene duplicados de webhooks)
    try {
      await emailEventsCollection.createIndex(
        { eventId: 1 },
        { 
          unique: true, 
          name: 'eventId_unique',
          background: true,
          sparse: true // Solo para eventos nuevos que tengan eventId
        }
      );
      console.log('   ✅ Índice único: eventId (PREVIENE WEBHOOKS DUPLICADOS)');
    } catch (error) {
      if (error.code === 85 || error.code === 11000) {
        console.log('   ℹ️  Índice eventId ya existe');
      } else {
        throw error;
      }
    }
    
    // ========== PASO 4: Verificar datos existentes ==========
    console.log('\n📊 PASO 4: Verificando datos existentes...\n');
    
    const emailSendsCount = await emailSendsCollection.countDocuments();
    const emailEventsCount = await emailEventsCollection.countDocuments();
    const campaignsCount = await db.collection('campaigns').countDocuments();
    
    console.log(`   📧 EmailSends: ${emailSendsCount.toLocaleString()}`);
    console.log(`   📨 EmailEvents: ${emailEventsCount.toLocaleString()}`);
    console.log(`   📮 Campaigns: ${campaignsCount.toLocaleString()}`);
    
    // ========== PASO 5: Limpiar locks expirados ==========
    console.log('\n📊 PASO 5: Limpiando locks expirados...\n');
    
    const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
    const lockTimeout = new Date(Date.now() - LOCK_TIMEOUT_MS);
    
    const result = await emailSendsCollection.updateMany(
      {
        status: 'processing',
        lockedAt: { $lt: lockTimeout }
      },
      {
        $set: {
          status: 'pending',
          lockedBy: null,
          lockedAt: null
        }
      }
    );
    
    if (result.modifiedCount > 0) {
      console.log(`   ✅ Liberados ${result.modifiedCount} locks expirados`);
    } else {
      console.log('   ℹ️  No hay locks expirados');
    }
    
    // ========== PASO 6: Verificar campañas en "sending" ==========
    console.log('\n📊 PASO 6: Verificando campañas en estado "sending"...\n');
    
    const sendingCampaigns = await db.collection('campaigns')
      .find({ status: 'sending' })
      .toArray();
    
    if (sendingCampaigns.length > 0) {
      console.log(`   ⚠️  Encontradas ${sendingCampaigns.length} campañas en "sending"`);
      console.log('   📝 Considera ejecutar checkAllSendingCampaigns() para verificarlas');
      
      sendingCampaigns.forEach(c => {
        console.log(`      - ${c.name} (${c._id})`);
      });
    } else {
      console.log('   ✅ No hay campañas pendientes');
    }
    
    // ========== RESUMEN FINAL ==========
    console.log('\n╔═══════════════════════════════════════════════╗');
    console.log('║  ✅ MIGRACIÓN COMPLETADA EXITOSAMENTE        ║');
    console.log('╚═══════════════════════════════════════════════╝\n');
    
    console.log('📋 Checklist Post-Migración:\n');
    console.log('   [ ] Actualizar archivos: EmailSend.js, emailQueue.js, campaignsController.js');
    console.log('   [ ] Configurar REDIS_URL en .env con Upstash Redis');
    console.log('   [ ] Configurar webhook de Resend apuntando a /api/webhooks/resend');
    console.log('   [ ] Reiniciar servidor con nuevos archivos');
    console.log('   [ ] Ejecutar campaña de prueba con 10-100 emails');
    console.log('   [ ] Verificar que no hay duplicados en email_sends');
    console.log('   [ ] Monitorear logs del worker\n');
    
    console.log('🔗 Documentación: https://docs.bullmq.io/');
    console.log('🔗 Upstash Redis: https://upstash.com/\n');
    
    await mongoose.disconnect();
    console.log('✅ Desconectado de MongoDB\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Error en migración:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Ejecutar migración
runMigration();