import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { disabledRecallWithAi } from "../ai/port.js";
import { buildProblems } from "../core/attempts.js";
import { commandIdentity } from "../core/fingerprint.js";
import {
  createMemoryQueries,
  loadDurableMemorySnapshot,
  loadDurableMemorySnapshotOrThrow,
  queryRecall,
  type MemoryQueries,
} from "../core/memory-query.js";
import {
  canonicalPath,
  memoryReadMetrics,
  type AssociationRecord,
  type FailureRecord,
  type FixRecord,
  type MemoryRecord,
  type RationaleRecord,
} from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { makeCardsForForTest, type CardsReadSyncHook } from "../desk/cards-read.js";
import type { StoredCard } from "../desk/cards-record.js";
import { cardsFilePath } from "../listening/cards-path.js";
import {
  ATTEMPT_HISTORY_NOTICE,
  type ProjectedProblemEntry,
} from "../mcp/attempts-projection.js";
import {
  MAX_RESPONSE_BYTES,
  projectRecallHits,
  projectRecentFailures,
} from "../mcp/privacy.js";
import {
  createToolRegistry,
  MCP_TOOL_CATALOG,
  MCP_TOOL_CATALOG_CONTRACT,
  MCP_TOOL_CATALOG_VERSION,
  McpInvalidParamsError,
  TOOL_ENVELOPE_RESERVE_BYTES,
} from "../mcp/tools.js";
import { causalWordViolations } from "./causal-words.js";

const RESPONSE_CAP_BYTES = MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES;
const MINUTE = 60_000;

function makeFailure(
  overrides: Partial<FailureRecord> & { id: string; ts: number },
): FailureRecord {
  const cmd = overrides.cmd ?? "npm test";
  const platform = overrides.platform ?? process.platform;
  const identity = commandIdentity(cmd, { platform });
  return {
    kind: "failure",
    cwd: process.cwd(),
    cmd,
    exitCode: 1,
    fingerprint: "1111222233334444",
    fingerprintV: 2,
    signature: ["TypeError: retryBudget undefined"],
    excerpt: "TypeError: retryBudget undefined",
    origin: "run",
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform,
    ...overrides,
  };
}

function makeFix(
  overrides: Partial<FixRecord> & { id: string; ts: number },
): FixRecord {
  const cmd = overrides.cmd ?? "npm test";
  const platform = overrides.platform ?? process.platform;
  const identity = commandIdentity(cmd, { platform });
  return {
    kind: "fix",
    cwd: process.cwd(),
    cmd,
    failureIds: [],
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform,
    ...overrides,
  };
}

function makeRationale(
  overrides: Partial<RationaleRecord> & { id: string; ts: number },
): RationaleRecord {
  return {
    kind: "rationale",
    v: 1,
    cwd: process.cwd(),
    agent: "claude-code",
    rationale_fidelity: "summary",
    source: "notify",
    excerpt: "adjust retry budget config",
    ...overrides,
  };
}

async function withDurableMemory<T>(
  records: readonly MemoryRecord[],
  use: (memory: MemoryQueries, tempRoot: string) => Promise<T>,
): Promise<T> {
  const tempRoot = mkdtempSync(join(tmpdir(), "rocky-mcp-attempt-history-"));
  const home = join(tempRoot, "home");
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const paths = resolveRockyPaths({ ROCKY_HOME: home });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      paths.memory,
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
      "utf8",
    );
    return await use(createMemoryQueries(), tempRoot);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

test("catalog has 14 tools, attempt_history last, version 1", () => {
  assert.equal(MCP_TOOL_CATALOG_VERSION, 1);
  assert.equal(MCP_TOOL_CATALOG_CONTRACT.version, 1);
  assert.equal(MCP_TOOL_CATALOG.length, 14);
  assert.equal(MCP_TOOL_CATALOG[13], "attempt_history");

  const sanitizedReg = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => []),
    recallWithAi: disabledRecallWithAi,
  });
  const sanitizedList = sanitizedReg.list();
  assert.equal(sanitizedList.length, 14);
  const def = sanitizedList[13]!;
  assert.equal(def.name, "attempt_history");
  assert.equal(def.title, "Attempt history");
  assert.equal(
    def.description,
    "Every remembered attempt at one recurring error: the order of runs and edits, never a cause.",
  );
  assert.deepEqual(def.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(def.inputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      fingerprint: { type: "string", pattern: "^[0-9a-f]{16}$" },
      query: { type: "string", minLength: 1, maxLength: 500 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
      attempts: { type: "integer", minimum: 1, maximum: 20 },
    },
  });

  const rawReg = createToolRegistry({
    exposure: "raw",
    memory: createMemoryQueries(() => []),
    recallWithAi: disabledRecallWithAi,
  });
  const rawDef = rawReg.list()[13]!;
  assert.deepEqual(rawDef.inputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      fingerprint: { type: "string", pattern: "^[0-9a-f]{16}$" },
      query: { type: "string", minLength: 1, maxLength: 500 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
      attempts: { type: "integer", minimum: 1, maximum: 20 },
      cwd: { type: "string" },
    },
  });
});

test("fingerprint and query each return the entry with notice and coverage", async () => {
  const now = Date.now();
  const fp = "a1b2c3d4e5f60718";
  const here = process.cwd();
  const f1 = makeFailure({
    id: "failure-1",
    ts: now - 20 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget",
    fingerprint: fp,
    signature: ["TypeError: retryBudget undefined"],
  });
  const r1 = makeRationale({
    id: "rationale-1",
    ts: now - 19 * MINUTE,
    cwd: here,
    links: { failureId: f1.id },
    files: ["src/retry.ts"],
    excerpt: "raise retry ceiling in config",
  });
  const f2 = makeFailure({
    id: "failure-2",
    ts: now - 10 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget",
    fingerprint: fp,
    signature: ["TypeError: retryBudget undefined"],
  });
  const fix = makeFix({
    id: "fix-1",
    ts: now - 5 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget",
    failureIds: [f2.id],
  });

  await withDurableMemory([f1, r1, f2, fix], async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const signal = new AbortController().signal;

    const byFp = await reg.call("attempt_history", { fingerprint: fp }, signal);
    const bodyFp = byFp.structuredContent as Record<string, unknown>;
    assert.equal(bodyFp.exposure, "sanitized");
    assert.equal(bodyFp.notice, ATTEMPT_HISTORY_NOTICE);
    assert.equal(bodyFp.memoryVersion, 1);
    assert.equal(bodyFp.memoryCoverageIncomplete, false);
    assert.equal((bodyFp.coverage as { complete: boolean }).complete, true);
    assert.deepEqual(bodyFp.memoryCoverage, bodyFp.coverage);
    assert.equal("truncated" in bodyFp, false);

    const entriesFp = bodyFp.entries as ProjectedProblemEntry[];
    assert.equal(entriesFp.length, 1);
    assert.equal(entriesFp[0]!.fingerprint, fp);
    assert.equal(entriesFp[0]!.cwdScope, "here");
    assert.equal("cwd" in entriesFp[0]!, false);
    assert.equal(entriesFp[0]!.attempts.length, 2);
    assert.equal(entriesFp[0]!.attemptsOmitted, 0);
    assert.equal(entriesFp[0]!.attempts[0]!.outcome, "same_failure");
    assert.deepEqual(entriesFp[0]!.attempts[0]!.changes, {
      state: "testimony",
      files: ["src/retry.ts"],
      more: 0,
    });
    assert.equal(entriesFp[0]!.attempts[1]!.outcome, "passed");

    const byQuery = await reg.call("attempt_history", { query: "retryBudget undefined" }, signal);
    const bodyQuery = byQuery.structuredContent as Record<string, unknown>;
    assert.equal(bodyQuery.notice, ATTEMPT_HISTORY_NOTICE);
    assert.equal(bodyQuery.memoryCoverageIncomplete, false);
    const entriesQuery = bodyQuery.entries as ProjectedProblemEntry[];
    assert.equal(entriesQuery.length, 1);
    assert.equal(entriesQuery[0]!.fingerprint, fp);
    assert.equal(entriesQuery[0]!.attempts.length, 2);

    const cappedAttempts = await reg.call(
      "attempt_history",
      { fingerprint: fp, attempts: 1 },
      signal,
    );
    const bodyCapped = cappedAttempts.structuredContent as Record<string, unknown>;
    const entriesCapped = bodyCapped.entries as ProjectedProblemEntry[];
    assert.equal(entriesCapped[0]!.attempts.length, 1);
    assert.equal(entriesCapped[0]!.attemptsOmitted, 1);
    assert.equal(entriesCapped[0]!.attempts[0]!.ts, f2.ts);
    assert.equal("truncated" in bodyCapped, false);
  });
});

test("both or neither of fingerprint and query is invalid", async () => {
  const reg = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => []),
    recallWithAi: disabledRecallWithAi,
  });
  const signal = new AbortController().signal;
  const validFp = "0123456789abcdef";

  const badInputs: unknown[] = [
    null,
    [],
    "query",
    {},
    { fingerprint: validFp, query: "type error" },
    { fingerprint: "1234" },
    { fingerprint: "0123456789abcdef0" },
    { fingerprint: "0123456789ABCDEF" },
    { fingerprint: "0123456789abcdeg" },
    { fingerprint: 1234567890123456 },
    { query: "" },
    { query: "a".repeat(501) },
    { query: 42 },
    { query: "ok", unknownKey: true },
    { query: "ok", limit: 0 },
    { query: "ok", limit: 11 },
    { query: "ok", limit: 1.5 },
    { query: "ok", limit: "3" },
    { query: "ok", attempts: 0 },
    { query: "ok", attempts: 21 },
    { query: "ok", attempts: 2.5 },
    { query: "ok", attempts: "10" },
  ];

  for (const input of badInputs) {
    await assert.rejects(
      () => reg.call("attempt_history", input, signal),
      (err: unknown) => err instanceof McpInvalidParamsError && err.message === "invalid params",
      `expected invalid params for ${JSON.stringify(input)}`,
    );
  }
});

