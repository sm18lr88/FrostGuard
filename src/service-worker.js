import {
  DEFAULT_SETTINGS,
  EVENT_LOG_LIMIT,
  MATCHES,
  SCRIPT_IDS,
  TEMP_ALLOW_DEFAULT_MS,
  appendEvent,
  buildExcludeMatches,
  getSiteStatus,
  makeEventRecord,
  normalizeOrigin,
  normalizeSettings,
  pruneTemporaryAllowlist,
  summarizeEvents,
} from './shared.js';

const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings',
  TEMP_ALLOWLIST: 'temporaryAllowlist',
  EVENTS: 'eventLog',
  NOTIFICATION_COOLDOWNS: 'notificationCooldowns',
});

const MAINTENANCE_ALARM = 'frostguard-maintenance';
const TEMPORARY_EXPIRY_ALARM = 'frostguard-temporary-expiry';
const NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000;
const BADGE_COLOR = '#b3261e';

let registrationQueue = Promise.resolve();
let logQueue = Promise.resolve();
const recentEvents = new Map();

function queueRegistrationSync() {
  registrationQueue = registrationQueue
    .catch(() => undefined)
    .then(() => syncRegisteredScripts());
  return registrationQueue;
}

async function getSettings() {
  const result = await chrome.storage.sync.get({
    [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS,
  });
  return normalizeSettings(result[STORAGE_KEYS.SETTINGS]);
}

async function getTemporaryAllowlist() {
  const result = await chrome.storage.local.get({
    [STORAGE_KEYS.TEMP_ALLOWLIST]: {},
  });
  return pruneTemporaryAllowlist(result[STORAGE_KEYS.TEMP_ALLOWLIST]);
}

async function persistNormalizedState() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS }),
    chrome.storage.local.get({ [STORAGE_KEYS.TEMP_ALLOWLIST]: {} }),
  ]);

  const settings = normalizeSettings(syncData[STORAGE_KEYS.SETTINGS]);
  const temporaryAllowlist = pruneTemporaryAllowlist(
    localData[STORAGE_KEYS.TEMP_ALLOWLIST],
  );

  const writes = [];
  if (JSON.stringify(settings) !== JSON.stringify(syncData[STORAGE_KEYS.SETTINGS])) {
    writes.push(chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings }));
  }
  if (
    JSON.stringify(temporaryAllowlist) !==
    JSON.stringify(localData[STORAGE_KEYS.TEMP_ALLOWLIST])
  ) {
    writes.push(
      chrome.storage.local.set({
        [STORAGE_KEYS.TEMP_ALLOWLIST]: temporaryAllowlist,
      }),
    );
  }

  await Promise.all(writes);
  return { settings, temporaryAllowlist };
}

async function scheduleTemporaryExpiry(temporaryAllowlist) {
  const expiries = Object.values(temporaryAllowlist)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > Date.now());

  if (expiries.length === 0) {
    await chrome.alarms.clear(TEMPORARY_EXPIRY_ALARM);
    return;
  }

  await chrome.alarms.create(TEMPORARY_EXPIRY_ALARM, {
    when: Math.max(Date.now() + 1_000, Math.min(...expiries)),
  });
}

function registeredScript({ id, files, world, excludeMatches }) {
  return {
    id,
    js: [...files],
    matches: [...MATCHES],
    excludeMatches: [...excludeMatches],
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
    runAt: 'document_start',
    world,
  };
}

async function syncRegisteredScripts() {
  const { settings, temporaryAllowlist } = await persistNormalizedState();
  await scheduleTemporaryExpiry(temporaryAllowlist);
  const ids = Object.values(SCRIPT_IDS);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });

  if (!settings.protectionEnabled) {
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: existing.map((script) => script.id),
      });
    }
    return;
  }

  const excludeMatches = buildExcludeMatches(settings, temporaryAllowlist);
  const desired = [
    registeredScript({
      id: SCRIPT_IDS.MAIN,
      files: ['src/main-shield.js'],
      world: 'MAIN',
      excludeMatches,
    }),
    registeredScript({
      id: SCRIPT_IDS.BRIDGE,
      files: [
        'src/storage-growth-classifier.js',
        'src/bridge.js',
        'src/storage-monitor.js',
      ],
      world: 'ISOLATED',
      excludeMatches,
    }),
  ];

  const existingIds = new Set(existing.map((script) => script.id));
  const toRegister = desired.filter((script) => !existingIds.has(script.id));
  const toUpdate = desired.filter((script) => existingIds.has(script.id));

  if (toRegister.length > 0) {
    await chrome.scripting.registerContentScripts(toRegister);
  }
  if (toUpdate.length > 0) {
    await chrome.scripting.updateContentScripts(toUpdate);
  }
}

