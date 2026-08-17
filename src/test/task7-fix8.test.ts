import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  appendEvent,
  listOrphanBatches,
  readCoverage,
  recordCoverage,
  type CoverageInput,
} from "../agent/spool.js";
import { parseClaudeHookPayload } from "../agent/adapters/claude-code.js";
import { parseCodexHookPayload } from "../agent/adapters/codex.js";
import { annotateBatch } from "../agent/annotate.js";
import { createMemoryQueries, type MemoryQueries } from "../core/memory-query.js";
import { pathIdentityHash, type FailureRecord, type TripleRecord } from "../core/memory-read.js";
import { whyFileEvidence } from "../core/memory-query.js";
import { createToolRegistry } from "../mcp/tools.js";
import { projectKnowledgeHits } from "../mcp/privacy.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

function freshPaths(): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-task7-fix8-"));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

function mechanism(path: string, extra: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    agent: "codex" as const,
    kind: "mechanism" as const,
    ts: 2,
    tool: "Edit",
    path,
    provenance: "tool-observed" as const,
    ...extra,
  };
}

function completeTriple(path: string, identityHash?: string): TripleRecord {
  return {
    kind: "triple",
    id: `round8-${path}`,
    ts: 10,
    cwd: "/repo",
    schemaV: 1,
    agent: "codex",
    origin: "agent-hook",
    platform: "linux",
    mechanism: {
      files: [{
        path,
        plusMinus: [1, 0],
        props: [],
        provenance: "tool-observed",
        ...(identityHash === undefined ? {} : { identityHash }),
      }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
}

function emptyMemory(overrides: Record<string, unknown> = {}): MemoryQueries {
  return {
    recall: () => [],
    recentFailures: () => [],
    stats: () => ({ failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }),
    searchKnowledge: () => [],
    fetchRecord: () => undefined,
    whyFile: () => [],
    ...overrides,
  } as MemoryQueries;
}

const signal = new AbortController().signal;

test("semantic replay normalizes alias multiplicity before digest identity", () => {
  const paths = freshPaths();
  const key = "alias-count-fix8";
  const aliases = ["src/a.ts", "./src/a.ts", "src//a.ts", "/repo/src/a.ts", "/repo/./src/a.ts"];
  try {
    // Each payload declares its raw alias multiplicity honestly: n spellings
    // of one canonical identity with candidateCount === n. All 65 replays
    // must collapse to one exact/complete payload.
    for (let index = 0; index < 65; index += 1) {
      assert.equal(recordCoverage(key, {
        agent: "codex", paths: [...aliases], cwd: "/repo", candidateCount: aliases.length,
        candidateCountExact: true, pathsComplete: true, platform: "linux",
      } as CoverageInput, paths), true);
    }
    const snapshot = readCoverage(key, paths);
    assert.ok(snapshot);
    assert.equal(snapshot.payloads, 1);
    assert.equal(snapshot.candidateCount, 1);
    assert.equal(snapshot.candidateCountExact, true);
    assert.equal(snapshot.pathsComplete, true);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("contradictory candidate count with a complete claim is never normalized to complete", () => {
  const paths = freshPaths();
  const key = "contradictory-count-fix8";
  try {
    // 200 declared candidates with one shipped path and pathsComplete=true is
    // self-contradictory; the contradiction must survive, not be laundered
    // into an exact single-identity complete snapshot.
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["src/a.ts"], cwd: "/repo", candidateCount: 200,
      candidateCountExact: true, pathsComplete: true, platform: "linux",
    } as CoverageInput, paths), true);
    const snapshot = readCoverage(key, paths);
    assert.ok(snapshot);
    assert.equal(snapshot.pathsComplete, false);
    assert.equal(snapshot.candidateCountExact, false);
    assert.equal(snapshot.candidateCount, 200);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("Codex and Claude cap counts from one cwd-aware canonical Set", () => {
  const edits = [
    { path: "src/a.ts", content: "a" },
    { path: "/repo/src/a.ts", content: "a" },
    ...Array.from({ length: 255 }, (_, index) => ({ path: `src/${index + 1}.ts`, content: "x" })),
  ];
  const codex = parseCodexHookPayload({
    session_id: "fix8", turn_id: "codex-set", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "MultiEdit", tool_input: { edits },
  }, 1);
  assert.ok(codex && codex.action === "append");
  assert.equal(codex?.coverageCandidateCount, 256);
  const claude = parseClaudeHookPayload({
    session_id: "fix8", prompt_id: "claude-set", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "MultiEdit", tool_input: {
      edits: edits.map((edit) => ({ file_path: edit.path, new_string: edit.content })),
    },
  }, 1);
  assert.ok(claude && claude.action === "append");
  assert.equal(claude?.coverageCandidateCount, 256);
});

test("coverage platform and cwd provenance reject known/rootless mixtures", () => {
  const paths = freshPaths();
  const key = "platform-mixture-fix8";
  try {
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["src/a.ts"], cwd: "/repo", platform: "linux",
      candidateCount: 1, candidateCountExact: true, pathsComplete: true,
    } as CoverageInput, paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["src/a.ts"], cwd: undefined, platform: "unknown",
      candidateCount: 1, candidateCountExact: true, pathsComplete: true,
    } as CoverageInput, paths), true);
    const snapshot = readCoverage(key, paths);
    assert.ok(snapshot);
    assert.equal(snapshot.pathsComplete, false);
    assert.equal(snapshot.candidateCountExact, false);
    assert.equal((snapshot as unknown as { platform?: string }).platform, "unknown");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("apply_patch markers are line strict and malformed paths disclose incomplete coverage", () => {
  const parsed = parseCodexHookPayload({
    session_id: "fix8", turn_id: "patch-markers", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "apply_patch",
    tool_input: { command: "*** Update File:\n@@\n*** Add File: src/b.ts" },
  }, 1);
  assert.ok(parsed && parsed.action === "append");
  assert.deepEqual(parsed?.coveragePaths, ["src/b.ts"]);
  assert.equal(parsed?.coveragePathsComplete, false);
  assert.equal(parsed?.coverageCandidateCountExact, false);

  const missingColon = parseCodexHookPayload({
    session_id: "fix8", turn_id: "patch-missing-colon", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "apply_patch",
    tool_input: { command: "*** Update File\n*** Add File: src/c.ts" },
  }, 1);
  assert.ok(missingColon && missingColon.action === "append");
  assert.deepEqual(missingColon?.coveragePaths, ["src/c.ts"]);
  assert.equal(missingColon?.coveragePathsComplete, false);
});

test("strong sidecars require a complete replay ledger, witnesses, and event coverage candidates", async () => {
  const paths = freshPaths();
  try {
    mkdirSync(paths.spoolDir, { recursive: true });
    const hash = pathIdentityHash("a.ts", { platform: "linux" });
    const key = "missing-ledger-fix8";
    writeFileSync(join(paths.spoolDir, `${key}.coverage.json`), JSON.stringify({
      v: 1, agent: "codex", platform: "linux", paths: [], identityHashes: [hash],
      candidateCount: 1, candidateCountExact: true, pathsComplete: true, payloads: 1,
    }));
    const missingLedger = readCoverage(key, paths);
    assert.ok(!missingLedger || missingLedger.candidateCountExact !== true || missingLedger.pathsComplete !== true);

    const eventKey = "event-coverage-mismatch-fix8";
    assert.equal(recordCoverage(eventKey, {
      agent: "codex", platform: "linux", paths: ["a.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: true,
    } as CoverageInput, paths), true);
    assert.equal(appendEvent(eventKey, mechanism("a.ts", {
      coveragePaths: ["a.ts", "b.ts"], coveragePathsComplete: true,
    }), paths), true);
    const triple = await annotateBatch(eventKey, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.equal(triple.mechanism.coverageStatus, "unknown");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("orphan discovery cannot classify a stale append lock with a live owner as safe", () => {
  const paths = freshPaths();
  const key = "live-append-owner-fix8";
  try {
    assert.equal(appendEvent(key, mechanism("src/a.ts"), paths), true);
    const stale = new Date(Date.now() - 20 * 60 * 1000);
    const batch = join(paths.spoolDir, `${key}.jsonl`);
    const lock = join(paths.spoolDir, `${key}.append.lock`);
    utimesSync(batch, stale, stale);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "a".repeat(32) }));
    utimesSync(lock, stale, stale);
    assert.deepEqual(listOrphanBatches(Date.now(), paths), []);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("custom mixed stats expose safe uncertainty bounds instead of a fabricated total", async () => {
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: emptyMemory({ stats: () => ({ failures: 100, fixEvents: 100, triples: 100, notes: 100, possibleFixes: 100 }) }),
    recallWithAi: disabledRecallWithAi,
  }).call("stats", {}, signal);
  const value = result.structuredContent as Record<string, unknown>;
  assert.equal(value.totalExact, false);
  assert.equal(value.totalLowerBound, 400);
  assert.equal(value.totalUpperBound, 500);
});

test("coincident bounds clamp an infeasible supplied total instead of trusting it", async () => {
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: emptyMemory({ stats: () => ({ failures: 2, fixEvents: 3, possibleFixes: 0, triples: 0, notes: 0, total: 999_999 }) }),
    recallWithAi: disabledRecallWithAi,
  });
  const high = (await registry.call("stats", {}, signal)).structuredContent as Record<string, unknown>;
  assert.equal(high.total, 5);
  assert.equal(high.totalExact, undefined);
  const low = await createToolRegistry({
    exposure: "sanitized",
    memory: emptyMemory({ stats: () => ({ failures: 2, fixEvents: 3, possibleFixes: 0, triples: 0, notes: 0, total: 0 }) }),
    recallWithAi: disabledRecallWithAi,
  }).call("stats", {}, signal);
  assert.equal((low.structuredContent as Record<string, unknown>).total, 5);
});

test("sanitized hostile knowledge IDs use collision-resistant registry handles that fetch", async () => {
  const ids = [
    "https://example.test/password=one/path",
    "https://example.test/password=two/path",
  ];
  const records: FailureRecord[] = ids.map((id, index) => ({
    kind: "failure", id, ts: index + 1, cwd: "/repo", cmd: "npm test", exitCode: 1,
    fingerprint: "0123456789abcdef", signature: ["failure"], excerpt: "failure", origin: "run",
  }));
  const memory = emptyMemory({
    searchKnowledge: () => records.map((record) => ({ id: record.id, ts: record.ts, kind: "failure", snippet: record.excerpt, score: 1 })),
    fetchRecord: (id: string) => records.find((record) => record.id === id),
  });
  const registry = createToolRegistry({ exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi });
  const search = await registry.call("search_knowledge", { query: "failure" }, signal);
  const items = (search.structuredContent as { items?: Array<{ id: string }> }).items ?? [];
  assert.equal(items.length, 2);
  assert.notEqual(items[0]?.id, items[1]?.id);
  assert.ok(!items.some((item) => item.id === "[redacted]"));
  const fetched = await registry.call("fetch_record", { id: items[0]!.id }, signal);
  const record = (fetched.structuredContent as { record?: unknown }).record;
  assert.ok(record !== null && record !== undefined, "handle must resolve to a projected record");
});

test("every handle returned by one hostile search resolves for immediate fetch_record", async () => {
  const count = 1_500;
  const records: FailureRecord[] = Array.from({ length: count }, (_, index) => ({
    kind: "failure", id: `https://example.test/password=${index}/p`, ts: index + 1, cwd: "/repo",
    cmd: "npm test", exitCode: 1, fingerprint: "0123456789abcdef", signature: ["f"], excerpt: "f", origin: "run",
  }));
  const byId = new Map(records.map((record) => [record.id, record]));
  const memory = emptyMemory({
    searchKnowledge: () => records.map((record) => ({ id: record.id, ts: record.ts, kind: "failure", snippet: record.excerpt, score: 1 })),
    fetchRecord: (id: string) => byId.get(id),
  });
  const registry = createToolRegistry({ exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi });
  const search = await registry.call("search_knowledge", { query: "f" }, signal);
  const items = (search.structuredContent as { items?: Array<{ id: string }> }).items ?? [];
  assert.ok(items.length >= 100);
  let resolved = 0;
  for (const item of items) {
    assert.ok(item.id.startsWith("rk-h-"), `leaked raw id: ${item.id}`);
    const fetched = await registry.call("fetch_record", { id: item.id }, signal);
    const record = (fetched.structuredContent as { record?: unknown }).record;
    if (record !== null && record !== undefined) resolved += 1;
  }
  assert.equal(resolved, items.length);
});

test("core and custom why remain ambiguous when redacted display paths have distinct hashes", async () => {
  const display = "[redacted]/src/a.ts";
  const first = completeTriple(display, pathIdentityHash("/home/one/src/a.ts", { platform: "linux", canonical: true }));
  const second = completeTriple(display, pathIdentityHash("/home/two/src/a.ts", { platform: "linux", canonical: true }));
  const core = whyFileEvidence([first, second], display);
  assert.deepEqual(core.matches, []);
  assert.equal(core.coverageIncomplete, true);
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: emptyMemory({ whyFile: () => [first, second] }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: display }, signal);
  assert.deepEqual((result.structuredContent as { items?: unknown[] }).items, []);
  assert.equal((result.structuredContent as { coverageIncomplete?: boolean }).coverageIncomplete, true);
});

test("knowledge projection uses bounded incremental accounting for hostile hit arrays", () => {
  const hits = Array.from({ length: 5_000 }, (_, index) => ({
    id: `0123456789abcdef${index.toString(16).padStart(16, "0")}`,
    ts: index,
    kind: "failure" as const,
    snippet: "bounded",
    score: 0.5,
  }));
  const original = JSON.stringify;
  let growingResponseStringifies = 0;
  JSON.stringify = ((value: unknown, replacer?: (this: unknown, key: string, value: unknown) => unknown, space?: string | number) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)
        && "items" in value && "exposure" in value) growingResponseStringifies += 1;
    return original(value, replacer as never, space as never);
  }) as typeof JSON.stringify;
  try {
    const projected = projectKnowledgeHits(hits, "sanitized");
    assert.equal(projected.truncated, true);
  } finally {
    JSON.stringify = original;
  }
  assert.ok(growingResponseStringifies <= 4, `response was serialized ${growingResponseStringifies} times`);
});

test("filesystem policy removes pathname identity fallback and uses exclusive watch publish", () => {
  const spoolSource = readFileSync(join(process.cwd(), "src", "agent", "spool.ts"), "utf8");
  const watchSource = readFileSync(join(process.cwd(), "src", "core", "watch-log.ts"), "utf8");
  assert.equal(spoolSource.includes("function pathStrictIdentity"), false);
  assert.doesNotMatch(spoolSource, /\bstatSync\s*\(/u);
  assert.match(spoolSource, /spoolDirectoryIdentity/u);
  assert.match(watchSource, /linkSync/u);
});

test("coverage publish cleanup carries an expected identity rather than deleting an arbitrary target", () => {
  const source = readFileSync(join(process.cwd(), "src", "agent", "spool.ts"), "utf8");
  assert.doesNotMatch(source, /if \(!written[^\n]*\) removeRegular\(target\)/u);
});

test("claim preparation threads the append lock and rechecks directory identity", () => {
  const source = readFileSync(join(process.cwd(), "src", "agent", "spool.ts"), "utf8");
  const bind = /function bindClaimCoverageLocked\([\s\S]*?\n\}/u.exec(source)?.[0] ?? "";
  const prepare = /function prepareClaimLocked\([\s\S]*?\n\}/u.exec(source)?.[0] ?? "";
  assert.match(bind, /lock: OwnedPrivateLock/u);
  assert.match(prepare, /lock: OwnedPrivateLock/u);
  assert.ok((bind.match(/appendLockUsable\(lock\)/gu) ?? []).length >= 3, "bind must recheck before mutations");
  assert.ok((prepare.match(/appendLockUsable\(lock\)/gu) ?? []).length >= 2, "prepare must recheck before unlink");
});

test("coverage snapshots persist origin platform and reject platform contradictions", () => {
  const paths = freshPaths();
  const key = "platform-persist-fix8";
  try {
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["C:/Repo/src/a.ts"], cwd: "C:/Repo", platform: "win32",
      candidateCount: 1, candidateCountExact: true, pathsComplete: true,
    } as CoverageInput, paths), true);
    assert.equal((readCoverage(key, paths) as unknown as { platform?: string } | undefined)?.platform, "win32");
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["c:/repo/src/a.ts"], cwd: "c:/repo", platform: "linux",
      candidateCount: 1, candidateCountExact: true, pathsComplete: true,
    } as CoverageInput, paths), true);
    const snapshot = readCoverage(key, paths);
    assert.ok(snapshot);
    assert.equal(snapshot.pathsComplete, false);
    assert.equal(snapshot.candidateCountExact, false);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});
