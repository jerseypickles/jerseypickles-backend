// 🧠 AI Analytics Cron Job - Calcula insights y genera análisis con AI Router
const cron = require('node-cron');
const AIInsight = require('../models/AIInsight');
const aiCalculator = require('../services/aiCalculator');
const aiService = require('../services/aiService');

class AIAnalyticsJob {
  constructor() {
    this.isRunning = false;
    this.lastRun = null;
    this.schedule = null;
    this.aiEnabled = false;
  }

  init(cronExpression = '0 */6 * * *') {
    console.log('🧠 AI Analytics Job inicializado');
    console.log(`   Schedule: ${cronExpression}`);

    aiService.init();
    this.aiEnabled = aiService.isAvailable();

    console.log(`   🤖 AI Engine: ${this.aiEnabled ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`   🤖 Provider: ${process.env.AI_PROVIDER || 'openai'}`);
    console.log(`   🤖 Model: ${aiService.model}`);

    this.schedule = cron.schedule(cronExpression, () => {
      this.runAllAnalyses();
    });

    setTimeout(() => {
      this.checkAndRunIfNeeded();
    }, 30000);

    console.log('✅ AI Analytics Job listo');
  }

  async checkAndRunIfNeeded() {
    try {
      const dueAnalyses = await AIInsight.getDueForRecalculation();

      if (dueAnalyses.length > 0) {
        console.log(`\n🔄 ${dueAnalyses.length} análisis pendientes, ejecutando...`);
        await this.runAllAnalyses();
        return;
      }

      const summary = await AIInsight.getDashboardSummary();
      const hasData = Object.values(summary.analyses).some(a => a !== null);

      if (!hasData) {
        console.log('\n🧠 No hay análisis guardados, ejecutando cálculo inicial...');
        await this.runAllAnalyses();
      } else {
        console.log('✅ Análisis de IA al día');
      }
    } catch (error) {
      console.error('❌ Error verificando análisis:', error.message);
    }
  }

  async runAllAnalyses() {
    if (this.isRunning) {
      console.log('⚠️  AI Analytics ya está ejecutándose, saltando...');
      return;
    }

    this.isRunning = true;
    this.lastRun = new Date();

    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║  🧠 AI ANALYTICS - CALCULANDO INSIGHTS          ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`   Inicio: ${this.lastRun.toISOString()}`);
    console.log(`   AI Enabled: ${this.aiEnabled ? '✅' : '❌'}\n`);

    const startTime = Date.now();
    const results = { success: [], failed: [] };

    const analysisResults = {
      healthCheck: null,
      subjectAnalysis: null,
      sendTiming: null,
      listPerformance: null
    };

    try {
      // ===== FASE 1: MÉTRICAS =====
      analysisResults.healthCheck = await this.runAnalysis(
        'health_check',
        7,
        () => aiCalculator.calculateHealthCheck(),
        results
      );

      analysisResults.subjectAnalysis = await this.runAnalysis(
        'subject_analysis',
        15,
        () => aiCalculator.calculateSubjectAnalysis({ days: 15 }),
        results
      );

      analysisResults.sendTiming = await this.runAnalysis(
        'send_timing',
        15,
        () => aiCalculator.calculateSendTiming({ days: 15 }),
        results
      );

      analysisResults.listPerformance = await this.runAnalysis(
        'list_performance',
        15,
        () => aiCalculator.calculateListPerformance({ days: 15 }),
        results
      );

      // ===== FASE 2: INSIGHTS AI =====
      await this.generateAIInsights(analysisResults, results);

      // ===== FASE 3: REPORT =====
      await this.runAnalysis(
        'comprehensive_report',
        15,
        async () => {
          const report = await aiCalculator.calculateComprehensiveReport({ days: 15 });
          const aiInsight = await AIInsight.getLatest('ai_generated_insights', 30);

          if (aiInsight?.data) {
            report.aiInsights = aiInsight.data.deepAnalysis;
            report.aiSummary = aiInsight.data.executiveSummary;
            report.aiRecommendations = aiInsight.data.actionPlan;
          }

          return report;
        },
        results
      );

      await AIInsight.cleanup(90);

    } catch (error) {
      console.error('❌ Error crítico en AI Analytics Job:', error);
    } finally {
      this.isRunning = false;
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log('\n╔════════════════════════════════════════════════╗');
      console.log('║  ✅ AI ANALYTICS - COMPLETADO                   ║');
      console.log('╚════════════════════════════════════════════════╝');
      console.log(`   Duración: ${duration}s`);
      console.log(`   Exitosos: ${results.success.length}`);
      console.log(`   Fallidos: ${results.failed.length}`);
      console.log('════════════════════════════════════════════════\n');
    }
  }

  // 🔥 YA NO ES CLAUDE, ES AI
  async generateAIInsights(analysisResults, results) {
    console.log('\n   🤖 Generando insights con AI Engine...');

    try {
      if (!analysisResults.healthCheck &&
          !analysisResults.subjectAnalysis &&
          !analysisResults.listPerformance) {
        console.log('      ⚠️  No hay datos suficientes');
        results.failed.push('ai_generated_insights (no data)');
        return;
      }

      const payload = aiCalculator.prepareDataForClaude(analysisResults); // nombre legacy OK
      const size = JSON.stringify(payload).length;

      console.log(`      📦 Payload: ${size} bytes`);
      console.log(`      🔄 Calling AI provider...`);

      const start = Date.now();
      const aiResponse = await aiService.generateEmailInsights(payload);
      const duration = ((Date.now() - start) / 1000).toFixed(2);

      console.log(`      ⏱️  AI respondió en ${duration}s`);

      await AIInsight.saveAnalysis(
        'ai_generated_insights',
        30,
        {
          success: aiResponse.success !== false,
          ...aiResponse,
          provider: process.env.AI_PROVIDER || 'openai',
          model: aiService.model,
          inputDataSize: size
        },
        { recalculateHours: aiResponse.success === false ? 1 : 6 }
      );

      results.success.push(`ai_generated_insights (${process.env.AI_PROVIDER || 'openai'})`);

    } catch (error) {
      console.error(`      ❌ Error AI Engine: ${error.message}`);
      results.failed.push('ai_generated_insights');
    }
  }

  async runAnalysis(type, periodDays, calculator, results) {
    try {
      const data = await calculator();
      await AIInsight.saveAnalysis(type, periodDays, data);
      results.success.push(`${type} (${periodDays}d)`);
      return data;
    } catch (error) {
      results.failed.push(type);
      console.error(`❌ ${type}: ${error.message}`);
      return null;
    }
  }

  stop() {
    if (this.schedule) {
      this.schedule.stop();
      console.log('🛑 AI Analytics Job detenido');
    }
  }
}

module.exports = new AIAnalyticsJob();