async function isOriginProtected(origin) {
  const [settings, temporaryAllowlist] = await Promise.all([
    getSettings(),
    getTemporaryAllowlist(),
  ]);
  return getSiteStatus(origin, settings, temporaryAllowlist).protected;
}

async function injectProtectionIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const results = await Promise.allSettled(
    tabs.map(async (tab) => {
      if (!Number.isInteger(tab.id) || !normalizeOrigin(tab.url || '')) return;
      if (!(await isOriginProtected(tab.url))) return;

      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/main-shield.js'],
        world: 'MAIN',
        injectImmediately: true,
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: [
          'src/storage-growth-classifier.js',
          'src/bridge.js',
          'src/storage-monitor.js',
        ],
        world: 'ISOLATED',
        injectImmediately: true,
      });
    }),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('FROST Guard could not protect an existing tab:', result.reason);
    }
  }
}

function appendLogEvent(record) {
  const task = logQueue
    .catch(() => undefined)
    .then(async () => {
      const data = await chrome.storage.local.get({ [STORAGE_KEYS.EVENTS]: [] });
      const eventLog = appendEvent(
        data[STORAGE_KEYS.EVENTS],
        record,
        EVENT_LOG_LIMIT,
      );
      await chrome.storage.local.set({ [STORAGE_KEYS.EVENTS]: eventLog });
      return eventLog;
    });
  logQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function setWarningBadge(tabId, record) {
  if (!Number.isInteger(tabId)) return;

  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: '!' }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }),
    chrome.action.setTitle({
      tabId,
      title: `FROST Guard: ${eventTitle(record.type)}`,
    }),
  ]);
}

async function clearWarningBadge(tabId) {
  if (!Number.isInteger(tabId)) return;
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: '' }),
    chrome.action.setTitle({ tabId, title: 'FROST Guard' }),
  ]);
}

function eventTitle(type) {
  switch (type) {
    case 'opfs-blocked':
      return 'Blocked hidden OPFS access';
    case 'bucket-opfs-blocked':
      return 'Blocked storage-bucket file-system access';
    case 'sync-access-blocked':
      return 'Blocked synchronous file-system timing access';
    case 'worker-opfs-blocked':
      return 'Blocked OPFS access inside a worker';
    case 'worker-sync-access-blocked':
      return 'Blocked synchronous worker file access';
    case 'worker-construction-blocked':
      return 'Blocked a worker that could not be shielded';
    case 'storage-growth':
      return 'Observed unusual browser-storage growth';
    case 'file-picker-observed':
      return 'Observed direct file-system access';
    default:
      return 'Detected a storage side-channel signal';
  }
}

function eventMessage(record) {
  const api = record.detail?.api ? ` (${record.detail.api})` : '';
  switch (record.type) {
    case 'storage-growth':
      return `Browser storage for this site crossed a confirmed growth threshold${api}. This heuristic does not establish malicious intent.`;
    case 'file-picker-observed':
      return `The site opened a direct file-system picker${api}. Only choose files you intend to share.`;
    case 'worker-construction-blocked':
      return `A worker could not be started through the protective bootstrap${api}, so it was blocked fail-closed.`;
    default:
      return `A page attempted a browser file-system operation associated with SSD timing attacks${api}. The operation was blocked.`;
  }
}

async function canNotify(record, channel) {
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return false;
  if (
    record.type !== 'storage-growth' ||
    record.detail?.reason !== 'confirmed-file-system-growth' ||
    channel !== 'monitor'
  ) return false;

  const key = `${record.origin || 'unknown'}:${record.type}`;
  const now = Date.now();
  const result = await chrome.storage.session.get({
    [STORAGE_KEYS.NOTIFICATION_COOLDOWNS]: {},
  });
  const cooldowns = result[STORAGE_KEYS.NOTIFICATION_COOLDOWNS] || {};
  for (const [cooldownKey, at] of Object.entries(cooldowns)) {
    if (Number(at) < now - 24 * 60 * 60 * 1000) delete cooldowns[cooldownKey];
  }
  if (Number(cooldowns[key]) + NOTIFICATION_COOLDOWN_MS > now) {
    return false;
  }

  cooldowns[key] = now;
  await chrome.storage.session.set({
    [STORAGE_KEYS.NOTIFICATION_COOLDOWNS]: cooldowns,
  });
  return true;
}

async function showNotification(record, channel) {
  if (!(await canNotify(record, channel))) return;

  const notificationId = `frostguard-${record.id}`;
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: eventTitle(record.type),
    message: eventMessage(record),
    contextMessage: record.origin || 'Unknown origin',
    priority: 0,
  });
}

