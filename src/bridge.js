(() => {
  const INSTALL_KEY = '__frostguard_isolated_bridge_installed_v1__';
  const BRIDGE_API_KEY = '__frostguardIsolatedBridgeV1__';
  const PAGE_MESSAGE_MARKER = '__frostguard_page_event_v1__';
  const BRIDGE_READY_MARKER = '__frostguard_bridge_ready_v1__';
  const DEFAULT_CONFIG = Object.freeze({ bannerEnabled: true });
  const STORAGE_SIGNAL_REASONS = new Set([
    'confirmed-file-system-growth',
    'confirmed-total-usage-growth',
    'large-file-system-usage',
  ]);
  const ALLOWED_PAGE_EVENTS = new Set([
    'opfs-blocked',
    'bucket-opfs-blocked',
    'sync-access-blocked',
    'worker-opfs-blocked',
    'worker-sync-access-blocked',
    'worker-construction-blocked',
    'file-picker-observed',
  ]);

  if (globalThis[INSTALL_KEY]) return;
  Object.defineProperty(globalThis, INSTALL_KEY, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  let config = { ...DEFAULT_CONFIG };
  let bannerHost = null;
  let bannerText = null;
  let bannerMeta = null;
  let bannerEventCount = 0;
  const forwardedAt = new Map();

  function sendMessage(message) {
    try {
      const promise = chrome.runtime.sendMessage(message);
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => undefined);
      }
    } catch {
      // The extension may be reloading. Protection in the main world remains active.
    }
  }

  async function request(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error || 'Extension request failed.');
      return response.result;
    } catch {
      return null;
    }
  }

  function eventCopy(detail) {
    if (!detail || typeof detail !== 'object') return {};
    const result = {};
    for (const key of [
      'api',
      'blocked',
      'context',
      'crossOriginIsolated',
      'secureContext',
      'reason',
      'usageBytes',
      'quotaBytes',
      'fileSystemBytes',
      'deltaBytes',
      'windowMs',
    ]) {
      if (detail[key] !== undefined) result[key] = detail[key];
    }
    return result;
  }

  function bannerMessage(eventType, detail) {
    switch (eventType) {
      case 'opfs-blocked':
      case 'bucket-opfs-blocked':
        return {
          title: 'Hidden browser file-system access blocked',
          text: `${detail.api || 'OPFS access'} can be used to measure SSD activity and fingerprint other activity on this device.`,
        };
      case 'sync-access-blocked':
      case 'worker-sync-access-blocked':
        return {
          title: 'High-speed file timing access blocked',
          text: `${detail.api || 'Synchronous file access'} was denied because it can support storage timing side channels.`,
        };
      case 'worker-opfs-blocked':
        return {
          title: 'Worker-based OPFS access blocked',
          text: 'A background worker attempted to reach origin-private storage without a permission prompt.',
        };
      case 'worker-construction-blocked':
        return {
          title: 'Unshieldable worker blocked',
          text: 'A worker could not be started through the protective bootstrap, so FROST Guard failed closed. This site may need an exception to function.',
        };
      case 'file-picker-observed':
        return {
          title: 'Direct file access requested',
          text: 'Only choose files or folders you intend to share. Very large files can also be abused as a storage timing probe.',
        };
      case 'storage-growth':
        if (detail.reason === 'large-file-system-usage') {
          return {
            title: 'Large browser file-system use detected',
            text: 'This site is using an unusually large amount of browser file-system storage. Legitimate offline apps can do this; review the event before clearing data.',
          };
        }
        return {
          title: 'Confirmed browser-storage growth observed',
          text: 'This site crossed a repeated local browser-storage growth threshold. Legitimate activity can produce the same pattern, so review it before clearing data.',
        };
      default:
        return {
          title: 'Storage side-channel warning',
          text: 'FROST Guard detected suspicious browser file-system behavior.',
        };
    }
  }

  function ensureBanner(eventType, detail = {}) {
    if (!config.bannerEnabled || window !== window.top) return;

    const content = bannerMessage(eventType, detail);
    bannerEventCount += 1;
    const eventLabel = `${bannerEventCount} ${bannerEventCount === 1 ? 'event' : 'events'}`;
    if (bannerHost?.isConnected) {
      bannerText.textContent = content.text;
      bannerMeta.textContent = `${content.title} · ${location.hostname} · ${eventLabel} · updated just now`;
      return;
    }

    const mount = () => {
      if (bannerHost?.isConnected) return;
      const parent = document.documentElement || document.body;
      if (!parent) {
        setTimeout(mount, 25);
        return;
      }

      bannerHost = document.createElement('div');
      bannerHost.setAttribute('data-frostguard-banner', '');
      const shadow = bannerHost.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
       style.textContent = `
        :host {
          all: initial;
          --fg-notice-surface: #fff7ed;
           --fg-notice-text: #3f1d0b;
           --fg-notice-action: #9a3412;
           --fg-notice-action-hover: #7c2d12;
           --fg-notice-border: rgba(127, 29, 29, 0.45);
           --fg-notice-button-surface: #ffffff;
           --fg-notice-button-text: #7c2d12;
           --fg-notice-button-hover: #ffedd5;
           --fg-notice-focus: #0b65c2;
           --fg-notice-shadow: rgba(0, 0, 0, 0.28);
        }
        .panel {
          box-sizing: border-box;
          position: fixed;
          top: 12px;
          right: 12px;
          z-index: 2147483647;
          width: min(420px, calc(100vw - 24px));
          padding: 14px 14px 12px;
          border: 1px solid var(--fg-notice-border);
          border-radius: 12px;
          background: var(--fg-notice-surface);
          color: var(--fg-notice-text);
          box-shadow: 0 12px 34px var(--fg-notice-shadow);
          font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .meta { margin: 0 0 6px; overflow-wrap: anywhere; font-weight: 700; font-size: 13px; }
        .text { margin: 0; overflow-wrap: anywhere; }
        .actions { display: flex; gap: 8px; margin-top: 10px; }
        button {
          appearance: none;
          border: 1px solid var(--fg-notice-action);
          border-radius: 8px;
          background: var(--fg-notice-button-surface);
          color: var(--fg-notice-button-text);
          cursor: pointer;
          font: 600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          padding: 8px 10px;
        }
        button:hover { background: var(--fg-notice-button-hover); }
        button:active { transform: translateY(1px); }
        button:focus-visible { outline: 2px solid var(--fg-notice-focus); outline-offset: 2px; }
        button.primary { background: var(--fg-notice-action); color: var(--fg-notice-button-surface); }
        button.primary:hover { background: var(--fg-notice-action-hover); }
      `;

      const panel = document.createElement('section');
      panel.className = 'panel';
      panel.setAttribute('role', 'status');
      panel.setAttribute('aria-live', 'polite');
      panel.setAttribute('aria-atomic', 'true');

      bannerMeta = document.createElement('p');
      bannerMeta.className = 'meta';
      bannerMeta.textContent = `${content.title} · ${location.hostname} · ${eventLabel}`;

      bannerText = document.createElement('p');
      bannerText.className = 'text';
      bannerText.textContent = content.text;

      const actions = document.createElement('div');
      actions.className = 'actions';

      const review = document.createElement('button');
      review.className = 'primary';
      review.type = 'button';
      review.textContent = 'Open event log';
      review.addEventListener('click', () => {
        sendMessage({ type: 'OPEN_OPTIONS' });
      });

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => bannerHost?.remove());

      actions.append(review, dismiss);
      panel.append(bannerMeta, bannerText, actions);
      shadow.append(style, panel);
      parent.appendChild(bannerHost);
    };

    mount();
  }

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data[PAGE_MESSAGE_MARKER] !== true || data.version !== 1) return;
      if (!ALLOWED_PAGE_EVENTS.has(data.eventType)) return;

      const detail = eventCopy(data.detail);
      const key = `${data.eventType}:${typeof detail.api === 'string' ? detail.api : ''}`;
      const now = Date.now();
      const last = forwardedAt.get(key) || 0;
      if (now - last < 1_500) return;
      forwardedAt.set(key, now);
      if (forwardedAt.size > 100) {
        for (const [eventKey, at] of forwardedAt) {
          if (now - at > 60_000) forwardedAt.delete(eventKey);
        }
      }

      sendMessage({
        type: 'SHIELD_EVENT',
        eventType: data.eventType,
        detail,
        channel: 'main',
      });
      if (data.eventType !== 'file-picker-observed') {
        ensureBanner(data.eventType, detail);
      }
    },
    true,
  );

  try {
    window.postMessage({ [BRIDGE_READY_MARKER]: true }, '*');
  } catch {
    // Events generated after this point are still delivered normally.
  }

  async function getStorageConfig() {
    const loaded = await request({ type: 'GET_BRIDGE_CONFIG' });
    if (!loaded) return null;
    config = { bannerEnabled: loaded.bannerEnabled !== false };
    return Object.freeze({ ...loaded });
  }

  function reportStorageSignal(signal) {
    if (!signal || !STORAGE_SIGNAL_REASONS.has(signal.reason)) return;
    const detail = eventCopy(signal);
    sendMessage({
      type: 'SHIELD_EVENT',
      eventType: 'storage-growth',
      detail,
      channel: 'monitor',
    });
    if (signal.reason !== 'confirmed-total-usage-growth') {
      ensureBanner('storage-growth', detail);
    }
  }

  Object.defineProperty(globalThis, BRIDGE_API_KEY, {
    value: Object.freeze({ getStorageConfig, reportStorageSignal }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
