import { normalizeOrigin } from './shared.js';

const elements = {
  protectionToggle: document.querySelector('#protection-toggle'),
  statusCard: document.querySelector('#status-card'),
  statusTitle: document.querySelector('#status-title'),
  siteOrigin: document.querySelector('#site-origin'),
  statusDetail: document.querySelector('#status-detail'),
  siteControls: document.querySelector('#site-controls'),
  temporaryButton: document.querySelector('#temporary-button'),
  permanentButton: document.querySelector('#permanent-button'),
  purgeButton: document.querySelector('#purge-button'),
  siteBlocked: document.querySelector('#site-blocked'),
  allBlocked: document.querySelector('#all-blocked'),
  growthCount: document.querySelector('#growth-count'),
  lastEvent: document.querySelector('#last-event'),
  feedback: document.querySelector('#feedback'),
  settingsButton: document.querySelector('#settings-button'),
  version: document.querySelector('#version'),
  purgeDialog: document.querySelector('#purge-dialog'),
  purgeOrigin: document.querySelector('#purge-origin'),
  confirmPurge: document.querySelector('#confirm-purge'),
};

let activeTab = null;
let origin = null;
let state = null;
let busy = false;

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Extension request failed.');
  return response.result;
}

function setBusy(value) {
  busy = value;
  elements.confirmPurge.disabled = value;
  render();
}

function showFeedback(message = '', isError = false) {
  elements.feedback.textContent = message;
  elements.feedback.dataset.tone = isError ? 'error' : 'success';
}

function errorMessage() {
  return 'FROST Guard could not complete that action. Try again or open Settings for details.';
}

function eventLabel(event) {
  if (!event) return 'No events recorded.';
  const labels = {
    'opfs-blocked': 'Blocked OPFS access',
    'bucket-opfs-blocked': 'Blocked storage-bucket OPFS access',
    'sync-access-blocked': 'Blocked synchronous file access',
    'worker-opfs-blocked': 'Blocked worker OPFS access',
    'worker-sync-access-blocked': 'Blocked worker file timing access',
    'worker-construction-blocked': 'Blocked an unshieldable worker',
    'storage-growth': 'Flagged suspicious storage growth',
    'file-picker-observed': 'Observed a file picker',
    'site-storage-purged': 'Purged site storage',
  };
  const when = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(event.at));
  return `${labels[event.type] || event.type} · ${when}`;
}

function render() {
  if (!state) return;
  const site = state.site;
  elements.protectionToggle.checked = state.settings.protectionEnabled;
  elements.protectionToggle.disabled = busy;
  elements.siteOrigin.textContent = site.origin || 'Chrome internal or unsupported page';
  elements.siteControls.hidden = !site.supported;

  let title = 'Protection unavailable';
  let detail = 'Chrome extensions cannot inject into this page.';
  let tone = 'warn';

  if (site.reason === 'protected') {
    title = 'Protection active';
    detail = 'Unprompted OPFS and high-speed worker file access are blocked.';
    tone = 'safe';
  } else if (site.reason === 'protection-disabled') {
    title = 'Protection disabled globally';
    detail = 'Enable the switch, then reload this tab to restore blocking.';
    tone = 'off';
  } else if (site.reason === 'temporary-allowlist') {
    title = 'Temporarily allowed';
    const until = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(site.temporaryUntil));
    detail = `This site is excluded until ${until}.`;
    tone = 'warn';
  } else if (site.reason === 'permanent-allowlist') {
    title = 'Always allowed';
    detail = 'This site is excluded from blocking until you remove the exception.';
    tone = 'warn';
  }

  elements.statusCard.dataset.tone = tone;
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;

  elements.temporaryButton.textContent =
    site.reason === 'temporary-allowlist'
      ? 'Protect now & reload'
      : 'Allow & reload for 1 hour';
  elements.temporaryButton.disabled =
    busy ||
    !site.supported ||
    !state.settings.protectionEnabled ||
    site.permanentlyAllowed;
  elements.permanentButton.textContent = site.permanentlyAllowed
    ? 'Remove exception & reload'
    : 'Always allow & reload';
  elements.permanentButton.disabled =
    busy || !site.supported || !state.settings.protectionEnabled;
  elements.purgeButton.disabled = busy || !site.supported;

  elements.siteBlocked.textContent = String(state.summary.blocked || 0);
  elements.allBlocked.textContent = String(state.totalSummary.blocked || 0);
  elements.growthCount.textContent = String(state.totalSummary.storageGrowth || 0);
  elements.lastEvent.textContent = eventLabel(state.summary.lastEvent || state.totalSummary.lastEvent);
}