async function purgeOrigin(originValue, tabId = null, reload = false) {
  const origin = normalizeOrigin(originValue);
  if (!origin) {
    throw new Error('A valid http(s) origin is required.');
  }

  await chrome.browsingData.remove(
    { origins: [origin] },
    {
      fileSystems: true,
      serviceWorkers: true,
    },
  );

  await appendLogEvent(
    makeEventRecord({
      type: 'site-storage-purged',
      origin,
      tabId,
      detail: {
        blocked: false,
        api: 'chrome.browsingData.remove(fileSystems, serviceWorkers)',
      },
    }),
  );

  if (reload && Number.isInteger(tabId)) {
    await chrome.tabs.reload(tabId).catch(() => undefined);
  }

  return { ok: true, origin };
}

async function handleShieldEvent(message, sender) {
  const senderUrl = sender.url || sender.tab?.url || '';
  const origin =
    normalizeOrigin(sender.origin || '') ||
    normalizeOrigin(senderUrl) ||
    normalizeOrigin(sender.tab?.url || '');
  if (!origin) {
    throw new Error('Shield event did not originate from a supported web page.');
  }

  const allowedTypes = new Set([
    'opfs-blocked',
    'bucket-opfs-blocked',
    'sync-access-blocked',
    'worker-opfs-blocked',
    'worker-sync-access-blocked',
    'worker-construction-blocked',
    'file-picker-observed',
    'storage-growth',
  ]);
  const type = allowedTypes.has(message.eventType)
    ? message.eventType
    : 'unknown-shield-event';

  const now = Date.now();
  const rateKey = [
    sender.tab?.id ?? 'no-tab',
    sender.frameId ?? 'no-frame',
    type,
    typeof message.detail?.api === 'string' ? message.detail.api : '',
  ].join(':');
  const lastSeen = recentEvents.get(rateKey) || 0;
  if (now - lastSeen < 1_500) {
    return { ok: true, suppressed: true };
  }
  recentEvents.set(rateKey, now);
  if (recentEvents.size > 1_000) {
    for (const [key, at] of recentEvents) {
      if (now - at > 60_000) recentEvents.delete(key);
    }
  }

  const record = makeEventRecord({
    type,
    origin,
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? null,
    url: senderUrl,
    detail: message.detail,
  });

  await appendLogEvent(record);
  const shouldEscalate = type !== 'file-picker-observed' && (
    type !== 'storage-growth' ||
    record.detail?.reason === 'confirmed-file-system-growth'
  );
  if (shouldEscalate) {
    await setWarningBadge(sender.tab?.id, record);
    await showNotification(record, message.channel);
  }

  return { ok: true };
}

async function updateProtection(enabled) {
  const settings = await getSettings();
  settings.protectionEnabled = enabled === true;
  await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings });
  await queueRegistrationSync();
  if (settings.protectionEnabled) {
    await injectProtectionIntoOpenTabs();
  }
  return { ok: true, settings };
}

async function allowTemporarily(originValue, durationMs = TEMP_ALLOW_DEFAULT_MS) {
  const origin = normalizeOrigin(originValue);
  if (!origin) throw new Error('A valid origin is required.');

  const temporary = await getTemporaryAllowlist();
  const duration = Math.min(
    24 * 60 * 60 * 1000,
    Math.max(60 * 1000, Number(durationMs) || TEMP_ALLOW_DEFAULT_MS),
  );
  temporary[origin] = Date.now() + duration;
  await chrome.storage.local.set({
    [STORAGE_KEYS.TEMP_ALLOWLIST]: temporary,
  });
  await queueRegistrationSync();
  return { ok: true, until: temporary[origin] };
}

async function clearTemporaryAllowance(originValue) {
  const origin = normalizeOrigin(originValue);
  if (!origin) throw new Error('A valid origin is required.');

  const temporary = await getTemporaryAllowlist();
  delete temporary[origin];
  await chrome.storage.local.set({
    [STORAGE_KEYS.TEMP_ALLOWLIST]: temporary,
  });
  await queueRegistrationSync();
  return { ok: true };
}

async function setPermanentAllowance(originValue, allowed) {
  const origin = normalizeOrigin(originValue);
  if (!origin) throw new Error('A valid origin is required.');

  const settings = await getSettings();
  const values = new Set(settings.permanentAllowlist);
  if (allowed) values.add(origin);
  else values.delete(origin);
  settings.permanentAllowlist = [...values].sort((a, b) => a.localeCompare(b));

  await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings });
  await queueRegistrationSync();
  return { ok: true, settings };
}

