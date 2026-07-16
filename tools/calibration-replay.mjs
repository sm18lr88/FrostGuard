import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCorpus = path.join(root, 'fixtures', 'calibration', 'reference-traces.json');
const classifierPath = path.join(root, 'src', 'storage-growth-classifier.js');

export async function loadClassifier() {
  const source = await readFile(classifierPath, 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: classifierPath });
  return context.__frostguardStorageGrowthTransitionV1__;
}

export function replayTrace(transition, trace, config) {
  let state = null;
  const events = [];
  for (const sample of trace.samples) {
    const result = transition(state, { config, sample });
    state = result.state;
    if (result.event) events.push(structuredClone(result.event));
  }
  return events;
}

export function evaluateCorpus(transition, corpus) {
  const traces = corpus.traces.map((trace) => {
    const events = replayTrace(transition, trace, corpus.config);
    const rapidFileSystemEvents = events.filter(
      (event) => event.reason === 'confirmed-file-system-growth',
    );
    return {
      id: trace.id,
      label: trace.label,
      source: trace.source,
      expectedRapid: trace.expectedRapid,
      rapidEventCount: rapidFileSystemEvents.length,
      reasons: events.map((event) => event.reason),
    };
  });
  const mismatches = traces.filter(
    (trace) => typeof trace.expectedRapid === 'boolean'
      && (trace.rapidEventCount > 0) !== trace.expectedRapid,
  );
  return {
    classifierVersion: 1,
    traceCount: traces.length,
    unlabeledCount: traces.filter((trace) => typeof trace.expectedRapid !== 'boolean').length,
    mismatchCount: mismatches.length,
    traces,
  };
}

async function main() {
  const corpusPath = path.resolve(process.argv[2] || defaultCorpus);
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const report = evaluateCorpus(await loadClassifier(), corpus);
  assert.equal(
    report.mismatchCount,
    0,
    `Calibration replay mismatches: ${JSON.stringify(report.traces.filter(
      (trace) => typeof trace.expectedRapid === 'boolean'
        && (trace.rapidEventCount > 0) !== trace.expectedRapid,
    ))}`,
  );
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
