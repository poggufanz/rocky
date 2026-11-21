import os from "node:os";
import { performance } from "node:perf_hooks";
import { buildProblems } from "../dist/core/attempts.js";
import { commandIdentity, fingerprintSignature } from "../dist/core/fingerprint.js";
import { MEMORY_FORMAT_VERSION } from "../dist/core/memory-read.js";

const RECORD_COUNT = 10_000;
const FINGERPRINT_COUNT = 200;
const CWD_COUNT = 20;
const WARMUPS = 1;
const RUNS = 5;
const FULL_BUDGET_MS = 30;
const SINGLE_BUDGET_MS = 10;
const NOW = 1_800_000_000_000;

function makeDataset() {
  const cwds = Array.from({ length: CWD_COUNT }, (_, index) => `/benchmark/project-${index}`);
  const cmds = Array.from({ length: 10 }, (_, index) => {
    const cmd = `npm run check-${index}`;
    const identity = commandIdentity(cmd, { platform: "linux" });
    return { cmd, commandIdentity: identity.value, identityReliable: identity.reliable };
  });
  const fingerprints = Array.from({ length: FINGERPRINT_COUNT }, (_, index) => {
    const signature = [`error: benchmark failure family ${index}`];
    const cmdMeta = cmds[index % cmds.length];
    return {
      fp: fingerprintSignature(signature, cmdMeta.cmd, 1),
      signature,
      excerpt: `Error: benchmark failure family ${index}`,
    };
  });

  const records = [];
  const lastFailureByCwdFp = new Map();
  let seq = 0;
  let ts = NOW - 100_000_000;

  while (records.length < RECORD_COUNT) {
    ts += 5_000;
    const slot = Math.floor(seq / FINGERPRINT_COUNT) % 10;
    const fpIdx = seq % FINGERPRINT_COUNT;
    const cwdIdx = (Math.floor(fpIdx / 10) + Math.floor(seq / (FINGERPRINT_COUNT * 10))) % CWD_COUNT;
    const cwd = cwds[cwdIdx];
    const fpMeta = fingerprints[fpIdx];
    const cmdMeta = cmds[fpIdx % cmds.length];
    const key = `${cwdIdx}:${fpIdx}`;
    const prior = lastFailureByCwdFp.get(key);

    if (slot === 7 && prior !== undefined && records.length < RECORD_COUNT) {
      const fixId = `fix-${seq}`;
      prior.resolvedBy = fixId;
      records.push({
        kind: "fix",
        id: fixId,
        ts,
        cwd,
        cmd: cmdMeta.cmd,
        failureIds: [prior.id],
        commandIdentity: cmdMeta.commandIdentity,
        identityV: 1,
        identityReliable: cmdMeta.identityReliable,
        platform: "linux",
      });
      lastFailureByCwdFp.delete(key);
    } else if (slot === 9 && prior !== undefined && records.length < RECORD_COUNT) {
      records.push({
        kind: "association",
        id: `assoc-${seq}`,
        ts,
        cwd,
        cmd: `${cmdMeta.cmd} -- --filter unit`,
        candidateFailureIds: [prior.id],
        links: [{ id: prior.id, basis: "program", confidence: "possible" }],
        commandIdentity: cmdMeta.commandIdentity,
        identityV: 1,
        identityReliable: cmdMeta.identityReliable,
        platform: "linux",
      });
      lastFailureByCwdFp.delete(key);
    } else {
      const failure = {
        kind: "failure",
        id: `fail-${seq}`,
        ts,
        cwd,
        cmd: cmdMeta.cmd,
        exitCode: 1,
        fingerprint: fpMeta.fp,
        fingerprintV: 2,
        signature: fpMeta.signature,
        excerpt: fpMeta.excerpt,
        origin: "run",
        commandIdentity: cmdMeta.commandIdentity,
        identityV: 1,
        identityReliable: cmdMeta.identityReliable,
        platform: "linux",
      };
      records.push(failure);
      lastFailureByCwdFp.set(key, failure);
    }
    seq += 1;
  }

  const actualFingerprints = new Set(
    records.filter((record) => record.kind === "failure").map((record) => record.fingerprint),
  ).size;
  const actualCwds = new Set(records.map((record) => record.cwd)).size;
  if (actualFingerprints !== FINGERPRINT_COUNT || actualCwds !== CWD_COUNT) {
    throw new Error(
      `Benchmark dataset cardinality mismatch: expected ${FINGERPRINT_COUNT} fingerprints and ${CWD_COUNT} cwds, got ${actualFingerprints} and ${actualCwds}`,
    );
  }

  return {
    records,
    actualFingerprints,
    actualCwds,
    targetFingerprint: fingerprints[0].fp,
    coverage: {
      version: MEMORY_FORMAT_VERSION,
      scanned: records.length,
      skipped: 0,
      truncated: 0,
      bytesScanned: records.length * 400,
      bytesTotal: records.length * 400,
      complete: true,
    },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(fn) {
  const started = performance.now();
  const result = fn();
  return { elapsedMs: performance.now() - started, result };
}

const assertBudget = process.argv.includes("--assert");
const { records, actualFingerprints, actualCwds, targetFingerprint, coverage } = makeDataset();

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
  fullSamples.push(Number(full.elapsedMs.toFixed(3)));
  singleSamples.push(Number(single.elapsedMs.toFixed(3)));
  fullEntries = full.result.entries.length;
  singleEntries = single.result.entries.length;
}

const fullMedianMs = median(fullSamples);
const singleMedianMs = median(singleSamples);
const passed = fullMedianMs <= FULL_BUDGET_MS && singleMedianMs <= SINGLE_BUDGET_MS;

const report = {
  command: "npm run benchmark:attempts",
  measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
  dataset: {
    records: records.length,
    fingerprints: actualFingerprints,
    cwds: actualCwds,
    targetFingerprint,
  },
  warmups: WARMUPS,
  runs: RUNS,
  fullMs: { median: fullMedianMs, samples: fullSamples, entries: fullEntries },
  singleFingerprintMs: { median: singleMedianMs, samples: singleSamples, entries: singleEntries },
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
