import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windowsLockOwnerScript = path.join(root, 'tools', 'windows-lock-owners.ps1');

function localBrowserCandidates() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return [];
  const playwrightRoot = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  if (!existsSync(playwrightRoot)) return [];
  return readdirSync(playwrightRoot)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) => path.join(playwrightRoot, name, 'chrome-win64', 'chrome.exe'))
    .filter(existsSync);
}

const candidates = [
  process.env.CHROME_BIN,
  ...localBrowserCandidates(),
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
].filter(Boolean);

function findBrowser() {
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && existsSync(candidate)) return candidate;
    if (process.platform === 'win32') continue;
    const result = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(candidate)}`], {
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error('No extension-capable Chromium executable found. Install Playwright Chromium or set CHROME_BIN to Chromium/Chrome for Testing.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonOutput(output, fallback = []) {
  const text = String(output || '').trim();
  if (!text) return fallback;
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function runPowerShell(command, env = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
}

function snapshotProcessTree(rootPid) {
  if (process.platform !== 'win32' || !Number.isInteger(rootPid)) return [];
  const command = `
    $all = @(Get-CimInstance Win32_Process)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add([int]$env:FG_ROOT_PID)
    do {
      $before = $ids.Count
      foreach ($process in $all) {
        if ($ids.Contains([int]$process.ParentProcessId)) {
          [void]$ids.Add([int]$process.ProcessId)
        }
      }
    } while ($ids.Count -ne $before)
    @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object {
      $live = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      if ($live) {
        [pscustomobject]@{
          pid = [int]$_.ProcessId
          parentPid = [int]$_.ParentProcessId
          creationFileTime = [long]$live.StartTime.ToUniversalTime().ToFileTimeUtc()
          executablePath = [string]$_.ExecutablePath
        }
      }
    }) | ConvertTo-Json -Compress
  `;
  const result = runPowerShell(command, { FG_ROOT_PID: String(rootPid) });
  if (result.status !== 0) return [];
  return parseJsonOutput(result.stdout);
}

function currentProcessIdentity(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return null;
  const command = `
    $process = Get-Process -Id ([int]$env:FG_PID) -ErrorAction SilentlyContinue
    if ($process) {
      [pscustomobject]@{
        pid = [int]$process.Id
        creationFileTime = [long]$process.StartTime.ToUniversalTime().ToFileTimeUtc()
      } | ConvertTo-Json -Compress
    }
  `;
  const result = runPowerShell(command, { FG_PID: String(pid) });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

function getWindowsLockOwners(filePath) {
  if (process.platform !== 'win32') return [];
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', windowsLockOwnerScript, '-Path', filePath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return [];
  return parseJsonOutput(result.stdout);
}

function killCapturedProcess(owner, capturedProcesses) {
  const captured = capturedProcesses.get(Number(owner.Pid));
  if (!captured || Number(captured.creationFileTime) !== Number(owner.CreationFileTime)) {
    return false;
  }
  const current = currentProcessIdentity(Number(owner.Pid));
  if (!current || Number(current.creationFileTime) !== Number(captured.creationFileTime)) {
    return false;
  }
  const result = spawnSync('taskkill.exe', ['/PID', String(owner.Pid), '/F'], {
    encoding: 'utf8',
  });
  if (result.status === 0) {
    console.log(`cleanup-action pid=${owner.Pid} action=taskkill`);
    return true;
  }
  return false;
}

async function closeServer(server) {
  const closed = new Promise((resolve) => server.close(resolve));
  const finished = await Promise.race([
    closed.then(() => true),
    sleep(2_000).then(() => false),
  ]);
  if (!finished && typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
    await Promise.race([closed, sleep(2_000)]);
  }
}

async function removeProfile(profile, capturedProcesses) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  let lastOwners = [];
  while (Date.now() < deadline) {
    try {
      await rm(profile, { recursive: true, force: true });
      console.log('cleanup-ok browser=gone server=closed profile=removed');
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      lastError = error;
      lastOwners = getWindowsLockOwners(error.path || profile);
      for (const owner of lastOwners) {
        const owned = capturedProcesses.has(Number(owner.Pid)) &&
          Number(capturedProcesses.get(Number(owner.Pid)).creationFileTime) ===
            Number(owner.CreationFileTime);
        console.log(
          `cleanup-lock path=${error.path || profile} pid=${owner.Pid} owner=${owned ? 'launched-chrome-descendant' : 'external-or-unknown'}`,
        );
        if (owned) killCapturedProcess(owner, capturedProcesses);
      }
      await sleep(250);
    }
  }
  throw new Error(
    `Could not remove Chromium profile: ${lastError?.code || 'unknown'} ${lastError?.path || profile}; owners=${JSON.stringify(lastOwners)}`,
  );
}

async function waitFor(fn, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed.')), {
        once: true,
      });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

const parentPage = `<!doctype html><meta charset="utf-8">
<title>FROST Guard smoke test</title>
<div id="result">pending</div>
<script>
setTimeout(() => {
  const frame = document.createElement('iframe');
  frame.src = '/probe?cache=' + Date.now();
  document.body.append(frame);
}, 4000);
addEventListener('message', (event) => {
  if (!event.data || event.data.kind !== 'probe-result') return;
  const node = document.querySelector('#result');
  node.textContent = event.data.result;
  node.dataset.outcome = event.data.result;
  node.dataset.environment = JSON.stringify(event.data.environment);
});
</script>`;

const probePage = `<!doctype html><meta charset="utf-8">
<script>
(async () => {
  let result = 'NOT_BLOCKED';
  try {
    await navigator.storage.getDirectory();
  } catch (error) {
    result = error && error.name ? error.name : 'BLOCKED_WITHOUT_NAME';
  }
  parent.postMessage({
    kind: 'probe-result',
    result,
    environment: {
      secureContext: isSecureContext,
      getDirectoryType: typeof navigator.storage?.getDirectory,
    },
  }, '*');
})();
</script>`;

const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(request.url?.startsWith('/probe') ? probePage : parentPage);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const profile = await mkdtemp(path.join(os.tmpdir(), 'frostguard-chrome-'));
const browser = findBrowser();
// Some managed CI images block direct navigation to 127.0.0.1. Use a reserved
// test hostname and map it to the loopback server inside Chromium.
const targetOrigin = `http://frostguard.test:${port}`;
const targetUrl = `${targetOrigin}/`;
let child = null;
let cdp = null;
let optionsCdp = null;
let browserCdp = null;
let optionsTargetId = null;
let childClosed = Promise.resolve();
let capturedProcesses = new Map();
let stderr = '';

