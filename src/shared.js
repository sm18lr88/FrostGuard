export const EXTENSION_NAME = 'FROST Guard';

export const SCRIPT_IDS = Object.freeze({
  MAIN: 'frostguard-main-shield-v1',
  BRIDGE: 'frostguard-isolated-bridge-v1',
});

export const MATCHES = Object.freeze([
  'http://*/*',
  'https://*/*',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  protectionEnabled: true,
  notificationsEnabled: true,
  bannerEnabled: true,
  storageMonitorEnabled: true,
  autoPurgeOnSuspiciousGrowth: false,
  fileSystemGrowthThresholdBytes: 128 * 1024 * 1024,
  totalGrowthThresholdBytes: 512 * 1024 * 1024,
  absoluteFileSystemWarningBytes: 1024 * 1024 * 1024,
  permanentAllowlist: [],
});

export const EVENT_LOG_LIMIT = 250;
export const TEMP_ALLOW_DEFAULT_MS = 60 * 60 * 1000;

const MIN_THRESHOLD_BYTES = 16 * 1024 * 1024;
const MAX_THRESHOLD_BYTES = 64 * 1024 * 1024 * 1024;

export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    if (url.hostname.includes('*')) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function originToMatchPattern(value) {
  const origin = normalizeOrigin(value);
  if (!origin) {
    return null;
  }

  const url = new URL(origin);
  // Chrome match patterns do not encode a specific port. Deliberately scope
  // exceptions to the exact scheme + host and all ports for that host.
  return `${url.protocol}//${url.hostname}/*`;
}

export function uniqueOrigins(values) {
  const seen = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    const origin = normalizeOrigin(value);
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      result.push(origin);
    }
  }

  return result.sort((a, b) => a.localeCompare(b));
}

function clampNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(MAX_THRESHOLD_BYTES, Math.max(MIN_THRESHOLD_BYTES, Math.round(number)));
}

export function normalizeSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};

  return {
    protectionEnabled: source.protectionEnabled !== false,
    notificationsEnabled: source.notificationsEnabled !== false,
    bannerEnabled: source.bannerEnabled !== false,
    storageMonitorEnabled: source.storageMonitorEnabled !== false,
    autoPurgeOnSuspiciousGrowth: source.autoPurgeOnSuspiciousGrowth === true,
    fileSystemGrowthThresholdBytes: clampNumber(
      source.fileSystemGrowthThresholdBytes,
      DEFAULT_SETTINGS.fileSystemGrowthThresholdBytes,
    ),
    totalGrowthThresholdBytes: clampNumber(
      source.totalGrowthThresholdBytes,
      DEFAULT_SETTINGS.totalGrowthThresholdBytes,
    ),
    absoluteFileSystemWarningBytes: clampNumber(
      source.absoluteFileSystemWarningBytes,
      DEFAULT_SETTINGS.absoluteFileSystemWarningBytes,
    ),
    permanentAllowlist: uniqueOrigins(source.permanentAllowlist),
  };
}

export function pruneTemporaryAllowlist(value, now = Date.now()) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};

  for (const [rawOrigin, rawExpiry] of Object.entries(source)) {
    const origin = normalizeOrigin(rawOrigin);
    const expiry = Number(rawExpiry);
    if (origin && Number.isFinite(expiry) && expiry > now) {
      result[origin] = Math.round(expiry);
    }
  }

  return result;
}

export function buildExcludeMatches(settings, temporaryAllowlist = {}, now = Date.now()) {
  const normalized = normalizeSettings(settings);
  const temporary = pruneTemporaryAllowlist(temporaryAllowlist, now);
  const patterns = new Set();

  for (const origin of normalized.permanentAllowlist) {
    const pattern = originToMatchPattern(origin);
    if (pattern) patterns.add(pattern);
  }

  for (const origin of Object.keys(temporary)) {
    const pattern = originToMatchPattern(origin);
    if (pattern) patterns.add(pattern);
  }

  return [...patterns].sort((a, b) => a.localeCompare(b));
}

