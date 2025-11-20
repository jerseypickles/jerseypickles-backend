// backend/src/middleware/rawBody.js
/**
 * Middleware para capturar el raw body ANTES de que express.json() lo parsee
 * Esto es necesario para validar webhooks de Shopify
 */

const rawBodySaver = (req, res, next) => {
  // Solo para rutas de webhooks
  if (!req.path.includes('/webhooks')) {
    return next();
  }

  let data = '';
  
  req.on('data', (chunk) => {
    data += chunk;
  });
  
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
};

module.exports = { rawBodySaver };