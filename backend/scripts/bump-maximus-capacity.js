// One-off: bump Maximus live config for multi-send capacity
require('dotenv').config();
const mongoose = require('mongoose');
const MaximusConfig = require('../src/models/MaximusConfig');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const c = await MaximusConfig.getConfig();
  console.log('Before:');
  console.log(`  maxCampaignsPerWeek:    ${c.maxCampaignsPerWeek}`);
  console.log(`  maxCampaignsPerDay:     ${c.maxCampaignsPerDay}`);
  console.log(`  minHoursBetweenSameDay: ${c.minHoursBetweenSameDay}`);

  c.maxCampaignsPerWeek = 8;
  if (!c.maxCampaignsPerDay) c.maxCampaignsPerDay = 2;
  if (!c.minHoursBetweenSameDay) c.minHoursBetweenSameDay = 3;
  await c.save();

  console.log('\nAfter:');
  console.log(`  maxCampaignsPerWeek:    ${c.maxCampaignsPerWeek}`);
  console.log(`  maxCampaignsPerDay:     ${c.maxCampaignsPerDay}`);
  console.log(`  minHoursBetweenSameDay: ${c.minHoursBetweenSameDay}`);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
