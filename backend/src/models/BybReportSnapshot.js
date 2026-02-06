// backend/src/models/BybReportSnapshot.js
const mongoose = require('mongoose');

const bybReportSnapshotSchema = new mongoose.Schema({
  snapshotKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  reportType: {
    type: String,
    required: true,
    index: true
  },
  periodDays: {
    type: Number,
    required: true,
    index: true
  },
  generatedAt: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  validUntil: {
    type: Date,
    required: true,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  }
}, {
  timestamps: true,
  collection: 'byb_report_snapshots'
});

bybReportSnapshotSchema.index({ reportType: 1, periodDays: 1, generatedAt: -1 });

module.exports = mongoose.model('BybReportSnapshot', bybReportSnapshotSchema);
