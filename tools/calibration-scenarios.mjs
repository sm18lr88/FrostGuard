import { sleep } from './chromium-cdp.mjs';

const MiB = 1024 * 1024;

export const scenarios = [
  { id: 'chromium-empty-control', label: 'benign-control', bytes: 0, chunk: 1, delay: 0, expectedRapid: false },
  { id: 'chromium-database-model', label: 'benign-database', bytes: 96 * MiB, chunk: 4 * MiB, delay: 250, expectedRapid: false },
  { id: 'chromium-frost-construction', label: 'attack-construction', bytes: 256 * MiB, chunk: 1, delay: 0, truncate: true, expectedRapid: true },
];

export function scenarioPage(bytes, chunkBytes, delayMs, truncate) {
  const workerSource = `onmessage = async ({ data: bytes }) => {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('calibration.bin', { create: true });
      const access = await handle.createSyncAccessHandle();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      access.truncate(bytes);
      access.flush();
      access.close();
      postMessage({ ok: true });
    } catch (error) {
      postMessage({ ok: false, error: error.name + ':' + error.message });
    }
  };`;
  return `<!doctype html><meta charset="utf-8"><title>Calibration scenario</title>
  <output id="status">running</output><script>
  (async () => {
    if (${truncate}) {
      const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], { type: 'text/javascript' })));
      const result = await new Promise((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.postMessage(${bytes});
      });
      worker.terminate();
      if (!result.ok) throw new Error(result.error);
      document.querySelector('#status').textContent = 'done';
      return;
    }
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('calibration.bin', { create: true });
    const writer = await handle.createWritable();
    const chunk = new Uint8Array(${chunkBytes});
    for (let offset = 0; offset < ${bytes}; offset += chunk.byteLength) {
      await writer.write({ type: 'write', position: offset, data: chunk });
      await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
    }
    await writer.close();
    document.querySelector('#status').textContent = 'done';
  })().catch((error) => { document.querySelector('#status').textContent = 'error:' + error.message; });
  </script>`;
}

function fileSystemUsage(result) {
  const entry = result.usageBreakdown?.find((item) => item.storageType === 'file_systems');
  return Number.isFinite(Number(entry?.usage)) ? Number(entry.usage) : null;
}

async function collectTrace(cdp, origin) {
  const startedAt = Date.now();
  const samples = [];
  for (let index = 0; index < 8; index += 1) {
    const quota = await cdp.send('Storage.getUsageAndQuota', { origin });
    samples.push({
      at: Date.now() - startedAt,
      usageBytes: Math.round(Number(quota.usage) || 0),
      fileSystemBytes: fileSystemUsage(quota),
    });
    if (index < 7) await sleep(1_500);
  }
  return samples;
}

async function readScenarioResult(cdp) {
  const evaluation = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const status = document.querySelector('#status')?.textContent || 'missing';
      const estimate = await navigator.storage.estimate();
      try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('calibration.bin');
        return { status, fileSize: (await handle.getFile()).size, estimatedQuota: estimate.quota };
      } catch (error) {
        return { status, fileSize: null, estimatedQuota: estimate.quota, inspectionError: error.name + ':' + error.message };
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return evaluation.result.value;
}

export async function runScenarios(cdp, origin) {
  const traces = [];
  for (const scenario of scenarios) {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(250);
    await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 2 * 1024 * MiB });
    const quotaOverride = await cdp.send('Storage.getUsageAndQuota', { origin });
    if (!quotaOverride.overrideActive) throw new Error(`Quota override was not active for ${origin}.`);
    await cdp.send('Page.navigate', { url: `${origin}/${scenario.id}` });
    await sleep(500);
    const samples = await collectTrace(cdp, origin);
    const scenarioResult = await readScenarioResult(cdp);
    if (scenario.expectedRapid
      && (scenarioResult.status !== 'done' || scenarioResult.fileSize !== scenario.bytes)) {
      throw new Error(`Known-positive OPFS preflight failed: ${JSON.stringify(scenarioResult)}`);
    }
    traces.push({
      id: scenario.id,
      label: scenario.label,
      source: 'chromium-local-opfs',
      expectedRapid: scenario.expectedRapid,
      scenarioResult,
      samples,
    });
  }
  await cdp.send('Storage.overrideQuotaForOrigin', { origin });
  return traces;
}
