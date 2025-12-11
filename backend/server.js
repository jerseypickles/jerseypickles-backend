// backend/server.js (ACTUALIZADO CON PRODUCTS, CALENDAR, FLOWS, AI ANALYTICS)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const connectDB = require('./src/config/database');
const errorHandler = require('./src/middleware/errorHandler');
const { apiLimiter } = require('./src/middleware/rateLimiter');
const { closeQueue } = require('./src/jobs/emailQueue');

const app = express();

app.set('trust proxy', 1);

// Conectar a MongoDB
connectDB();

// ==================== CARGAR MODELOS ====================
// ⚠️ IMPORTANTE: Los modelos deben cargarse ANTES de las rutas
// para que mongoose.model() funcione en los servicios
console.log('📦 Loading models...');

// Modelos base
try { require('./src/models/User'); } catch(e) { /* opcional */ }
try { require('./src/models/Customer'); } catch(e) { /* opcional */ }
try { require('./src/models/Order'); } catch(e) { /* opcional */ }
try { require('./src/models/Campaign'); } catch(e) { /* opcional */ }
try { require('./src/models/List'); } catch(e) { /* opcional */ }
try { require('./src/models/Segment'); } catch(e) { /* opcional */ }

// 🆕 Modelos nuevos para Products y Calendar
try { 
  require('./src/models/Product'); 
  console.log('   ✅ Product model loaded');
} catch(e) { 
  console.log('   ⚠️ Product model:', e.message); 
}

try { 
  require('./src/models/BusinessCalendar'); 
  console.log('   ✅ BusinessCalendar model loaded');
} catch(e) { 
  console.log('   ⚠️ BusinessCalendar model:', e.message); 
}

console.log('📦 Models ready');

// ==================== MIDDLEWARE ====================

// Seguridad y compresión
app.use(helmet());
app.use(compression());

