// backend/src/jobs/smsInsightsJob.js
// 🧠 SMS Insights Daily Job - Genera insights diarios con Claude AI

const cron = require('node-cron');
const smsAnalyticsService = require('../services/smsAnalyticsService');

// Cargar claudeService de forma segura
let claudeService = null;
try {
  claudeService = require('../services/claudeService');
} catch (e) {
  console.log('⚠️  SMS Insights Job: Claude service not available');
}

class SmsInsightsJob {
  constructor() {
    this.isRunning = false;
    this.lastRun = null;
    this.lastResult = null;
    this.schedule = null;
    this.initialized = false;
  }

  /**
   * Inicializar el job
   * Por defecto: 6:00 AM y 6:00 PM diariamente (2 veces al día)
   */
  init(cronExpression = '0 6,18 * * *') {
    console.log('🧠 SMS Insights Job inicializado');
    console.log(`   Schedule: ${cronExpression} (6 AM y 6 PM)`);

    // Inicializar Claude si está disponible
    if (claudeService) {
      claudeService.init();
      console.log(`   Claude API: ${claudeService.isAvailable() ? '✅ Habilitado' : '⚠️ No configurado'}`);
    }

    // Programar ejecución
    this.schedule = cron.schedule(cronExpression, async () => {
      console.log('\n🧠 [CRON] Ejecutando SMS Insights Job...');
      await this.generateInsights();
    });

    this.initialized = true;

    // Primera ejecución después de 2 minutos si no hay insights
    setTimeout(async () => {
      const cached = smsAnalyticsService.getLastAiInsights();
      if (!cached.insights || cached.isStale) {
        console.log('\n🧠 [STARTUP] Generando insights iniciales de SMS...');
        await this.generateInsights();
      } else {
        console.log('✅ SMS Insights ya disponibles, próxima ejecución programada');
      }
    }, 120000);

    console.log('✅ SMS Insights Job listo');
  }

  /**
   * Generar insights usando Claude AI
   */
  async generateInsights() {
    if (this.isRunning) {
      console.log('⚠️  SMS Insights Job ya está ejecutándose, saltando...');
      return { success: false, reason: 'already_running' };
    }

    this.isRunning = true;
    this.lastRun = new Date();

    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║  🧠 SMS INSIGHTS - GENERANDO CON CLAUDE AI      ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`   Inicio: ${this.lastRun.toISOString()}`);

    const startTime = Date.now();
    let result = { success: false };

    try {
      // 1. Preparar datos para Claude
      console.log('   📊 Preparando datos de SMS...');
      const data = await smsAnalyticsService.prepareAiInsightsData();
      console.log(`      - Total suscriptores: ${data.health?.totalSubscribers || 0}`);
      console.log(`      - Conversion rate: ${data.health?.conversionRate || 0}%`);
      console.log(`      - Estados con datos: ${data.geographic?.totalStates || 0}`);

      // 2. Verificar Claude
      if (!claudeService || !claudeService.isAvailable()) {
        console.log('   ⚠️  Claude API no disponible, usando fallback...');

        // Usar fallback del claudeService
        const fallbackInsights = claudeService?.getSmsFallbackInsights(data) || {
          success: true,
          executiveSummary: 'Claude AI no disponible. Análisis básico generado automáticamente.',
          isFallback: true
        };

        smsAnalyticsService.saveAiInsights(fallbackInsights);
        result = { success: true, isFallback: true };
      } else {
        // 3. Generar insights con Claude
        console.log('   🧠 Llamando a Claude API...');
        const insights = await claudeService.generateSmsInsights(data);

        if (insights.success) {
          // Guardar insights
          smsAnalyticsService.saveAiInsights(insights);
          result = {
            success: true,
            tokensUsed: insights.tokensUsed,
            hasActionPlan: insights.actionPlan?.length > 0,
            hasWarnings: insights.warnings?.length > 0
          };

          console.log(`   ✅ Insights generados exitosamente`);
          console.log(`      - Tokens: ${insights.tokensUsed?.input || 0} in / ${insights.tokensUsed?.output || 0} out`);
          console.log(`      - Action plan: ${insights.actionPlan?.length || 0} items`);
          console.log(`      - Warnings: ${insights.warnings?.length || 0}`);

          if (insights.executiveSummary) {
            console.log(`      - Summary: ${insights.executiveSummary.substring(0, 100)}...`);
          }
        } else {
          console.log('   ⚠️  Error generando insights, usando fallback...');
          smsAnalyticsService.saveAiInsights(insights); // Fallback tiene misma estructura
          result = { success: true, isFallback: true };
        }
      }

    } catch (error) {
      console.error(`   ❌ Error en SMS Insights Job: ${error.message}`);
      result = { success: false, error: error.message };
    } finally {
      this.isRunning = false;
      this.lastResult = result;

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log('\n╔════════════════════════════════════════════════╗');
      console.log(`║  ${result.success ? '✅' : '❌'} SMS INSIGHTS - ${result.success ? 'COMPLETADO' : 'FALLIDO'}              ║`);
      console.log('╚════════════════════════════════════════════════╝');
      console.log(`   Duración: ${duration}s`);
      console.log('════════════════════════════════════════════════\n');
    }

    return result;
  }

  /**
   * Forzar regeneración de insights
   */
  async forceRegenerate() {
    console.log('🔄 Forzando regeneración de SMS insights...');
    return await this.generateInsights();
  }

  /**
   * Obtener estado del job
   */
  getStatus() {
    const cached = smsAnalyticsService.getLastAiInsights();

    return {
      initialized: this.initialized,
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
      schedule: '0 6,18 * * *',
      scheduleDescription: '6 AM y 6 PM diariamente',
      nextRun: this.getNextRun(),
      claudeAvailable: claudeService?.isAvailable() || false,
      cachedInsights: {
        available: !!cached.insights,
        generatedAt: cached.generatedAt,
        isStale: cached.isStale
      }
    };
  }

  /**
   * Calcular próxima ejecución
   */
  getNextRun() {
    const now = new Date();
    const hour = now.getHours();
    const next = new Date(now);

    if (hour < 6) {
      next.setHours(6, 0, 0, 0);
    } else if (hour < 18) {
      next.setHours(18, 0, 0, 0);
    } else {
      next.setDate(next.getDate() + 1);
      next.setHours(6, 0, 0, 0);
    }

    return next;
  }

  /**
   * Detener el job
   */
  stop() {
    if (this.schedule) {
      this.schedule.stop();
      console.log('🛑 SMS Insights Job detenido');
    }
  }
}

const smsInsightsJob = new SmsInsightsJob();
module.exports = smsInsightsJob;
