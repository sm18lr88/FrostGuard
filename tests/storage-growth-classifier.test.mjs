import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(
  new URL('../src/storage-growth-classifier.js', import.meta.url),
  'utf8',
);
const MiB = 1024 * 1024;
const config = Object.freeze({
  fileSystemGrowthThresholdBytes: 128 * MiB,
  totalGrowthThresholdBytes: 512 * MiB,
  absoluteFileSystemWarningBytes: 1024 * MiB,
});

function loadTransition() {
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'storage-growth-classifier.js' });
  return context.__frostguardStorageGrowthTransitionV1__;
}

function sample(at, fileSystemBytes, usageBytes = fileSystemBytes ?? 0) {
  return { at, fileSystemBytes, usageBytes };
}

function step(transition, state, current) {
  return transition(state, { config, sample: current });
}

test('confirms file-system growth only after a persistent second observation', () => {
  const transition = loadTransition();
  const first = step(transition, null, sample(0, 0));
  const crossed = step(transition, first.state, sample(5_000, 128 * MiB));
  const confirmed = step(transition, crossed.state, sample(10_000, 128 * MiB));

  assert.equal(first.event, null);
  assert.equal(crossed.event, null);
  assert.equal(crossed.state.phase, 'confirming');
  assert.equal(confirmed.event.reason, 'confirmed-file-system-growth');
  assert.equal(confirmed.event.deltaBytes, 128 * MiB);
  assert.equal(confirmed.state.phase, 'cooldown');
});

test('keeps threshold-minus-one below confirmation and accepts the exact threshold', () => {
  const transition = loadTransition();
  const first = step(transition, null, sample(0, 0));
  const below = step(transition, first.state, sample(5_000, 128 * MiB - 1));
  const exact = step(transition, below.state, sample(10_000, 128 * MiB));
  const confirmed = step(transition, exact.state, sample(15_000, 128 * MiB));

  assert.equal(below.state.phase, 'tracking');
  assert.equal(exact.state.phase, 'confirming');
  assert.equal(confirmed.event.reason, 'confirmed-file-system-growth');
});

test('uses total usage only for an episode with no file-system detail', () => {
  const transition = loadTransition();
  const first = step(transition, null, sample(0, null, 0));
  const crossed = step(transition, first.state, sample(5_000, null, 512 * MiB));
  const confirmed = step(transition, crossed.state, sample(10_000, null, 512 * MiB));

  assert.equal(confirmed.event.reason, 'confirmed-total-usage-growth');

  const switched = step(transition, crossed.state, sample(10_000, 512 * MiB, 512 * MiB));
  assert.equal(switched.event, null);
  assert.equal(switched.state.phase, 'tracking');
  assert.equal(switched.state.metric, 'file-system');
});

test('re-primes on excessive gaps, decreasing usage, and non-increasing time', () => {
  const transition = loadTransition();
  const first = step(transition, null, sample(10_000, 100 * MiB));
  const gap = step(transition, first.state, sample(41_000, 300 * MiB));
  const decreased = step(transition, gap.state, sample(45_000, 200 * MiB));
  const reversed = step(transition, decreased.state, sample(44_000, 400 * MiB));

  for (const result of [gap, decreased, reversed]) {
    assert.equal(result.event, null);
    assert.equal(result.state.phase, 'tracking');
  }
  assert.equal(gap.state.baselineBytes, 300 * MiB);
  assert.equal(decreased.state.baselineBytes, 200 * MiB);
  assert.equal(reversed.state.baselineBytes, 400 * MiB);
});

test('requires two consecutive file-system samples for an absolute warning', () => {
  const transition = loadTransition();
  const first = step(transition, null, sample(0, 1024 * MiB));
  const confirmed = step(transition, first.state, sample(5_000, 1024 * MiB));

  assert.equal(first.event, null);
  assert.equal(confirmed.event.reason, 'large-file-system-usage');
  assert.equal(confirmed.state.absoluteSent, true);
});

test('emits one rapid-growth event during continuous growth and cooldown', () => {
  const transition = loadTransition();
  const first = step(transition, null, sample(0, 0));
  const crossed = step(transition, first.state, sample(5_000, 128 * MiB));
  const confirmed = step(transition, crossed.state, sample(10_000, 256 * MiB));
  const growing = step(transition, confirmed.state, sample(20_000, 512 * MiB));
  const moreGrowth = step(transition, growing.state, sample(40_000, 640 * MiB));
  const later = step(transition, moreGrowth.state, sample(65_000, 768 * MiB));

  assert.equal(confirmed.event.reason, 'confirmed-file-system-growth');
  assert.equal(growing.event, null);
  assert.equal(later.event, null);
  assert.equal(later.state.phase, 'cooldown');
});

test('does not mutate previous state or samples', () => {
  const transition = loadTransition();
  const current = Object.freeze(sample(0, 0));
  const first = step(transition, null, current);
  const stateSnapshot = structuredClone(first.state);
  const next = Object.freeze(sample(5_000, 128 * MiB));

  step(transition, first.state, next);

  assert.deepEqual(structuredClone(first.state), stateSnapshot);
  assert.equal(current.fileSystemBytes, 0);
  assert.equal(next.fileSystemBytes, 128 * MiB);
});
