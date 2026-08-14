import os from "node:os";
import { performance } from "node:perf_hooks";
import { fingerprint, legacyFingerprint, legacyFingerprintSignature, queryTokens, similarity, signatureLines } from "../dist/core/fingerprint.js";
import { queryRecall, retrievalEvidenceTokens } from "../dist/core/memory-query.js";

// Deterministic Task-6 workload: 25k v1 records and 25k v2 records with the
// same mixed HTTP/port families. Generation is outside the timed sections.
const RECORD_COUNT = 50_000;
const LEGACY_COUNT = RECORD_COUNT / 2;
const RUNS = 5;
const WARMUPS = 1;
const NOW = 1_800_000_000_000;
const QUERY = "404 9200";
const NON_DISTINCTIVE_TOKENS = new Set([
  "line", "pid", "time", "timestamp", "date", "error", "exception", "fail", "failed", "failure",
  "http", "status", "code", "port", "connect", "refused", "request", "response",
]);

function recordAt(family, isCurrent) {
  const status = family % 4 === 0 ? 404 : family % 4 === 1 ? 500 : 503;
  const port = family % 3 === 0 ? 9200 : family % 3 === 1 ? 5432 : 6379;
  const cmd = `curl --service deterministic-${family % 37}`;
  const sequence = isCurrent ? family : family + LEGACY_COUNT;
  const stderr = `Error: HTTP ${status} from port ${port} worker:${1000 + sequence} request ${sequence}`;
  const signature = !isCurrent
    ? ["error: http # from port # worker:# request #"]
    : signatureLines(stderr);
  const current = fingerprint(stderr, cmd, 1);
  const legacy = legacyFingerprint(stderr, cmd, 1);
  if (!isCurrent) {
    return {
      kind: "failure", id: `legacy-${family}`, benchmarkFamily: family, ts: NOW - 100_000 - family,
      cwd: "/benchmark", cmd, exitCode: 1, fingerprint: legacy, signature, excerpt: stderr,
    };
  }
  return {
    kind: "failure", id: `current-${family}`, benchmarkFamily: family, ts: NOW - family,
    cwd: "/benchmark", cmd, exitCode: 1, fingerprint: current, fingerprintV: 2, signature, excerpt: stderr,
  };
}

function makeDataset() {
  return Array.from({ length: LEGACY_COUNT * 2 }, (_, index) => recordAt(Math.floor(index / 2), index % 2 === 1));
}

function documentFrequency(tokenSets) {
  const frequency = new Map();
  for (const set of tokenSets) for (const token of set) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  return frequency;
}

function score(querySet, documentSet, frequencies, candidateCount) {
  const base = similarity(querySet, documentSet);
  const rareFrequency = candidateCount >= 10 ? Math.min(8, Math.max(2, Math.ceil(candidateCount * 0.05))) : 1;
  const rare = [...querySet].some((token) =>
    distinctiveToken(token) && documentSet.has(token) &&
    (frequencies.get(token) ?? 0) <= rareFrequency,
  );
  return rare ? Math.max(base, 0.06) : base;
}

function distinctiveToken(token) {
  if (token.startsWith("<") || token.startsWith("#") || NON_DISTINCTIVE_TOKENS.has(token)) return false;
  return token.length >= 3 || /[^\x00-\x7F]/u.test(token);
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

function provenLegacy(record) {
  if (record.fingerprintV === 2 || !/^[0-9a-f]{16}$/u.test(record.fingerprint)) return false;
  if (record.origin === "hook" || (record.signature.length === 0 && record.excerpt.length === 0)) {
    return legacyFingerprint("", record.cmd, record.exitCode) === record.fingerprint;
  }
  if (record.signature.length === 0) return false;
  const signature = record.signature.join("\n");
  return legacyFingerprintSignature(record.signature, record.cmd, record.exitCode) === record.fingerprint ||
    legacyFingerprint(signature, record.cmd, record.exitCode) === record.fingerprint;
}

// Equivalent semantic scan without migration bookkeeping. It mirrors the
// normal queryRecall filter, token role, document-frequency pass, score,
// threshold, first-wins IDs, three-state legacy/current dedupe, and final
// ordering. The optimized path adds the indexed provenance state selection.
function baselineRecall(records) {
  const querySet = queryTokens(QUERY);
  const candidates = uniqueRecords(records)
    .filter((record) => record.kind === "failure" && record.ts <= NOW && record.cwd === "/benchmark")
    .map((record) => ({ record, tokenSet: retrievalEvidenceTokens(record) }));
  const documents = candidates.map(({ tokenSet }) => tokenSet);
  const frequencies = documentFrequency(documents);
  const best = new Map();
  for (const { record, tokenSet } of candidates) {
    const value = score(querySet, tokenSet, frequencies, candidates.length);
    if (value <= 0.05) continue;
    const hit = { record, score: value };
    const key = record.fingerprintV === 2
      ? record.fingerprint
      : provenLegacy(record) ? `legacy:${record.fingerprint}` : `legacy:${record.id}`;
    const previous = best.get(key);
    if (previous === undefined || record.ts > previous.record.ts) best.set(key, hit);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || b.record.ts - a.record.ts)
    .slice(0, 3);
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
const baselineResults = baselineRecall(records);
const optimizedResults = queryRecall(records, { query: QUERY, cwd: "/benchmark", now: NOW, limit: 3 });
const baselineIds = baselineResults.map(({ record }) => record.id);
const optimizedIds = optimizedResults.map(({ failure }) => failure.id);
const baselineFamilies = baselineResults.map(({ record }) => record.benchmarkFamily);
const optimizedFamilies = optimizedResults.map(({ failure }) => failure.benchmarkFamily);
const baselineScores = baselineResults.map(({ score }) => score);
const optimizedScores = optimizedResults.map(({ score }) => score);
const equivalent = JSON.stringify(baselineIds) === JSON.stringify(optimizedIds) &&
  JSON.stringify(baselineFamilies) === JSON.stringify(optimizedFamilies) &&
  baselineScores.every((score, index) => Math.abs(score - (optimizedScores[index] ?? Number.NaN)) < 1e-12);
if (!equivalent) {
  throw new Error(`baseline/optimized result mismatch: ${JSON.stringify({ baselineIds, optimizedIds, baselineFamilies, optimizedFamilies, baselineScores, optimizedScores })}`);
}
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
  baselineHits = base.result.length;
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
    seed: "family=0..24999; alternating legacy/current; status=(404,500,503); port=(9200,5432,6379)",
    query: QUERY,
  },
  warmups: WARMUPS,
  runs: RUNS,
  baselineMs: { median: baselineMedian, samples: baseline, hits: baselineHits },
  optimizedMs: { median: optimizedMedian, samples: optimized, hits: optimizedHits },
  equivalence: {
    passed: equivalent,
    baselineIds,
    optimizedIds,
    baselineFamilies,
    optimizedFamilies,
    baselineScores,
    optimizedScores,
  },
  ratio,
  gate: { maxRatio: 2, passed: equivalent && Number.isFinite(ratio) && ratio <= 2 },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gate.passed) process.exitCode = 1;