async function getState(originValue = null) {
  const [settings, temporaryAllowlist, localData] = await Promise.all([
    getSettings(),
    getTemporaryAllowlist(),
    chrome.storage.local.get({ [STORAGE_KEYS.EVENTS]: [] }),
  ]);

  return {
    settings,
    temporaryAllowlist,
    site: getSiteStatus(originValue, settings, temporaryAllowlist),
    summary: summarizeEvents(localData[STORAGE_KEYS.EVENTS], originValue),
    totalSummary: summarizeEvents(localData[STORAGE_KEYS.EVENTS]),
  };
}

const EXTENSION_PAGE_PREFIX = chrome.runtime.getURL('');
const BRIDGE_MESSAGE_TYPES = new Set([
  'GET_BRIDGE_CONFIG',
  'SHIELD_EVENT',
  'OPEN_OPTIONS',
]);

function isExtensionPageSender(sender) {
  return (
    sender?.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(EXTENSION_PAGE_PREFIX)
  );
}

function isBridgeSender(sender) {
  const senderUrl = sender?.url || sender?.tab?.url || '';
  return sender?.id === chrome.runtime.id && normalizeOrigin(senderUrl) !== null;
}

function assertAuthorizedSender(messageType, sender) {
  const authorized = BRIDGE_MESSAGE_TYPES.has(messageType)
    ? isBridgeSender(sender) || isExtensionPageSender(sender)
    : isExtensionPageSender(sender);
  if (!authorized) {
    throw new Error('This extension request is not authorized for the sender.');
  }
}

async function handleMessage(message, sender) {
  if (!message || typeof message !== 'object') {
    throw new Error('Invalid message.');
  }
  assertAuthorizedSender(message.type, sender);

  switch (message.type) {
    case 'GET_STATE':
      return getState(message.origin);
    case 'GET_BRIDGE_CONFIG': {
      const settings = await getSettings();
      return {
        bannerEnabled: settings.bannerEnabled,
        storageMonitorEnabled: settings.storageMonitorEnabled,
        fileSystemGrowthThresholdBytes: settings.fileSystemGrowthThresholdBytes,
        totalGrowthThresholdBytes: settings.totalGrowthThresholdBytes,
        absoluteFileSystemWarningBytes: settings.absoluteFileSystemWarningBytes,
      };
    }
    case 'SHIELD_EVENT':
      return handleShieldEvent(message, sender);
    case 'SET_PROTECTION':
      return updateProtection(message.enabled);
    case 'ALLOW_TEMPORARILY':
      return allowTemporarily(message.origin, message.durationMs);
    case 'CLEAR_TEMPORARY_ALLOWANCE':
      return clearTemporaryAllowance(message.origin);
    case 'SET_PERMANENT_ALLOWANCE':
      return setPermanentAllowance(message.origin, message.allowed === true);
    case 'PURGE_ORIGIN':
      return purgeOrigin(message.origin, message.tabId, message.reload === true);
    case 'GET_EVENTS': {
      const data = await chrome.storage.local.get({ [STORAGE_KEYS.EVENTS]: [] });
      return { events: data[STORAGE_KEYS.EVENTS] };
    }
    case 'CLEAR_EVENTS':
      await chrome.storage.local.set({ [STORAGE_KEYS.EVENTS]: [] });
      return { ok: true };
    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case 'ACKNOWLEDGE_TAB_ALERT':
      await clearWarningBadge(message.tabId);
      return { ok: true };
    case 'SYNC_REGISTRATIONS':
      await queueRegistrationSync();
      return { ok: true };
    default:
      throw new Error(`Unknown message type: ${String(message.type)}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error('FROST Guard message error:', error);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});

async function initialize({ protectOpenTabs = false } = {}) {
  await persistNormalizedState();
  await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 5 });
  await queueRegistrationSync();
  if (protectOpenTabs) await injectProtectionIntoOpenTabs();
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize({ protectOpenTabs: true }).catch((error) =>
    console.error('FROST Guard install initialization failed:', error),
  );
});

chrome.runtime.onStartup.addListener(() => {
  void initialize().catch((error) =>
    console.error('FROST Guard startup initialization failed:', error),
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (
    alarm.name === MAINTENANCE_ALARM ||
    alarm.name === TEMPORARY_EXPIRY_ALARM
  ) {
    void queueRegistrationSync().catch((error) =>
      console.error('FROST Guard maintenance failed:', error),
    );
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const relevant =
    (areaName === 'sync' && changes[STORAGE_KEYS.SETTINGS]) ||
    (areaName === 'local' && changes[STORAGE_KEYS.TEMP_ALLOWLIST]);
  if (relevant) {
    void queueRegistrationSync().catch((error) =>
      console.error('FROST Guard registration update failed:', error),
    );
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  void (async () => {
    await chrome.runtime.openOptionsPage();
    await chrome.notifications.clear(notificationId);
  })().catch((error) => console.error('FROST Guard notification click failed:', error));
});