// CORS MEJORADA
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:5174',
      'https://jerseypickles.com',
      'https://www.jerseypickles.com'
    ];
    
    const vercelPatterns = [
      /^https:\/\/jerseypickles-frontend.*\.vercel\.app$/,
      /^https:\/\/.*-jerseypickles-projects\.vercel\.app$/
    ];
    
    const isAllowedOrigin = allowedOrigins.includes(origin);
    const isVercelDomain = vercelPatterns.some(pattern => pattern.test(origin));
    
    if (isAllowedOrigin || isVercelDomain) {
      callback(null, true);
    } else {
      console.log(`❌ CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600
};

app.use(cors(corsOptions));

// express.raw() SOLO para webhooks de Shopify (necesitan Buffer para HMAC)
app.use('/api/webhooks/customers', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

app.use('/api/webhooks/orders', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

// WEBHOOKS PARA FLOWS
app.use('/api/webhooks/checkouts', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

app.use('/api/webhooks/products', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

app.use('/api/webhooks/refunds', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

// express.json() para todas las demás rutas
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// COOKIE PARSER (para attribution tracking)
app.use(cookieParser());

// Rate limiting para rutas API (excepto webhooks)
app.use('/api/', (req, res, next) => {
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

app.get('/', (req, res) => {
  res.json({ 
    message: '🥒 Jersey Pickles Email Marketing API',
    version: '2.2.0',
    status: 'running',
    features: {
      campaigns: '✅ Email Campaigns',
      flows: '✅ Automation Flows',
      segmentation: '✅ Dynamic Segments',
      revenue_tracking: '✅ Revenue Attribution',
      shopify_integration: '✅ Shopify Webhooks',
      ai_analytics: '✅ AI-Powered Insights',
      products: '✅ Product Analytics',
      calendar: '✅ Business Calendar'
    },
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      customers: '/api/customers',
      orders: '/api/orders',
      segments: '/api/segments',
      campaigns: '/api/campaigns',
      flows: '/api/flows',
      lists: '/api/lists',
      webhooks: '/api/webhooks',
      tracking: '/api/track',
      analytics: '/api/analytics',
      popup: '/api/popup',
      ai: '/api/ai',
      products: '/api/products',
      calendar: '/api/calendar'
    }
  });
});

// ==================== ROUTES ====================

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/test', require('./src/routes/test'));
app.use('/api/webhooks', require('./src/routes/webhooks'));
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/orders', require('./src/routes/orders'));
app.use('/api/segments', require('./src/routes/segments'));
app.use('/api/campaigns', require('./src/routes/campaigns'));

// FLOWS ROUTES - con manejo de errores
try {
  const flowsRoutes = require('./src/routes/flows');
  app.use('/api/flows', flowsRoutes);
} catch (error) {
  console.log('⚠️  Flows routes not available:', error.message);
  app.use('/api/flows', (req, res) => {
    res.status(503).json({ 
      error: 'Flows feature is currently unavailable',
      message: 'Please check system configuration'
    });
  });
}

// AI ANALYTICS ROUTES - con manejo de errores
try {
  const aiRoutes = require('./src/routes/ai');
  app.use('/api/ai', aiRoutes);
} catch (error) {
  console.log('⚠️  AI Analytics routes not available:', error.message);
  app.use('/api/ai', (req, res) => {
    res.status(503).json({ 
      error: 'AI Analytics feature is currently unavailable',
      message: 'Please check system configuration'
    });
  });
}

// 🆕 PRODUCTS ROUTES - con manejo de errores
try {
  const productsRoutes = require('./src/routes/products');
  app.use('/api/products', productsRoutes);
  console.log('✅ Products routes loaded');
} catch (error) {
  console.log('⚠️  Products routes not available:', error.message);
  app.use('/api/products', (req, res) => {
    res.status(503).json({ 
      error: 'Products feature is currently unavailable',
      message: 'Please check system configuration'
    });
  });
}

// 🆕 BUSINESS CALENDAR ROUTES - con manejo de errores
try {
  const calendarRoutes = require('./src/routes/calendar');
  app.use('/api/calendar', calendarRoutes);
  console.log('✅ Calendar routes loaded');
} catch (error) {
  console.log('⚠️  Calendar routes not available:', error.message);
  app.use('/api/calendar', (req, res) => {
    res.status(503).json({ 
      error: 'Calendar feature is currently unavailable',
      message: 'Please check system configuration'
    });
  });
}

app.use('/api/lists', require('./src/routes/lists'));
app.use('/api/track', require('./src/routes/tracking'));
app.use('/api/analytics', require('./src/routes/analytics'));
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api/popup', require('./src/routes/popup'));

app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Ruta no encontrada',
    path: req.originalUrl
  });
});

// ==================== ERROR HANDLER ====================
app.use(errorHandler);

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;

// Variables para tracking de features disponibles
let flowEngineAvailable = false;
let aiAnalyticsAvailable = false;
let productsAvailable = false;
let calendarAvailable = false;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   🥒 Jersey Pickles Email Marketing v2.2      ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting...'}`);
  console.log(`🍪 Cookie Parser: Enabled`);
  console.log(`🔒 Webhook Validation: ${process.env.SHOPIFY_WEBHOOK_SECRET ? 'Enabled' : '⚠️  Disabled'}`);
  console.log(`📧 Email Queue: ${process.env.REDIS_URL ? '✅ Redis Connected' : '⚠️  Direct Send Mode'}`);
  console.log(`✅ Server ready - Payload limit: 10MB`);
  
  // Inicializar Flow Queue con manejo de errores mejorado
  setTimeout(() => {
    console.log('\n🔄 Inicializando Flow Engine...');
    try {
      const flowQueue = require('./src/jobs/flowQueue');
      flowEngineAvailable = true;
      console.log('✅ Flow Engine listo para automatizaciones');
    } catch (error) {
      flowEngineAvailable = false;
      console.log('⚠️  Flow Engine no disponible:', error.message);
      console.log('   El sistema continuará funcionando sin automatizaciones');
    }
  }, 2000);
  
  // Inicializar AI Analytics Job
  setTimeout(() => {
    console.log('\n🧠 Inicializando AI Analytics Engine...');
    try {
      const aiAnalyticsJob = require('./src/jobs/aiAnalyticsJob');
      
      // Inicializar con cron cada 6 horas
      aiAnalyticsJob.init('0 */6 * * *');
      
      aiAnalyticsAvailable = true;
      console.log('✅ AI Analytics Engine listo');
      console.log('   Schedule: Cada 6 horas (0 */6 * * *)');
      console.log('   Primer análisis: En 30 segundos');
    } catch (error) {
      aiAnalyticsAvailable = false;
      console.log('⚠️  AI Analytics no disponible:', error.message);
      console.log('   El sistema continuará funcionando sin AI insights');
      console.log('   Para habilitar, instale: npm install node-cron');
    }
  }, 3000);
  
  // 🆕 Inicializar Product Service
  setTimeout(() => {
    console.log('\n📦 Inicializando Product Service...');
    try {
      const productService = require('./src/services/productService');
      productsAvailable = true;
      console.log('✅ Product Service listo');
      console.log('   Sync manual: POST /api/products/sync');
      console.log('   Webhooks: products/create, products/update, products/delete');
    } catch (error) {
      productsAvailable = false;
      console.log('⚠️  Product Service no disponible:', error.message);
    }
  }, 3500);
  
  // 🆕 Inicializar Business Calendar Service
  setTimeout(() => {
    console.log('\n📅 Inicializando Business Calendar Service...');
    try {
      const businessCalendarService = require('./src/services/businessCalendarService');
      calendarAvailable = true;
      console.log('✅ Business Calendar Service listo');
      console.log('   Goals: POST /api/calendar/goals/monthly');
      console.log('   Events: POST /api/calendar/events/initialize');
      
      // Inicializar eventos del año actual si no existen
      businessCalendarService.initializeCommonEvents().catch(err => {
        console.log('   ⚠️ Error inicializando eventos:', err.message);
      });
    } catch (error) {
      calendarAvailable = false;
      console.log('⚠️  Business Calendar Service no disponible:', error.message);
    }
  }, 4000);
  
  // 🆕 Resumen de features después de inicialización
  setTimeout(() => {
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║              FEATURES STATUS                   ║');
    console.log('╠════════════════════════════════════════════════╣');
    console.log(`║  Flow Engine:        ${flowEngineAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  AI Analytics:       ${aiAnalyticsAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  Product Analytics:  ${productsAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  Business Calendar:  ${calendarAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log('╚════════════════════════════════════════════════╝');
  }, 5000);
});

// ==================== GRACEFUL SHUTDOWN ====================

const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  server.close(async () => {
    console.log('✅ HTTP server closed');
    
    // CERRAR EMAIL QUEUE
    try {
      await closeQueue();
      console.log('✅ Email queue closed');
    } catch (err) {
      console.error('⚠️  Error closing email queue:', err.message);
    }
    
    // CERRAR FLOW QUEUE
    if (flowEngineAvailable) {
      try {
        const flowQueueModule = require('./src/jobs/flowQueue');
        if (flowQueueModule && typeof flowQueueModule.close === 'function') {
          await flowQueueModule.close();
          console.log('✅ Flow queue closed');
        }
      } catch (err) {
        console.log('⚠️  Flow queue not closed:', err.message);
      }
    }
    
    // CERRAR AI ANALYTICS JOB
    if (aiAnalyticsAvailable) {
      try {
        const aiAnalyticsJob = require('./src/jobs/aiAnalyticsJob');
        if (aiAnalyticsJob && typeof aiAnalyticsJob.stop === 'function') {
          aiAnalyticsJob.stop();
          console.log('✅ AI Analytics job stopped');
        }
      } catch (err) {
        console.log('⚠️  AI Analytics job not stopped:', err.message);
      }
    }
    
    // Cerrar MongoDB
    try {
      await mongoose.connection.close();
      console.log('✅ MongoDB connection closed');
    } catch (err) {
      console.error('⚠️  Error closing MongoDB:', err.message);
    }
    
    console.log('👋 Graceful shutdown completed');
    process.exit(0);
  });
  
  // Timeout de 10 segundos
  setTimeout(() => {
    console.error('⚠️  Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

// SIGNALS para shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// UNHANDLED REJECTION - NO HACER SHUTDOWN en producción
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Promise Rejection:', err);
  console.error('Stack:', err.stack);
  // NO cerrar servidor - solo loggear el error
});

// UNCAUGHT EXCEPTION - Este sí es crítico
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  console.error('Stack:', err.stack);
  
  // Solo cerrar si NO es un error de módulo faltante
  if (err.code !== 'MODULE_NOT_FOUND') {
    gracefulShutdown('uncaughtException');
  } else {
    console.log('⚠️  Continuando a pesar del módulo faltante...');
  }
});

module.exports = app;