import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import v8 from "node:v8";
import { fileURLToPath } from "node:url";
import {
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_RECORDS,
  MAX_SUPPORTED_MEMORY_RECORDS,
} from "../dist/core/memory-read.js";
import { createMemoryQueries } from "../dist/core/memory-query.js";

const NOW = 1_800_000_000_000;
const COUNTS = [10_000, 50_000, 250_000];
const SCALAR_HEAVY_RECORDS = 70;
const SCALAR_HEAVY_LINE_BYTES = 850 * 1024;
const WRITE_CHUNK_BYTES = 64 * 1024;
const WORKER_TIMEOUT_MS = 180_000;

function line(index) {
  return JSON.stringify({
    kind: "failure",
    id: `score-${index}`,
    ts: NOW - Number(index),
    cwd: "/scorecard",
    cmd: `node benchmark-needle-${index}`,
    exitCode: 1,
    fingerprint: Number(index).toString(16).padStart(16, "0"),
    fingerprintV: 2,
    signature: [`benchmark needle ${Number(index) % 100}`],
    excerpt: "benchmark needle",
  });
}

function scalarHeavyLine(index) {
  const base = {
    kind: "failure",
    id: `scalar-${index}`,
    ts: NOW - Number(index),
    cwd: "/scorecard",
    cmd: "scalar-heavy",
    exitCode: 1,
    fingerprint: Number(index).toString(16).padStart(16, "0"),
    fingerprintV: 2,
    signature: ["scalar-heavy"],
    excerpt: "",
  };
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  return JSON.stringify({ ...base, excerpt: "s".repeat(Math.max(0, SCALAR_HEAVY_LINE_BYTES - overhead)) });
}

function writeAll(descriptor, value) {
  let offset = 0;
  while (offset < value.byteLength) {
    const written = writeSync(descriptor, value, offset, value.byteLength - offset);
    if (written <= 0) throw new Error("memory fixture write made no progress");
    offset += written;
  }
}

function writeFixture(memoryPath, envelope) {
  const descriptor = openSync(memoryPath, "w");
  let bytes = 0;
  let chunk = "";
  const flush = () => {
    if (chunk.length === 0) return;
    const value = Buffer.from(chunk, "utf8");
    writeAll(descriptor, value);
    bytes += value.byteLength;
    chunk = "";
  };
  try {
    if (envelope === "over-cap") {
      // Repeated valid IDs make skipped evidence observable while keeping the
      // fixture small in object terms. The timestamp remains valid JSON.
      const repeated = `${line(0)}\n`;
      const target = MAX_MEMORY_FILE_BYTES + Buffer.byteLength(repeated, "utf8");
      while (bytes + Buffer.byteLength(chunk, "utf8") < target) {
        chunk += repeated;
        if (Buffer.byteLength(chunk, "utf8") >= WRITE_CHUNK_BYTES) flush();
      }
      flush();
    } else if (envelope === "scalar-heavy") {
      for (let index = 0; index < SCALAR_HEAVY_RECORDS; index += 1) {
        chunk += `${scalarHeavyLine(index)}\n`;
        if (Buffer.byteLength(chunk, "utf8") >= WRITE_CHUNK_BYTES) flush();
      }
      flush();
    } else {
      for (let index = 0; index < envelope; index += 1) {
        chunk += `${line(index)}\n`;
        if (Buffer.byteLength(chunk, "utf8") >= WRITE_CHUNK_BYTES) flush();
      }
      flush();
    }
  } finally {
    closeSync(descriptor);
  }
  return bytes;
}

