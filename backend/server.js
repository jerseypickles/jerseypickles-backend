// backend/server.js (v2.6.0 - Second Chance SMS)
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
console.log('📦 Loading models...');

try { require('./src/models/User'); } catch(e) { /* opcional */ }
try { require('./src/models/Customer'); } catch(e) { /* opcional */ }
try { require('./src/models/Order'); } catch(e) { /* opcional */ }
try { require('./src/models/Campaign'); } catch(e) { /* opcional */ }
try { require('./src/models/List'); } catch(e) { /* opcional */ }
try { require('./src/models/Segment'); } catch(e) { /* opcional */ }

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

// 📱 SMS MODELS
try { 
  require('./src/models/SmsSubscriber'); 
  console.log('   ✅ SmsSubscriber model loaded');
} catch(e) { 
  console.log('   ⚠️ SmsSubscriber model:', e.message); 
}

try { 
  require('./src/models/SmsCampaign'); 
  console.log('   ✅ SmsCampaign model loaded');
} catch(e) { 
  console.log('   ⚠️ SmsCampaign model:', e.message); 
}

try {
  require('./src/models/SmsMessage');
  console.log('   ✅ SmsMessage model loaded');
} catch(e) {
  console.log('   ⚠️ SmsMessage model:', e.message);
}

try {
  require('./src/models/SmsTransactional');
  console.log('   ✅ SmsTransactional model loaded');
} catch(e) {
  console.log('   ⚠️ SmsTransactional model:', e.message);
}

try {
  require('./src/models/ShortUrl');
  console.log('   ✅ ShortUrl model loaded');
} catch(e) {
  console.log('   ⚠️ ShortUrl model:', e.message);
}

console.log('📦 Models ready');

// ==================== MIDDLEWARE ====================

// Seguridad y compresión
app.use(helmet());
app.use(compression());

// CORS
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

// ==================== 🔧 SHOPIFY WEBHOOK ROUTES (RAW BODY) ====================
// CRÍTICO: Estas rutas van ANTES de express.json()
// Usan express.raw() para capturar el body como Buffer para HMAC validation

const webhookRoutes = require('./src/routes/webhooks');

// Rutas de Shopify que necesitan raw body
const shopifyWebhookPaths = [
  '/api/webhooks/customers',
  '/api/webhooks/orders', 
  '/api/webhooks/checkouts',
  '/api/webhooks/carts',
  '/api/webhooks/products',
  '/api/webhooks/refunds'
];

// Aplicar express.raw() SOLO a webhooks de Shopify
shopifyWebhookPaths.forEach(path => {
  app.use(path, express.raw({ type: 'application/json', limit: '10mb' }));
});

// 📧 Resend webhooks (JSON body)
app.use('/api/webhooks/resend', express.json({ limit: '10mb' }));

// 📱 Telnyx SMS webhooks (JSON body)
app.use('/api/webhooks/telnyx', express.json({ limit: '10mb' }));

// Montar webhook routes ANTES de express.json()
app.use('/api/webhooks', webhookRoutes);

// ==================== JSON PARSER ====================
// Este va DESPUÉS de las rutas de webhooks de Shopify
// Solo parsea requests que NO son webhooks de Shopify

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// COOKIE PARSER
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
    message: '🥒 Jersey Pickles Email & SMS Marketing API',
    version: '2.6.0',
    status: 'running',
    features: {
      campaigns: '✅ Email Campaigns',
      flows: '✅ Automation Flows',
      segmentation: '✅ Dynamic Segments',
      revenue_tracking: '✅ Revenue Attribution',
      shopify_integration: '✅ Shopify Webhooks',
      ai_analytics: '✅ AI-Powered Insights',
      products: '✅ Product Analytics',
      calendar: '✅ Business Calendar',
      sms_marketing: '✅ SMS Marketing (Telnyx)',
      sms_campaigns: '✅ SMS Campaigns',
      sms_second_chance: '✅ Second Chance SMS (20% Recovery)'
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
      calendar: '/api/calendar',
      sms: '/api/sms',
      sms_campaigns: '/api/sms/campaigns',
      sms_second_chance: '/api/sms/second-chance'
    }
  });
});

