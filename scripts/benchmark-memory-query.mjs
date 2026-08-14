import os from "node:os";
import { performance } from "node:perf_hooks";
import { fingerprint, fingerprintSignature, legacyFingerprint, legacyFingerprintSignature, queryTokens, similarity, signatureLines } from "../dist/core/fingerprint.js";
import { queryRecall, retrievalEvidenceTokens } from "../dist/core/memory-query.js";

// Deterministic Task-6 workload: 25k v1 records and 25k v2 records with the
// same mixed HTTP/port families, including trusted v1/v2 witness families.
// Generation is outside the timed sections.
const RECORD_COUNT = 50_000;
const LEGACY_COUNT = RECORD_COUNT / 2;
const RUNS = 5;
const WARMUPS = 1;
const NOW = 1_800_000_000_000;
const QUERY = "404 9200";
const MIGRATION_QUERY = "migration-diverse";
const MIGRATION_WITNESS_FAMILIES = new Set([0, 1, 2]);
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
  const currentSignature = signatureLines(stderr);
  const signature = !isCurrent && !MIGRATION_WITNESS_FAMILIES.has(family)
    ? ["error: http # from port # worker:# request #"]
    : currentSignature;
  const current = fingerprint(stderr, cmd, 1);
  const legacy = !isCurrent && MIGRATION_WITNESS_FAMILIES.has(family)
    ? legacyFingerprintSignature(signature, cmd, 1)
    : legacyFingerprint(stderr, cmd, 1);
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

