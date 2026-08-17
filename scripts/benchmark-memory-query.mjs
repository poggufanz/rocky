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
const REQUIRED_STATE_IDS = [
  "state-migrated-legacy", "state-migrated-current", "state-migrated-malformed-old", "state-migrated-malformed-new",
  "state-legacy-only-old", "state-legacy-only-new", "state-silent-legacy", "state-silent-current",
  "state-hook-legacy", "state-hook-current",
];
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

function makeStateRecords() {
  const migratedCmd = "tool state-migrated";
  const migratedSignature = ["error: state-migrated"];
  const migratedLegacy = legacyFingerprintSignature(migratedSignature, migratedCmd, 1);
  const migratedCurrent = fingerprintSignature(migratedSignature, migratedCmd, 1);
  const migratedExcerpt = "Error: state-migrated";

  const legacyOnlyCmd = "tool state-legacy-only";
  const legacyOnlySignature = ["error: state-legacy-only"];
  const legacyOnlyFingerprint = legacyFingerprintSignature(legacyOnlySignature, legacyOnlyCmd, 1);

  const silentCmd = "tool state-silent";
  const hookCmd = "tool state-hook";
  return [
    {
      kind: "failure", id: "state-migrated-legacy", benchmarkFamily: 600, ts: NOW - 200,
      cwd: "/benchmark", cmd: migratedCmd, exitCode: 1, fingerprint: migratedLegacy,
      signature: migratedSignature, excerpt: migratedExcerpt,
    },
    {
      kind: "failure", id: "state-migrated-current", benchmarkFamily: 600, ts: NOW - 50,
      cwd: "/benchmark", cmd: migratedCmd, exitCode: 1, fingerprint: migratedCurrent, fingerprintV: 2,
      signature: migratedSignature, excerpt: migratedExcerpt,
    },
    {
      kind: "failure", id: "state-migrated-malformed-old", benchmarkFamily: 600, ts: NOW - 150,
      cwd: "/benchmark", cmd: migratedCmd, exitCode: 1, fingerprint: migratedLegacy,
      signature: ["error: state-migrated forged-old"], excerpt: "Error: state-migrated forged-old",
    },
    {
      kind: "failure", id: "state-migrated-malformed-new", benchmarkFamily: 600, ts: NOW - 100,
      cwd: "/benchmark", cmd: migratedCmd, exitCode: 1, fingerprint: migratedLegacy,
      signature: ["error: state-migrated forged-new"], excerpt: "Error: state-migrated forged-new",
    },
    {
      kind: "failure", id: "state-legacy-only-old", benchmarkFamily: 601, ts: NOW - 300,
      cwd: "/benchmark", cmd: legacyOnlyCmd, exitCode: 1, fingerprint: legacyOnlyFingerprint,
      signature: legacyOnlySignature, excerpt: "Error: state-legacy-only",
    },
    {
      kind: "failure", id: "state-legacy-only-new", benchmarkFamily: 601, ts: NOW - 250,
      cwd: "/benchmark", cmd: legacyOnlyCmd, exitCode: 1, fingerprint: legacyOnlyFingerprint,
      signature: legacyOnlySignature, excerpt: "Error: state-legacy-only",
    },
    {
      kind: "failure", id: "state-silent-legacy", benchmarkFamily: 602, ts: NOW - 400,
      cwd: "/benchmark", cmd: silentCmd, exitCode: 1, fingerprint: legacyFingerprint("", silentCmd, 1),
      signature: [], excerpt: "",
    },
    {
      kind: "failure", id: "state-silent-current", benchmarkFamily: 602, ts: NOW - 350,
      cwd: "/benchmark", cmd: silentCmd, exitCode: 1, fingerprint: fingerprint("", silentCmd, 1), fingerprintV: 2,
      signature: [], excerpt: "",
    },
    {
      kind: "failure", id: "state-hook-legacy", benchmarkFamily: 603, ts: NOW - 500,
      cwd: "/benchmark", cmd: hookCmd, exitCode: 1, fingerprint: legacyFingerprint("", hookCmd, 1),
      signature: [], excerpt: "", origin: "hook",
    },
    {
      kind: "failure", id: "state-hook-current", benchmarkFamily: 603, ts: NOW - 450,
      cwd: "/benchmark", cmd: hookCmd, exitCode: 1, fingerprint: fingerprint("", hookCmd, 1), fingerprintV: 2,
      signature: [], excerpt: "", origin: "hook",
    },
  ];
}

function makeDataset() {
  const records = Array.from({ length: LEGACY_COUNT * 2 }, (_, index) => recordAt(Math.floor(index / 2), index % 2 === 1));
  const stateRecords = makeStateRecords();
  records.splice(records.length - stateRecords.length, stateRecords.length, ...stateRecords);
  return records;
}