test("cwd is rejected under sanitized and filters under raw", async () => {
  const now = Date.now();
  const fp = "fedcba9876543210";

  await withDurableMemory([], async (_unused, tempRoot) => {
    const dirA = join(tempRoot, "dir-a");
    const dirB = join(tempRoot, "dir-b");
    const records: MemoryRecord[] = [
      makeFailure({
        id: "failure-a",
        ts: now - 15 * MINUTE,
        cwd: dirA,
        fingerprint: fp,
        signature: ["Error: port busy"],
      }),
      makeFailure({
        id: "failure-b",
        ts: now - 10 * MINUTE,
        cwd: dirB,
        fingerprint: fp,
        signature: ["Error: port busy"],
      }),
    ];

    await withDurableMemory(records, async (memory) => {
      const signal = new AbortController().signal;
      const sanitized = createToolRegistry({
        exposure: "sanitized",
        memory,
        recallWithAi: disabledRecallWithAi,
      });

      await assert.rejects(
        () => sanitized.call("attempt_history", { fingerprint: fp, cwd: dirA }, signal),
        (err: unknown) => err instanceof McpInvalidParamsError && err.message === "invalid params",
      );

      // Sanitized without cwd spans all directories and computes cwdScope against server cwd.
      const sanitizedAll = await sanitized.call("attempt_history", { fingerprint: fp }, signal);
      const sanitizedEntries = (sanitizedAll.structuredContent as { entries: ProjectedProblemEntry[] }).entries;
      assert.equal(sanitizedEntries.length, 2);
      for (const entry of sanitizedEntries) {
        assert.equal(entry.cwdScope, "elsewhere");
        assert.equal("cwd" in entry, false);
      }

      const raw = createToolRegistry({
        exposure: "raw",
        memory,
        recallWithAi: disabledRecallWithAi,
      });

      await assert.rejects(
        () => raw.call("attempt_history", { fingerprint: fp, cwd: 123 }, signal),
        (err: unknown) => err instanceof McpInvalidParamsError && err.message === "invalid params",
      );

      const rawDirA = await raw.call("attempt_history", { fingerprint: fp, cwd: dirA }, signal);
      const rawDirAEntries = (rawDirA.structuredContent as { entries: ProjectedProblemEntry[] }).entries;
      assert.equal(rawDirAEntries.length, 1);
      assert.equal(rawDirAEntries[0]!.cwd, dirA);
      assert.equal(rawDirAEntries[0]!.cwdScope, "here");

      const rawAll = await raw.call("attempt_history", { fingerprint: fp }, signal);
      const rawAllEntries = (rawAll.structuredContent as { entries: ProjectedProblemEntry[] }).entries;
      assert.equal(rawAllEntries.length, 2);
    });
  });
});

test("oversized history drops oldest attempts first and stays under the cap", async () => {
  const now = Date.now();
  const fp = "abcdef0123456789";
  const here = process.cwd();
  const records: MemoryRecord[] = [];
  const totalAttempts = 20;

  // 20 attempts, each with a ~15 KiB space-separated command so total payload + envelope exceeds RESPONSE_CAP_BYTES.
  const longWords = "word ".repeat(3000).trim();
  for (let i = 0; i < totalAttempts; i += 1) {
    const ts = now - (totalAttempts - i) * MINUTE;
    records.push(
      makeFailure({
        id: `failure-big-${i}`,
        ts,
        cwd: here,
        cmd: `npm test ${i} ${longWords}`,
        fingerprint: fp,
        signature: ["Error: oversized payload test"],
      }),
    );
  }

  await withDurableMemory(records, async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const signal = new AbortController().signal;
    const result = await reg.call(
      "attempt_history",
      { fingerprint: fp, attempts: totalAttempts },
      signal,
    );

    assert.ok(
      Buffer.byteLength(JSON.stringify(result), "utf8") <= RESPONSE_CAP_BYTES,
      "wire envelope must stay under RESPONSE_CAP_BYTES",
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8") <= RESPONSE_CAP_BYTES,
      "structured payload must stay under RESPONSE_CAP_BYTES",
    );

    const body = result.structuredContent as {
      truncated?: boolean;
      entries: ProjectedProblemEntry[];
    };
    assert.equal(body.truncated, true);
    assert.equal(body.entries.length, 1);

    const entry = body.entries[0]!;
    assert.ok(entry.attempts.length >= 1, "newest attempt must be kept");
    assert.ok(entry.attempts.length < totalAttempts, "oldest attempts must be dropped");
    assert.equal(entry.attempts.length + entry.attemptsOmitted, totalAttempts);

    const newestTs = now - MINUTE;
    const oldestTs = now - totalAttempts * MINUTE;
    assert.equal(entry.attempts[entry.attempts.length - 1]!.ts, newestTs);
    assert.equal(entry.attempts.some((a) => a.ts === oldestTs), false);
  });
});

test("oversized multi-entry cap breaks timestamp ties by later entry and drops trailing entries at zero attempts", async () => {
  const now = Date.now();
  const fp = "1234567890abcdef";
  const here = process.cwd();
  const other = join(here, "..", "rocky-other-dir-tiebreak");

  // Two entries (same fp, different dirs): entry 0 (newest lastSeen = now - 1m) and entry 1 (lastSeen = now - 2m).
  // Both have 9 attempts of ~15 KiB each (~272 KiB total payload, ~545 KiB wire envelope > 508 KiB cap),
  // so dropping 1 attempt (~15 KiB) brings the response under cap. Both share the exact oldest timestamp (sharedOldTs);
  // tie-breaking must drop Entry 1's sharedOldTs attempt first and keep Entry 0's.
  const sharedOldTs = now - 100 * MINUTE;
  const wordFiller = "item ".repeat(3000).trim();
  const bigCmd = (tag: string) => `npm test ${tag} ${wordFiller}`;
  const tieRecords: MemoryRecord[] = [
    makeFailure({ id: "e0-old", ts: sharedOldTs, cwd: here, cmd: bigCmd("e0a"), fingerprint: fp, signature: ["Error: tie test"] }),
    ...Array.from({ length: 7 }, (_, idx) =>
      makeFailure({
        id: `e0-${idx}`,
        ts: now - (20 - idx) * MINUTE,
        cwd: here,
        cmd: bigCmd(`e0_${idx}`),
        fingerprint: fp,
        signature: ["Error: tie test"],
      }),
    ),
    makeFailure({ id: "e0-newest", ts: now - MINUTE, cwd: here, cmd: bigCmd("e0z"), fingerprint: fp, signature: ["Error: tie test"] }),
    makeFailure({ id: "e1-old", ts: sharedOldTs, cwd: other, cmd: bigCmd("e1a"), fingerprint: fp, signature: ["Error: tie test"] }),
    ...Array.from({ length: 7 }, (_, idx) =>
      makeFailure({
        id: `e1-${idx}`,
        ts: now - (30 - idx) * MINUTE,
        cwd: other,
        cmd: bigCmd(`e1_${idx}`),
        fingerprint: fp,
        signature: ["Error: tie test"],
      }),
    ),
    makeFailure({ id: "e1-newest", ts: now - 2 * MINUTE, cwd: other, cmd: bigCmd("e1z"), fingerprint: fp, signature: ["Error: tie test"] }),
  ];

  await withDurableMemory(tieRecords, async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const result = await reg.call(
      "attempt_history",
      { fingerprint: fp, limit: 2, attempts: 10 },
      new AbortController().signal,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= RESPONSE_CAP_BYTES);
    const body = result.structuredContent as {
      truncated?: boolean;
      entries: ProjectedProblemEntry[];
    };
    assert.equal(body.truncated, true);
    assert.equal(body.entries.length, 2);
    // Entry 0 (newer lastSeen) is first; Entry 1 (later entry) loses its tied sharedOldTs attempt first.
    assert.equal(body.entries[0]!.attempts[body.entries[0]!.attempts.length - 1]!.ts, now - MINUTE);
    assert.equal(body.entries[1]!.attempts[body.entries[1]!.attempts.length - 1]!.ts, now - 2 * MINUTE);
    assert.equal(body.entries[0]!.attemptsOmitted, 0);
    assert.equal(body.entries[0]!.attempts.some((a) => a.ts === sharedOldTs), true);
    assert.equal(body.entries[1]!.attemptsOmitted, 1);
    assert.equal(body.entries[1]!.attempts.some((a) => a.ts === sharedOldTs), false);
  });

  // Force zero-attempt entry dropping: 10 entries with huge 3-line signatures (~45 KiB per entry = ~450 KiB payload > cap).
  const sigFiller = "err ".repeat(3750).trim();
  const hugeSig = [
    `Error A: ${sigFiller}`,
    `Error B: ${sigFiller}`,
    `Error C: ${sigFiller}`,
  ];
  const zeroAttemptRecords: MemoryRecord[] = Array.from({ length: 10 }, (_, idx) =>
    makeFailure({
      id: `bigsig-${idx}`,
      ts: now - (10 - idx) * MINUTE,
      cwd: join(here, "..", `rocky-sig-dir-${idx}`),
      cmd: "npm test",
      fingerprint: fp,
      signature: hugeSig,
    }),
  );

  await withDurableMemory(zeroAttemptRecords, async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const result = await reg.call(
      "attempt_history",
      { fingerprint: fp, limit: 10, attempts: 1 },
      new AbortController().signal,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= RESPONSE_CAP_BYTES);
    const body = result.structuredContent as {
      truncated?: boolean;
      entries: ProjectedProblemEntry[];
    };
    assert.equal(body.truncated, true);
    assert.ok(body.entries.length > 0 && body.entries.length < 10);
    for (const entry of body.entries) {
      assert.equal(entry.attempts.length, 0);
      assert.equal(entry.attemptsOmitted, 1);
    }
  });
});

function makeWordPadding(targetBytes: number): string {
  const unit = "word ";
  const full = Math.floor(targetBytes / unit.length);
  const rem = targetBytes - full * unit.length;
  if (rem === 0) return unit.repeat(full).trimEnd() + (full > 0 ? "a" : "");
  return `${unit.repeat(full)}${"a".repeat(rem)}`;
}

