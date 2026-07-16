import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateCorpus, loadClassifier } from './calibration-replay.mjs';

function growthMetrics(trace) {
  const usage = trace.samples.map((sample) => Number(sample.usageBytes) || 0);
  const baseline = usage[0] || 0;
  return {
    id: trace.id,
    category: trace.category,
    source: trace.source,
    peakGrowthBytes: Math.max(...usage) - baseline,
    endGrowthBytes: usage.at(-1) - baseline,
  };
}

export function summarizeCorpus(corpus, replay) {
  const publicTraces = corpus.traces.filter(
    (trace) => trace.label === 'public-site-screening' || trace.label === 'collection-failure',
  );
  const successful = publicTraces.filter((trace) => trace.status === 'ok');
  const failures = publicTraces.filter((trace) => trace.status !== 'ok');
  const replayById = new Map(replay.traces.map((trace) => [trace.id, trace]));
  const categoryGroups = Object.groupBy(publicTraces, (trace) => trace.category);

  return {
    generatedAt: new Date().toISOString(),
    classifierVersion: replay.classifierVersion,
    attemptedCount: publicTraces.length,
    successCount: successful.length,
    failureCount: failures.length,
    classifierCandidateCount: successful.filter(
      (trace) => (replayById.get(trace.id)?.rapidEventCount || 0) > 0,
    ).length,
    categories: Object.entries(categoryGroups)
      .map(([category, traces]) => ({
        category,
        attempted: traces.length,
        success: traces.filter((trace) => trace.status === 'ok').length,
        failure: traces.filter((trace) => trace.status !== 'ok').length,
      }))
      .sort((left, right) => left.category.localeCompare(right.category)),
    largestPeakGrowth: successful
      .map(growthMetrics)
      .sort((left, right) => right.peakGrowthBytes - left.peakGrowthBytes)
      .slice(0, 10),
    classifierCandidates: successful
      .filter((trace) => (replayById.get(trace.id)?.rapidEventCount || 0) > 0)
      .map((trace) => ({
        id: trace.id,
        category: trace.category,
        source: trace.source,
        reasons: replayById.get(trace.id).reasons,
      })),
    failures: failures.map((trace) => ({
      id: trace.id,
      category: trace.category,
      source: trace.source,
      status: trace.status,
      error: trace.error,
    })),
    caveats: [
      'Observed storage growth does not establish malicious intent, abuse, tracking, persistence, resource exhaustion, or use of FROST.',
      'Measurements are approximate and origin-scoped; they do not identify which party or script caused a change.',
      'A negative result covers only one passive visit under the recorded conditions.',
      'This preselected cohort cannot establish classifier accuracy or false-positive rates for the public web.',
    ],
  };
}

async function main() {
  const corpusPath = path.resolve(process.argv[2]);
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const replay = evaluateCorpus(await loadClassifier(), corpus);
  const serialized = `${JSON.stringify(summarizeCorpus(corpus, replay), null, 2)}\n`;
  if (!outputPath) {
    console.log(serialized.trimEnd());
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized);
  console.log(outputPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
