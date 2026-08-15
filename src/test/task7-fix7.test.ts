import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
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
import { sameFilesystemIdentity } from "../core/fs-safety.js";
import { createToolRegistry } from "../mcp/tools.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

function freshPaths(): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-task7-fix7-"));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

function mechanism(path: string) {
  return {
    v: 1 as const,
    agent: "codex" as const,
    kind: "mechanism" as const,
    ts: 2,
    tool: "Edit",
    path,
    provenance: "tool-observed" as const,
  };
}

function completeTriple(path: string, overrides: Record<string, unknown> = {}): TripleRecord {
  return {
    kind: "triple",
    id: "round7-triple",
    ts: 10,
    cwd: "/repo",
    schemaV: 1,
    agent: "codex",
    origin: "agent-hook",
    platform: "linux",
    mechanism: {
      files: [{ path, plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
    ...overrides,
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

function registry(memory: MemoryQueries, exposure: "sanitized" | "raw" = "sanitized") {
  return createToolRegistry({ exposure, memory, recallWithAi: disabledRecallWithAi });
}

const TEST_SIGNAL = new AbortController().signal;

test("semantic coverage replay deduplicates cwd aliases and reordered payloads", () => {
  const paths = freshPaths();
  const key = "alias-replay-fix7";
  const aliases = ["src/a.ts", "./src/a.ts", "src//a.ts", "/repo/src/a.ts", "/repo/./src/a.ts"];
  try {
    for (let index = 0; index < 65; index += 1) {
      const spelling = aliases[index % aliases.length]!;
      const payloadDigest = createHash("sha256").update(`raw-${index}-${spelling}`, "utf8").digest("hex");
      assert.equal(recordCoverage(key, {
        agent: "codex", paths: [spelling], cwd: "/repo", candidateCount: 1,
        candidateCountExact: true, pathsComplete: true, payloadDigest,
      }, paths), true);
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

test("complete coverage rejects conflicting cwd roots but equivalent cwd aliases merge", () => {
  const paths = freshPaths();
  const key = "mixed-root-fix7";
  const input = (cwd: string): CoverageInput => ({
    agent: "codex", paths: ["src/a.ts"], cwd, candidateCount: 1,
    candidateCountExact: true, pathsComplete: true,
  });
  try {
    assert.equal(recordCoverage(key, input("/repo"), paths), true);
    assert.equal(recordCoverage(key, input("/repo/./"), paths), true);
    const equivalent = readCoverage(key, paths);
    assert.ok(equivalent);
    assert.equal(equivalent.payloads, 1);
    assert.equal(equivalent.pathsComplete, true);

    assert.equal(recordCoverage(key, input("/other"), paths), true);
    const mixed = readCoverage(key, paths);
    assert.ok(mixed);
    assert.equal(mixed.pathsComplete, false);
    assert.equal(mixed.candidateCountExact, false);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("Claude and Codex MultiEdit keep valid events but disclose missing paths", () => {
  const claude = parseClaudeHookPayload({
    session_id: "session-fix7", prompt_id: "turn-fix7", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "MultiEdit",
    tool_input: { file_path: "src/fallback.ts", edits: [{ file_path: "src/a.ts", new_string: "a" }, { new_string: "missing" }] },
  }, 1);
  assert.ok(claude);
  assert.equal(claude.action, "append");
  assert.equal(claude.events.length, 1);
  assert.equal(claude.coveragePathsComplete, false);
  assert.equal(claude.coverageCandidateCountExact, false);

  const codex = parseCodexHookPayload({
    session_id: "session-fix7", turn_id: "turn-fix7", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "MultiEdit",
    tool_input: { file_path: "src/fallback.ts", edits: [{ path: "src/a.ts", content: "a" }, { content: "missing" }] },
  }, 1);
  assert.ok(codex);
  assert.equal(codex.action, "append");
  assert.equal(codex.events.length, 1);
  assert.equal(codex.coveragePathsComplete, false);
  assert.equal(codex.coverageCandidateCountExact, false);

  const codexOuterFallback = parseCodexHookPayload({
    session_id: "session-fix7", turn_id: "turn-fix7-outer-fallback", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "MultiEdit", file_path: "src/fallback.ts",
    tool_input: { edits: [{ content: "missing" }] },
  }, 1);
  assert.equal(codexOuterFallback, undefined);
});

test("full-set adapter digest deduplicates canonical duplicate aliases", () => {
  const one = parseClaudeHookPayload({
    session_id: "digest-fix7", prompt_id: "one", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "MultiEdit",
    tool_input: { edits: [{ file_path: "src/a.ts", new_string: "a" }] },
  }, 1);
  const duplicate = parseClaudeHookPayload({
    session_id: "digest-fix7", prompt_id: "two", cwd: "/repo",
    hook_event_name: "PostToolUse", tool_name: "MultiEdit",
    tool_input: { edits: [
      { file_path: "src/a.ts", new_string: "a" },
      { file_path: "/repo/src/a.ts", new_string: "a" },
    ] },
  }, 1);
  assert.ok(one && duplicate && one.action === "append" && duplicate.action === "append");
  if (one?.action !== "append" || duplicate?.action !== "append") return;
  assert.equal(one.coverageDigest, duplicate.coverageDigest);
});

test("forged payload digest overflow is never read as exact proof", () => {
  const paths = freshPaths();
  const key = "forged-ledger-fix7";
  try {
    mkdirSync(paths.spoolDir, { recursive: true });
    const digest = "a".repeat(64);
    writeFileSync(join(paths.spoolDir, `${key}.coverage.json`), JSON.stringify({
      v: 1, agent: "codex", paths: ["src/a.ts"], identityHashes: [pathIdentityHash("src/a.ts", { platform: "unknown" })],
      candidateCount: 1, candidateCountExact: true, pathsComplete: true, payloads: 65,
      payloadDigests: Array.from({ length: 64 }, () => digest),
    }));
    const snapshot = readCoverage(key, paths);
    assert.ok(!snapshot || snapshot.candidateCountExact !== true || snapshot.pathsComplete !== true);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("distinct capped tails remain distinguishable while semantic retries dedupe", () => {
  const paths = freshPaths();
  const key = "capped-tail-digest-fix7";
  const candidates = Array.from({ length: 256 }, (_, index) => `src/${index}.ts`);
  try {
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: candidates, candidateCount: 300,
      candidateCountExact: true, pathsComplete: false, payloadDigest: "a".repeat(64),
    }, paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: candidates, candidateCount: 300,
      candidateCountExact: true, pathsComplete: false, payloadDigest: "a".repeat(64),
    }, paths), true);
    assert.equal(readCoverage(key, paths)?.payloads, 1);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: candidates, candidateCount: 300,
      candidateCountExact: true, pathsComplete: false, payloadDigest: "b".repeat(64),
    }, paths), true);
    const snapshot = readCoverage(key, paths);
    assert.ok(snapshot);
    assert.equal(snapshot.payloads, 2);
    assert.equal(snapshot.candidateCountExact, false);
    assert.equal(snapshot.pathsComplete, false);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("exact sidecar count contradicting surviving event discloses unknown coverage", async () => {
  const paths = freshPaths();
  const key = "count-event-fix7";
  try {
    assert.equal(appendEvent(key, mechanism("src/b.ts"), paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["src/a.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.equal(triple.mechanism.coverageStatus, "unknown");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("orphan batches remain protected while a per-key append lock is active", () => {
  const paths = freshPaths();
  const key = "append-lock-orphan-fix7";
  try {
    assert.equal(appendEvent(key, mechanism("src/a.ts"), paths), true);
    const batch = join(paths.spoolDir, `${key}.jsonl`);
    const lock = join(paths.spoolDir, `${key}.append.lock`);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(batch, old, old);
    writeFileSync(lock, "active append");
    const orphans = listOrphanBatches(Date.now(), paths);
    assert.deepEqual(orphans, []);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("custom mixed stats use a feasible supplied total without double-counting fix categories", async () => {
  const result = await registry(emptyMemory({
    stats: () => ({ failures: 1, fixEvents: 1, confirmedFixes: 1, possibleFixes: 1, triples: 0, notes: 0, total: 2 }),
  })).call("stats", {}, TEST_SIGNAL);
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { total?: number }).total, 2);
});

test("custom why_file matches a trusted redacted identity hash only", async () => {
  const rawIdentity = "/home/password=secret/repo/src/a.ts";
  const record = completeTriple("[redacted]/src/a.ts", {
    cwd: "/home/password=secret/repo",
    mechanism: {
      files: [{
        path: "[redacted]/src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed",
        identityHash: pathIdentityHash(rawIdentity, { platform: "linux", canonical: true }),
      }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  });
  const result = await registry(emptyMemory({ whyFile: () => [record] })).call(
    "why_file", { path: rawIdentity }, TEST_SIGNAL,
  );
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { items?: unknown[] }).items?.length, 1);
  assert.equal((result.structuredContent as { coverageStatus?: string }).coverageStatus, "complete");
});

test("sanitized search IDs round-trip to fetch for valid Rocky hex IDs", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  const failure: FailureRecord = {
    kind: "failure", id, ts: 1, cwd: "/repo", cmd: "npm test", exitCode: 1,
    fingerprint: "0123456789abcdef", signature: ["failure"], excerpt: "failure", origin: "run",
  };
  const tools = registry(createMemoryQueries(() => [failure]));
  const search = await tools.call("search_knowledge", { query: "failure" }, TEST_SIGNAL);
  const item = (search.structuredContent as { items?: Array<{ id: string }> }).items?.[0];
  assert.ok(item?.id);
  assert.equal(item?.id, id);
  const fetched = await tools.call("fetch_record", { id: item.id }, TEST_SIGNAL);
  assert.equal((fetched.structuredContent as { record?: unknown }).record !== null, true);
});

test("filesystem policy rejects unavailable and zero identities and is centralized in memory reads", async () => {
  const file = (dev: number, ino: number) => ({
    dev, ino, isFile: () => true, isSymbolicLink: () => false,
  });
  assert.equal(sameFilesystemIdentity(file(0, 0) as never, file(0, 0) as never), false);
  const source = readFileSync(join(process.cwd(), "src", "agent", "spool.ts"), "utf8");
  assert.equal(source.includes("function compatibleIdentity"), false);
});