test("just-fitting attempt_history keeps all attempts without truncated while cappedResult callers keep conservative gate", async () => {
  const now = Date.now();
  const fp = "5566778899aabbcc";
  const here = process.cwd();
  const attemptCount = 16;
  const fixedPad = makeWordPadding(16_200);

  const buildRecords = (lastPadBytes: number): MemoryRecord[] =>
    Array.from({ length: attemptCount }, (_, i) =>
      makeFailure({
        id: `fit-${String(i).padStart(2, "0")}`,
        ts: now - (attemptCount - i) * MINUTE,
        cwd: here,
        cmd: `npm test ${String(i).padStart(2, "0")} ${i === attemptCount - 1 ? makeWordPadding(lastPadBytes) : fixedPad}`,
        fingerprint: fp,
        signature: ["Error: exact wire cap boundary test"],
      }),
    );

  // Calibrate the 16th attempt so the exact wire response lands just below RESPONSE_CAP_BYTES
  // while payloadBytes * 2 + 1024 exceeds RESPONSE_CAP_BYTES (where cappedResult's estimate gate trips).
  const probePad = 10_000;
  let probeWireBytes = 0;
  await withDurableMemory(buildRecords(probePad), async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const probe = await reg.call(
      "attempt_history",
      { fingerprint: fp, attempts: attemptCount },
      new AbortController().signal,
    );
    const probeBody = probe.structuredContent as {
      truncated?: boolean;
      entries: ProjectedProblemEntry[];
    };
    assert.equal("truncated" in probeBody, false);
    assert.equal(probeBody.entries[0]!.attempts.length, attemptCount);
    probeWireBytes = Buffer.byteLength(JSON.stringify(probe), "utf8");
  });

  // Each added ASCII byte in observedCommand adds 2 wire bytes (structuredContent + text).
  const targetWireBytes = RESPONSE_CAP_BYTES - 120;
  const exactFitPad = probePad + Math.floor((targetWireBytes - probeWireBytes) / 2);

  let exactWireBytes = 0;
  await withDurableMemory(buildRecords(exactFitPad), async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const result = await reg.call(
      "attempt_history",
      { fingerprint: fp, attempts: attemptCount },
      new AbortController().signal,
    );
    exactWireBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    const payloadBytes = Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8");
    assert.ok(
      exactWireBytes <= RESPONSE_CAP_BYTES,
      `expected exact wire size ${exactWireBytes} <= ${RESPONSE_CAP_BYTES}`,
    );
    assert.ok(
      payloadBytes * 2 + 1024 > RESPONSE_CAP_BYTES,
      `expected fixture to exceed conservative estimate gate (${payloadBytes * 2 + 1024} > ${RESPONSE_CAP_BYTES})`,
    );

    const body = result.structuredContent as {
      truncated?: boolean;
      entries: ProjectedProblemEntry[];
    };
    assert.equal("truncated" in body, false);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0]!.attempts.length, attemptCount);
    assert.equal(body.entries[0]!.attemptsOmitted, 0);
  });

  // Pushing past RESPONSE_CAP_BYTES by a few bytes must trim exactly one oldest attempt.
  const justOverPad = exactFitPad + Math.floor((RESPONSE_CAP_BYTES - exactWireBytes) / 2) + 4;
  await withDurableMemory(buildRecords(justOverPad), async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const result = await reg.call(
      "attempt_history",
      { fingerprint: fp, attempts: attemptCount },
      new AbortController().signal,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= RESPONSE_CAP_BYTES);
    const body = result.structuredContent as {
      truncated?: boolean;
      entries: ProjectedProblemEntry[];
    };
    assert.equal(body.truncated, true);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0]!.attempts.length, attemptCount - 1);
    assert.equal(body.entries[0]!.attemptsOmitted, 1);
    assert.equal(body.entries[0]!.attempts[0]!.ts, now - (attemptCount - 1) * MINUTE);
  });

  // Opposite direction: existing cappedResult caller (recent_failures) keeps its conservative
  // estimate gate in the same narrow band where exact wire size fits under RESPONSE_CAP_BYTES.
  const buildRecentHits = (lastPadBytes: number) =>
    Array.from({ length: attemptCount }, (_, i) => ({
      failure: makeFailure({
        id: `recent-fit-${String(i).padStart(2, "0")}`,
        ts: now - (attemptCount - i) * MINUTE,
        cwd: here,
        cmd: `npm test ${String(i).padStart(2, "0")} ${i === attemptCount - 1 ? makeWordPadding(lastPadBytes) : fixedPad}`,
        fingerprint: `00000000000000${String(i).padStart(2, "0")}`,
        signature: ["Error: cappedResult boundary lock"],
      }),
    }));

  const probeRecentPayload = projectRecentFailures(buildRecentHits(8_000), "sanitized", now);
  const probeRecentWire = Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(probeRecentPayload) }],
      structuredContent: probeRecentPayload,
    }),
    "utf8",
  );
  const recentBandPad = 8_000 + Math.floor((RESPONSE_CAP_BYTES - 120 - probeRecentWire) / 2);
  const bandHits = buildRecentHits(recentBandPad);
  const unfilteredRecent = projectRecentFailures(bandHits, "sanitized", now);
  const unfilteredRecentText = JSON.stringify(unfilteredRecent);
  const unfilteredRecentWire = Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: unfilteredRecentText }],
      structuredContent: unfilteredRecent,
    }),
    "utf8",
  );
  assert.equal(unfilteredRecent.items.length, attemptCount);
  assert.equal(unfilteredRecent.truncated, false);
  assert.ok(unfilteredRecentWire <= RESPONSE_CAP_BYTES);
  assert.ok(Buffer.byteLength(unfilteredRecentText, "utf8") * 2 + 1024 > RESPONSE_CAP_BYTES);

  const recentMemory: MemoryQueries = {
    ...createMemoryQueries(() => []),
    recentFailures: () => bandHits,
  };
  const recentReg = createToolRegistry({
    exposure: "sanitized",
    memory: recentMemory,
    recallWithAi: disabledRecallWithAi,
  });
  const recentResult = await recentReg.call(
    "recent_failures",
    { limit: 20 },
    new AbortController().signal,
  );
  const recentBody = recentResult.structuredContent as {
    truncated: boolean;
    items: unknown[];
  };
  assert.equal(recentBody.truncated, true);
  assert.equal(recentBody.items.length, attemptCount - 1);
});

test("maximum shape (10 entries x 20 attempts with long commands) trims oldest-first under the cap", async () => {
  const now = Date.now();
  const fp = "deadbeefcafebabe";
  const here = process.cwd();
  const entryCount = 10;
  const attemptsPerEntry = 20;
  const longPad = makeWordPadding(15_500);

  const records: MemoryRecord[] = [];
  const expectedOrder: { entryIndex: number; attemptIndex: number; ts: number }[] = [];

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const dir = join(here, "..", `rocky-max-shape-${entryIndex}`);
    for (let attemptIndex = 0; attemptIndex < attemptsPerEntry; attemptIndex += 1) {
      // Newest attempt establishes deterministic entry ordering (entry 0 newest .. entry 9 oldest).
      // Earlier attempts include intentional cross-entry timestamp ties (entryIndex % 3).
      const ts =
        attemptIndex === attemptsPerEntry - 1
          ? now - (entryIndex + 1) * 1_000
          : now - (attemptsPerEntry - attemptIndex) * MINUTE - (entryIndex % 3) * 1_000;
      expectedOrder.push({ entryIndex, attemptIndex, ts });
      records.push(
        makeFailure({
          id: `max-e${entryIndex}-a${String(attemptIndex).padStart(2, "0")}`,
          ts,
          cwd: dir,
          cmd: `npm test e${entryIndex} a${String(attemptIndex).padStart(2, "0")} ${longPad}`,
          fingerprint: fp,
          signature: ["Error: maximum shape trimming test"],
        }),
      );
    }
  }

  expectedOrder.sort(
    (a, b) => a.ts - b.ts || b.entryIndex - a.entryIndex || a.attemptIndex - b.attemptIndex,
  );

  await withDurableMemory(records, async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const result = await reg.call(
      "attempt_history",
      { fingerprint: fp, limit: entryCount, attempts: attemptsPerEntry },
      new AbortController().signal,
    );

    const wireBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(wireBytes <= RESPONSE_CAP_BYTES, `wireBytes ${wireBytes} must be <= ${RESPONSE_CAP_BYTES}`);

    const body = result.structuredContent as {
      truncated?: boolean;
      entries: ProjectedProblemEntry[];
    };
    assert.equal(body.truncated, true);
    assert.equal(body.entries.length, entryCount);

    const keptKeys: string[] = [];
    for (let entryIndex = 0; entryIndex < body.entries.length; entryIndex += 1) {
      const entry = body.entries[entryIndex]!;
      assert.equal(entry.attempts.length + entry.attemptsOmitted, attemptsPerEntry);
      assert.equal(entry.lastSeen, now - (entryIndex + 1) * 1_000);
      for (const attempt of entry.attempts) {
        keptKeys.push(`${entryIndex}:${attempt.ts}`);
      }
    }

    assert.ok(keptKeys.length > 0 && keptKeys.length < entryCount * attemptsPerEntry);
    const expectedKept = expectedOrder
      .slice(expectedOrder.length - keptKeys.length)
      .map((item) => `${item.entryIndex}:${item.ts}`)
      .sort();
    assert.deepEqual([...keptKeys].sort(), expectedKept);
  });
});