async function reloadActiveTab() {
  if (Number.isInteger(activeTab?.id)) {
    await chrome.tabs.reload(activeTab.id).catch(() => undefined);
  }
}

async function refresh() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  origin = normalizeOrigin(activeTab?.url || '');
  state = await request({ type: 'GET_STATE', origin });
  render();
  if (Number.isInteger(activeTab?.id)) {
    await request({ type: 'ACKNOWLEDGE_TAB_ALERT', tabId: activeTab.id });
  }
}

elements.protectionToggle.addEventListener('change', async () => {
  setBusy(true);
  showFeedback();
  try {
    await request({
      type: 'SET_PROTECTION',
      enabled: elements.protectionToggle.checked,
    });
    await reloadActiveTab();
    await refresh();
    showFeedback(elements.protectionToggle.checked ? 'Protection enabled.' : 'Protection disabled.');
  } catch {
    showFeedback(errorMessage(), true);
    await refresh().catch(() => undefined);
  } finally {
    setBusy(false);
  }
});

elements.temporaryButton.addEventListener('click', async () => {
  if (!origin || !state) return;
  setBusy(true);
  showFeedback();
  try {
    const restoringProtection = state.site.reason === 'temporary-allowlist';
    if (restoringProtection) {
      await request({ type: 'CLEAR_TEMPORARY_ALLOWANCE', origin });
    } else {
      await request({ type: 'ALLOW_TEMPORARILY', origin, durationMs: 60 * 60 * 1000 });
    }
    await reloadActiveTab();
    await refresh();
    showFeedback(
      restoringProtection
        ? 'Protection restored; the tab reloaded.'
        : 'Allowed for 1 hour; the tab reloaded.',
    );
  } catch {
    showFeedback(errorMessage(), true);
  } finally {
    setBusy(false);
  }
});

elements.permanentButton.addEventListener('click', async () => {
  if (!origin || !state) return;
  setBusy(true);
  showFeedback();
  try {
    const removingException = state.site.permanentlyAllowed;
    await request({
      type: 'SET_PERMANENT_ALLOWANCE',
      origin,
      allowed: !state.site.permanentlyAllowed,
    });
    if (state.site.reason === 'temporary-allowlist') {
      await request({ type: 'CLEAR_TEMPORARY_ALLOWANCE', origin });
    }
    await reloadActiveTab();
    await refresh();
    showFeedback(
      removingException
        ? 'Permanent exception removed; the tab reloaded.'
        : 'Permanent exception added; the tab reloaded.',
    );
  } catch {
    showFeedback(errorMessage(), true);
  } finally {
    setBusy(false);
  }
});

async function purgeSite() {
  if (!origin) return;
  setBusy(true);
  showFeedback();
  try {
    await request({
      type: 'PURGE_ORIGIN',
      origin,
      tabId: activeTab?.id,
      reload: true,
    });
    await refresh();
    showFeedback('Site file-system data and service worker purged.');
  } catch {
    showFeedback(errorMessage(), true);
  } finally {
    setBusy(false);
  }
}

elements.purgeButton.addEventListener('click', () => {
  if (!origin) return;
  elements.purgeOrigin.textContent = origin;
  elements.purgeDialog.showModal();
});

elements.purgeDialog.addEventListener('close', () => {
  if (elements.purgeDialog.returnValue === 'confirm') {
    void purgeSite();
  }
});

elements.settingsButton.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage().catch(() => showFeedback(errorMessage(), true));
});

elements.version.textContent = `v${chrome.runtime.getManifest().version}`;

void refresh().catch(() => {
  elements.statusCard.dataset.tone = 'off';
  elements.statusTitle.textContent = 'Unable to load extension state';
  elements.statusDetail.textContent = 'Open Settings or reload the extension, then try again.';
  showFeedback(errorMessage(), true);
});
