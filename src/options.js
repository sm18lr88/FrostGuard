import {
  DEFAULT_SETTINGS,
  formatBytes,
  normalizeOrigin,
  normalizeSettings,
  summarizeEvents,
} from './shared.js';

const MiB = 1024 * 1024;
const elements = {
  heroTitle: document.querySelector('#hero-title'),
  heroCopy: document.querySelector('#hero-copy'),
  protectionEnabled: document.querySelector('#protection-enabled'),
  notificationsEnabled: document.querySelector('#notifications-enabled'),
  bannerEnabled: document.querySelector('#banner-enabled'),
  monitorEnabled: document.querySelector('#monitor-enabled'),
  autoPurgeEnabled: document.querySelector('#auto-purge-enabled'),
  fsGrowthMiB: document.querySelector('#fs-growth-mib'),
  totalGrowthMiB: document.querySelector('#total-growth-mib'),
  absoluteFsMiB: document.querySelector('#absolute-fs-mib'),
  saveButton: document.querySelector('#save-button'),
  saveStatus: document.querySelector('#save-status'),
  allowlistForm: document.querySelector('#allowlist-form'),
  allowlistOrigin: document.querySelector('#allowlist-origin'),
  allowlist: document.querySelector('#allowlist'),
  eventTotal: document.querySelector('#event-total'),
  eventTotalLabel: document.querySelector('#event-total-label'),
  eventBlocked: document.querySelector('#event-blocked'),
  eventGrowth: document.querySelector('#event-growth'),
  eventGrowthLabel: document.querySelector('#event-growth-label'),
  eventRows: document.querySelector('#event-rows'),
  emptyEvents: document.querySelector('#empty-events'),
  exportEvents: document.querySelector('#export-events'),
  clearEvents: document.querySelector('#clear-events'),
  clearEventsDialog: document.querySelector('#clear-events-dialog'),
  autoPurgeDialog: document.querySelector('#auto-purge-dialog'),
  allowlistError: document.querySelector('#allowlist-error'),
  eventLimitNote: document.querySelector('#event-limit-note'),
  buildInfo: document.querySelector('#build-info'),
};

let settings = { ...DEFAULT_SETTINGS };
let events = [];
let autoPurgeConfirmed = false;
let settingsDirty = false;

for (const input of [
  elements.protectionEnabled,
  elements.notificationsEnabled,
  elements.bannerEnabled,
  elements.monitorEnabled,
  elements.fsGrowthMiB,
  elements.totalGrowthMiB,
  elements.absoluteFsMiB,
]) {
  input.addEventListener('input', () => {
    settingsDirty = true;
  });
}

window.addEventListener('beforeunload', (event) => {
  if (!settingsDirty) return;
  event.preventDefault();
  event.returnValue = '';
});

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Extension request failed.');
  return response.result;
}

function setStatus(message, error = false) {
  elements.saveStatus.textContent = message;
  elements.saveStatus.dataset.tone = error ? 'error' : 'success';
}

function setAllowlistError(message = '') {
  elements.allowlistError.textContent = message;
  elements.allowlistOrigin.setAttribute('aria-invalid', String(message !== ''));
}

function messageFromError(error) {
  return error instanceof Error && error.message
    ? error.message
    : 'FROST Guard could not complete that action. Try again.';
}

function valueInMiB(input, fallbackBytes) {
  const number = Number(input.value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * MiB) : fallbackBytes;
}