test("custom memory host returns empty entries with incomplete coverage", async () => {
  const now = Date.now();
  const customMemory = createMemoryQueries(() => [
    makeFailure({
      id: "failure-custom",
      ts: now - 5 * MINUTE,
      fingerprint: "2222333344445555",
      signature: ["Error: custom host"],
    }),
  ]);
  const reg = createToolRegistry({
    exposure: "sanitized",
    memory: customMemory,
    recallWithAi: disabledRecallWithAi,
  });
  const signal = new AbortController().signal;
  const result = await reg.call(
    "attempt_history",
    { fingerprint: "2222333344445555" },
    signal,
  );
  const body = result.structuredContent as Record<string, unknown>;
  assert.equal(body.exposure, "sanitized");
  assert.deepEqual(body.entries, []);
  assert.equal(body.notice, ATTEMPT_HISTORY_NOTICE);
  assert.equal(body.memoryCoverageIncomplete, true);
  assert.equal((body.coverage as { complete: boolean }).complete, false);
  assert.equal(body.memoryVersion, 1);
});

test("no causal words in the response", async () => {
  const now = Date.now();
  const fp = "9988776655443322";
  const here = process.cwd();
  const f1 = makeFailure({
    id: "failure-c1",
    ts: now - 15 * MINUTE,
    cwd: here,
    cmd: "npm test lint",
    fingerprint: fp,
    signature: ["Error: lint check failed"],
  });
  const r1 = makeRationale({
    id: "rationale-c1",
    ts: now - 14 * MINUTE,
    cwd: here,
    links: { failureId: f1.id },
    files: ["src/lint.ts"],
    excerpt: "change timeout value to 5000",
  });
  const fix = makeFix({
    id: "fix-c1",
    ts: now - 10 * MINUTE,
    cwd: here,
    cmd: "npm test lint",
    failureIds: [f1.id],
  });

  await withDurableMemory([f1, r1, fix], async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const def = reg.list().find((tool) => tool.name === "attempt_history")!;
    const result = await reg.call(
      "attempt_history",
      { fingerprint: fp },
      new AbortController().signal,
    );
    const strings = [
      def.title,
      def.description,
      ...collectStrings(result.structuredContent),
    ];
    assert.deepEqual(causalWordViolations(strings), []);
  });
});

function makeAssociation(
  overrides: Partial<AssociationRecord> & { id: string; ts: number; candidateFailureIds: string[] },
): AssociationRecord {
  return {
    kind: "association",
    cwd: process.cwd(),
    cmd: "npm run fix-step",
    links: overrides.candidateFailureIds.map((id) => ({
      id,
      basis: "same-program" as const,
      confidence: "possible" as const,
    })),
    ...overrides,
  };
}

function freezeOldRecallEnvelope(
  memory: MemoryQueries,
  input: { query: string; limit?: number; cwd?: string },
  exposure: "sanitized" | "raw",
): string {
  const hits = memory.recall(input);
  const coverage = memory.coverage?.();
  const projected = projectRecallHits(hits, exposure);
  const coveragePayload = coverage === undefined
    ? {}
    : {
        coverage,
        memoryCoverage: coverage,
        memoryVersion: coverage.version,
        memoryCoverageIncomplete: !coverage.complete || coverage.skipped > 0 || coverage.truncated > 0,
      };
  const payload = { ...projected, ...coveragePayload };
  const result = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
  return JSON.stringify(result);
}

test("durable snapshot + queryRecall produces identical hits to memory.recall", async () => {
  const now = Date.now();
  const dirA = join(process.cwd(), "dir-equiv-a");
  const dirB = join(process.cwd(), "dir-equiv-b");
  const f1 = makeFailure({
    id: "eq-f1",
    ts: now - 30 * MINUTE,
    cwd: dirA,
    cmd: "npm test auth-token",
    fingerprint: "1111000011110001",
    signature: ["TypeError: authToken missing"],
  });
  const fix1 = makeFix({
    id: "eq-fix1",
    ts: now - 25 * MINUTE,
    cwd: dirA,
    cmd: "npm test auth-token",
    failureIds: [f1.id],
  });
  const f2 = makeFailure({
    id: "eq-f2",
    ts: now - 20 * MINUTE,
    cwd: dirB,
    cmd: "npm test auth-token",
    fingerprint: "1111000011110002",
    signature: ["Error: authToken expired"],
  });
  const assoc2 = makeAssociation({
    id: "eq-assoc2",
    ts: now - 15 * MINUTE,
    cwd: dirB,
    candidateFailureIds: [f2.id],
  });
  const futureFailure = makeFailure({
    id: "eq-future",
    ts: now + 10 * MINUTE,
    cwd: dirA,
    cmd: "npm test auth-token",
    fingerprint: "1111000011110003",
    signature: ["Error: authToken future"],
  });

  await withDurableMemory([f1, f1, fix1, f2, assoc2, futureFailure], async (memory) => {
    const snapshot = loadDurableMemorySnapshot(memory, now);
    assert.ok(snapshot !== undefined);

    const directAll = memory.recall({ query: "authToken", limit: 10, now });
    const snapAll = queryRecall(snapshot.records, { query: "authToken", limit: 10, now });
    assert.deepEqual(snapAll, directAll);
    assert.deepEqual(snapshot.coverage, memory.coverage?.());

    const directDirA = memory.recall({ query: "authToken", limit: 10, cwd: dirA, now });
    const snapDirA = queryRecall(snapshot.records, { query: "authToken", limit: 10, cwd: dirA, now });
    assert.deepEqual(snapDirA, directDirA);
    assert.equal(snapDirA.length, 1);
    assert.equal(snapDirA[0]!.failure.id, f1.id);
  });
});

test("recall output is byte-identical when no hit has two attempts", async () => {
  const now = Date.now();
  const here = process.cwd();
  const f1 = makeFailure({
    id: "single-f1",
    ts: now - 20 * MINUTE,
    cwd: here,
    cmd: "npm test cache-key",
    fingerprint: "aaaa111122223333",
    signature: ["Error: cacheKey invalid"],
  });
  const fix1 = makeFix({
    id: "single-fix1",
    ts: now - 15 * MINUTE,
    cwd: here,
    cmd: "npm test cache-key",
    failureIds: [f1.id],
  });
  const f2 = makeFailure({
    id: "single-f2",
    ts: now - 10 * MINUTE,
    cwd: here,
    cmd: "npm test cache-key-miss",
    fingerprint: "bbbb111122223333",
    signature: ["Error: cacheKey missing"],
  });

  await withDurableMemory([f1, fix1, f2], async (memory) => {
    const signal = new AbortController().signal;
    for (const exposure of ["sanitized", "raw"] as const) {
      const oldJson = freezeOldRecallEnvelope(memory, { query: "cacheKey", limit: 5 }, exposure);
      const reg = createToolRegistry({
        exposure,
        memory,
        recallWithAi: disabledRecallWithAi,
      });
      const result = await reg.call("recall", { query: "cacheKey", limit: 5 }, signal);
      assert.equal(JSON.stringify(result), oldJson);
      const items = (result.structuredContent as { items: Record<string, unknown>[] }).items;
      assert.equal(items.length, 2);
      for (const item of items) {
        assert.equal("attemptsSummary" in item, false);
      }
    }
  });
});

test("recall adds attemptsSummary only for entries with two or more attempts", async () => {
  const now = Date.now();
  const here = process.cwd();
  const fpRepeat = "cc11223344556677";
  const fpOtherErr = "dd11223344556677";
  const fpDiffAndPossible = "ee11223344556677";
  const fpSingle = "ff11223344556677";

  const f1 = makeFailure({
    id: "rep-f1",
    ts: now - 40 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget",
    fingerprint: fpRepeat,
    signature: ["TypeError: retryBudget undefined"],
  });
  const f2 = makeFailure({
    id: "rep-f2",
    ts: now - 35 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget",
    fingerprint: fpRepeat,
    signature: ["TypeError: retryBudget undefined"],
  });
  const fix2 = makeFix({
    id: "rep-fix2",
    ts: now - 30 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget",
    failureIds: [f2.id],
  });

  const f3 = makeFailure({
    id: "rep-f3",
    ts: now - 25 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget-alt",
    fingerprint: fpDiffAndPossible,
    signature: ["RangeError: retryBudget negative"],
  });
  const f3Next = makeFailure({
    id: "rep-f3-other",
    ts: now - 22 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget-alt",
    fingerprint: fpOtherErr,
    signature: ["SyntaxError: unrelated parse fault"],
  });
  const f4 = makeFailure({
    id: "rep-f4",
    ts: now - 15 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget-alt",
    fingerprint: fpDiffAndPossible,
    signature: ["RangeError: retryBudget negative"],
  });
  const assoc4 = makeAssociation({
    id: "rep-assoc4",
    ts: now - 12 * MINUTE,
    cwd: here,
    cmd: "npm run retry-budget-alt",
    candidateFailureIds: [f4.id],
  });

  const fSingle = makeFailure({
    id: "rep-single",
    ts: now - 5 * MINUTE,
    cwd: here,
    cmd: "npm test retry-budget-once",
    fingerprint: fpSingle,
    signature: ["Error: retryBudget single occurrence"],
  });

  await withDurableMemory([f1, f2, fix2, f3, f3Next, f4, assoc4, fSingle], async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const result = await reg.call(
      "recall",
      { query: "retryBudget", limit: 10 },
      new AbortController().signal,
    );
    const items = (result.structuredContent as { items: Record<string, unknown>[] }).items;
    const byFp = new Map(items.map((item) => [item.fingerprint as string, item]));

    const repeatHit = byFp.get(fpRepeat);
    assert.ok(repeatHit !== undefined);
    assert.deepEqual(repeatHit.attemptsSummary, {
      attempts: 2,
      passed: 1,
      sameFailure: 1,
      differentFailure: 0,
      possiblePass: 0,
      latestOutcome: "passed",
    });
    const repeatKeys = Object.keys(repeatHit);
    assert.equal(repeatKeys[repeatKeys.length - 1], "attemptsSummary");

    const altHit = byFp.get(fpDiffAndPossible);
    assert.ok(altHit !== undefined);
    assert.deepEqual(altHit.attemptsSummary, {
      attempts: 2,
      passed: 0,
      sameFailure: 0,
      differentFailure: 1,
      possiblePass: 1,
      latestOutcome: "possible_pass",
    });

    const singleHit = byFp.get(fpSingle);
    assert.ok(singleHit !== undefined);
    assert.equal("attemptsSummary" in singleHit, false);

    const summaryTokens = [
      "attemptsSummary",
      ...Object.keys(repeatHit.attemptsSummary as Record<string, unknown>),
      (repeatHit.attemptsSummary as { latestOutcome: string }).latestOutcome,
      (altHit.attemptsSummary as { latestOutcome: string }).latestOutcome,
    ];
    assert.deepEqual(causalWordViolations(summaryTokens), []);
  });
});