try {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-proxy-server',
    '--host-resolver-rules=MAP frostguard.test 127.0.0.1',
    `--unsafely-treat-insecure-origin-as-secure=${targetOrigin}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    targetUrl,
  ];

  child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  childClosed = new Promise((resolve) => child.once('close', resolve));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  capturedProcesses = new Map(
    snapshotProcessTree(child.pid).map((processInfo) => [Number(processInfo.pid), processInfo]),
  );

  const activePortPath = path.join(profile, 'DevToolsActivePort');
  const activePortText = await waitFor(
    async () => readFile(activePortPath, 'utf8'),
    10_000,
    'Chromium DevTools endpoint',
  );
  const debugPort = Number(activePortText.split(/\r?\n/, 1)[0]);
  assert.ok(Number.isInteger(debugPort) && debugPort > 0, 'Invalid DevTools port.');

  const browserVersion = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
    .then((response) => response.json());
  browserCdp = new CdpClient(browserVersion.webSocketDebuggerUrl);

  const pageTarget = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await response.json();
    return targets.find(
      (target) => target.type === 'page' && target.url.startsWith(targetUrl),
    );
  }, 10_000, 'test page target');

  const extensionWorkerTarget = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await response.json();
    return targets.find(
      (target) => target.type === 'service_worker' &&
        target.url.endsWith('/src/service-worker.js'),
    );
  }, 10_000, 'FROST Guard service worker (Chrome Stable 137+ does not permit command-line unpacked extension loading; use Chromium or Chrome for Testing)');

  cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  let outcome;
  let skippedByPolicy = false;
  try {
    outcome = await waitFor(async () => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `document.querySelector('#result')?.dataset.outcome || ''`,
        returnByValue: true,
      });
      return result?.result?.value || '';
    }, 15_000, 'OPFS probe result');
  } catch (error) {
    const dom = await cdp.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    }).catch(() => null);
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      .then((response) => response.json())
      .catch(() => []);
    const domText = String(dom?.result?.value || '');
    if (
      /Your organization doesn.t allow you to view this site/i.test(domText) ||
      /"summary":\{"msg":"Your organization/i.test(domText)
    ) {
      skippedByPolicy = true;
      console.log(
        'SKIP: managed Chromium URL policy blocks all HTTP(S) test pages in this environment.',
      );
    } else {
      throw new Error(
      `${error.message}\nDOM: ${String(dom?.result?.value || '').slice(-4000)}` +
      `\nTargets: ${JSON.stringify(targets.map(({ type, url, title }) => ({ type, url, title })))}` +
      `\nChromium diagnostics: ${stderr.slice(-4000)}`,
      );
    }
  }

  if (!skippedByPolicy) {
    const environmentResult = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('#result')?.dataset.environment || ''`,
      returnByValue: true,
    });
    const environment = environmentResult?.result?.value || '';
    assert.equal(
      outcome,
      'SecurityError',
      `OPFS probe outcome was ${JSON.stringify(outcome)} with environment ${environment}. Chromium diagnostics:\n${stderr.slice(-3000)}`,
    );

    const extensionOrigin = new URL(extensionWorkerTarget.url).origin;
    const optionsTarget = await browserCdp.send('Target.createTarget', {
      url: `${extensionOrigin}/src/options.html`,
    });
    optionsTargetId = optionsTarget.targetId;
    const optionsPageTarget = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      return targets.find((target) => target.id === optionsTargetId);
    }, 10_000, 'FROST Guard options page target');
    optionsCdp = new CdpClient(optionsPageTarget.webSocketDebuggerUrl);
    await optionsCdp.send('Page.enable');
    await optionsCdp.send('Runtime.enable');
    await optionsCdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const optionsWidth = await waitFor(async () => {
      const result = await optionsCdp.send('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && document.querySelector('#hero-title')?.textContent !== 'Loading…' ? ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }) : null`,
        returnByValue: true,
      });
      return result?.result?.value || null;
    }, 10_000, 'responsive options page');
    assert.equal(
      optionsWidth.scrollWidth,
      optionsWidth.innerWidth,
      `Options page overflowed horizontally at 375px: ${JSON.stringify(optionsWidth)}`,
    );
    console.log(`Chromium smoke test passed with ${browser}.`);
  }
} finally {
  for (const processInfo of snapshotProcessTree(child?.pid)) {
    capturedProcesses.set(Number(processInfo.pid), processInfo);
  }
  if (browserCdp && child?.exitCode === null) {
    await Promise.race([
      browserCdp.send('Browser.close').catch(() => undefined),
      sleep(2_000),
    ]);
  }
  cdp?.close();
  optionsCdp?.close();
  if (browserCdp && optionsTargetId) {
    await browserCdp.send('Target.closeTarget', { targetId: optionsTargetId }).catch(() => undefined);
  }
  browserCdp?.close();
  if (child && child.exitCode === null) {
    const closed = await Promise.race([
      childClosed.then(() => true),
      sleep(5_000).then(() => false),
    ]);
    if (!closed && process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
      await Promise.race([childClosed, sleep(5_000)]);
    } else if (!closed) {
      child.kill('SIGKILL');
      await Promise.race([childClosed, sleep(5_000)]);
    }
  }
  await closeServer(server);
  await removeProfile(profile, capturedProcesses);
}
