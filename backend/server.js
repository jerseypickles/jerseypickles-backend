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

// ✅ AUMENTAR LÍMITE A 10MB PARA SOPORTAR CSV E IMÁGENES
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

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
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      customers: '/api/customers',
      orders: '/api/orders',
      segments: '/api/segments',
      campaigns: '/api/campaigns',
      lists: '/api/lists', // ✅ NUEVO
      webhooks: '/api/webhooks',
      tracking: '/api/track',
      analytics: '/api/analytics'
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
app.use('/api/lists', require('./src/routes/lists')); // ✅ NUEVO
app.use('/api/track', require('./src/routes/tracking'));
app.use('/api/analytics', require('./src/routes/analytics'));
app.use('/api/upload', require('./src/routes/upload'));

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
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🥒 Jersey Pickles Email Marketing   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting...'}`);
  console.log(`✅ Server ready - Payload limit: 10MB`);
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