test("recall summary and hits come from one snapshot", async () => {
  const now = Date.now();
  const here = process.cwd();
  const fp = "aabbccddeeff0011";
  const f1 = makeFailure({
    id: "snap-f1",
    ts: now - 20 * MINUTE,
    cwd: here,
    cmd: "npm test snapshot-once",
    fingerprint: fp,
    signature: ["Error: snapshotOnce failure"],
  });
  const f2 = makeFailure({
    id: "snap-f2",
    ts: now - 10 * MINUTE,
    cwd: here,
    cmd: "npm test snapshot-once",
    fingerprint: fp,
    signature: ["Error: snapshotOnce failure"],
  });
  const fix = makeFix({
    id: "snap-fix",
    ts: now - 5 * MINUTE,
    cwd: here,
    cmd: "npm test snapshot-once",
    failureIds: [f2.id],
  });

  await withDurableMemory([f1, f2, fix], async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const signal = new AbortController().signal;

    const beforeFirst = memoryReadMetrics();
    const first = await reg.call("recall", { query: "snapshotOnce" }, signal);
    const afterFirst = memoryReadMetrics();

    assert.equal(afterFirst.parses - beforeFirst.parses, 1);
    assert.equal(afterFirst.cacheHits - beforeFirst.cacheHits, 0);
    const firstItems = (first.structuredContent as { items: Record<string, unknown>[] }).items;
    assert.equal(firstItems.length, 1);
    assert.deepEqual(firstItems[0]!.attemptsSummary, {
      attempts: 2,
      passed: 1,
      sameFailure: 1,
      differentFailure: 0,
      possiblePass: 0,
      latestOutcome: "passed",
    });

    const beforeSecond = memoryReadMetrics();
    const second = await reg.call("recall", { query: "snapshotOnce" }, signal);
    const afterSecond = memoryReadMetrics();

    assert.equal(afterSecond.parses - beforeSecond.parses, 0);
    assert.equal(afterSecond.cacheHits - beforeSecond.cacheHits, 1);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
});

test("custom memory host recall has no summary and unchanged bytes", async () => {
  const now = Date.now();
  const here = process.cwd();
  const fp = "1020304050607080";
  const records: MemoryRecord[] = [
    makeFailure({
      id: "cust-f1",
      ts: now - 20 * MINUTE,
      cwd: here,
      cmd: "npm test custom-host",
      fingerprint: fp,
      signature: ["Error: customHost repeated"],
    }),
    makeFailure({
      id: "cust-f2",
      ts: now - 10 * MINUTE,
      cwd: here,
      cmd: "npm test custom-host",
      fingerprint: fp,
      signature: ["Error: customHost repeated"],
    }),
    makeFix({
      id: "cust-fix",
      ts: now - 5 * MINUTE,
      cwd: here,
      cmd: "npm test custom-host",
      failureIds: ["cust-f2"],
    }),
  ];

  const customMemory = createMemoryQueries(() => records);
  const expectedOldJson = freezeOldRecallEnvelope(
    customMemory,
    { query: "customHost", limit: 3 },
    "sanitized",
  );
  const reg = createToolRegistry({
    exposure: "sanitized",
    memory: customMemory,
    recallWithAi: disabledRecallWithAi,
  });
  const result = await reg.call(
    "recall",
    { query: "customHost" },
    new AbortController().signal,
  );
  assert.equal(JSON.stringify(result), expectedOldJson);
  const items = (result.structuredContent as { items: Record<string, unknown>[] }).items;
  assert.equal(items.length, 1);
  assert.equal("attemptsSummary" in items[0]!, false);
});

async function withDateNowSequence<T>(sequence: readonly number[], run: () => Promise<T> | T): Promise<T> {
  const originalNow = Date.now;
  let index = 0;
  Date.now = () => {
    const value = sequence[Math.min(index, sequence.length - 1)]!;
    index += 1;
    return value;
  };
  try {
    return await run();
  } finally {
    Date.now = originalNow;
  }
}

async function withClockAdvanceOnSetAdd<T>(
  targetValue: string,
  initialNow: number,
  advancedNow: number,
  run: () => Promise<T> | T,
): Promise<{ result: T; triggered: boolean }> {
  const originalNow = Date.now;
  const originalSetAdd = Set.prototype.add;
  let currentNow = initialNow;
  let triggered = false;
  Date.now = () => currentNow;
  Set.prototype.add = function addWithClockAdvance<V>(this: Set<V>, value: V): Set<V> {
    if (!triggered && (value as unknown) === targetValue) {
      triggered = true;
      currentNow = advancedNow;
    }
    return originalSetAdd.call(this, value);
  };
  try {
    return { result: await run(), triggered };
  } finally {
    Set.prototype.add = originalSetAdd;
    Date.now = originalNow;
  }
}

test("recall output stays byte-identical when clock advances across load and uniqueRecords", async () => {
  const failureTs = 1_700_000_000_000;
  const here = process.cwd();
  const f1 = makeFailure({
    id: "fixture-failure-resolved",
    ts: failureTs,
    cwd: here,
    cmd: "npm test",
    fingerprint: "fixture-missing-module",
    fingerprintV: undefined,
    signature: ["Error: missing module from /private/rocky/project"],
    excerpt: "Error: missing module",
  });

  await withDurableMemory([f1], async (memory) => {
    const signal = new AbortController().signal;
    for (const exposure of ["sanitized", "raw"] as const) {
      const reg = createToolRegistry({
        exposure,
        memory,
        recallWithAi: disabledRecallWithAi,
      });

      const oldLoadBoundaryJson = await withDateNowSequence(
        [failureTs - 1, failureTs],
        () => freezeOldRecallEnvelope(memory, { query: "missing module", limit: 5 }, exposure),
      );
      const loadBoundaryResult = await withDateNowSequence(
        [failureTs - 1, failureTs],
        () => reg.call("recall", { query: "missing module", limit: 5 }, signal),
      );
      assert.equal(JSON.stringify(loadBoundaryResult), oldLoadBoundaryJson);

      const oldDedupRun = await withClockAdvanceOnSetAdd(
        f1.id,
        failureTs - 1,
        failureTs,
        () => freezeOldRecallEnvelope(memory, { query: "missing module", limit: 5 }, exposure),
      );
      const durableDedupRun = await withClockAdvanceOnSetAdd(
        f1.id,
        failureTs - 1,
        failureTs,
        () => reg.call("recall", { query: "missing module", limit: 5 }, signal),
      );
      assert.equal(oldDedupRun.triggered, true);
      assert.equal(durableDedupRun.triggered, true);
      assert.equal(JSON.stringify(durableDedupRun.result), oldDedupRun.result);
      const dedupBody = durableDedupRun.result.structuredContent as {
        items: Record<string, unknown>[];
        truncated: boolean;
      };
      assert.equal(dedupBody.truncated, false);
      assert.equal(dedupBody.items.length, 1);
      assert.equal(dedupBody.items[0]!.fingerprint, "fixture-missing-module");
      assert.equal("attemptsSummary" in dedupBody.items[0]!, false);
    }
  });
});

test("recall output stays byte-identical when clock steps back between query and projection", async () => {
  const failureTs = 1_700_000_000_000;
  const here = process.cwd();
  const f1 = makeFailure({
    id: "fixture-failure-resolved",
    ts: failureTs,
    cwd: here,
    cmd: "npm test",
    fingerprint: "fixture-missing-module",
    fingerprintV: undefined,
    signature: ["Error: missing module from /private/rocky/project"],
    excerpt: "Error: missing module",
  });

  await withDurableMemory([f1], async (memory) => {
    const signal = new AbortController().signal;
    for (const exposure of ["sanitized", "raw"] as const) {
      const reg = createToolRegistry({
        exposure,
        memory,
        recallWithAi: disabledRecallWithAi,
      });

      const oldProjectionStepBackJson = await withDateNowSequence(
        [failureTs, failureTs, failureTs - 1],
        () => freezeOldRecallEnvelope(memory, { query: "missing module", limit: 5 }, exposure),
      );
      const projectionStepBackResult = await withDateNowSequence(
        [failureTs, failureTs, failureTs - 1],
        () => reg.call("recall", { query: "missing module", limit: 5 }, signal),
      );
      assert.equal(JSON.stringify(projectionStepBackResult), oldProjectionStepBackJson);
      const projectionBody = projectionStepBackResult.structuredContent as {
        items: Record<string, unknown>[];
        truncated: boolean;
      };
      assert.equal(projectionBody.truncated, true);
      assert.equal(projectionBody.items.length, 0);
    }
  });
});

test("durable recall preserves operational read errors while loadDurableMemorySnapshot still swallows", async () => {
  const cwdError = Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), { code: "ENOENT" });
  const durableMemory = createMemoryQueries();
  const legacyCanonicalMemory = createMemoryQueries(() => { throw cwdError; });
  const signal = new AbortController().signal;

  const originalCwd = process.cwd;
  process.cwd = () => { throw cwdError; };
  try {
    assert.throws(
      () => loadDurableMemorySnapshotOrThrow(durableMemory),
      (error: unknown) => error === cwdError,
    );
    assert.equal(loadDurableMemorySnapshot(durableMemory), undefined);

    const durableReg = createToolRegistry({
      exposure: "sanitized",
      memory: durableMemory,
      recallWithAi: disabledRecallWithAi,
    });
    const legacyReg = createToolRegistry({
      exposure: "sanitized",
      memory: legacyCanonicalMemory,
      recallWithAi: disabledRecallWithAi,
    });

    const durableResult = await durableReg.call("recall", { query: "missing" }, signal);
    const legacyResult = await legacyReg.call("recall", { query: "missing" }, signal);

    assert.equal(durableResult.isError, true);
    assert.deepEqual(durableResult.structuredContent.error, {
      code: "memory_unavailable",
      message: "memory unavailable",
    });
    assert.equal(durableResult.structuredContent.memoryCoverageIncomplete, true);
    assert.equal(JSON.stringify(durableResult), JSON.stringify(legacyResult));

    const attemptHistoryResult = await durableReg.call("attempt_history", { query: "missing" }, signal);
    assert.equal(attemptHistoryResult.isError, undefined);
    assert.deepEqual(attemptHistoryResult.structuredContent.entries, []);
    assert.equal(attemptHistoryResult.structuredContent.memoryCoverageIncomplete, true);
  } finally {
    process.cwd = originalCwd;
  }
});

