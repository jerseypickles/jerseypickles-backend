// backend/src/routes/webhooks.js
const express = require('express');
const router = express.Router();
const webhooksController = require('../controllers/webhooksController');
const { validateShopifyWebhook } = require('../middleware/validateWebhook');
const { webhookLimiter } = require('../middleware/rateLimiter');

// Aplicar rate limiter a todos los webhooks
router.use(webhookLimiter);

// Aplicar validación de Shopify a todos los webhooks
router.use(validateShopifyWebhook);

// Webhooks de clientes
router.post('/customers/create', webhooksController.customerCreate);
router.post('/customers/update', webhooksController.customerUpdate);

// Webhooks de órdenes
router.post('/orders/create', webhooksController.orderCreate);
router.post('/orders/update', webhooksController.orderUpdate);

module.exports = router;