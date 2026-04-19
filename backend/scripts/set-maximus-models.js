// Set Maximus model split: Opus 4.7 for decisions/planning, Sonnet 4.6 for analysis
require('dotenv').config();
const mongoose = require('mongoose');
const MaximusConfig = require('../src/models/MaximusConfig');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const c = await MaximusConfig.getConfig();
  console.log('Before:');
  console.log(`  model:            ${c.model}`);
  console.log(`  modelForAnalysis: ${c.modelForAnalysis || '(unset)'}`);

  c.model = 'claude-opus-4-7';
  c.modelForAnalysis = 'claude-sonnet-4-6';
  await c.save();

  console.log('\nAfter:');
  console.log(`  model:            ${c.model}`);
  console.log(`  modelForAnalysis: ${c.modelForAnalysis}`);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
