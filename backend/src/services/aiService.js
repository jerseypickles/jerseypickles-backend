const openAIService = require('./openAIService'); // GPT-5.2
const claudeService = require('./claudeService');

class AIService {
  constructor() {
    this.provider = process.env.AI_PROVIDER || 'openai'; // openai | claude
  }

  init() {
    if (this.provider === 'claude') {
      claudeService.init();
    } else {
      openAIService.init();
    }

    console.log(`🤖 AI Provider activo: ${this.provider}`);
  }

  isAvailable() {
    return this.provider === 'claude'
      ? claudeService.isAvailable()
      : openAIService.isAvailable();
  }

  get model() {
    return this.provider === 'claude'
      ? claudeService.model
      : openAIService.model;
  }

  async generateEmailInsights(payload) {
    if (this.provider === 'claude') {
      return claudeService.generateEmailInsights(payload);
    }
    return openAIService.generateEmailInsights(payload);
  }
}

module.exports = new AIService();
