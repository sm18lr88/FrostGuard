import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeCorpus } from '../tools/calibration-report.mjs';

test('summarizes public attempts, failures, categories, and growth candidates', () => {
  const summary = summarizeCorpus({ traces: [
    {
      id: 'one', label: 'public-site-screening', category: 'control', source: 'https://one.example/',
      status: 'ok', samples: [
        { usageBytes: 10, fileSystemBytes: null },
        { usageBytes: 30, fileSystemBytes: null },
      ],
    },
    {
      id: 'two', label: 'collection-failure', category: 'control', source: 'https://two.example/',
      status: 'timeout', error: 'navigation timeout', samples: [],
    },
  ] }, {
    traces: [
      { id: 'one', rapidEventCount: 1, reasons: ['confirmed-file-system-growth'] },
      { id: 'two', rapidEventCount: 0, reasons: [] },
    ],
  });

  assert.equal(summary.attemptedCount, 2);
  assert.equal(summary.successCount, 1);
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.classifierCandidateCount, 1);
  assert.deepEqual(summary.categories, [{ category: 'control', attempted: 2, success: 1, failure: 1 }]);
  assert.equal(summary.largestPeakGrowth[0].peakGrowthBytes, 20);
  assert.equal(summary.failures[0].status, 'timeout');
});