test("recall summary failure signals truncation without partial attemptsSummary", async () => {
  const now = Date.now();
  const here = process.cwd();
  const fpA = "aa00112233445566";
  const fpB = "bb00112233445566";

  const records: MemoryRecord[] = [
    makeFailure({
      id: "sf-a1",
      ts: now - 40 * MINUTE,
      cwd: here,
      cmd: "npm test summary-fail-a",
      fingerprint: fpA,
      signature: ["Error: summaryFail alpha"],
    }),
    makeFailure({
      id: "sf-a2",
      ts: now - 35 * MINUTE,
      cwd: here,
      cmd: "npm test summary-fail-a",
      fingerprint: fpA,
      signature: ["Error: summaryFail alpha"],
    }),
    makeFix({
      id: "sf-fix-a",
      ts: now - 30 * MINUTE,
      cwd: here,
      cmd: "npm test summary-fail-a",
      failureIds: ["sf-a2"],
    }),
    makeFailure({
      id: "sf-b1",
      ts: now - 25 * MINUTE,
      cwd: here,
      cmd: "npm test summary-fail-b",
      fingerprint: fpB,
      signature: ["Error: summaryFail beta"],
    }),
    makeFailure({
      id: "sf-b2",
      ts: now - 20 * MINUTE,
      cwd: here,
      cmd: "npm test summary-fail-b",
      fingerprint: fpB,
      signature: ["Error: summaryFail beta"],
    }),
    makeFix({
      id: "sf-fix-b",
      ts: now - 15 * MINUTE,
      cwd: here,
      cmd: "npm test summary-fail-b",
      failureIds: ["sf-b2"],
    }),
  ];

  await withDurableMemory(records, async (memory) => {
    const signal = new AbortController().signal;

    const baselineReg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
    });
    const baseline = await baselineReg.call("recall", { query: "summaryFail", limit: 10 }, signal);
    const baselineBody = baseline.structuredContent as { items: Record<string, unknown>[]; truncated: boolean };
    assert.equal(baselineBody.truncated, false);
    assert.equal(baselineBody.items.length, 2);
    for (const item of baselineBody.items) {
      assert.ok("attemptsSummary" in item);
    }

    const throwingReg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
      buildProblems: () => { throw new Error("summary grouping boom"); },
    });
    const thrownResult = await throwingReg.call("recall", { query: "summaryFail", limit: 10 }, signal);
    const thrownBody = thrownResult.structuredContent as { items: Record<string, unknown>[]; truncated: boolean };
    assert.equal(thrownResult.isError, undefined);
    assert.equal(thrownBody.truncated, true);
    assert.equal(thrownBody.items.length, 2);
    for (const item of thrownBody.items) {
      assert.equal("attemptsSummary" in item, false);
    }

    const secondHitFp = baselineBody.items[1]!.fingerprint as string;
    const partialThrowReg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
      buildProblems: (recs, cov, opts) => {
        const real = buildProblems(recs, cov, opts);
        return {
          ...real,
          entries: real.entries.map((entry) => {
            if (entry.fingerprint !== secondHitFp) return entry;
            return {
              ...entry,
              get counts(): typeof entry.counts {
                throw new Error("mid-loop attachment boom");
              },
            };
          }),
        };
      },
    });
    const partialResult = await partialThrowReg.call("recall", { query: "summaryFail", limit: 10 }, signal);
    const partialBody = partialResult.structuredContent as { items: Record<string, unknown>[]; truncated: boolean };
    assert.equal(partialResult.isError, undefined);
    assert.equal(partialBody.truncated, true);
    assert.equal(partialBody.items.length, 2);
    for (const item of partialBody.items) {
      assert.equal("attemptsSummary" in item, false);
    }
  });
});

function makeStoredCard(overrides: Partial<StoredCard> & { card_id: string; root: string; started_ms: number }): StoredCard {
  return {
    v: 1,
    rev: 1,
    session_id: "sess-1",
    agent_id: "",
    ended_ms: overrides.started_ms + 60_000,
    prompt: "fix test failure",
    blocks: [],
    flow: [],
    coverage: { state: "full", reasons: [] },
    ...overrides,
  };
}

function buildJoinCardFixture(now: number, fp: string, repoRoot: string, pkgDir: string, cardId: string): {
  records: MemoryRecord[];
  card: StoredCard;
} {
  const t1 = now - 20 * MINUTE;
  const t2 = now - 15 * MINUTE;
  const t3 = now - 10 * MINUTE;
  const f1 = makeFailure({ id: "join-f1", ts: t1, cwd: pkgDir, cmd: "npm test", fingerprint: fp, signature: ["TypeError: retryBudget undefined"] });
  const f2 = makeFailure({ id: "join-f2", ts: t2, cwd: pkgDir, cmd: "npm test", fingerprint: fp, signature: ["TypeError: retryBudget undefined"] });
  const fix = makeFix({ id: "join-fix", ts: t3, cwd: pkgDir, cmd: "npm test", failureIds: [f2.id] });
  const card = makeStoredCard({
    card_id: cardId,
    root: canonicalPath(repoRoot),
    started_ms: t1 - 5_000,
    ended_ms: t3 + 5_000,
    blocks: [
      { seq: 1, path: "shared/x.ts", labels: [], importance: "medium", quote: { text: "fallback quote for first edit", shared: false } },
      { seq: 2, path: "/outside/secret.ts", labels: [], importance: "low" },
      { seq: 3, path: "pkg/src/retry.ts", labels: [], importance: "medium", quote: { text: "check https://internal.example.com with Bearer secretquotevalue999", shared: false } },
    ],
    flow: [
      { kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: t1 - 100, end_ms: t1, cwd: pkgDir, tool_use_id: "tu-f1" },
      { kind: "edit", text: "Edit shared/x.ts", ok: true, dur_ms: 50, seqs: [1, 2], start_ms: t1 + 10_000, end_ms: t1 + 10_050 },
      { kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: t2 - 100, end_ms: t2, cwd: pkgDir, tool_use_id: "tu-f2", desc: "Re-run tests against https://internal.example.com with Bearer supersecrettoken123" },
      { kind: "edit", text: "Edit pkg/src/retry.ts", ok: true, dur_ms: 50, seqs: [3], start_ms: t2 + 10_000, end_ms: t2 + 10_050 },
      { kind: "cmd", text: "npm test", ok: true, dur_ms: 100, seqs: [], start_ms: t3 - 100, end_ms: t3, cwd: pkgDir, tool_use_id: "tu-pass" },
    ],
  });
  return { records: [f1, f2, fix], card };
}

test("sanitized attempt_history joins cards for observed edits and redacted bash-description and card-quote testimony", async () => {
  const fp = "a1a2a3a4b1b2b3b4";
  const repoRoot = join(process.cwd(), "virtual-join-repo");
  const cardId = "11111111222222223333333344444444";
  const { records, card } = buildJoinCardFixture(Date.now(), fp, repoRoot, join(repoRoot, "pkg"), cardId);

  await withDurableMemory(records, async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
      cardsFor: () => ({ cards: [card], complete: true }),
    });
    const result = await reg.call("attempt_history", { fingerprint: fp }, new AbortController().signal);
    const body = result.structuredContent as { entries: ProjectedProblemEntry[] };
    assert.equal(body.entries.length, 1);

    const [a1, a2] = body.entries[0]!.attempts;
    assert.deepEqual(a1!.changes, { state: "observed", files: ["shared/x.ts"], more: 1 });
    assert.equal("cardId" in a1!.changes, false);
    assert.equal(a1!.stated?.source, "bash-description");
    assert.equal(a1!.stated?.testimony, true);
    assert.equal("recordId" in a1!.stated!, false);
    assert.equal(a1!.stated!.text.includes("internal.example.com"), false);
    assert.equal(a1!.stated!.text.includes("supersecrettoken123"), false);
    assert.equal(a1!.stated!.text.includes("[redacted]"), true);

    assert.deepEqual(a2!.changes, { state: "observed", files: ["pkg/src/retry.ts"], more: 0 });
    assert.equal(a2!.stated?.source, "card-quote");
    assert.equal(a2!.stated?.testimony, true);
    assert.equal("recordId" in a2!.stated!, false);
    assert.equal(a2!.stated!.text.includes("internal.example.com"), false);
    assert.equal(a2!.stated!.text.includes("secretquotevalue999"), false);
    assert.equal(a2!.stated!.text.includes("[redacted]"), true);

    const json = JSON.stringify(body);
    assert.equal(json.includes("secret.ts"), false);
    assert.equal(json.includes(cardId), false);
  });
});

