// Investigate the metrics corruption bug in Maximus logs
require('dotenv').config();
const mongoose = require('mongoose');
const MaximusCampaignLog = require('../src/models/MaximusCampaignLog');
const Campaign = require('../src/models/Campaign');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const logs = await MaximusCampaignLog.find().sort({ sentAt: -1 }).limit(8).lean();

  console.log('=== TIMESTAMP / METRICS ANALYSIS ===\n');
  for (const log of logs) {
    const campaign = await Campaign.findById(log.campaign).lean();
    const cs = campaign?.stats || {};
    const delivered = cs.delivered || 0;
    const opened = cs.opened || 0;
    const actualOpenRate = delivered > 0 ? (opened / delivered * 100).toFixed(1) : 0;

    console.log(`\n[${new Date(log.sentAt).toISOString().split('T')[0]}] "${log.subjectLine.substring(0, 50)}"`);
    console.log(`  sentAt:              ${log.sentAt}`);
    console.log(`  metricsUpdatedAt:    ${log.metricsUpdatedAt || 'never'}`);
    console.log(`  claudeInsight.at:    ${log.claudeInsight?.analyzedAt || 'never'}`);
    console.log(`  campaign.status:     ${campaign?.status}`);
    console.log(`  campaign.stats:`);
    console.log(`    delivered:         ${delivered}`);
    console.log(`    opened:            ${opened}  (${actualOpenRate}%)`);
    console.log(`    clicked:           ${cs.clicked || 0}`);
    console.log(`    purchased:         ${cs.purchased || 0}`);
    console.log(`    totalRevenue:      ${cs.totalRevenue || 0}`);
    console.log(`  log.metrics:         open=${log.metrics.openRate}% click=${log.metrics.clickRate}% rev=${log.metrics.revenue}`);
    if (log.claudeInsight?.analysis) {
      console.log(`  Claude wrote:        "${log.claudeInsight.analysis.substring(0, 120)}"`);
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