function measure(root, envelope, query, operation) {
  globalThis.gc?.({ type: "major", execution: "sync" });
  const memoryHome = join(root, query);
  const memoryPath = join(memoryHome, "memory.jsonl");
  mkdirSync(memoryHome, { recursive: true });
  const bytes = writeFixture(memoryPath, envelope);
  globalThis.gc?.({ type: "major", execution: "sync" });
  process.env.ROCKY_HOME = memoryHome;
  const queries = createMemoryQueries();
  const started = performance.now();
  const answer = operation === "stats"
    ? queries.stats({ now: NOW })
    : queries.recall({ query: "benchmark needle", limit: 3, now: NOW });
  const elapsedMs = performance.now() - started;
  // Use the query's already-materialized snapshot for coverage and totals.
  // Calling loadMemoryChecked here would retain a third record array and make
  // the RSS measurement describe the probe rather than steady query state.
  const stats = operation === "stats" ? answer : queries.stats({ now: NOW });
  const coverage = queries.coverage?.();
  globalThis.gc?.({ type: "major", execution: "sync" });
  const rssAfterGcBytes = process.memoryUsage().rss;
  const heapUsedAfterGcBytes = process.memoryUsage().heapUsed;
  const resource = process.resourceUsage();
  const resourceMaxRssRaw = resource.maxRSS;
  // Node reports resourceUsage().maxRSS in kilobytes (including Windows).
  const resourceMaxRssUnit = "kilobytes";
  const resourceMaxRssBytes = resourceMaxRssRaw * 1024;
  return {
    operation,
    records: stats.failures + stats.triples + stats.notes,
    bytes,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    statsMs: operation === "stats" ? Number(elapsedMs.toFixed(3)) : undefined,
    recallMs: operation === "recall" ? Number(elapsedMs.toFixed(3)) : undefined,
    hits: operation === "recall" ? answer.length : undefined,
    rssAfterGcBytes,
    heapUsedAfterGcBytes,
    heapTotalAfterGcBytes: v8.getHeapStatistics().total_heap_size,
    resourceMaxRssRaw,
    resourceMaxRssUnit,
    resourceMaxRssBytes,
    coverage,
  };
}

function worker(envelope, operation) {
  const root = mkdtempSync(join(tmpdir(), "rocky-memory-budget-worker-"));
  try {
    process.stdout.write(JSON.stringify({ envelope, ...measure(root, envelope, `case-${String(envelope)}`, operation) }) + "\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runWorker(envelope, operation) {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", String(envelope), operation], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: WORKER_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || `worker failed: ${result.status}`);
  }
  const output = result.stdout.trim();
  if (!output) throw new Error(`worker returned no scorecard for ${envelope}/${operation}`);
  return JSON.parse(output);
}

function assertScorecard(scorecard) {
  const byEnvelope = new Map(scorecard.map((entry) => [String(entry.envelope), entry]));
  for (const envelope of [...COUNTS, "over-cap", "scalar-heavy"]) {
    const entry = byEnvelope.get(String(envelope));
    if (!entry || !Number.isFinite(entry.statsMs) || !Number.isFinite(entry.recallMs)
        || !Number.isSafeInteger(entry.rssAfterGcBytes) || entry.rssAfterGcBytes < 0
        || !Number.isSafeInteger(entry.resourceMaxRssBytes) || entry.resourceMaxRssBytes < 0) {
      throw new Error(`invalid scorecard entry for ${envelope}`);
    }
  }
  const fiftyK = byEnvelope.get("50000");
  if (fiftyK.records !== Math.min(50_000, MAX_SUPPORTED_MEMORY_RECORDS)
      || (MAX_SUPPORTED_MEMORY_RECORDS === MAX_MEMORY_RECORDS && fiftyK.coverage.complete !== true)
      || (MAX_SUPPORTED_MEMORY_RECORDS < MAX_MEMORY_RECORDS && fiftyK.coverage.complete !== false)) {
    throw new Error("50k fixture did not remain inside supported envelope");
  }
  if (fiftyK.statsMs >= 5_000 || fiftyK.recallMs >= 5_000) {
    throw new Error(`50k bounded latency guard missed: stats=${fiftyK.statsMs}ms recall=${fiftyK.recallMs}ms`);
  }
  const twoFiftyK = byEnvelope.get("250000");
  if (twoFiftyK.records !== MAX_SUPPORTED_MEMORY_RECORDS || twoFiftyK.coverage.complete !== false
      || twoFiftyK.coverage.truncated < 1 || twoFiftyK.statsMs >= 2_000 || twoFiftyK.recallMs >= 2_000) {
    throw new Error(`250k fixture did not meet bounded record-cap target: stats=${twoFiftyK.statsMs}ms recall=${twoFiftyK.recallMs}ms`);
  }
  const overCap = byEnvelope.get("over-cap");
  if (overCap.coverage.complete !== false || overCap.coverage.truncated < 1
      || overCap.coverage.bytesScanned > MAX_MEMORY_FILE_BYTES) {
    throw new Error("over-cap fixture did not disclose bounded incomplete coverage");
  }
  const scalarHeavy = byEnvelope.get("scalar-heavy");
  if (scalarHeavy.records >= SCALAR_HEAVY_RECORDS || scalarHeavy.coverage.complete !== false ||
      scalarHeavy.coverage.reason !== "file-size-cap" || scalarHeavy.coverage.truncated < 1 ||
      scalarHeavy.coverage.bytesScanned > MAX_MEMORY_FILE_BYTES) {
    throw new Error("scalar-heavy fixture did not disclose file-cap degraded coverage");
  }
  for (const envelope of ["10000", "over-cap", "scalar-heavy"]) {
    const entry = byEnvelope.get(envelope);
    if (entry.rssAfterGcBytes >= 150 * 1024 * 1024) {
      throw new Error(`${envelope} bounded RSS guard missed: rssAfterGc=${entry.rssAfterGcBytes}`);
    }
  }

  // The approved targets are measured on the reference Linux Node 22 runner.
  // Other hosts still enforce bounded degraded behavior above; their timings
  // and RSS are reported without pretending to be reference measurements.
  const reference = process.platform === "linux" && process.versions.node.startsWith("22.");
  if (reference) {
    if (fiftyK.statsMs >= 500 || fiftyK.recallMs >= 750) {
      throw new Error(`reference 50k latency budget missed: stats=${fiftyK.statsMs}ms recall=${fiftyK.recallMs}ms`);
    }
    if (Math.max(...scorecard.map((entry) => entry.rssAfterGcBytes)) >= 150 * 1024 * 1024) {
      throw new Error("reference RSS budget missed");
    }
  }
  return { referenceTargetsEnforced: reference };
}

