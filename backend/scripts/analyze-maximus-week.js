// Analyze Maximus + Apollo — current week
require('dotenv').config();
const mongoose = require('mongoose');

const MaximusConfig = require('../src/models/MaximusConfig');
const MaximusCampaignLog = require('../src/models/MaximusCampaignLog');
const ApolloConfig = require('../src/models/ApolloConfig');
const Campaign = require('../src/models/Campaign');

const fmt = (n, d = 1) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(d));
const money = (n) => (n == null ? '$—' : '$' + Number(n).toFixed(2));

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('\n============================================================');
  console.log('  MAXIMUS + APOLLO — ANALISIS SEMANAL');
  console.log('============================================================\n');

  const config = await MaximusConfig.getConfig();
  const apollo = await ApolloConfig.getConfig();

  // ============== STATE ==============
  console.log('[ESTADO]');
  console.log(`  Maximus activo:          ${config.active}`);
  console.log(`  Creative agent ready:    ${config.creativeAgentReady}`);
  console.log(`  Fase de aprendizaje:     ${config.learning.phase}`);
  console.log(`  Campanas analizadas:     ${config.learning.campaignsAnalyzed}`);
  console.log(`  Ultima actualiz learn:   ${config.learning.lastLearningUpdate || '—'}`);
  console.log(`  Memoria (insights):      ${config.memory?.insights?.length || 0}/15`);
  console.log(`  Apollo activo:           ${apollo.active}`);
  console.log(`  Apollo products:         ${apollo.products?.length || 0} (${apollo.products?.filter(p => p.active).length || 0} activos)`);
  console.log(`  Apollo modelo:           ${apollo.geminiModel}`);
  console.log(`  Apollo totalGenerated:   ${apollo.stats?.totalGenerated || 0}`);

  // ============== THIS WEEK ==============
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const thisWeek = await MaximusCampaignLog.find({
    sentAt: { $gte: startOfWeek }
  }).sort({ sentAt: 1 }).lean();

  console.log(`\n[ESTA SEMANA: ${thisWeek.length}/${config.maxCampaignsPerWeek} campanas]`);
  console.log(`  Rango: ${startOfWeek.toISOString().split('T')[0]} → hoy`);

  if (thisWeek.length === 0) {
    console.log('  Sin campanas enviadas esta semana aun.');
  } else {
    thisWeek.forEach((c, i) => {
      const date = new Date(c.sentAt).toISOString().split('T')[0];
      console.log(`\n  ${i + 1}. [${c.campaignType || '?'}] ${date} ${c.sentDay} ${c.sentHour}:00`);
      console.log(`     Subject: "${c.subjectLine}"`);
      console.log(`     Product: ${c.productName || c.headline || '—'}`);
      console.log(`     List:    ${c.listName}`);
      if (c.contentArchetype) console.log(`     Archetype: ${c.contentArchetype}`);
      console.log(`     Metrics: sent=${c.metrics.sent} delivered=${c.metrics.delivered} opened=${c.metrics.opened} (${fmt(c.metrics.openRate)}%) clicked=${c.metrics.clicked} (${fmt(c.metrics.clickRate)}%) conv=${c.metrics.converted} revenue=${money(c.metrics.revenue)}`);
      if (c.claudeInsight?.analyzedAt) {
        console.log(`     Claude: ${c.claudeInsight.analysis}`);
        console.log(`     Leccion: ${c.claudeInsight.lessonForNext}`);
      } else {
        console.log(`     Claude: (no analizado aun — delivered ${c.metrics.delivered}, umbral 50)`);
      }
    });
  }

  // ============== ALL TIME ==============
  const total = await MaximusCampaignLog.countDocuments();
  const summary = await MaximusCampaignLog.getLearningSummary();
  const s = summary[0] || {};
  console.log(`\n[HISTORIAL TOTAL: ${total} campanas]`);
  console.log(`  Avg open:    ${fmt(s.avgOpenRate)}%`);
  console.log(`  Avg click:   ${fmt(s.avgClickRate)}%`);
  console.log(`  Avg conv:    ${fmt(s.avgConversionRate)}%`);
  console.log(`  Revenue:     ${money(s.totalRevenue)}`);
  console.log(`  Mejor open:  ${fmt(s.bestOpenRate)}%`);
  console.log(`  Mejor click: ${fmt(s.bestClickRate)}%`);

  // ============== BY DAY / HOUR / LIST ==============
  const byDay = await MaximusCampaignLog.getPerformanceByDay();
  const byHour = await MaximusCampaignLog.getPerformanceByHour();
  const byList = await MaximusCampaignLog.getPerformanceByList();

  console.log('\n[PERFORMANCE POR DIA]');
  byDay.forEach(d => console.log(`  ${d._id?.padEnd(10)} campaigns=${d.campaigns} open=${fmt(d.avgOpenRate)}% click=${fmt(d.avgClickRate)}% conv=${fmt(d.avgConversionRate)}% rev=${money(d.totalRevenue)}`));

  console.log('\n[PERFORMANCE POR HORA]');
  byHour.forEach(h => console.log(`  ${String(h._id).padStart(2)}:00  campaigns=${h.campaigns} open=${fmt(h.avgOpenRate)}% click=${fmt(h.avgClickRate)}% conv=${fmt(h.avgConversionRate)}% rev=${money(h.totalRevenue)}`));

  console.log('\n[PERFORMANCE POR LISTA]');
  byList.forEach(l => console.log(`  "${l.listName}"  campaigns=${l.campaigns} open=${fmt(l.avgOpenRate)}% click=${fmt(l.avgClickRate)}% conv=${fmt(l.avgConversionRate)}% rev=${money(l.totalRevenue)}`));

  // ============== BREAKDOWN BY TYPE ==============
  const byType = await MaximusCampaignLog.aggregate([
    { $match: { 'metrics.sent': { $gt: 0 } } },
    { $group: {
      _id: '$campaignType',
      count: { $sum: 1 },
      avgOpen: { $avg: '$metrics.openRate' },
      avgClick: { $avg: '$metrics.clickRate' },
      avgConv: { $avg: '$metrics.conversionRate' },
      rev: { $sum: '$metrics.revenue' }
    } }
  ]);
  console.log('\n[PERFORMANCE POR TIPO]');
  byType.forEach(t => console.log(`  ${(t._id || 'unknown').padEnd(18)} n=${t.count}  open=${fmt(t.avgOpen)}%  click=${fmt(t.avgClick)}%  conv=${fmt(t.avgConv)}%  rev=${money(t.rev)}`));

  // ============== MEMORY ==============
  if (config.memory?.insights?.length) {
    console.log('\n[MEMORIA ACUMULADA (lo que Maximus aprendio)]');
    config.memory.insights.forEach((ins, i) => console.log(`  ${i + 1}. ${ins}`));
  }

  // ============== PENDING ==============
  console.log('\n[PENDIENTES]');
  console.log(`  pendingProposal.active:   ${!!config.pendingProposal?.active}`);
  console.log(`  pendingWeeklyPlan.active: ${!!config.pendingWeeklyPlan?.active}`);
  if (config.pendingWeeklyPlan?.active) {
    const p = config.pendingWeeklyPlan;
    console.log(`    weekLabel: ${p.weekLabel}`);
    console.log(`    campaigns: ${p.campaigns.length} (${p.campaigns.filter(c => c.status === 'approved').length} aprobadas, ${p.campaigns.filter(c => c.status === 'pending').length} pendientes, ${p.campaigns.filter(c => c.status === 'rejected').length} rechazadas)`);
  }

  // ============== RECENT 10 (for lesson trend) ==============
  const recent = await MaximusCampaignLog.find().sort({ sentAt: -1 }).limit(10).lean();
  console.log(`\n[ULTIMAS 10 CAMPANAS]`);
  recent.forEach(c => {
    const date = new Date(c.sentAt).toISOString().split('T')[0];
    console.log(`  ${date} ${c.sentDay?.substring(0,3) || '---'} ${String(c.sentHour || 0).padStart(2)}h  [${(c.campaignType || '?').substring(0,10).padEnd(10)}]  open=${fmt(c.metrics.openRate)}%  click=${fmt(c.metrics.clickRate)}%  conv=${fmt(c.metrics.conversionRate)}%  rev=${money(c.metrics.revenue)}  "${c.subjectLine.substring(0, 45)}"`);
  });

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
