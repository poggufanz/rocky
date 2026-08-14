import os from "node:os";
import { performance } from "node:perf_hooks";
import { fingerprint, legacyFingerprint, queryTokens, retrievalTokens, similarity, signatureLines } from "../dist/core/fingerprint.js";
import { queryRecall } from "../dist/core/memory-query.js";

// Deterministic Task-6 workload: 25k v1 records and 25k v2 records with the
// same mixed HTTP/port families. Generation is outside the timed sections.
const RECORD_COUNT = 50_000;
const LEGACY_COUNT = RECORD_COUNT / 2;
const RUNS = 5;
const WARMUPS = 1;
const NOW = 1_800_000_000_000;
const QUERY = "404 9200";

function recordAt(index) {
  const status = index % 4 === 0 ? 404 : index % 4 === 1 ? 500 : 503;
  const port = index % 3 === 0 ? 9200 : index % 3 === 1 ? 5432 : 6379;
  const cmd = `curl --service deterministic-${index % 37}`;
  const stderr = `Error: HTTP ${status} from port ${port} worker:${1000 + index} request ${index}`;
  const signature = index < LEGACY_COUNT
    ? ["error: http # from port # worker:# request #"]
    : signatureLines(stderr);
  const current = fingerprint(stderr, cmd, 1);
  const legacy = legacyFingerprint(stderr, cmd, 1);
  if (index < LEGACY_COUNT) {
    return {
      kind: "failure", id: `legacy-${index}`, ts: NOW - index, cwd: "/benchmark", cmd, exitCode: 1,
      fingerprint: legacy, signature, excerpt: stderr,
    };
  }
  return {
    kind: "failure", id: `current-${index}`, ts: NOW - index, cwd: "/benchmark", cmd, exitCode: 1,
    fingerprint: current, fingerprintV: 2, signature, excerpt: stderr,
  };
}

function makeDataset() {
  return Array.from({ length: RECORD_COUNT }, (_, index) => recordAt(index));
}

function documentFrequency(tokenSets) {
  const frequency = new Map();
  for (const set of tokenSets) for (const token of set) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  return frequency;
}

function score(querySet, documentSet, frequencies) {
  const base = similarity(querySet, documentSet);
  const rare = [...querySet].some((token) => token.length >= 3 && documentSet.has(token) && (frequencies.get(token) ?? 0) <= 2);
  return rare ? Math.max(base, 0.06) : base;
}

// Equivalent semantic scan without migration bookkeeping. It uses the same
// query/candidate token roles, document-frequency pass, scoring, and 50k
// record input as queryRecall; the optimized path adds only trusted
// v1->v2 provenance and family dedupe work.
function baselineRecall(records) {
  const querySet = queryTokens(QUERY);
  const documents = records.map((record) => retrievalTokens([record.cmd, ...record.signature].join(" ")));
  const frequencies = documentFrequency(documents);
  let hits = 0;
  for (const document of documents) if (score(querySet, document, frequencies) > 0.05) hits++;
  return hits;
}

function optimizedRecall(records) {
  return queryRecall(records, { query: QUERY, cwd: "/benchmark", now: NOW, limit: 3 }).length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(fn, records) {
  const started = performance.now();
  const result = fn(records);
  return { elapsedMs: performance.now() - started, result };
}

const records = makeDataset();
for (let index = 0; index < WARMUPS; index++) {
  baselineRecall(records);
  optimizedRecall(records);
}
const baseline = [];
const optimized = [];
let baselineHits = 0;
let optimizedHits = 0;
for (let index = 0; index < RUNS; index++) {
  const base = measure(baselineRecall, records);
  const current = measure(optimizedRecall, records);
  baseline.push(Number(base.elapsedMs.toFixed(3)));
  optimized.push(Number(current.elapsedMs.toFixed(3)));
  baselineHits = base.result;
  optimizedHits = current.result;
}
const baselineMedian = median(baseline);
const optimizedMedian = median(optimized);
const ratio = optimizedMedian / baselineMedian;
const report = {
  command: "npm run benchmark:memory-query",
  measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
  dataset: {
    records: RECORD_COUNT,
    legacyRecords: LEGACY_COUNT,
    currentRecords: RECORD_COUNT - LEGACY_COUNT,
    seed: "index=0..49999; status=(404,500,503); port=(9200,5432,6379)",
    query: QUERY,
  },
  warmups: WARMUPS,
  runs: RUNS,
  baselineMs: { median: baselineMedian, samples: baseline, hits: baselineHits },
  optimizedMs: { median: optimizedMedian, samples: optimized, hits: optimizedHits },
  ratio,
  gate: { maxRatio: 2, passed: Number.isFinite(ratio) && ratio <= 2 },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gate.passed) process.exitCode = 1;
