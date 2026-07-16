import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  evaluateCorpus,
  loadClassifier,
} from '../tools/calibration-replay.mjs';

test('replays the exact packaged classifier deterministically', async () => {
  const corpus = JSON.parse(await readFile(
    new URL('../fixtures/calibration/reference-traces.json', import.meta.url),
    'utf8',
  ));
  const transition = await loadClassifier();

  const first = evaluateCorpus(transition, corpus);
  const second = evaluateCorpus(transition, corpus);

  assert.equal(first.mismatchCount, 0);
  assert.deepEqual(first, second);
  assert.equal(first.traces.find((trace) => trace.id === 'synthetic-frost-construction').rapidEventCount, 1);
  assert.equal(first.traces.find((trace) => trace.id === 'synthetic-total-only-growth').rapidEventCount, 0);
});

test('reports but does not score unlabeled live-site traces', async () => {
  const transition = await loadClassifier();
  const report = evaluateCorpus(transition, {
    config: {
      fileSystemGrowthThresholdBytes: 1,
      totalGrowthThresholdBytes: 10,
      absoluteFileSystemWarningBytes: 100,
    },
    traces: [{
      id: 'live-example',
      label: 'public-site-screening',
      source: 'https://example.com/',
      expectedRapid: null,
      samples: [
        { at: 0, usageBytes: 0, fileSystemBytes: 0 },
        { at: 5_000, usageBytes: 1, fileSystemBytes: 1 },
        { at: 10_000, usageBytes: 1, fileSystemBytes: 1 },
      ],
    }],
  });

  assert.equal(report.mismatchCount, 0);
  assert.equal(report.unlabeledCount, 1);
  assert.equal(report.traces[0].rapidEventCount, 1);
});
