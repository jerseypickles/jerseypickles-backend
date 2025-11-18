// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoose = require('mongoose');
const connectDB = require('./src/config/database');
const errorHandler = require('./src/middleware/errorHandler');
const { apiLimiter } = require('./src/middleware/rateLimiter');

const app = express();

// Conectar a MongoDB
connectDB();

// ==================== MIDDLEWARE ====================

// Seguridad y compresión
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// ⚠️ CRÍTICO: Raw body para webhooks DEBE ir ANTES de express.json()
// Esto captura el raw body solo para /api/webhooks
app.use('/api/webhooks', express.raw({ type: 'application/json' }));

// Body parsers (van DESPUÉS del raw)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting para rutas API (excepto webhooks)
app.use('/api/', (req, res, next) => {
  // No aplicar rate limit a webhooks
  if (req.path.startsWith('/webhooks')) {
    return next();
  }
  return apiLimiter(req, res, next);
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Ruta raíz - Información de la API
app.get('/', (req, res) => {
  res.json({ 
    message: '🥒 Jersey Pickles Email Marketing API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      customers: '/api/customers',
      orders: '/api/orders',
      segments: '/api/segments',
      campaigns: '/api/campaigns',
      webhooks: '/api/webhooks',
      tracking: '/api/track',
      analytics: '/api/analytics'
    },
    documentation: {
      auth: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        me: 'GET /api/auth/me'
      },
      customers: {
        list: 'GET /api/customers',
        sync: 'POST /api/customers/sync',
        stats: 'GET /api/customers/stats',
        testShopify: 'GET /api/customers/test-shopify'
      },
      orders: {
        list: 'GET /api/orders',
        sync: 'POST /api/orders/sync',
        stats: 'GET /api/orders/stats'
      },
      segments: {
        list: 'GET /api/segments',
        create: 'POST /api/segments',
        preview: 'POST /api/segments/preview',
        predefined: 'POST /api/segments/predefined/create-all'
      },
      campaigns: {
        list: 'GET /api/campaigns',
        create: 'POST /api/campaigns',
        send: 'POST /api/campaigns/:id/send',
        fromTemplate: 'POST /api/campaigns/from-template'
      },
      analytics: {
        dashboard: 'GET /api/analytics/dashboard',
        topCustomers: 'GET /api/analytics/top-customers',
        revenueTimeline: 'GET /api/analytics/revenue-timeline',
        campaignPerformance: 'GET /api/analytics/campaign-performance'
      }
    }
  });
});

// ==================== ROUTES ====================

// Auth (sin autenticación requerida)
app.use('/api/auth', require('./src/routes/auth'));

// Webhooks (validación propia de Shopify)
app.use('/api/webhooks', require('./src/routes/webhooks'));

// API Routes (requieren autenticación - se valida dentro de cada ruta)
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/orders', require('./src/routes/orders'));
app.use('/api/segments', require('./src/routes/segments'));
app.use('/api/campaigns', require('./src/routes/campaigns'));
app.use('/api/track', require('./src/routes/tracking'));
app.use('/api/analytics', require('./src/routes/analytics'));

// Ruta 404 - Manejo de rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Ruta no encontrada',
    path: req.originalUrl,
    availableEndpoints: [
      '/health',
      '/api/auth',
      '/api/customers',
      '/api/orders',
      '/api/segments',
      '/api/campaigns',
      '/api/webhooks',
      '/api/track',
      '/api/analytics'
    ]
  });
});

// ==================== ERROR HANDLER ====================
// Debe ir AL FINAL, después de todas las rutas
app.use(errorHandler);

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🥒 Jersey Pickles Email Marketing   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting...'}`);
  console.log(`🌐 API URL: http://localhost:${PORT}`);
  console.log('');
  console.log('📡 Available endpoints:');
  console.log(`   - Health Check:        http://localhost:${PORT}/health`);
  console.log(`   - API Documentation:   http://localhost:${PORT}/`);
  console.log('');
  console.log('🔐 Authentication:');
  console.log(`   - Register:            POST http://localhost:${PORT}/api/auth/register`);
  console.log(`   - Login:               POST http://localhost:${PORT}/api/auth/login`);
  console.log('');
  console.log('👥 Customers:');
  console.log(`   - List:                GET  http://localhost:${PORT}/api/customers`);
  console.log(`   - Sync from Shopify:   POST http://localhost:${PORT}/api/customers/sync`);
  console.log(`   - Test Connection:     GET  http://localhost:${PORT}/api/customers/test-shopify`);
  console.log('');
  console.log('📦 Orders:');
  console.log(`   - List:                GET  http://localhost:${PORT}/api/orders`);
  console.log(`   - Sync from Shopify:   POST http://localhost:${PORT}/api/orders/sync`);
  console.log('');
  console.log('🎯 Segments:');
  console.log(`   - List:                GET  http://localhost:${PORT}/api/segments`);
  console.log(`   - Create Predefined:   POST http://localhost:${PORT}/api/segments/predefined/create-all`);
  console.log('');
  console.log('📧 Campaigns:');
  console.log(`   - List:                GET  http://localhost:${PORT}/api/campaigns`);
  console.log(`   - Create:              POST http://localhost:${PORT}/api/campaigns`);
  console.log(`   - Send:                POST http://localhost:${PORT}/api/campaigns/:id/send`);
  console.log('');
  console.log('📊 Analytics:');
  console.log(`   - Dashboard:           GET  http://localhost:${PORT}/api/analytics/dashboard`);
  console.log('');
  console.log('✅ Server ready to accept requests!');
  console.log('═══════════════════════════════════════════\n');
});

// ==================== GRACEFUL SHUTDOWN ====================

// Manejar cierre graceful
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  // Cerrar servidor HTTP
  server.close(async () => {
    console.log('✅ HTTP server closed');
    
    // Cerrar conexión de MongoDB
    try {
      await mongoose.connection.close();
      console.log('✅ MongoDB connection closed');
    } catch (err) {
      console.error('❌ Error closing MongoDB:', err);
    }
    
    console.log('👋 Graceful shutdown completed');
    process.exit(0);
  });
  
  // Forzar cierre después de 10 segundos
  setTimeout(() => {
    console.error('⚠️  Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

// Escuchar señales de terminación
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Manejar errores no capturados
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Promise Rejection:', err);
  console.error('Stack:', err.stack);
  // En producción, considera cerrar el servidor
  if (process.env.NODE_ENV === 'production') {
    gracefulShutdown('unhandledRejection');
  }
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  console.error('Stack:', err.stack);
  // Siempre cerrar en excepciones no capturadas
  gracefulShutdown('uncaughtException');
});

// Exportar para testing
module.exports = app;