// ==================== ROUTES ====================

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/test', require('./src/routes/test'));
// NOTA: webhooks ya están montados arriba ANTES de express.json()
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/orders', require('./src/routes/orders'));
app.use('/api/segments', require('./src/routes/segments'));
app.use('/api/campaigns', require('./src/routes/campaigns'));

// FLOWS ROUTES
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

// AI ANALYTICS ROUTES
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

// IA BUSINESS ROUTES
try {
  const businessRoutes = require('./src/routes/business');
  app.use('/api/ai/business', businessRoutes);
} catch (error) {
  console.log('IA Business routes not available:', error.message);
}

// PRODUCTS ROUTES
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

// BUSINESS CALENDAR ROUTES
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

// 📱 SMS MARKETING ROUTES (Subscribers + Second Chance)
try {
  const smsRoutes = require('./src/routes/sms');
  app.use('/api/sms', smsRoutes);
  console.log('✅ SMS Marketing routes loaded');
} catch (error) {
  console.log('⚠️  SMS routes not available:', error.message);
  app.use('/api/sms', (req, res) => {
    res.status(503).json({ 
      error: 'SMS Marketing feature is currently unavailable',
      message: 'Please check Telnyx configuration'
    });
  });
}

// 📱 SMS CAMPAIGNS ROUTES
try {
  const smsCampaignRoutes = require('./src/routes/smsCampaigns');
  app.use('/api/sms/campaigns', smsCampaignRoutes);
  console.log('✅ SMS Campaigns routes loaded');
} catch (error) {
  console.log('⚠️  SMS Campaigns routes not available:', error.message);
  app.use('/api/sms/campaigns', (req, res) => {
    res.status(503).json({
      error: 'SMS Campaigns feature is currently unavailable',
      message: 'Please check configuration'
    });
  });
}

// 📦 BUILD YOUR BOX ANALYTICS (DEMANDA) ROUTES
try {
  const bybRoutes = require('./src/routes/byb');
  app.use('/api/byb', bybRoutes);
  console.log('✅ Build Your Box Analytics routes loaded');
} catch (error) {
  console.log('⚠️  BYB routes not available:', error.message);
  app.use('/api/byb', (req, res) => {
    res.status(503).json({
      error: 'Build Your Box Analytics feature is currently unavailable',
      message: 'Please check configuration'
    });
  });
}

app.use('/api/lists', require('./src/routes/lists'));
app.use('/api/track', require('./src/routes/tracking'));
app.use('/api/analytics', require('./src/routes/analytics'));
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api/popup', require('./src/routes/popup'));

// 🔗 SHORT URL ROUTES (for SMS link tracking)
try {
  const shortUrlRoutes = require('./src/routes/shortUrl');
  app.use('/s', shortUrlRoutes);
  console.log('✅ Short URL routes loaded (/s/:code)');
} catch (error) {
  console.log('⚠️  Short URL routes not available:', error.message);
}

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

