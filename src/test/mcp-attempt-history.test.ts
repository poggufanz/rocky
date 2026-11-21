import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { disabledRecallWithAi } from "../ai/port.js";
import { commandIdentity } from "../core/fingerprint.js";
import { createMemoryQueries, type MemoryQueries } from "../core/memory-query.js";
import type { FailureRecord, FixRecord, MemoryRecord, RationaleRecord } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  ATTEMPT_HISTORY_NOTICE,
  type ProjectedProblemEntry,
} from "../mcp/attempts-projection.js";
import { MAX_RESPONSE_BYTES } from "../mcp/privacy.js";
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