function settingsFromForm() {
  return normalizeSettings({
    ...settings,
    protectionEnabled: elements.protectionEnabled.checked,
    notificationsEnabled: elements.notificationsEnabled.checked,
    bannerEnabled: elements.bannerEnabled.checked,
    storageMonitorEnabled: elements.monitorEnabled.checked,
    autoPurgeOnSuspiciousGrowth: false,
    fileSystemGrowthThresholdBytes: valueInMiB(
      elements.fsGrowthMiB,
      DEFAULT_SETTINGS.fileSystemGrowthThresholdBytes,
    ),
    totalGrowthThresholdBytes: valueInMiB(
      elements.totalGrowthMiB,
      DEFAULT_SETTINGS.totalGrowthThresholdBytes,
    ),
    absoluteFileSystemWarningBytes: valueInMiB(
      elements.absoluteFsMiB,
      DEFAULT_SETTINGS.absoluteFileSystemWarningBytes,
    ),
  });
}

function fillForm() {
  elements.protectionEnabled.checked = settings.protectionEnabled;
  elements.notificationsEnabled.checked = settings.notificationsEnabled;
  elements.bannerEnabled.checked = settings.bannerEnabled;
  elements.monitorEnabled.checked = settings.storageMonitorEnabled;
  elements.autoPurgeEnabled.checked = false;
  autoPurgeConfirmed = false;
  elements.fsGrowthMiB.value = String(Math.round(settings.fileSystemGrowthThresholdBytes / MiB));
  elements.totalGrowthMiB.value = String(Math.round(settings.totalGrowthThresholdBytes / MiB));
  elements.absoluteFsMiB.value = String(Math.round(settings.absoluteFileSystemWarningBytes / MiB));
  elements.heroTitle.textContent = settings.protectionEnabled
    ? 'Protection is enabled'
    : 'Protection is disabled';
  elements.heroCopy.textContent = settings.protectionEnabled
    ? 'Protected pages receive the shield at document start.'
    : 'No blocking scripts are registered. Existing tabs require a reload after re-enabling.';
}

function renderAllowlist() {
  elements.allowlist.replaceChildren();
  if (settings.permanentAllowlist.length === 0) {
    const item = document.createElement('li');
    item.className = 'empty-row';
    item.textContent = 'No permanent exceptions.';
    elements.allowlist.append(item);
    return;
  }

  for (const origin of settings.permanentAllowlist) {
    const item = document.createElement('li');
    const label = document.createElement('code');
    label.textContent = origin;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await request({ type: 'SET_PERMANENT_ALLOWANCE', origin, allowed: false });
        settings.permanentAllowlist = settings.permanentAllowlist.filter(
          (value) => value !== origin,
        );
        renderAllowlist();
        setStatus(`Removed ${origin}. Reload affected tabs.`);
      } catch (error) {
        setStatus(error.message, true);
        remove.disabled = false;
      }
    });
    item.append(label, remove);
    elements.allowlist.append(item);
  }
}

function eventTitle(type) {
  const labels = {
    'opfs-blocked': 'OPFS blocked',
    'bucket-opfs-blocked': 'Bucket OPFS blocked',
    'sync-access-blocked': 'Sync access blocked',
    'worker-opfs-blocked': 'Worker OPFS blocked',
    'worker-sync-access-blocked': 'Worker timing blocked',
    'worker-construction-blocked': 'Unshieldable worker blocked',
    'storage-growth': 'Storage growth alert',
    'file-picker-observed': 'File picker observed',
    'site-storage-purged': 'Site storage purged',
  };
  return labels[type] || type || 'Unknown event';
}

function eventDetails(event) {
  const detail = event?.detail || {};
  const parts = [];
  if (detail.api) parts.push(detail.api);
  if (Number.isFinite(detail.deltaBytes) && detail.deltaBytes > 0) {
    parts.push(`grew ${formatBytes(detail.deltaBytes)}`);
  }
  if (Number.isFinite(detail.fileSystemBytes) && detail.fileSystemBytes > 0) {
    parts.push(`OPFS ${formatBytes(detail.fileSystemBytes)}`);
  }
  if (detail.context) parts.push(detail.context);
  return parts.join(' · ') || 'No additional detail';
}