let flowEngineAvailable = false;
let aiAnalyticsAvailable = false;
let productsAvailable = false;
let calendarAvailable = false;
let smsServiceAvailable = false;
let smsCampaignsAvailable = false;
let secondChanceSmsAvailable = false; // 🆕

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   🥒 Jersey Pickles Marketing Platform v2.6.0 ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting...'}`);
  console.log(`🍪 Cookie Parser: Enabled`);
  console.log(`🔒 Webhook Validation: ${process.env.SHOPIFY_WEBHOOK_SECRET ? '✅ Enabled' : '⚠️  Disabled'}`);
  console.log(`📧 Email Queue: ${process.env.REDIS_URL ? '✅ Redis Connected' : '⚠️  Direct Send Mode'}`);
  console.log(`📱 SMS Provider: ${process.env.TELNYX_API_KEY ? '✅ Telnyx Configured' : '⚠️  Not Configured'}`);
  console.log(`✅ Server ready - Payload limit: 10MB`);
  console.log(`🔧 Shopify webhooks: express.raw() enabled`);
  console.log(`🔧 Telnyx webhooks: express.json() enabled`);
  
  // Inicializar Flow Queue
  setTimeout(() => {
    console.log('\n🔄 Inicializando Flow Engine...');
    try {
      const flowQueue = require('./src/jobs/flowQueue');
      flowEngineAvailable = true;
      console.log('✅ Flow Engine listo para automatizaciones');
    } catch (error) {
      flowEngineAvailable = false;
      console.log('⚠️  Flow Engine no disponible:', error.message);
    }
  }, 2000);
  
  // Inicializar AI Analytics Job
  setTimeout(() => {
    console.log('\n🧠 Inicializando AI Analytics Engine...');
    try {
      const aiAnalyticsJob = require('./src/jobs/aiAnalyticsJob');
      aiAnalyticsJob.init('0 */6 * * *');
      aiAnalyticsAvailable = true;
      console.log('✅ AI Analytics Engine listo');
    } catch (error) {
      aiAnalyticsAvailable = false;
      console.log('⚠️  AI Analytics no disponible:', error.message);
    }
  }, 3000);
  
  // Inicializar Product Service
  setTimeout(() => {
    console.log('\n📦 Inicializando Product Service...');
    try {
      const productService = require('./src/services/productService');
      productsAvailable = true;
      console.log('✅ Product Service listo');
    } catch (error) {
      productsAvailable = false;
      console.log('⚠️  Product Service no disponible:', error.message);
    }
  }, 3500);
  
  // Inicializar Business Calendar Service
  setTimeout(() => {
    console.log('\n📅 Inicializando Business Calendar Service...');
    try {
      const businessCalendarService = require('./src/services/businessCalendarService');
      calendarAvailable = true;
      console.log('✅ Business Calendar Service listo');
      businessCalendarService.initializeCommonEvents().catch(err => {
        console.log('   ⚠️ Error inicializando eventos:', err.message);
      });
    } catch (error) {
      calendarAvailable = false;
      console.log('⚠️  Business Calendar Service no disponible:', error.message);
    }
  }, 4000);
  
  // 📱 Inicializar SMS Marketing Service
  setTimeout(() => {
    console.log('\n📱 Inicializando SMS Marketing Service (Telnyx)...');
    try {
      const telnyxService = require('./src/services/telnyxService');
      
      // Verificar configuración
      if (!process.env.TELNYX_API_KEY) {
        console.log('⚠️  SMS Service: TELNYX_API_KEY no configurado');
        smsServiceAvailable = false;
        return;
      }
      
      // Health check async
      telnyxService.healthCheck().then(health => {
        if (health.healthy) {
          smsServiceAvailable = true;
          console.log('✅ SMS Marketing Service listo');
          console.log(`   📞 From Number: ${process.env.TELNYX_FROM_NUMBER || 'Not set'}`);
          console.log(`   🔗 Webhook URL: ${process.env.TELNYX_WEBHOOK_URL || 'Not set'}`);
        } else {
          smsServiceAvailable = false;
          console.log('⚠️  SMS Service unhealthy:', health.error);
        }
      }).catch(err => {
        smsServiceAvailable = false;
        console.log('⚠️  SMS Service error:', err.message);
      });
      
    } catch (error) {
      smsServiceAvailable = false;
      console.log('⚠️  SMS Marketing Service no disponible:', error.message);
    }
  }, 4500);
  
  // 📱 Verificar SMS Campaigns
  setTimeout(() => {
    console.log('\n📱 Verificando SMS Campaigns...');
    try {
      require('./src/models/SmsCampaign');
      require('./src/models/SmsMessage');
      smsCampaignsAvailable = true;
      console.log('✅ SMS Campaigns disponible');
    } catch (error) {
      smsCampaignsAvailable = false;
      console.log('⚠️  SMS Campaigns no disponible:', error.message);
    }
  }, 5000);
  
  // 🆕 📱 Inicializar Second Chance SMS Job
  setTimeout(() => {
    console.log('\n📱 Inicializando Second Chance SMS Job...');
    try {
      const secondChanceSmsJob = require('./src/jobs/secondChanceSmsJob');
      
      // Initialize cron job - runs every 5 minutes, processes ALL pending
      // Only sends SMS between 9am-9pm Eastern Time
      secondChanceSmsJob.init('*/5 * * * *');

      secondChanceSmsAvailable = true;
      console.log('✅ Second Chance SMS Job listo');
      console.log('   ⏰ Schedule: Every 5 minutes');
      console.log('   🕐 Sending hours: 9am - 9pm (Eastern)');
      console.log('   ⏳ Delay: 6+ hours after first SMS');
      console.log('   🎟️ Discount: 20% OFF (expires in 2 hours)');
      console.log('   📝 Code format: JP2-XXXXX');
      console.log('   🔄 Processes ALL pending (max 500 per run)');
    } catch (error) {
      secondChanceSmsAvailable = false;
      console.log('⚠️  Second Chance SMS Job no disponible:', error.message);
    }
  }, 5500);

  // Inicializar Delayed Shipment SMS Job
  let delayedShipmentAvailable = false;
  setTimeout(() => {
    console.log('\n📦 Inicializando Delayed Shipment SMS Job...');
    try {
      const delayedShipmentJob = require('./src/jobs/delayedShipmentJob');

      // Initialize cron job - runs every 6 hours
      // Only sends SMS between 9am-9pm Eastern Time
      delayedShipmentJob.init('0 */6 * * *');

      delayedShipmentAvailable = true;
      console.log('✅ Delayed Shipment SMS Job listo');
      console.log('   ⏰ Schedule: Every 6 hours');
      console.log('   🕐 Sending hours: 9am - 9pm (Eastern)');
      console.log('   ⏳ Threshold: 72+ hours unfulfilled');
    } catch (error) {
      delayedShipmentAvailable = false;
      console.log('⚠️  Delayed Shipment SMS Job no disponible:', error.message);
    }
  }, 6000);

  // Resumen de features
  setTimeout(() => {
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║              FEATURES STATUS                   ║');
    console.log('╠════════════════════════════════════════════════╣');
    console.log(`║  Flow Engine:        ${flowEngineAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  AI Analytics:       ${aiAnalyticsAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  Product Analytics:  ${productsAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  Business Calendar:  ${calendarAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  SMS Marketing:      ${smsServiceAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  SMS Campaigns:      ${smsCampaignsAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  Second Chance SMS:  ${secondChanceSmsAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log(`║  Delayed Shipment:   ${delayedShipmentAvailable ? '✅ Active' : '❌ Inactive'}              ║`);
    console.log('╚════════════════════════════════════════════════╝');
  }, 7000);
});

// ==================== GRACEFUL SHUTDOWN ====================

const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  server.close(async () => {
    console.log('✅ HTTP server closed');
    
    try {
      await closeQueue();
      console.log('✅ Email queue closed');
    } catch (err) {
      console.error('⚠️  Error closing email queue:', err.message);
    }
    
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
    
    // 🆕 Stop Second Chance SMS Job
    if (secondChanceSmsAvailable) {
      try {
        const secondChanceSmsJob = require('./src/jobs/secondChanceSmsJob');
        if (secondChanceSmsJob && typeof secondChanceSmsJob.stop === 'function') {
          secondChanceSmsJob.stop();
          console.log('✅ Second Chance SMS job stopped');
        }
      } catch (err) {
        console.log('⚠️  Second Chance SMS job not stopped:', err.message);
      }
    }
    
    try {
      await mongoose.connection.close();
      console.log('✅ MongoDB connection closed');
    } catch (err) {
      console.error('⚠️  Error closing MongoDB:', err.message);
    }
    
    console.log('👋 Graceful shutdown completed');
    process.exit(0);
  });
  
  setTimeout(() => {
    console.error('⚠️  Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Promise Rejection:', err);
  console.error('Stack:', err.stack);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  console.error('Stack:', err.stack);
  
  if (err.code !== 'MODULE_NOT_FOUND') {
    gracefulShutdown('uncaughtException');
  } else {
    console.log('⚠️  Continuando a pesar del módulo faltante...');
  }
});

module.exports = app;