function assertDatasetComposition(records) {
  if (records.length !== RECORD_COUNT) throw new Error(`50k migration-state composition changed record count: ${records.length}`);
  const byId = new Map(records.map((record) => [record.id, record]));
  const present = new Set(records.map((record) => record.id));
  const missing = REQUIRED_STATE_IDS.filter((id) => !present.has(id));
  if (missing.length > 0) throw new Error(`50k migration-state composition missing: ${missing.join(",")}`);

  const requireRecord = (id) => {
    const record = byId.get(id);
    if (record === undefined) throw new Error(`50k migration-state composition lost ${id}`);
    return record;
  };
  const migratedLegacy = requireRecord("state-migrated-legacy");
  const migratedCurrent = requireRecord("state-migrated-current");
  const malformedOld = requireRecord("state-migrated-malformed-old");
  const malformedNew = requireRecord("state-migrated-malformed-new");
  if (migratedLegacy.fingerprintV === 2 || migratedCurrent.fingerprintV !== 2 ||
      migratedLegacy.fingerprint !== legacyFingerprintSignature(migratedLegacy.signature, migratedLegacy.cmd, migratedLegacy.exitCode) ||
      migratedCurrent.fingerprint !== fingerprintSignature(migratedCurrent.signature, migratedCurrent.cmd, migratedCurrent.exitCode) ||
      malformedOld.fingerprint !== migratedLegacy.fingerprint || malformedNew.fingerprint !== migratedLegacy.fingerprint ||
      legacyFingerprintSignature(malformedOld.signature, malformedOld.cmd, malformedOld.exitCode) === malformedOld.fingerprint ||
      legacyFingerprintSignature(malformedNew.signature, malformedNew.cmd, malformedNew.exitCode) === malformedNew.fingerprint) {
    throw new Error("50k migration-state composition has invalid migrated/malformed provenance");
  }

  const legacyOnlyOld = requireRecord("state-legacy-only-old");
  const legacyOnlyNew = requireRecord("state-legacy-only-new");
  const legacyOnlyWitness = fingerprintSignature(legacyOnlyOld.signature, legacyOnlyOld.cmd, legacyOnlyOld.exitCode);
  if (legacyOnlyOld.fingerprintV === 2 || legacyOnlyNew.fingerprintV === 2 ||
      legacyOnlyOld.fingerprint !== legacyOnlyNew.fingerprint ||
      legacyFingerprintSignature(legacyOnlyOld.signature, legacyOnlyOld.cmd, legacyOnlyOld.exitCode) !== legacyOnlyOld.fingerprint ||
      records.some((record) => record.fingerprintV === 2 && record.fingerprint === legacyOnlyWitness)) {
    throw new Error("50k migration-state composition has an unexpected legacy-only witness");
  }

  const silentLegacy = requireRecord("state-silent-legacy");
  const silentCurrent = requireRecord("state-silent-current");
  const hookLegacy = requireRecord("state-hook-legacy");
  const hookCurrent = requireRecord("state-hook-current");
  if (silentLegacy.signature.length !== 0 || silentLegacy.excerpt.length !== 0 || silentCurrent.fingerprintV !== 2 ||
      silentLegacy.fingerprint !== legacyFingerprint("", silentLegacy.cmd, silentLegacy.exitCode) ||
      silentCurrent.fingerprint !== fingerprint("", silentCurrent.cmd, silentCurrent.exitCode) ||
      hookLegacy.origin !== "hook" || hookCurrent.origin !== "hook" || hookCurrent.fingerprintV !== 2 ||
      hookLegacy.fingerprint !== legacyFingerprint("", hookLegacy.cmd, hookLegacy.exitCode) ||
      hookCurrent.fingerprint !== fingerprint("", hookCurrent.cmd, hookCurrent.exitCode)) {
    throw new Error("50k migration-state composition has invalid silent or hook provenance");
  }
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

function stateShape(results, optimized) {
  return {
    ids: results.map((hit) => optimized ? hit.failure.id : hit.record.id),
    families: results.map((hit) => optimized ? hit.failure.benchmarkFamily : hit.record.benchmarkFamily),
    scores: results.map((hit) => hit.score),
  };
}

function assertStateVector(records, vector) {
  const requested = new Set(vector.ids);
  const subset = records.filter((record) => requested.has(record.id));
  if (subset.length !== vector.ids.length) {
    throw new Error(`${vector.label} subset composition mismatch: ${JSON.stringify({ requested: vector.ids, actual: subset.map((record) => record.id) })}`);
  }
  const baseline = baselineRecall(subset, vector.query);
  const optimized = optimizedRecall(subset, vector.query);
  assertEquivalent(`${vector.label} state vector`, baseline, optimized);
  const baselineShape = stateShape(baseline, false);
  const optimizedShape = stateShape(optimized, true);
  const expectedShape = { ids: vector.expectedIds, families: vector.expectedFamilies, scores: vector.expectedScores };
  const scoresMatch = (actual) => actual.length === expectedShape.scores.length &&
    actual.every((score, index) => Math.abs(score - expectedShape.scores[index]) < 1e-12);
  const matches = (actual) => JSON.stringify(actual.ids) === JSON.stringify(expectedShape.ids) &&
    JSON.stringify(actual.families) === JSON.stringify(expectedShape.families) && scoresMatch(actual.scores);
  if (!matches(baselineShape) || !matches(optimizedShape)) {
    throw new Error(`${vector.label} state vector expected mismatch: ${JSON.stringify({ expected: expectedShape, baseline: baselineShape, optimized: optimizedShape })}`);
  }
  return { label: vector.label, query: vector.query, expected: expectedShape, baseline: baselineShape, optimized: optimizedShape, passed: true };
}

const STATE_VECTORS = [
  {
    label: "trusted signature migration", query: "state-migrated",
    ids: ["state-migrated-legacy", "state-migrated-current"],
    expectedIds: ["state-migrated-current"], expectedFamilies: [600], expectedScores: [0.6],
  },
  {
    label: "valid legacy duplicates without witness", query: "state-legacy-only",
    ids: ["state-legacy-only-old", "state-legacy-only-new"],
    expectedIds: ["state-legacy-only-new"], expectedFamilies: [601], expectedScores: [0.6666666666666666],
  },
  {
    label: "unproven same-hash records", query: "state-migrated",
    ids: ["state-migrated-malformed-old", "state-migrated-malformed-new"],
    expectedIds: ["state-migrated-malformed-new", "state-migrated-malformed-old"], expectedFamilies: [600, 600], expectedScores: [0.375, 0.375],
  },
  {
    label: "migrated family beside malformed records", query: "state-migrated",
    ids: ["state-migrated-legacy", "state-migrated-current", "state-migrated-malformed-old", "state-migrated-malformed-new"],
    expectedIds: ["state-migrated-current", "state-migrated-malformed-new", "state-migrated-malformed-old"], expectedFamilies: [600, 600, 600], expectedScores: [0.6, 0.375, 0.375],
  },
  {
    label: "silent command-only migration", query: "state-silent",
    ids: ["state-silent-legacy", "state-silent-current"],
    expectedIds: ["state-silent-current"], expectedFamilies: [602], expectedScores: [0.75],
  },
  {
    label: "hook-origin migration", query: "state-hook",
    ids: ["state-hook-legacy", "state-hook-current"],
    expectedIds: ["state-hook-current"], expectedFamilies: [603], expectedScores: [0.75],
  },
];

const migrationCorpus = makeMigrationCorpus();
const migrationBaseline = baselineRecall(migrationCorpus, MIGRATION_QUERY);
const migrationOptimized = optimizedRecall(migrationCorpus, MIGRATION_QUERY);
const migrationComparison = assertEquivalent("migration corpus", migrationBaseline, migrationOptimized);
if (JSON.stringify(migrationComparison.optimizedIds) !== JSON.stringify(["migration-current", "migration-neighbor"])) {
  throw new Error(`migration corpus family/order assertion failed: ${JSON.stringify(migrationComparison)}`);
}

const records = makeDataset();
assertDatasetComposition(records);
const stateVectorResults = STATE_VECTORS.map((vector) => assertStateVector(records, vector));
const baselineResults = baselineRecall(records);
const optimizedResults = queryRecall(records, { query: QUERY, cwd: "/benchmark", now: NOW, limit: 3 });
const equivalence = assertEquivalent("50k dataset", baselineResults, optimizedResults);
const { baselineIds, optimizedIds, baselineFamilies, optimizedFamilies, baselineScores, optimizedScores } = equivalence;
const equivalent = equivalence.passed;
const currentRecordCount = records.filter((record) => record.fingerprintV === 2).length;
const legacyRecordCount = records.length - currentRecordCount;
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
    legacyRecords: legacyRecordCount,
    currentRecords: currentRecordCount,
    seed: "base families=0..24994 alternating legacy/current plus named state branches=(600..603); trusted-v2 witness families=(0,1,2); status=(404,500,503); port=(9200,5432,6379)",
    stateIds: REQUIRED_STATE_IDS,
    query: QUERY,
  },
  warmups: WARMUPS,
  runs: RUNS,
  baselineMs: { median: baselineMedian, samples: baseline, hits: baselineHits },
  optimizedMs: { median: optimizedMedian, samples: optimized, hits: optimizedHits },
  equivalence: {
    passed: equivalent,
    migrationCorpus: migrationComparison,
    stateVectors: stateVectorResults,
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