if (process.argv[2] === "--worker") {
  const workerEnvelope = process.argv[3] === "over-cap" || process.argv[3] === "scalar-heavy"
    ? process.argv[3]
    : Number(process.argv[3]);
  worker(workerEnvelope, process.argv[4] === "recall" ? "recall" : "stats");
} else {
  const scorecard = [];
  for (const envelope of [...COUNTS, "over-cap", "scalar-heavy"]) {
    const stats = runWorker(envelope, "stats");
    const recall = runWorker(envelope, "recall");
    scorecard.push({
      envelope,
      records: stats.records,
      bytes: stats.bytes,
      statsMs: stats.statsMs,
      recallMs: recall.recallMs,
      statsRssAfterGcBytes: stats.rssAfterGcBytes,
      recallRssAfterGcBytes: recall.rssAfterGcBytes,
      rssAfterGcBytes: Math.max(stats.rssAfterGcBytes, recall.rssAfterGcBytes),
      statsResourceMaxRssBytes: stats.resourceMaxRssBytes,
      recallResourceMaxRssBytes: recall.resourceMaxRssBytes,
      resourceMaxRssBytes: Math.max(stats.resourceMaxRssBytes, recall.resourceMaxRssBytes),
      coverage: stats.coverage,
      recallCoverage: recall.coverage,
    });
  }
  const gate = assertScorecard(scorecard);
  process.stdout.write(`${JSON.stringify({
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    limits: {
      maxFileBytes: MAX_MEMORY_FILE_BYTES,
      logicalReferenceRecords: MAX_MEMORY_RECORDS,
      supportedRecords: MAX_SUPPORTED_MEMORY_RECORDS,
      supportedEnvelope: MAX_SUPPORTED_MEMORY_RECORDS < MAX_MEMORY_RECORDS
        ? `${process.platform} Node ${process.versions.node} degraded ${MAX_SUPPORTED_MEMORY_RECORDS}-record cap`
        : `${process.platform} Node ${process.versions.node} exact reference ${MAX_MEMORY_RECORDS}-record cap`,
    },
    targets: {
      referenceLinuxNode22: { stats50kMs: 500, recall50kMs: 750, rssBytes: 150 * 1024 * 1024 },
      bounded250kMs: 2_000,
    },
    ...gate,
    scorecard,
  }, null, 2)}\n`);
}
