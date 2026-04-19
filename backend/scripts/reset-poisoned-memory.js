// Reset Maximus poisoned memory
// - Clears claudeInsight on logs analyzed <48h after send (stale open rates)
// - Wipes config.memory.insights (all derived from stale data)
// Next run of updateMetrics job will re-analyze with mature metrics
require('dotenv').config();
const mongoose = require('mongoose');
const MaximusConfig = require('../src/models/MaximusConfig');
const MaximusCampaignLog = require('../src/models/MaximusCampaignLog');

const MIN_AGE_MS = 48 * 60 * 60 * 1000;
const DRY_RUN = process.argv.includes('--apply') ? false : true;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`\n${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} Reset poisoned Maximus memory\n`);

  const logs = await MaximusCampaignLog.find({ 'claudeInsight.analyzedAt': { $exists: true } });
  const toReset = [];

  for (const log of logs) {
    const analysisAge = new Date(log.claudeInsight.analyzedAt).getTime() - new Date(log.sentAt).getTime();
    const prematurely = analysisAge < MIN_AGE_MS;
    console.log(`${prematurely ? 'RESET' : 'keep '} | sent=${log.sentAt.toISOString().split('T')[0]} analyzed=+${(analysisAge / 3600000).toFixed(1)}h | "${log.subjectLine.substring(0, 50)}"`);
    if (prematurely) toReset.push(log);
  }

  const config = await MaximusConfig.getConfig();
  const memCount = config.memory?.insights?.length || 0;

  console.log(`\nSummary:`);
  console.log(`  Logs to reset:        ${toReset.length}/${logs.length}`);
  console.log(`  Memory insights to wipe: ${memCount}`);

  if (DRY_RUN) {
    console.log(`\n(Dry run — no changes. Run with --apply to persist.)`);
    await mongoose.disconnect();
    return;
  }

  for (const log of toReset) {
    log.claudeInsight = undefined;
    await log.save();
  }

  if (config.memory) {
    config.memory.insights = [];
    config.memory.lastUpdated = new Date();
    await config.save();
  }

  console.log(`\nApplied. Next metricsJob tick will re-analyze with mature metrics (>=48h, delivered>=100).`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