function makeMigrationCorpus() {
  const cmd = "tool migration-diverse";
  const signature = ["error: http 404 from port 9200 migration-diverse"];
  const excerpt = "Error: HTTP 404 from port 9200 migration-diverse worker:123 request:456";
  const legacy = {
    kind: "failure", id: "migration-legacy", benchmarkFamily: 90, ts: NOW - 100,
    cwd: "/benchmark", cmd, exitCode: 1,
    fingerprint: legacyFingerprintSignature(signature, cmd, 1), signature, excerpt,
  };
  const current = {
    kind: "failure", id: "migration-current", benchmarkFamily: 90, ts: NOW - 50,
    cwd: "/benchmark", cmd, exitCode: 1,
    fingerprint: fingerprintSignature(signature, cmd, 1), fingerprintV: 2, signature, excerpt,
  };
  const neighborSignature = ["error: http 500 from port 5432 migration-diverse"];
  const neighbor = {
    kind: "failure", id: "migration-neighbor", benchmarkFamily: 91, ts: NOW - 75,
    cwd: "/benchmark", cmd, exitCode: 1,
    fingerprint: fingerprintSignature(neighborSignature, cmd, 1), fingerprintV: 2,
    signature: neighborSignature, excerpt: "Error: HTTP 500 from port 5432 migration-diverse",
  };
  return [legacy, current, neighbor];
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

function exactEvidence(record) {
  if (record.origin === "hook" || (record.signature.length === 0 && record.excerpt.length === 0)) {
    return [{
      current: fingerprint("", record.cmd, record.exitCode),
      legacy: legacyFingerprint("", record.cmd, record.exitCode),
    }];
  }
  if (record.signature.length === 0) return [];
  const signature = record.signature.join("\n");
  const fast = {
    current: fingerprintSignature(record.signature, record.cmd, record.exitCode),
    legacy: legacyFingerprintSignature(record.signature, record.cmd, record.exitCode),
  };
  const evidence = [fast];
  if (fast.legacy !== record.fingerprint) {
    const fullLegacy = legacyFingerprint(signature, record.cmd, record.exitCode);
    if (fullLegacy !== fast.legacy) evidence.push({ ...fast, legacy: fullLegacy });
  }
  return evidence;
}

function migrationState(records) {
  const currentByHash = new Map();
  for (const record of records) {
    if (record.fingerprintV !== 2 || !/^[0-9a-f]{16}$/u.test(record.fingerprint)) continue;
    const bucket = currentByHash.get(record.fingerprint);
    if (bucket === undefined) currentByHash.set(record.fingerprint, [record]);
    else bucket.push(record);
  }
  const migrated = new Map();
  const provenLegacyRecords = new Set();
  const trustedCurrent = new Set();
  const untrustedCurrent = new Set();
  for (const record of records) {
    if (record.fingerprintV === 2 || !/^[0-9a-f]{16}$/u.test(record.fingerprint)) continue;
    for (const evidence of exactEvidence(record)) {
      if (record.fingerprint !== evidence.legacy) continue;
      provenLegacyRecords.add(record.id);
      const witnesses = currentByHash.get(evidence.current);
      if (witnesses === undefined || untrustedCurrent.has(evidence.current)) continue;
      if (!trustedCurrent.has(evidence.current)) {
        const trusted = witnesses.some((witness) =>
          exactEvidence(witness).some((witnessEvidence) => witness.fingerprint === witnessEvidence.current),
        );
        if (!trusted) {
          untrustedCurrent.add(evidence.current);
          continue;
        }
        trustedCurrent.add(evidence.current);
      }
      const family = migrated.get(record.fingerprint);
      if (family === undefined) migrated.set(record.fingerprint, new Set([evidence.current]));
      else family.add(evidence.current);
      break;
    }
  }
  return { migrated, provenLegacyRecords };
}

function canonicalKey(record, migration) {
  if (record.fingerprintV === 2) return record.fingerprint;
  const unprovenKey = `legacy:${record.id}`;
  if (!/^[0-9a-f]{16}$/u.test(record.fingerprint)) return unprovenKey;
  const family = migration.migrated.get(record.fingerprint);
  if (family === undefined) {
    return migration.provenLegacyRecords.has(record.id) ? `legacy:${record.fingerprint}` : unprovenKey;
  }
  let canonical = migration.provenLegacyRecords.has(record.id) ? `legacy:${record.fingerprint}` : unprovenKey;
  for (const evidence of exactEvidence(record)) {
    if (record.fingerprint !== evidence.legacy || !family.has(evidence.current)) continue;
    canonical = evidence.current;
    break;
  }
  return canonical;
}

// Independent semantic scan. It mirrors the normal queryRecall filter, token
// role, document-frequency pass, score, threshold, first-wins IDs, three-state
// legacy/current dedupe, and final ordering. Its migration state is kept
// independent so equivalence catches runtime or benchmark provenance drift.
function baselineRecall(records, query = QUERY) {
  const querySet = queryTokens(query);
  const candidates = uniqueRecords(records)
    .filter((record) => record.kind === "failure" && record.ts <= NOW && record.cwd === "/benchmark")
    .map((record) => ({ record, tokenSet: retrievalEvidenceTokens(record) }));
  const documents = candidates.map(({ tokenSet }) => tokenSet);
  const frequencies = documentFrequency(documents);
  const migration = migrationState(candidates.map(({ record }) => record));
  const best = new Map();
  for (const { record, tokenSet } of candidates) {
    const value = score(querySet, tokenSet, frequencies, candidates.length);
    if (value <= 0.05) continue;
    const hit = { record, score: value };
    const key = canonicalKey(record, migration);
    const previous = best.get(key);
    if (previous === undefined || record.ts > previous.record.ts) best.set(key, hit);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || b.record.ts - a.record.ts)
    .slice(0, 3);
}

function optimizedRecall(records, query = QUERY) {
  return queryRecall(records, { query, cwd: "/benchmark", now: NOW, limit: 3 });
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

function compareResults(baselineResults, optimizedResults) {
  const baselineIds = baselineResults.map(({ record }) => record.id);
  const optimizedIds = optimizedResults.map(({ failure }) => failure.id);
  const baselineFamilies = baselineResults.map(({ record }) => record.benchmarkFamily);
  const optimizedFamilies = optimizedResults.map(({ failure }) => failure.benchmarkFamily);
  const baselineScores = baselineResults.map(({ score }) => score);
  const optimizedScores = optimizedResults.map(({ score }) => score);
  const passed = JSON.stringify(baselineIds) === JSON.stringify(optimizedIds) &&
    JSON.stringify(baselineFamilies) === JSON.stringify(optimizedFamilies) &&
    baselineScores.length === optimizedScores.length &&
    baselineScores.every((score, index) => Math.abs(score - (optimizedScores[index] ?? Number.NaN)) < 1e-12);
  return { passed, baselineIds, optimizedIds, baselineFamilies, optimizedFamilies, baselineScores, optimizedScores };
}

function assertEquivalent(label, baselineResults, optimizedResults) {
  const comparison = compareResults(baselineResults, optimizedResults);
  if (!comparison.passed) {
    throw new Error(`${label} baseline/optimized result mismatch: ${JSON.stringify(comparison)}`);
  }
  return comparison;
}

const migrationCorpus = makeMigrationCorpus();
const migrationBaseline = baselineRecall(migrationCorpus, MIGRATION_QUERY);
const migrationOptimized = optimizedRecall(migrationCorpus, MIGRATION_QUERY);
const migrationComparison = assertEquivalent("migration corpus", migrationBaseline, migrationOptimized);
if (JSON.stringify(migrationComparison.optimizedIds) !== JSON.stringify(["migration-current", "migration-neighbor"])) {
  throw new Error(`migration corpus family/order assertion failed: ${JSON.stringify(migrationComparison)}`);
}

const records = makeDataset();
const baselineResults = baselineRecall(records);
const optimizedResults = queryRecall(records, { query: QUERY, cwd: "/benchmark", now: NOW, limit: 3 });
const equivalence = assertEquivalent("50k dataset", baselineResults, optimizedResults);
const { baselineIds, optimizedIds, baselineFamilies, optimizedFamilies, baselineScores, optimizedScores } = equivalence;
const equivalent = equivalence.passed;
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
  optimizedHits = current.result.length;
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
    seed: "family=0..24999; alternating legacy/current; trusted-v2 witness families=(0,1,2); status=(404,500,503); port=(9200,5432,6379)",
    query: QUERY,
  },
  warmups: WARMUPS,
  runs: RUNS,
  baselineMs: { median: baselineMedian, samples: baseline, hits: baselineHits },
  optimizedMs: { median: optimizedMedian, samples: optimized, hits: optimizedHits },
  equivalence: {
    passed: equivalent,
    migrationCorpus: migrationComparison,
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
