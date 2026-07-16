import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTargets, publicCheckpointTraces } from '../tools/calibration-targets.mjs';

test('parses unique HTTPS calibration targets', () => {
  const targets = parseTargets({
    targets: [
      { category: 'control', url: 'https://example.com' },
      { category: 'pwa', url: 'https://web.dev/' },
    ],
  });

  assert.deepEqual(targets, [
    { id: 'control-example-com', category: 'control', url: 'https://example.com/' },
    { id: 'pwa-web-dev', category: 'pwa', url: 'https://web.dev/' },
  ]);
});

test('rejects duplicate origins and non-HTTPS targets', () => {
  assert.throws(
    () => parseTargets({ targets: [
      { category: 'control', url: 'https://example.com/a' },
      { category: 'control', url: 'https://example.com/b' },
    ] }),
    /duplicate origin/i,
  );
  assert.throws(
    () => parseTargets({ targets: [{ category: 'control', url: 'http://example.com/' }] }),
    /HTTPS/i,
  );
});

test('requires a category and a targets array', () => {
  assert.throws(() => parseTargets({}), /targets array/i);
  assert.throws(
    () => parseTargets({ targets: [{ category: '', url: 'https://example.com/' }] }),
    /category/i,
  );
});

test('resumes only completed public outcomes from a checkpoint', () => {
  const publicTrace = { id: 'control-example-com', label: 'public-site-screening', status: 'ok' };
  const failureTrace = { id: 'pwa-web-dev', label: 'collection-failure', status: 'timeout' };
  const traces = publicCheckpointTraces({ traces: [
    { id: 'synthetic', label: 'benign-control' },
    publicTrace,
    failureTrace,
  ] });

  assert.deepEqual(traces, [publicTrace, failureTrace]);
  assert.throws(() => publicCheckpointTraces({ traces: 'invalid' }), /traces array/i);
});
