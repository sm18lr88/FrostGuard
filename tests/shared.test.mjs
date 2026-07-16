import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  appendEvent,
  buildExcludeMatches,
  formatBytes,
  getSiteStatus,
  makeEventRecord,
  normalizeOrigin,
  normalizeSettings,
  originToMatchPattern,
  pruneTemporaryAllowlist,
  safeEventDetail,
  summarizeEvents,
  uniqueOrigins,
} from '../src/shared.js';

test('normalizes supported origins and rejects non-web schemes', () => {
  assert.equal(normalizeOrigin(' https://Example.COM:443/path?q=1 '), 'https://example.com');
  assert.equal(normalizeOrigin('http://localhost:8080/a'), 'http://localhost:8080');
  assert.equal(normalizeOrigin('file:///tmp/a'), null);
  assert.equal(normalizeOrigin('https://*.example.com'), null);
  assert.equal(normalizeOrigin('not a url'), null);
});

test('converts exceptions to Chrome match patterns', () => {
  assert.equal(originToMatchPattern('https://example.com:8443'), 'https://example.com/*');
  assert.equal(originToMatchPattern('http://localhost:3000'), 'http://localhost/*');
  assert.equal(originToMatchPattern('chrome://settings'), null);
});

test('normalizes settings, thresholds, and allowlist values', () => {
  const settings = normalizeSettings({
    protectionEnabled: false,
    notificationsEnabled: false,
    autoPurgeOnSuspiciousGrowth: true,
    fileSystemGrowthThresholdBytes: 1,
    totalGrowthThresholdBytes: Number.POSITIVE_INFINITY,
    absoluteFileSystemWarningBytes: 128 * 1024 * 1024 * 1024,
    permanentAllowlist: [
      'https://b.example/path',
      'https://a.example',
      'https://b.example',
      'file:///ignored',
    ],
  });

  assert.equal(settings.protectionEnabled, false);
  assert.equal(settings.notificationsEnabled, false);
  assert.equal(settings.bannerEnabled, true);
  assert.equal(settings.autoPurgeOnSuspiciousGrowth, true);
  assert.equal(settings.fileSystemGrowthThresholdBytes, 16 * 1024 * 1024);
  assert.equal(
    settings.totalGrowthThresholdBytes,
    DEFAULT_SETTINGS.totalGrowthThresholdBytes,
  );
  assert.equal(settings.absoluteFileSystemWarningBytes, 64 * 1024 * 1024 * 1024);
  assert.deepEqual(settings.permanentAllowlist, [
    'https://a.example',
    'https://b.example',
  ]);
});

test('deduplicates origins deterministically', () => {
  assert.deepEqual(
    uniqueOrigins(['https://z.example/a', 'https://a.example', 'https://z.example/b']),
    ['https://a.example', 'https://z.example'],
  );
});

test('prunes expired temporary exceptions and builds exclusions', () => {
  const now = 1_000_000;
  const temporary = pruneTemporaryAllowlist(
    {
      'https://temp.example': now + 5000,
      'https://expired.example': now - 1,
      'invalid origin': now + 5000,
    },
    now,
  );
  assert.deepEqual(temporary, { 'https://temp.example': now + 5000 });

  const matches = buildExcludeMatches(
    {
      ...DEFAULT_SETTINGS,
      permanentAllowlist: ['https://always.example:8443'],
    },
    temporary,
    now,
  );
  assert.deepEqual(matches, [
    'https://always.example/*',
    'https://temp.example/*',
  ]);
});

test('reports protected, temporary, permanent, disabled, and unsupported states', () => {
  const now = 2_000_000;
  assert.equal(
    getSiteStatus('https://safe.example', DEFAULT_SETTINGS, {}, now).reason,
    'protected',
  );
  assert.equal(
    getSiteStatus(
      'https://temp.example',
      DEFAULT_SETTINGS,
      { 'https://temp.example': now + 1000 },
      now,
    ).reason,
    'temporary-allowlist',
  );
  assert.equal(
    getSiteStatus(
      'https://always.example',
      { ...DEFAULT_SETTINGS, permanentAllowlist: ['https://always.example'] },
      {},
      now,
    ).reason,
    'permanent-allowlist',
  );
  assert.equal(
    getSiteStatus(
      'https://safe.example',
      { ...DEFAULT_SETTINGS, protectionEnabled: false },
      {},
      now,
    ).reason,
    'protection-disabled',
  );
  assert.equal(getSiteStatus('chrome://settings', DEFAULT_SETTINGS, {}, now).supported, false);
});

test('sanitizes event details and summarizes a bounded log', () => {
  const detail = safeEventDetail({
    api: 'navigator.storage.getDirectory',
    blocked: true,
    deltaBytes: 123.7,
    negative: -4,
    secret: 'not copied',
  });
  assert.deepEqual(detail, {
    api: 'navigator.storage.getDirectory',
    blocked: true,
    deltaBytes: 124,
  });

  const blocked = makeEventRecord({
    type: 'opfs-blocked',
    origin: 'https://example.com/path',
    url: 'https://example.com/private/document?token=secret#section',
    detail,
    at: 100,
  });
  assert.equal(blocked.url, 'https://example.com');
  const growth = makeEventRecord({
    type: 'storage-growth',
    origin: 'https://example.com',
    detail: { blocked: false, deltaBytes: 200 },
    at: 200,
  });
  const log = appendEvent(appendEvent([], blocked, 2), growth, 2);
  assert.equal(log.length, 2);
  assert.equal(log[0].type, 'storage-growth');

  assert.deepEqual(
    summarizeEvents(log, 'https://example.com'),
    {
      total: 2,
      blocked: 1,
      storageGrowth: 1,
      lastEvent: growth,
    },
  );
});

test('formats byte quantities for UI', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(128 * 1024 * 1024), '128 MiB');
  assert.equal(formatBytes(Number.NaN), '0 B');
});