function buildToolTextOffFixture(now: number, fp: string, repoRoot: string, pkgDir: string): {
  records: MemoryRecord[];
  card: StoredCard;
} {
  const t1 = now - 30 * MINUTE;
  const t2 = now - 20 * MINUTE;
  const t3 = now - 10 * MINUTE;
  const t4 = now - 5 * MINUTE;
  const f1 = makeFailure({ id: "tto-f1", ts: t1, cwd: pkgDir, cmd: "npm test", fingerprint: fp, signature: ["Error: tool text test"] });
  const f2 = makeFailure({ id: "tto-f2", ts: t2, cwd: pkgDir, cmd: "npm test", fingerprint: fp, signature: ["Error: tool text test"] });
  const f3 = makeFailure({ id: "tto-f3", ts: t3, cwd: pkgDir, cmd: "npm test", fingerprint: fp, signature: ["Error: tool text test"] });
  const r3 = makeRationale({ id: "tto-r3", ts: t3 + 1_000, cwd: pkgDir, links: { failureId: f3.id }, excerpt: "adjust retry window in config" });
  const fix = makeFix({ id: "tto-fix", ts: t4, cwd: pkgDir, cmd: "npm test", failureIds: [f3.id] });
  const card = makeStoredCard({
    card_id: "aaaa1111bbbb2222cccc3333dddd4444",
    root: canonicalPath(repoRoot),
    started_ms: t1 - 5_000,
    ended_ms: t4 + 5_000,
    blocks: [
      { seq: 1, path: "src/a.ts", labels: [], importance: "medium", quote: { text: "first edit quote", shared: false } },
      { seq: 2, path: "src/b.ts", labels: [], importance: "medium", quote: { text: "second edit quote", shared: false } },
      { seq: 3, path: "src/c.ts", labels: [], importance: "medium", quote: { text: "third edit quote", shared: false } },
    ],
    flow: [
      { kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: t1 - 100, end_ms: t1, cwd: pkgDir, tool_use_id: "tu-1" },
      { kind: "edit", text: "Edit src/a.ts", ok: true, dur_ms: 50, seqs: [1], start_ms: t1 + 5_000, end_ms: t1 + 5_050 },
      { kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: t2 - 100, end_ms: t2, cwd: pkgDir, tool_use_id: "tu-2", desc: "Retry after updating a.ts" },
      { kind: "edit", text: "Edit src/b.ts", ok: true, dur_ms: 50, seqs: [2], start_ms: t2 + 5_000, end_ms: t2 + 5_050 },
      { kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: t3 - 100, end_ms: t3, cwd: pkgDir, tool_use_id: "tu-3" },
      { kind: "edit", text: "Edit src/c.ts", ok: true, dur_ms: 50, seqs: [3], start_ms: t3 + 5_000, end_ms: t3 + 5_050 },
      { kind: "cmd", text: "npm test", ok: true, dur_ms: 100, seqs: [], start_ms: t4 - 100, end_ms: t4, cwd: pkgDir, tool_use_id: "tu-4", desc: "Verify final pass" },
    ],
  });
  return { records: [f1, f2, f3, r3, fix], card };
}

test("attempt_history strips bash-description and card-quote under desk/tool-text-off while keeping observed files and rationale", async () => {
  const fp = "c1c2c3c4d1d2d3d4";

  await withDurableMemory([], async (_unused, rawTempRoot) => {
    const tempRoot = realpathSync.native(rawTempRoot);
    const repoRoot = join(tempRoot, "repo");
    const pkgDir = join(repoRoot, "pkg");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(pkgDir, { recursive: true });
    const { records, card } = buildToolTextOffFixture(Date.now(), fp, repoRoot, pkgDir);

    await withDurableMemory(records, async (memory) => {
      const home = process.env.ROCKY_HOME!;
      mkdirSync(join(home, "desk", "cards"), { recursive: true });
      writeFileSync(cardsFilePath(canonicalPath(repoRoot), home), `${JSON.stringify(card)}\n`, "utf8");

      const reg = createToolRegistry({ exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi });
      const signal = new AbortController().signal;

      const before = await reg.call("attempt_history", { fingerprint: fp }, signal);
      const beforeAttempts = (before.structuredContent as { entries: ProjectedProblemEntry[] }).entries[0]!.attempts;
      assert.deepEqual(beforeAttempts.map((a) => a.changes.files), [["src/a.ts"], ["src/b.ts"], ["src/c.ts"]]);
      assert.deepEqual(beforeAttempts.map((a) => a.stated?.source), ["bash-description", "card-quote", "rationale"]);

      writeFileSync(join(home, "desk", "tool-text-off"), "", "utf8");

      const after = await reg.call("attempt_history", { fingerprint: fp }, signal);
      const afterAttempts = (after.structuredContent as { entries: ProjectedProblemEntry[] }).entries[0]!.attempts;
      assert.deepEqual(afterAttempts.map((a) => a.changes), [
        { state: "observed", files: ["src/a.ts"], more: 0 },
        { state: "observed", files: ["src/b.ts"], more: 0 },
        { state: "observed", files: ["src/c.ts"], more: 0 },
      ]);
      assert.equal(afterAttempts[0]!.stated, undefined);
      assert.equal(afterAttempts[1]!.stated, undefined);
      assert.deepEqual(afterAttempts[2]!.stated, {
        text: "adjust retry window in config",
        source: "rationale",
        testimony: true,
      });
    });
  });
});

test("attempt_history canonicalizes sanitized testimony files to repo root and keeps cwd limit outside a repo", async () => {
  const now = Date.now();
  const fpRepo = "e1e2e3e4f1f2f3f4";
  const fpOutside = "f4f3f2f1e4e3e2e1";

  await withDurableMemory([], async (_unused, rawTempRoot) => {
    const tempRoot = realpathSync.native(rawTempRoot);
    const repoRoot = join(tempRoot, "repo");
    const repoPkg = join(repoRoot, "pkg");
    const outsidePkg = join(tempRoot, "outside", "pkg");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(repoPkg, { recursive: true });
    mkdirSync(outsidePkg, { recursive: true });

    const fRepo = makeFailure({ id: "root-f1", ts: now - 15 * MINUTE, cwd: repoPkg, fingerprint: fpRepo, signature: ["Error: repo root test"] });
    const rRepo = makeRationale({
      id: "root-r1",
      ts: now - 14 * MINUTE,
      cwd: repoPkg,
      links: { failureId: fRepo.id },
      files: ["../shared/x.ts", "../../escape.ts"],
    });
    const fOut = makeFailure({ id: "out-f1", ts: now - 10 * MINUTE, cwd: outsidePkg, fingerprint: fpOutside, signature: ["Error: outside repo test"] });
    const rOut = makeRationale({
      id: "out-r1",
      ts: now - 9 * MINUTE,
      cwd: outsidePkg,
      links: { failureId: fOut.id },
      files: ["../shared/x.ts", "local/y.ts"],
    });

    await withDurableMemory([fRepo, rRepo, fOut, rOut], async (memory) => {
      const reg = createToolRegistry({
        exposure: "sanitized",
        memory,
        recallWithAi: disabledRecallWithAi,
      });
      const signal = new AbortController().signal;

      const repoRes = await reg.call("attempt_history", { fingerprint: fpRepo }, signal);
      const repoEntry = (repoRes.structuredContent as { entries: ProjectedProblemEntry[] }).entries[0]!;
      assert.deepEqual(repoEntry.attempts[0]!.changes, {
        state: "testimony",
        files: ["shared/x.ts"],
        more: 1,
      });
      assert.equal(JSON.stringify(repoRes.structuredContent).includes("escape.ts"), false);

      const outRes = await reg.call("attempt_history", { fingerprint: fpOutside }, signal);
      const outEntry = (outRes.structuredContent as { entries: ProjectedProblemEntry[] }).entries[0]!;
      assert.deepEqual(outEntry.attempts[0]!.changes, {
        state: "testimony",
        files: ["local/y.ts"],
        more: 1,
      });
      const outJson = JSON.stringify(outRes.structuredContent);
      assert.equal(outJson.includes("shared"), false);
      assert.equal(outJson.includes("x.ts"), false);
    });
  });
});

test("attempt_history treats card read errors as no join and never fails the tool", async () => {
  const now = Date.now();
  const fp = "0011223344556677";
  const here = process.cwd();
  const f1 = makeFailure({ id: "err-f1", ts: now - 10 * MINUTE, cwd: here, fingerprint: fp, signature: ["Error: card read err"] });
  const r1 = makeRationale({ id: "err-r1", ts: now - 9 * MINUTE, cwd: here, links: { failureId: f1.id }, files: ["src/ok.ts"], excerpt: "keep testimony" });
  const fix = makeFix({ id: "err-fix", ts: now - 5 * MINUTE, cwd: here, failureIds: [f1.id] });

  await withDurableMemory([f1, r1, fix], async (memory) => {
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
      cardsFor: () => { throw new Error("card log unreadable"); },
    });
    const res = await reg.call("attempt_history", { fingerprint: fp }, new AbortController().signal);
    assert.equal(res.isError, undefined);
    const entries = (res.structuredContent as { entries: ProjectedProblemEntry[] }).entries;
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.attempts[0]!.changes, {
      state: "testimony",
      files: ["src/ok.ts"],
      more: 0,
    });
    assert.equal(entries[0]!.attempts[0]!.stated?.source, "rationale");
  });
});

