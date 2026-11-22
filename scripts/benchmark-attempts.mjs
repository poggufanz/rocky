import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { prepareLaneOneNote } from "../dist/commands/attempt-note-lane.js";
import { buildProblems } from "../dist/core/attempts.js";
import { MEMORY_FORMAT_VERSION } from "../dist/core/memory-read.js";
import { assertDatasetMix, generateRealisticRecords } from "./benchmark-attempt-fixtures.mjs";

const RECORD_COUNT = 10_000;
const FINGERPRINT_COUNT = 200;
const CWD_COUNT = 20;
const WARMUPS = 1;
const RUNS = 20;
const FULL_BUDGET_MS = 30;
const SINGLE_BUDGET_MS = 10;
const NOW = 1_800_000_000_000;

function makeDataset() {
  const cwds = Array.from({ length: CWD_COUNT }, (_, index) => `/benchmark/project-${index}`);
  const { records, fingerprints } = generateRealisticRecords({
    recordCount: RECORD_COUNT,
    fingerprintCount: FINGERPRINT_COUNT,
    cwds,
    platform: "linux",
    startTs: NOW - 100_000_000,
    stepMs: 5_000,
    sampleTs: NOW,
    excerptPrefix: "Error: benchmark failure family",
    patchResolvedBy: true,
    includeFixLinks: false,
  });

  const actualFingerprints = new Set(
    records.filter((record) => record.kind === "failure").map((record) => record.fingerprint),
  ).size;
  const actualCwds = new Set(records.map((record) => record.cwd)).size;
  if (actualFingerprints !== FINGERPRINT_COUNT || actualCwds !== CWD_COUNT) {
    throw new Error(
      `Benchmark dataset cardinality mismatch: expected ${FINGERPRINT_COUNT} fingerprints and ${CWD_COUNT} cwds, got ${actualFingerprints} and ${actualCwds}`,
    );
  }

  const mix = assertDatasetMix(records);

  const targetFp = fingerprints[0].fp;
  const targetFailure = records.find((record) => record.kind === "failure" && record.fingerprint === targetFp);

  return {
    records,
    actualFingerprints,
    actualCwds,
    targetFingerprint: targetFp,
    targetCwd: targetFailure.cwd,
    mix,
    coverage: {
      version: MEMORY_FORMAT_VERSION,
      scanned: records.length,
      skipped: 0,
      truncated: 0,
      bytesScanned: records.length * 1_400,
      bytesTotal: records.length * 1_400,
      complete: true,
    },
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  const rounded = values.map((value) => Number(value.toFixed(3)));
  const sum = values.reduce((acc, value) => acc + value, 0);
  const p50 = Number(percentile(values, 50).toFixed(3));
  const p95 = Number(percentile(values, 95).toFixed(3));
  return {
    count: values.length,
    min: Number(Math.min(...values).toFixed(3)),
    median: p50,
    p50,
    p95,
    max: Number(Math.max(...values).toFixed(3)),
    mean: Number((sum / values.length).toFixed(3)),
    samples: rounded,
  };
}

function shownSessions(count, prefix) {
  const ids = [];
  let seq = 1;
  while (ids.length < count) {
    const candidate = `${prefix}-${seq}`;
    seq += 1;
    const firstByte = createHash("sha256").update(candidate, "utf8").digest()[0];
    if ((firstByte & 0x80) === 0) {
      ids.push(candidate);
    }
  }
  return ids;
}

function cleanEnv(rockyHome, session) {
  const env = { ...process.env, ROCKY_HOME: rockyHome, ROCKY_AGENT_SESSION: session };
  delete env.ROCKY_TEST_SEAMS;
  delete env.ROCKY_ATTEMPT_ARM;
  delete env.ROCKY_ATTEMPT_ADVISORY;
  delete env.CLAUDECODE;
  return env;
}

function measure(fn) {
  const started = performance.now();
  const result = fn();
  return { elapsedMs: performance.now() - started, result };
}

const assertBudget = process.argv.includes("--assert");
const { records, actualFingerprints, actualCwds, targetFingerprint, targetCwd, mix, coverage } = makeDataset();

for (let index = 0; index < WARMUPS; index += 1) {
  buildProblems(records, coverage, { now: NOW, platform: "linux" });
  buildProblems(records, coverage, { now: NOW, fingerprint: targetFingerprint, platform: "linux" });
}

const fullSamples = [];
const singleSamples = [];
let fullEntries = 0;
let singleEntries = 0;

for (let index = 0; index < RUNS; index += 1) {
  const full = measure(() => buildProblems(records, coverage, { now: NOW, platform: "linux" }));
  const single = measure(() => buildProblems(records, coverage, {
    now: NOW,
    fingerprint: targetFingerprint,
    platform: "linux",
  }));
  fullSamples.push(full.elapsedMs);
  singleSamples.push(single.elapsedMs);
  fullEntries = full.result.entries.length;
  singleEntries = single.result.entries.length;
}

const tempHome = realpathSync.native(mkdtempSync(join(os.tmpdir(), "rocky-bench-attempts-")));
const lane1Samples = [];
let lane1NoteBytes = 0;
try {
  const sessions = shownSessions(WARMUPS + RUNS, "bench-attempts-l1");
  for (let index = 0; index < WARMUPS; index += 1) {
    prepareLaneOneNote({
      lane: "run",
      records,
      coverage,
      fingerprints: [targetFingerprint],
      cwd: targetCwd,
      now: NOW,
      env: cleanEnv(tempHome, sessions[index]),
      home: tempHome,
    });
  }
  for (let index = 0; index < RUNS; index += 1) {
    const measured = measure(() => prepareLaneOneNote({
      lane: "run",
      records,
      coverage,
      fingerprints: [targetFingerprint],
      cwd: targetCwd,
      now: NOW,
      env: cleanEnv(tempHome, sessions[WARMUPS + index]),
      home: tempHome,
    }));
    if (measured.result.text === undefined) {
      throw new Error(`prepareLaneOneNote unexpectedly returned no note on iteration ${index}`);
    }
    lane1NoteBytes = Buffer.byteLength(`rocky: ${measured.result.text}`, "utf8");
    lane1Samples.push(measured.elapsedMs);
  }
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

const fullSummary = summarize(fullSamples);
const singleSummary = summarize(singleSamples);
const lane1Summary = summarize(lane1Samples);
const passed = fullSummary.p50 <= FULL_BUDGET_MS && singleSummary.p50 <= SINGLE_BUDGET_MS;

const report = {
  command: "npm run benchmark:attempts",
  measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
  dataset: {
    records: records.length,
    fingerprints: actualFingerprints,
    cwds: actualCwds,
    targetFingerprint,
    mix,
  },
  warmups: WARMUPS,
  runs: RUNS,
  fullMs: { ...fullSummary, entries: fullEntries },
  singleFingerprintMs: { ...singleSummary, entries: singleEntries },
  prepareLaneOneNoteMs: { ...lane1Summary, noteBytes: lane1NoteBytes },
  gate: {
    fullBudgetMs: FULL_BUDGET_MS,
    singleBudgetMs: SINGLE_BUDGET_MS,
    passed,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (assertBudget && !passed) {
  process.exitCode = 1;
}
