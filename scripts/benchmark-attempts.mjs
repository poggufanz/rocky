import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { prepareLaneOneNote } from "../dist/commands/attempt-note-lane.js";
import { buildProblems } from "../dist/core/attempts.js";
import {
  commandIdentity,
  FINGERPRINT_ALGORITHM_VERSION,
  fingerprintSignature,
} from "../dist/core/fingerprint.js";
import { MEMORY_FORMAT_VERSION } from "../dist/core/memory-read.js";

const RECORD_COUNT = 10_000;
const FINGERPRINT_COUNT = 200;
const CWD_COUNT = 20;
const WARMUPS = 1;
const RUNS = 20;
const FULL_BUDGET_MS = 30;
const SINGLE_BUDGET_MS = 10;
const NOW = 1_800_000_000_000;

const SIGNAL_TEMPLATES = [
  (tag, idx) => `error: family ${tag} check failed in service stage #`,
  (tag, idx) => `fatal: cannot connect to worker ${tag} on port ${4000 + idx}`,
  (tag, idx) => `exception: missing config entry for ${tag} pipeline`,
  (tag, idx) => `failed: invalid checksum while verifying ${tag} artifact`,
  (tag, idx) => `error: connection refused by upstream ${tag} gateway`,
  (tag, idx) => `unexpected token while parsing ${tag} manifest`,
  (tag, idx) => `unable to acquire lock for ${tag} deployment`,
  (tag, idx) => `traceback: panic in ${tag} handler dispatch`,
];

const LONG_CMD_PATH_RE = /(?:^|\s)\/(?:[^\s/]+\/)+[^\s/]+/;
const LONG_CMD_SHA_RE = /\b[0-9a-f]{40}\b/;
const LONG_CMD_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
const LONG_CMD_PORT_RE = /\b127\.0\.0\.1:\d{4,5}\b/;
const LONG_CMD_TS_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/;