test("recall attemptsSummary stays byte-identical when joinable cards exist", async () => {
  const now = Date.now();
  const fp = "7766554433221100";
  const t1 = now - 20 * MINUTE;
  const t2 = now - 10 * MINUTE;
  const t3 = now - 5 * MINUTE;

  await withDurableMemory([], async (_unused, rawTempRoot) => {
    const tempRoot = realpathSync.native(rawTempRoot);
    const repoRoot = join(tempRoot, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });

    const f1 = makeFailure({ id: "rc-f1", ts: t1, cwd: repoRoot, cmd: "npm test", fingerprint: fp, signature: ["Error: recallCardNoJoin"] });
    const f2 = makeFailure({ id: "rc-f2", ts: t2, cwd: repoRoot, cmd: "npm test", fingerprint: fp, signature: ["Error: recallCardNoJoin"] });
    const fix = makeFix({ id: "rc-fix", ts: t3, cwd: repoRoot, cmd: "npm test", failureIds: [f2.id] });

    const card = makeStoredCard({
      card_id: "99998888777766665555444433332222",
      root: canonicalPath(repoRoot),
      started_ms: t1 - 5_000,
      ended_ms: t3 + 5_000,
      blocks: [{ seq: 1, path: "src/changed.ts", labels: [], importance: "high" }],
      flow: [
        { kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: t1 - 100, end_ms: t1, tool_use_id: "tu-rc1" },
        { kind: "edit", text: "Edit src/changed.ts", ok: true, dur_ms: 50, seqs: [1], start_ms: t1 + 5_000, end_ms: t1 + 5_050 },
        { kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: t2 - 100, end_ms: t2, tool_use_id: "tu-rc2", desc: "retry" },
        { kind: "cmd", text: "npm test", ok: true, dur_ms: 100, seqs: [], start_ms: t3 - 100, end_ms: t3, tool_use_id: "tu-rc3" },
      ],
    });

    await withDurableMemory([f1, f2, fix], async (memory) => {
      const signal = new AbortController().signal;
      const baselineReg = createToolRegistry({
        exposure: "sanitized",
        memory,
        recallWithAi: disabledRecallWithAi,
      });
      const withoutCards = await baselineReg.call("recall", { query: "recallCardNoJoin", limit: 5 }, signal);

      const home = process.env.ROCKY_HOME!;
      const logPath = cardsFilePath(canonicalPath(repoRoot), home);
      mkdirSync(join(home, "desk", "cards"), { recursive: true });
      writeFileSync(logPath, `${JSON.stringify(card)}\n`, "utf8");

      let cardsForCalls = 0;
      const withCardsReg = createToolRegistry({
        exposure: "sanitized",
        memory,
        recallWithAi: disabledRecallWithAi,
        cardsFor: () => {
          cardsForCalls += 1;
          return { cards: [card], complete: true };
        },
      });
      const withCards = await withCardsReg.call("recall", { query: "recallCardNoJoin", limit: 5 }, signal);

      assert.equal(cardsForCalls, 0, "recall must not invoke cardsFor");
      assert.equal(JSON.stringify(withCards), JSON.stringify(withoutCards));
      const items = (withCards.structuredContent as { items: Record<string, unknown>[] }).items;
      assert.equal(items.length, 1);
      assert.deepEqual(items[0]!.attemptsSummary, {
        attempts: 2,
        passed: 1,
        sameFailure: 1,
        differentFailure: 0,
        possiblePass: 0,
        latestOutcome: "passed",
      });
    });
  });
});

function buildMultiAttemptSeries(
  prefix: string,
  cwd: string,
  fp: string,
  startTs: number,
  count: number,
  editedFile: string,
): { records: MemoryRecord[]; card: StoredCard } {
  const records: MemoryRecord[] = [];
  const flow: NonNullable<StoredCard["flow"]> = [];
  for (let i = 0; i < count; i += 1) {
    const ts = startTs + i * 2 * MINUTE;
    const f = makeFailure({ id: `${prefix}-f${i}`, ts, cwd, cmd: "npm test", fingerprint: fp, signature: ["Error: tailJoinLimit"] });
    records.push(f);
    flow.push({ kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: ts - 100, end_ms: ts, cwd, tool_use_id: `${prefix}-tu-${i}` });
  }
  const passTs = startTs + count * 2 * MINUTE;
  const lastFailureId = `${prefix}-f${count - 1}`;
  records.push(makeFix({ id: `${prefix}-fix`, ts: passTs, cwd, cmd: "npm test", failureIds: [lastFailureId] }));
  flow.push({ kind: "edit", text: `Edit ${editedFile}`, ok: true, dur_ms: 50, seqs: [1], start_ms: passTs - MINUTE, end_ms: passTs - MINUTE + 50 });
  flow.push({ kind: "cmd", text: "npm test", ok: true, dur_ms: 100, seqs: [], start_ms: passTs - 100, end_ms: passTs, cwd, tool_use_id: `${prefix}-tu-pass` });
  const card = makeStoredCard({
    card_id: `${prefix}-card-1111222233334444`,
    root: canonicalPath(cwd),
    started_ms: startTs - 5_000,
    ended_ms: passTs + 5_000,
    blocks: [{ seq: 1, path: editedFile, labels: [], importance: "medium" }],
    flow,
  });
  return { records, card };
}

test("attempt_history joins only the retained tail of attempts while preserving counts and attemptsOmitted", async () => {
  const now = Date.now();
  const dirA = join(process.cwd(), "virtual-tail-a");
  const dirB = join(process.cwd(), "virtual-tail-b");
  const seriesA = buildMultiAttemptSeries("a", dirA, "1010101020202020", now - 30 * MINUTE, 4, "src/a-fix.ts");
  const seriesB = buildMultiAttemptSeries("b", dirB, "3030303040404040", now - 20 * MINUTE, 3, "src/b-fix.ts");

  await withDurableMemory([...seriesA.records, ...seriesB.records], async (memory) => {
    const signal = new AbortController().signal;
    const baseReg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
      cardsFor: () => ({ cards: [], complete: true }),
    });
    const baseEntries = ((await baseReg.call("attempt_history", { query: "tailJoinLimit", limit: 2, attempts: 1 }, signal))
      .structuredContent as { entries: ProjectedProblemEntry[] }).entries;

    const seenCwds: string[] = [];
    const spyReg = createToolRegistry({
      exposure: "sanitized",
      memory,
      recallWithAi: disabledRecallWithAi,
      cardsFor: (cwd) => {
        seenCwds.push(cwd);
        return { cards: cwd === dirA ? [seriesA.card] : [seriesB.card], complete: true };
      },
    });
    const entries = ((await spyReg.call("attempt_history", { query: "tailJoinLimit", limit: 2, attempts: 1 }, signal))
      .structuredContent as { entries: ProjectedProblemEntry[] }).entries;

    assert.equal(entries.length, 2);
    assert.equal(seenCwds.length, 2, "must join only 1 retained attempt per entry");
    assert.deepEqual(seenCwds.sort(), [dirA, dirB].sort());
    assert.deepEqual(entries.map((e) => e.counts), baseEntries.map((e) => e.counts));
    assert.deepEqual(entries.map((e) => e.attemptsOmitted), baseEntries.map((e) => e.attemptsOmitted));
    assert.deepEqual(entries.map((e) => e.attemptsOmitted).sort((x, y) => x - y), [2, 3]);
    for (const entry of entries) {
      assert.equal(entry.attempts.length, 1);
      assert.equal(entry.attempts[0]!.changes.state, "observed");
    }
  });
});

test("attempt_history keeps original changes when card log fails mid-read after parsing a matching card", async () => {
  const now = Date.now();
  const fp = "5566778899aabbcc";
  const t1 = now - 10 * MINUTE;
  const t2 = now - 5 * MINUTE;

  await withDurableMemory([], async (_unused, rawTempRoot) => {
    const tempRoot = realpathSync.native(rawTempRoot);
    const repoRoot = join(tempRoot, "mid-read-repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const f1 = makeFailure({ id: "mr-f1", ts: t1, cwd: repoRoot, cmd: "npm test", fingerprint: fp, signature: ["Error: midRead"] });
    const r1 = makeRationale({ id: "mr-r1", ts: t1 + 1_000, cwd: repoRoot, links: { failureId: f1.id }, files: ["src/ok.ts"], excerpt: "keep testimony" });
    const fix = makeFix({ id: "mr-fix", ts: t2, cwd: repoRoot, cmd: "npm test", failureIds: [f1.id] });
    const matchingCard = makeStoredCard({
      card_id: "aaaa0000bbbb1111cccc2222dddd3333",
      root: canonicalPath(repoRoot),
      started_ms: t1 - 5_000,
      ended_ms: t2 + 5_000,
      blocks: [{ seq: 1, path: "src/from-card.ts", labels: [], importance: "high" }],
      flow: [
        { kind: "cmd", text: "npm test", ok: false, dur_ms: 100, seqs: [], exit_code: 1, start_ms: t1 - 100, end_ms: t1, cwd: repoRoot, tool_use_id: "tu-mr1" },
        { kind: "edit", text: "Edit src/from-card.ts", ok: true, dur_ms: 50, seqs: [1], start_ms: t1 + 5_000, end_ms: t1 + 5_050 },
        { kind: "cmd", text: "npm test", ok: true, dur_ms: 100, seqs: [], start_ms: t2 - 100, end_ms: t2, cwd: repoRoot, tool_use_id: "tu-mr2", desc: "from card" },
      ],
    });
    const secondCard = makeStoredCard({ card_id: "eeee0000ffff11112222333344445555", root: canonicalPath(repoRoot), started_ms: t2 + 6_000 });

    await withDurableMemory([f1, r1, fix], async (memory) => {
      const home = process.env.ROCKY_HOME!;
      const logPath = cardsFilePath(canonicalPath(repoRoot), home);
      const line1 = `${JSON.stringify(matchingCard)}\n`;
      const line2 = `${JSON.stringify(secondCard)}\n`;
      mkdirSync(join(home, "desk", "cards"), { recursive: true });
      writeFileSync(logPath, line1 + line2, "utf8");
      const firstLineBytes = Buffer.byteLength(line1, "utf8");

      let calls = 0;
      const eioAfterFirstLine: CardsReadSyncHook = (fd, buffer, offset, length, position) => {
        calls += 1;
        if (calls === 1) return readSync(fd, buffer, offset, Math.min(length, firstLineBytes), position);
        const err = new Error("EIO: read error") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      };
      const reg = createToolRegistry({
        exposure: "sanitized",
        memory,
        recallWithAi: disabledRecallWithAi,
        cardsFor: makeCardsForForTest({ home, toolText: true }, eioAfterFirstLine),
      });
      const res = await reg.call("attempt_history", { fingerprint: fp }, new AbortController().signal);
      assert.equal(res.isError, undefined);
      const attempt = (res.structuredContent as { entries: ProjectedProblemEntry[] }).entries[0]!.attempts[0]!;
      assert.deepEqual(attempt.changes, { state: "testimony", files: ["src/ok.ts"], more: 0 });
      assert.equal(attempt.stated?.source, "rationale");
    });
  });
});