function renderEvents() {
  const summary = summarizeEvents(events);
  elements.eventTotal.textContent = String(summary.total);
  elements.eventTotalLabel.textContent = summary.total === 1 ? 'event' : 'events';
  elements.eventBlocked.textContent = String(summary.blocked);
  elements.eventGrowth.textContent = String(summary.storageGrowth);
  elements.eventGrowthLabel.textContent = summary.storageGrowth === 1
    ? 'growth alert'
    : 'growth alerts';
  elements.eventRows.replaceChildren();
  elements.emptyEvents.hidden = events.length > 0;
  elements.exportEvents.disabled = events.length === 0;
  elements.clearEvents.disabled = events.length === 0;
  elements.eventLimitNote.hidden = events.length <= 100;

  for (const event of events.slice(0, 100)) {
    const row = document.createElement('tr');

    const timeCell = document.createElement('td');
    const date = new Date(event.at);
    timeCell.textContent = new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    }).format(date);

    const originCell = document.createElement('td');
    originCell.textContent = event.origin || 'Unknown origin';

    const eventCell = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `event-pill${event.detail?.blocked ? ' blocked' : ''}`;
    pill.textContent = eventTitle(event.type);
    eventCell.append(pill);

    const detailsCell = document.createElement('td');
    detailsCell.textContent = eventDetails(event);
    if (event.detail?.reason) {
      const reason = document.createElement('small');
      reason.textContent = event.detail.reason;
      detailsCell.append(reason);
    }

    row.append(timeCell, originCell, eventCell, detailsCell);
    elements.eventRows.append(row);
  }
}

async function load() {
  const [state, eventResult] = await Promise.all([
    request({ type: 'GET_STATE' }),
    request({ type: 'GET_EVENTS' }),
  ]);
  settings = normalizeSettings(state.settings);
  events = Array.isArray(eventResult.events) ? eventResult.events : [];
  fillForm();
  renderAllowlist();
  renderEvents();
}

function appendBuildFact(list, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  list.append(term, description);
}

async function loadBuildInfo() {
  const [manifestResponse, packageResponse] = await Promise.all([
    fetch(chrome.runtime.getURL('manifest.json')),
    fetch(chrome.runtime.getURL('package.json')),
  ]);
  if (!manifestResponse.ok || !packageResponse.ok) {
    throw new Error('Packaged build metadata is unavailable.');
  }

  const [manifest, packageJson] = await Promise.all([
    manifestResponse.json(),
    packageResponse.json(),
  ]);
  const dependencies = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };
  const metadata = packageJson.frostguardMetadata || {};

  const sourceNote = document.createElement('p');
  sourceNote.textContent = 'Generated directly from the packaged manifest and package metadata. No AI, telemetry, external service, or runtime network request is used.';

  const facts = document.createElement('dl');
  appendBuildFact(facts, 'Version', String(manifest.version));
  appendBuildFact(facts, 'Platform', `Chrome Manifest V${manifest.manifest_version}, Chrome ${manifest.minimum_chrome_version}+`);
  appendBuildFact(facts, 'Implementation', metadata.implementation || 'Browser-native JavaScript modules with no bundler');
  appendBuildFact(facts, 'Node checks', String(packageJson.engines?.node || 'Not specified'));
  appendBuildFact(facts, 'Last reviewed', String(metadata.lastReviewed || 'Not specified'));

  const packageHeading = document.createElement('p');
  const packageNames = Object.keys(dependencies).sort((a, b) => a.localeCompare(b));
  packageHeading.textContent = packageNames.length === 0
    ? 'npm packages: none. Runtime and development dependency counts are both 0.'
    : `npm packages (${packageNames.length}): ${packageNames.join(', ')}`;

  const scriptHeading = document.createElement('p');
  scriptHeading.textContent = 'Reproducible checks:';
  const scriptList = document.createElement('ul');
  for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    const item = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = `npm run ${name}`;
    item.append(code, ` — ${command}`);
    scriptList.append(item);
  }

  const referenceHeading = document.createElement('p');
  referenceHeading.textContent = 'Research and platform references:';
  const referenceList = document.createElement('ul');
  for (const reference of Array.isArray(metadata.references) ? metadata.references : []) {
    if (!reference || typeof reference.title !== 'string' || typeof reference.url !== 'string') {
      continue;
    }
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = reference.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = reference.title;
    item.append(link);
    referenceList.append(item);
  }

  elements.buildInfo.replaceChildren(
    sourceNote,
    facts,
    packageHeading,
    scriptHeading,
    scriptList,
    referenceHeading,
    referenceList,
  );
}

