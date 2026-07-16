import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpClient, findBrowser, sleep, waitFor } from './chromium-cdp.mjs';
import { runScenarios, scenarioPage, scenarios } from './calibration-scenarios.mjs';
import { parseTargets, publicCheckpointTraces } from './calibration-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MiB = 1024 * 1024;

async function collectPageTrace(cdp, sampleCount, intervalMs) {
  const startedAt = Date.now();
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const evaluation = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const estimate = await navigator.storage.estimate();
        return {
          usageBytes: Math.round(Number(estimate.usage) || 0),
          fileSystemBytes: Number.isFinite(Number(estimate.usageDetails?.fileSystem))
            ? Math.round(Number(estimate.usageDetails.fileSystem))
            : null
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails) {
      throw new Error(evaluation.exceptionDetails.text || 'Storage estimate failed.');
    }
    samples.push({ at: Date.now() - startedAt, ...evaluation.result.value });
    if (index + 1 < sampleCount) await sleep(intervalMs);
  }
  return samples;
}

const defaultTargets = parseTargets({ targets: [
  { category: 'ordinary-control', url: 'https://example.com/' },
  { category: 'developer-docs', url: 'https://developer.mozilla.org/' },
  { category: 'developer-docs', url: 'https://web.dev/' },
] });
const output = path.resolve(process.argv[2] || path.join(root, '.tmp', 'live-calibration.json'));
const targetPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const publicTargets = targetPath
  ? parseTargets(JSON.parse(await readFile(targetPath, 'utf8')))
  : defaultTargets;
const publicSampleCount = 4;
const publicSampleIntervalMs = 5_000;
const config = {
  fileSystemGrowthThresholdBytes: 128 * MiB,
  totalGrowthThresholdBytes: 512 * MiB,
  absoluteFileSystemWarningBytes: 1024 * MiB,
};

async function loadCheckpoint(file) {
  try {
    return publicCheckpointTraces(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const server = http.createServer((request, response) => {
  const scenario = scenarios.find((item) => request.url === `/${item.id}`) || scenarios[0];
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(scenarioPage(scenario.bytes, scenario.chunk, scenario.delay, Boolean(scenario.truncate)));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const profileRoot = process.env.FROSTGUARD_PROFILE_ROOT
  || (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp')
    : os.tmpdir());
await mkdir(profileRoot, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'frostguard-calibration-'));
const browser = findBrowser();
const child = spawn(browser, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const checkpointTraces = await loadCheckpoint(output);
const traces = [];
let cdp = null;
let browserCdp = null;

async function saveCorpus(status) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({
    metadata: {
      browser,
      collectedAt: new Date().toISOString(),
      status,
      targetPath,
      targetCount: publicTargets.length,
      attemptedCount: traces.filter((trace) => trace.label === 'public-site-screening' || trace.label === 'collection-failure').length,
      protocol: {
        interaction: 'passive-page-load',
        sampleCount: publicSampleCount,
        sampleIntervalMs: publicSampleIntervalMs,
        isolation: 'clean-profile-with-per-origin-clear',
      },
    },
    config,
    traces,
  }, null, 2)}\n`);
}

try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const activePort = await waitFor(async () => readFile(portFile, 'utf8'), 'Chromium CDP port');
  const debugPort = Number(activePort.split(/\r?\n/, 1)[0]);
  const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
  browserCdp = new CdpClient(version.webSocketDebuggerUrl);
  const pageTarget = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    return targets.find((target) => target.type === 'page');
  }, 'calibration page');
  cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  traces.push(...await runScenarios(cdp, `http://127.0.0.1:${port}`));

  traces.push(...checkpointTraces);
  await saveCorpus('running');
  const attemptedTargetIds = new Set(checkpointTraces.map((trace) => trace.id));
  for (const [index, target] of publicTargets.entries()) {
    if (attemptedTargetIds.has(target.id)) {
      console.log(`[${index + 1}/${publicTargets.length}] ${target.url} resumed`);
      continue;
    }
    const origin = new URL(target.url).origin;
    const startedAt = Date.now();
    try {
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      const navigation = await cdp.send('Page.navigate', { url: target.url });
      if (navigation.errorText) throw new Error(navigation.errorText);
      await sleep(3_000);
      const location = await cdp.send('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      const samples = await collectPageTrace(cdp, publicSampleCount, publicSampleIntervalMs);
      traces.push({
        id: target.id,
        label: 'public-site-screening',
        category: target.category,
        source: target.url,
        requestedUrl: target.url,
        finalUrl: location.result.value,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        expectedRapid: null,
        samples,
      });
    } catch (error) {
      traces.push({
        id: target.id,
        label: 'collection-failure',
        category: target.category,
        source: target.url,
        requestedUrl: target.url,
        finalUrl: null,
        status: /timed out/i.test(error.message) ? 'timeout' : 'error',
        durationMs: Date.now() - startedAt,
        expectedRapid: null,
        samples: [],
        error: error.message,
      });
    }
    await saveCorpus('running');
    console.log(`[${index + 1}/${publicTargets.length}] ${target.url} ${traces.at(-1).status}`);
  }

  await saveCorpus('complete');
  console.log(output);
} finally {
  cdp?.close();
  if (browserCdp) await browserCdp.send('Browser.close').catch(() => undefined);
  browserCdp?.close();
  await Promise.race([new Promise((resolve) => child.once('close', resolve)), sleep(5_000)]);
  if (child.exitCode === null && process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
  } else if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
