// backend/src/services/aiService.js
// Router para elegir proveedor AI sin cambiar tu app

const claudeService = require("./claudeService");
const gpt52Service = require("./gpt52Service");

const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();

// Inicializa ambos (si no tienen keys, se auto-desactivan)
claudeService.init?.();
gpt52Service.init?.();

module.exports = provider === "claude" ? claudeService : gpt52Service;