elements.saveButton.addEventListener('click', async () => {
  elements.saveButton.disabled = true;
  setStatus('Saving…');
  try {
    settings = settingsFromForm();
    await chrome.storage.sync.set({ settings });
    await request({ type: 'SET_PROTECTION', enabled: settings.protectionEnabled });
    fillForm();
    settingsDirty = false;
    setStatus('Settings saved. Reload open tabs after changing protection or exceptions.');
  } catch (error) {
    setStatus(messageFromError(error), true);
  } finally {
    elements.saveButton.disabled = false;
  }
});

elements.protectionEnabled.addEventListener('change', () => {
  elements.heroTitle.textContent = elements.protectionEnabled.checked
    ? 'Protection will be enabled'
    : 'Protection will be disabled';
  elements.heroCopy.textContent = 'Select “Save settings” to apply this change.';
});

elements.autoPurgeEnabled.addEventListener('change', () => {
  if (elements.autoPurgeEnabled.checked && !autoPurgeConfirmed) {
    elements.autoPurgeDialog.showModal();
  }
});

elements.autoPurgeDialog.addEventListener('close', () => {
  autoPurgeConfirmed = elements.autoPurgeDialog.returnValue === 'confirm';
  elements.autoPurgeEnabled.checked = autoPurgeConfirmed;
  if (autoPurgeConfirmed) {
    setStatus('Auto-purge will be enabled after you save settings.');
  }
});

elements.allowlistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const origin = normalizeOrigin(elements.allowlistOrigin.value);
  if (!origin) {
    setAllowlistError('Enter a complete http:// or https:// origin.');
    elements.allowlistOrigin.focus();
    return;
  }
  setAllowlistError();
  try {
    await request({ type: 'SET_PERMANENT_ALLOWANCE', origin, allowed: true });
    settings.permanentAllowlist = [...new Set([...settings.permanentAllowlist, origin])]
      .sort((a, b) => a.localeCompare(b));
    elements.allowlistOrigin.value = '';
    renderAllowlist();
    setStatus(`Added ${origin}. Reload affected tabs.`);
  } catch (error) {
    setStatus(messageFromError(error), true);
  }
});

elements.exportEvents.addEventListener('click', () => {
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      extension: `FROST Guard ${chrome.runtime.getManifest().version}`,
      events,
    },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `frostguard-events-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  setStatus('Event log exported.');
});

async function clearEventLog() {
  try {
    await request({ type: 'CLEAR_EVENTS' });
    events = [];
    renderEvents();
    setStatus('Event log cleared.');
  } catch (error) {
    setStatus(messageFromError(error), true);
  }
}

elements.clearEvents.addEventListener('click', () => {
  elements.clearEventsDialog.showModal();
});

elements.clearEventsDialog.addEventListener('close', () => {
  if (elements.clearEventsDialog.returnValue === 'confirm') {
    void clearEventLog();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.eventLog) {
    events = Array.isArray(changes.eventLog.newValue) ? changes.eventLog.newValue : [];
    renderEvents();
  }
});

void Promise.all([load(), loadBuildInfo()]).catch((error) => {
  setStatus(messageFromError(error), true);
  if (elements.buildInfo.textContent?.includes('Reading')) {
    elements.buildInfo.textContent = 'Build metadata could not be read from this package.';
  }
});
