// backend/server.js (ACTUALIZADO CON FLOWS & TRIGGERS)
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

// ✅ express.raw() SOLO para webhooks de Shopify (necesitan Buffer para HMAC)
app.use('/api/webhooks/customers', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

app.use('/api/webhooks/orders', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

// 🆕 NUEVOS WEBHOOKS PARA FLOWS
app.use('/api/webhooks/carts', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

app.use('/api/webhooks/products', express.raw({ 
  type: 'application/json',
  limit: '10mb'
}));

// express.json() para todas las demás rutas (incluyendo /api/webhooks/resend)
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
    version: '2.0.0', // 🆕 Actualizado a 2.0 con Flows
    status: 'running',
    features: { // 🆕 Features agregadas
      campaigns: '✅ Email Campaigns',
      flows: '✅ Automation Flows',
      segmentation: '✅ Dynamic Segments',
      revenue_tracking: '✅ Revenue Attribution',
      shopify_integration: '✅ Shopify Webhooks'
    },
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      customers: '/api/customers',
      orders: '/api/orders',
      segments: '/api/segments',
      campaigns: '/api/campaigns',
      flows: '/api/flows', // 🆕 NUEVO ENDPOINT
      lists: '/api/lists',
      webhooks: '/api/webhooks',
      tracking: '/api/track',
      analytics: '/api/analytics',
      popup: '/api/popup'
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
app.use('/api/flows', require('./src/routes/flows')); // 🆕 FLOWS ROUTES
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   🥒 Jersey Pickles Email Marketing v2.0      ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting...'}`);
  console.log(`🍪 Cookie Parser: Enabled`);
  console.log(`🔒 Webhook Validation: ${process.env.SHOPIFY_WEBHOOK_SECRET ? 'Enabled' : '⚠️  Disabled'}`);
  console.log(`📧 Email Queue: ${process.env.REDIS_URL ? '✅ Redis Connected' : '⚠️  Direct Send Mode'}`);
  console.log(`🔄 Flow Engine: ✅ Active`); // 🆕
  console.log(`✅ Server ready - Payload limit: 10MB`);
  
  // 🆕 Inicializar Flow Queue
  console.log('\n🔄 Inicializando Flow Engine...');
  require('./src/jobs/flowQueue');
  console.log('✅ Flow Engine listo para automatizaciones');
});

// ==================== GRACEFUL SHUTDOWN ====================

const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  server.close(async () => {
    console.log('✅ HTTP server closed');
    
    // ✅ CERRAR EMAIL QUEUE
    try {
      await closeQueue();
      console.log('✅ Email queue closed');
    } catch (err) {
      console.error('❌ Error closing email queue:', err);
    }
    
    // 🆕 CERRAR FLOW QUEUE
    try {
      const { flowQueue } = require('./src/jobs/flowQueue');
      if (flowQueue) {
        await flowQueue.close();
        console.log('✅ Flow queue closed');
      }
    } catch (err) {
      console.error('❌ Error closing flow queue:', err);
    }
    
    // Cerrar MongoDB
    try {
      await mongoose.connection.close();
      console.log('✅ MongoDB connection closed');
    } catch (err) {
      console.error('❌ Error closing MongoDB:', err);
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

// ✅ SIGNALS para shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ✅ UNHANDLED REJECTION - NO HACER SHUTDOWN en producción
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Promise Rejection:', err);
  console.error('Stack:', err.stack);
  
  // ✅ NO cerrar servidor - solo loggear el error
  // El servidor debe seguir corriendo a pesar del error
});

// ✅ UNCAUGHT EXCEPTION - Este sí es crítico
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  console.error('Stack:', err.stack);
  
  // ✅ Este sí debería cerrar el servidor porque es más grave
  gracefulShutdown('uncaughtException');
});

module.exports = app;