export function getSiteStatus(originValue, settingsValue, temporaryAllowlist = {}, now = Date.now()) {
  const origin = normalizeOrigin(originValue);
  const settings = normalizeSettings(settingsValue);
  const temporary = pruneTemporaryAllowlist(temporaryAllowlist, now);

  if (!origin) {
    return {
      origin: null,
      supported: false,
      protected: false,
      reason: 'unsupported-origin',
      temporaryUntil: null,
      permanentlyAllowed: false,
    };
  }

  if (!settings.protectionEnabled) {
    return {
      origin,
      supported: true,
      protected: false,
      reason: 'protection-disabled',
      temporaryUntil: null,
      permanentlyAllowed: settings.permanentAllowlist.includes(origin),
    };
  }

  if (settings.permanentAllowlist.includes(origin)) {
    return {
      origin,
      supported: true,
      protected: false,
      reason: 'permanent-allowlist',
      temporaryUntil: null,
      permanentlyAllowed: true,
    };
  }

  if (temporary[origin]) {
    return {
      origin,
      supported: true,
      protected: false,
      reason: 'temporary-allowlist',
      temporaryUntil: temporary[origin],
      permanentlyAllowed: false,
    };
  }

  return {
    origin,
    supported: true,
    protected: true,
    reason: 'protected',
    temporaryUntil: null,
    permanentlyAllowed: false,
  };
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes;
  let index = -1;
  do {
    size /= 1024;
    index += 1;
  } while (size >= 1024 && index < units.length - 1);

  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[index]}`;
}

export function safeEventDetail(value) {
  if (!value || typeof value !== 'object') return {};

  const allowed = {};
  const stringKeys = ['api', 'context', 'reason', 'message'];
  const booleanKeys = ['blocked', 'crossOriginIsolated', 'secureContext'];
  const numberKeys = [
    'usageBytes',
    'quotaBytes',
    'fileSystemBytes',
    'deltaBytes',
    'windowMs',
  ];

  for (const key of stringKeys) {
    if (typeof value[key] === 'string') {
      allowed[key] = value[key].slice(0, 300);
    }
  }

  for (const key of booleanKeys) {
    if (typeof value[key] === 'boolean') {
      allowed[key] = value[key];
    }
  }

  for (const key of numberKeys) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) {
      allowed[key] = Math.round(number);
    }
  }

  return allowed;
}

export function makeEventRecord({
  type,
  origin,
  tabId = null,
  frameId = null,
  url = null,
  detail = {},
  at = Date.now(),
}) {
  const normalizedOrigin = normalizeOrigin(origin || url);
  const safeType = typeof type === 'string' ? type.slice(0, 80) : 'unknown';

  return {
    id: `${at}-${Math.random().toString(36).slice(2, 10)}`,
    at: Math.round(at),
    type: safeType,
    origin: normalizedOrigin,
    tabId: Number.isInteger(tabId) ? tabId : null,
    frameId: Number.isInteger(frameId) ? frameId : null,
    // Persist only the origin. Full page URLs can contain search terms, tokens,
    // document identifiers, or other data that does not belong in an audit log.
    url: normalizedOrigin,
    detail: safeEventDetail(detail),
  };
}

export function appendEvent(existing, record, limit = EVENT_LOG_LIMIT) {
  const events = Array.isArray(existing) ? existing.filter(Boolean) : [];
  return [record, ...events].slice(0, Math.max(1, limit));
}

export function summarizeEvents(events, originValue = null) {
  const origin = normalizeOrigin(originValue);
  const source = Array.isArray(events) ? events : [];
  const filtered = origin ? source.filter((event) => event?.origin === origin) : source;

  return {
    total: filtered.length,
    blocked: filtered.filter((event) => event?.detail?.blocked === true).length,
    storageGrowth: filtered.filter((event) => event?.type === 'storage-growth').length,
    lastEvent: filtered[0] || null,
  };
}
