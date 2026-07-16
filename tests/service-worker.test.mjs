import test from 'node:test';
import assert from 'node:assert/strict';

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    dispatch(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function makeChromeMock() {
  const storageChanged = makeEvent();
  const stores = {
    sync: {},
    local: {},
    session: {},
  };

  function storageArea(areaName) {
    return {
      async get(query = null) {
        const store = stores[areaName];
        if (query === null) return clone(store);
        if (typeof query === 'string') {
          return { [query]: clone(store[query]) };
        }
        if (Array.isArray(query)) {
          return Object.fromEntries(query.map((key) => [key, clone(store[key])]));
        }
        const result = {};
        for (const [key, fallback] of Object.entries(query || {})) {
          result[key] = key in store ? clone(store[key]) : clone(fallback);
        }
        return result;
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          const oldValue = clone(stores[areaName][key]);
          stores[areaName][key] = clone(value);
          if (JSON.stringify(oldValue) !== JSON.stringify(value)) {
            changes[key] = { oldValue, newValue: clone(value) };
          }
        }
        if (Object.keys(changes).length > 0) {
          storageChanged.dispatch(changes, areaName);
        }
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete stores[areaName][key];
        }
      },
      async clear() {
        for (const key of Object.keys(stores[areaName])) delete stores[areaName][key];
      },
    };
  }

  const registered = [];
  const executedScripts = [];
  const alarmState = new Map();
  const removedBrowsingData = [];
  const badges = [];
  const notifications = [];
  const reloadedTabs = [];
  const updatedTabs = [];
  const focusedWindows = [];
  let optionsOpened = 0;

  const events = {
    runtimeMessage: makeEvent(),
    runtimeInstalled: makeEvent(),
    runtimeStartup: makeEvent(),
    alarm: makeEvent(),
    storageChanged,
    tabUpdated: makeEvent(),
    notificationClicked: makeEvent(),
    notificationButtonClicked: makeEvent(),
  };

  const tab = {
    id: 7,
    windowId: 2,
    active: true,
    url: 'https://site.example/page',
  };

  const chrome = {
    storage: {
      sync: storageArea('sync'),
      local: storageArea('local'),
      session: storageArea('session'),
      onChanged: storageChanged,
    },
    scripting: {
      async getRegisteredContentScripts(filter = {}) {
        const ids = Array.isArray(filter.ids) ? new Set(filter.ids) : null;
        return clone(ids ? registered.filter((script) => ids.has(script.id)) : registered);
      },
      async registerContentScripts(scripts) {
        for (const script of scripts) {
          if (registered.some((value) => value.id === script.id)) {
            throw new Error(`duplicate script ${script.id}`);
          }
          registered.push(clone(script));
        }
      },
      async updateContentScripts(scripts) {
        for (const script of scripts) {
          const index = registered.findIndex((value) => value.id === script.id);
          if (index < 0) throw new Error(`missing script ${script.id}`);
          registered[index] = { ...registered[index], ...clone(script) };
        }
      },
      async unregisterContentScripts({ ids }) {
        const removal = new Set(ids);
        for (let index = registered.length - 1; index >= 0; index -= 1) {
          if (removal.has(registered[index].id)) registered.splice(index, 1);
        }
      },
      async executeScript(injection) {
        executedScripts.push(clone(injection));
        return [];
      },
    },
    tabs: {
      onUpdated: events.tabUpdated,
      async query() {
        return [clone(tab)];
      },
      async reload(tabId) {
        reloadedTabs.push(tabId);
      },
      async update(tabId, values) {
        updatedTabs.push({ tabId, values: clone(values) });
        return { ...clone(tab), id: tabId, ...clone(values) };
      },
    },
    windows: {
      async update(windowId, values) {
        focusedWindows.push({ windowId, values: clone(values) });
        return { id: windowId, ...clone(values) };
      },
    },
    alarms: {
      onAlarm: events.alarm,
      async create(name, info) {
        alarmState.set(name, clone(info));
      },
      async clear(name) {
        return alarmState.delete(name);
      },
    },
    action: {
      async setBadgeText(value) {
        badges.push({ method: 'text', value: clone(value) });
      },
      async setBadgeBackgroundColor(value) {
        badges.push({ method: 'color', value: clone(value) });
      },
      async setTitle(value) {
        badges.push({ method: 'title', value: clone(value) });
      },
    },
    notifications: {
      onClicked: events.notificationClicked,
      onButtonClicked: events.notificationButtonClicked,
      async create(id, options) {
        notifications.push({ id, options: clone(options) });
        return id;
      },
      async clear() {
        return true;
      },
    },
    browsingData: {
      async remove(options, dataTypes) {
        removedBrowsingData.push({ options: clone(options), dataTypes: clone(dataTypes) });
      },
    },
    runtime: {
      id: 'frostguard-test-extension',
      onMessage: events.runtimeMessage,
      onInstalled: events.runtimeInstalled,
      onStartup: events.runtimeStartup,
      getURL(path = '') {
        return `chrome-extension://frostguard-test-extension/${path}`;
      },
      async openOptionsPage() {
        optionsOpened += 1;
      },
    },
  };

  async function sendMessage(message, sender = {
    id: 'frostguard-test-extension',
    url: 'chrome-extension://frostguard-test-extension/src/popup.html',
  }) {
    const listener = events.runtimeMessage.listeners[0];
    assert.equal(typeof listener, 'function', 'runtime message listener was not registered');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('message response timed out')), 2_000);
      listener(message, sender, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  async function settle() {
    for (let index = 0; index < 10; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    alarmState,
    badges,
    chrome,
    events,
    executedScripts,
    focusedWindows,
    notifications,
    optionsOpened: () => optionsOpened,
    registered,
    reloadedTabs,
    removedBrowsingData,
    sendMessage,
    settle,
    stores,
    updatedTabs,
  };
}

test('service worker registers, warns, rate-limits, allows, purges, and toggles', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock.chrome;

  try {
    await import(`../src/service-worker.js?test=${Date.now()}`);
    mock.events.runtimeInstalled.dispatch({ reason: 'install' });
    await mock.settle();

    assert.equal(mock.registered.length, 2);
    const main = mock.registered.find((script) => script.world === 'MAIN');
    const bridge = mock.registered.find((script) => script.world === 'ISOLATED');
    assert.ok(main);
    assert.ok(bridge);
    assert.deepEqual(main.js, ['src/main-shield.js']);
    assert.deepEqual(bridge.js, [
      'src/storage-growth-classifier.js',
      'src/bridge.js',
      'src/storage-monitor.js',
    ]);
    for (const script of [main, bridge]) {
      assert.equal(script.runAt, 'document_start');
      assert.equal(script.allFrames, true);
      assert.equal(script.matchOriginAsFallback, true);
      assert.equal(script.persistAcrossSessions, true);
      assert.deepEqual(script.excludeMatches, []);
    }

    const stateResponse = await mock.sendMessage({
      type: 'GET_STATE',
      origin: 'https://site.example',
    });
    assert.equal(stateResponse.ok, true);
    assert.equal(stateResponse.result.site.protected, true);
    mock.stores.sync.settings = {
      ...stateResponse.result.settings,
      autoPurgeOnSuspiciousGrowth: true,
    };

    const sender = {
      id: 'frostguard-test-extension',
      origin: 'https://site.example',
      url: 'https://site.example/frame',
      frameId: 0,
      tab: { id: 7, url: 'https://site.example/page' },
    };
    const eventResponse = await mock.sendMessage(
      {
        type: 'SHIELD_EVENT',
        eventType: 'opfs-blocked',
        detail: { api: 'navigator.storage.getDirectory', blocked: true },
        channel: 'main',
      },
      sender,
    );
    assert.equal(eventResponse.ok, true);
    assert.equal(mock.stores.local.eventLog.length, 1);
    assert.equal(mock.stores.local.eventLog[0].origin, 'https://site.example');
    assert.equal(mock.stores.local.eventLog[0].url, 'https://site.example');
    assert.equal(mock.notifications.length, 0);
    assert.ok(mock.badges.some((entry) => entry.method === 'text' && entry.value.text === '!'));

    const growthResponse = await mock.sendMessage(
      {
        type: 'SHIELD_EVENT',
        eventType: 'storage-growth',
        detail: {
          api: 'navigator.storage.estimate',
          blocked: false,
          reason: 'confirmed-file-system-growth',
          deltaBytes: 256 * 1024 * 1024,
        },
        channel: 'monitor',
      },
      sender,
    );
    assert.equal(growthResponse.ok, true);
    assert.equal(mock.notifications.length, 1);
    assert.equal(mock.notifications[0].options.priority, 0);
    assert.equal(mock.notifications[0].options.buttons, undefined);
    assert.equal(mock.removedBrowsingData.length, 0);

    const badgeCount = mock.badges.length;
    const totalGrowth = await mock.sendMessage(
      {
        type: 'SHIELD_EVENT',
        eventType: 'storage-growth',
        detail: {
          api: 'navigator.storage.estimate',
          blocked: false,
          reason: 'confirmed-total-usage-growth',
          deltaBytes: 512 * 1024 * 1024,
        },
        channel: 'monitor',
      },
      { ...sender, frameId: 1 },
    );
    assert.equal(totalGrowth.ok, true);
    assert.equal(mock.notifications.length, 1);
    assert.equal(mock.badges.length, badgeCount);
    assert.equal(mock.removedBrowsingData.length, 0);

    const duplicate = await mock.sendMessage(
      {
        type: 'SHIELD_EVENT',
        eventType: 'opfs-blocked',
        detail: { api: 'navigator.storage.getDirectory', blocked: true },
        channel: 'main',
      },
      sender,
    );
    assert.equal(duplicate.result.suppressed, true);
    assert.equal(mock.stores.local.eventLog.length, 3);

    const originalConsoleError = console.error;
    console.error = () => undefined;
    const unauthorized = await mock.sendMessage(
      { type: 'PURGE_ORIGIN', origin: 'https://site.example' },
      { id: 'different-extension', url: 'chrome-extension://different-extension/popup.html' },
    ).finally(() => {
      console.error = originalConsoleError;
    });
    assert.equal(unauthorized.ok, false);
    assert.match(unauthorized.error, /not authorized/);

    const temporary = await mock.sendMessage({
      type: 'ALLOW_TEMPORARILY',
      origin: 'https://site.example',
      durationMs: 60_000,
    });
    assert.equal(temporary.ok, true);
    assert.ok(mock.alarmState.has('frostguard-temporary-expiry'));
    assert.ok(
      mock.registered.every((script) =>
        script.excludeMatches.includes('https://site.example/*')),
    );

    await mock.sendMessage({
      type: 'CLEAR_TEMPORARY_ALLOWANCE',
      origin: 'https://site.example',
    });
    assert.ok(
      mock.registered.every((script) =>
        !script.excludeMatches.includes('https://site.example/*')),
    );

    await mock.sendMessage({
      type: 'SET_PERMANENT_ALLOWANCE',
      origin: 'https://trusted.example',
      allowed: true,
    });
    assert.ok(
      mock.registered.every((script) =>
        script.excludeMatches.includes('https://trusted.example/*')),
    );

    const purge = await mock.sendMessage({
      type: 'PURGE_ORIGIN',
      origin: 'https://site.example/path',
      tabId: 7,
      reload: true,
    });
    assert.equal(purge.ok, true);
    assert.deepEqual(mock.removedBrowsingData.at(-1), {
      options: { origins: ['https://site.example'] },
      dataTypes: { fileSystems: true, serviceWorkers: true },
    });
    assert.equal(mock.reloadedTabs.at(-1), 7);

    await mock.sendMessage({ type: 'SET_PROTECTION', enabled: false });
    assert.equal(mock.registered.length, 0);

    await mock.sendMessage({ type: 'SET_PROTECTION', enabled: true });
    assert.equal(mock.registered.length, 2);
    assert.equal(mock.executedScripts.length, 4);
    assert.deepEqual(
      mock.executedScripts.slice(-2).map((entry) => entry.world),
      ['MAIN', 'ISOLATED'],
    );
    assert.deepEqual(mock.executedScripts.at(-1).files, [
      'src/storage-growth-classifier.js',
      'src/bridge.js',
      'src/storage-monitor.js',
    ]);
  } finally {
    delete globalThis.chrome;
  }
});