function alphaTag(index) {
  let n = index;
  let out = "";
  for (let i = 0; i < 3; i += 1) {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function deterministicHex(seedA, seedB, length) {
  let state = ((seedA * 2654435761) ^ (seedB * 2246822519) ^ 0x9e3779b9) >>> 0;
  let out = "";
  while (out.length < length) {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
    z ^= (z + Math.imul(z ^ (z >>> 7), z | 61)) >>> 0;
    z = (z ^ (z >>> 14)) >>> 0;
    out += z.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

function makeRealisticCommand(fpIdx, seq, ts) {
  const tag = alphaTag(fpIdx);
  const port = 4000 + fpIdx;
  const sha = deterministicHex(fpIdx + 1, seq + 11, 40);
  const u = deterministicHex(fpIdx + 101, seq + 997, 32);
  const uuid = `${u.slice(0, 8)}-${u.slice(8, 12)}-4${u.slice(13, 16)}-8${u.slice(17, 20)}-${u.slice(20, 32)}`;
  const iso = new Date(ts).toISOString();
  // Varying path segments shifts command byte length across 300..1,200 bytes
  // while keeping `normalizeLine(cmd)` identical within a command family.
  const segments = 1 + ((seq * 7 + fpIdx * 13) % 42);
  const deepDir = Array.from({ length: segments }, (_, idx) => `seg-${(seq + idx) % 97}-${idx}`).join("/");
  const entryPath = `/workspace/services/svc-${alphaTag(fpIdx % 25)}/${deepDir}/runner-${seq}.mjs`;
  const logPath = `/var/log/rocky/runs/${deepDir}/job-${seq}.log`;
  return (
    `node ${entryPath} --family fam-${tag} --commit ${sha} --request-id ${uuid} ` +
    `--endpoint http://127.0.0.1:${port}/api/v1/run --listen 127.0.0.1:${port} ` +
    `--started-at ${iso} --pid ${10000 + (seq % 50000)} --attempt ${1 + (seq % 99)} ` +
    `--log ${logPath}`
  );
}

function makeSignalSignature(fpIdx) {
  const tag = alphaTag(fpIdx);
  const lineCount = 1 + (fpIdx % 8);
  const lines = [];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(SIGNAL_TEMPLATES[i](tag, fpIdx));
  }
  return lines;
}

function measureDatasetMix(records) {
  let totalFailures = 0;
  let emptySignatureFailures = 0;
  let signalLineFailures = 0;
  let minSignalLines = Infinity;
  let maxSignalLines = 0;
  let longCommandBytesMin = Infinity;
  let longCommandBytesMax = 0;
  const distinctLongCommands = new Set();
  const distinctAllCommands = new Set();

  for (const record of records) {
    if (record.kind !== "failure") continue;
    totalFailures += 1;
    distinctAllCommands.add(record.cmd);
    const sigLen = record.signature.length;
    if (sigLen === 0) {
      emptySignatureFailures += 1;
    } else if (sigLen >= 1 && sigLen <= 8) {
      signalLineFailures += 1;
      if (sigLen < minSignalLines) minSignalLines = sigLen;
      if (sigLen > maxSignalLines) maxSignalLines = sigLen;
    }
    const bytes = Buffer.byteLength(record.cmd, "utf8");
    if (
      bytes >= 300 &&
      bytes <= 1200 &&
      LONG_CMD_PATH_RE.test(record.cmd) &&
      LONG_CMD_SHA_RE.test(record.cmd) &&
      LONG_CMD_UUID_RE.test(record.cmd) &&
      LONG_CMD_PORT_RE.test(record.cmd) &&
      LONG_CMD_TS_RE.test(record.cmd)
    ) {
      distinctLongCommands.add(record.cmd);
      if (bytes < longCommandBytesMin) longCommandBytesMin = bytes;
      if (bytes > longCommandBytesMax) longCommandBytesMax = bytes;
    }
  }

  return {
    totalFailures,
    distinctCommands: distinctAllCommands.size,
    distinctLongCommands: distinctLongCommands.size,
    distinctLongCommandPct: Number(((distinctLongCommands.size / totalFailures) * 100).toFixed(2)),
    longCommandBytesMin: Number.isFinite(longCommandBytesMin) ? longCommandBytesMin : 0,
    longCommandBytesMax,
    emptySignatureFailures,
    emptySignaturePct: Number(((emptySignatureFailures / totalFailures) * 100).toFixed(2)),
    signalLineFailures,
    signalLinePct: Number(((signalLineFailures / totalFailures) * 100).toFixed(2)),
    minSignalLines: Number.isFinite(minSignalLines) ? minSignalLines : 0,
    maxSignalLines,
  };
}

function makeDataset() {
  const cwds = Array.from({ length: CWD_COUNT }, (_, index) => `/benchmark/project-${index}`);
  const shortCmds = Array.from({ length: 10 }, (_, index) => {
    const cmd = `npm run check-${index}`;
    const identity = commandIdentity(cmd, { platform: "linux" });
    return { cmd, commandIdentity: identity.value, identityReliable: identity.reliable };
  });
  const fingerprints = Array.from({ length: FINGERPRINT_COUNT }, (_, index) => {
    const isCommandFamily = index % 10 < 3;
    const usesLongCmd = index % 10 < 7;
    const signature = isCommandFamily ? [] : makeSignalSignature(index);
    const sampleCmd = usesLongCmd ? makeRealisticCommand(index, 0, NOW) : shortCmds[index % shortCmds.length].cmd;
    return {
      fp: fingerprintSignature(signature, sampleCmd, 1),
      signature,
      usesLongCmd,
      isCommandFamily,
      excerpt: isCommandFamily ? "" : `Error: benchmark failure family ${alphaTag(index)}`,
    };
  });

  const records = [];
  const lastFailureByCwdFp = new Map();
  let seq = 0;
  let ts = NOW - 100_000_000;
  let verifiedCommandFamilyCount = 0;

  while (records.length < RECORD_COUNT) {
    ts += 5_000;
    const slot = Math.floor(seq / FINGERPRINT_COUNT) % 10;
    const fpIdx = seq % FINGERPRINT_COUNT;
    const cwdIdx = (Math.floor(fpIdx / 10) + Math.floor(seq / (FINGERPRINT_COUNT * 10))) % CWD_COUNT;
    const cwd = cwds[cwdIdx];
    const fpMeta = fingerprints[fpIdx];
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
        cmd: prior.cmd,
        failureIds: [prior.id],
        commandIdentity: prior.commandIdentity,
        identityV: 1,
        identityReliable: prior.identityReliable,
        platform: "linux",
      });
      lastFailureByCwdFp.delete(key);
    } else if (slot === 9 && prior !== undefined && records.length < RECORD_COUNT) {
      const assocCmd = `${shortCmds[fpIdx % shortCmds.length].cmd} -- --filter unit`;
      const assocId = commandIdentity(assocCmd, { platform: "linux" });
      records.push({
        kind: "association",
        id: `assoc-${seq}`,
        ts,
        cwd,
        cmd: assocCmd,
        candidateFailureIds: [prior.id],
        links: [{ id: prior.id, basis: "program", confidence: "possible" }],
        commandIdentity: assocId.value,
        identityV: 1,
        identityReliable: assocId.reliable,
        platform: "linux",
      });
      lastFailureByCwdFp.delete(key);
    } else {
      let cmd;
      let identityValue;
      let identityReliable;
      if (fpMeta.usesLongCmd) {
        cmd = makeRealisticCommand(fpIdx, seq, ts);
        const identity = commandIdentity(cmd, { platform: "linux" });
        identityValue = identity.value;
        identityReliable = identity.reliable;
      } else {
        const shortMeta = shortCmds[fpIdx % shortCmds.length];
        cmd = shortMeta.cmd;
        identityValue = shortMeta.commandIdentity;
        identityReliable = shortMeta.identityReliable;
      }
      if (fpMeta.isCommandFamily && verifiedCommandFamilyCount < FINGERPRINT_COUNT) {
        const checkFp = fingerprintSignature([], cmd, 1);
        if (checkFp !== fpMeta.fp) {
          throw new Error(`Command-family fingerprint drift for fpIdx=${fpIdx}, seq=${seq}: ${checkFp} !== ${fpMeta.fp}`);
        }
        verifiedCommandFamilyCount += 1;
      }
      const failure = {
        kind: "failure",
        id: `fail-${seq}`,
        ts,
        cwd,
        cmd,
        exitCode: 1,
        fingerprint: fpMeta.fp,
        fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
        signature: fpMeta.signature,
        excerpt: fpMeta.excerpt,
        origin: "run",
        commandIdentity: identityValue,
        identityV: 1,
        identityReliable,
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

  const mix = measureDatasetMix(records);
  if (mix.distinctLongCommandPct < 60) {
    throw new Error(`Expected >=60% distinct 300-1200B commands, got ${mix.distinctLongCommandPct}%`);
  }
  if (mix.emptySignaturePct < 29 || mix.emptySignaturePct > 31) {
    throw new Error(`Expected ~30% empty-signature failures, got ${mix.emptySignaturePct}%`);
  }
  if (mix.emptySignatureFailures + mix.signalLineFailures !== mix.totalFailures) {
    throw new Error(`Unexpected signature lengths outside 0 or 1..8`);
  }

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
