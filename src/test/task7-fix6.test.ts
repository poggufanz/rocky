import { strict as assert } from "node:assert";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { annotateBatch } from "../agent/annotate.js";
import { appendEvent, appendPayload, claimBatch, readCoverage, recordCoverage, type CoverageInput } from "../agent/spool.js";
import { createMemoryQueries, whyFileEvidence, type MemoryQueries } from "../core/memory-query.js";
import { sameFilesystemIdentity } from "../core/fs-safety.js";
import { createToolRegistry } from "../mcp/tools.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import type { FailureRecord, FixRecord, TripleRecord } from "../core/memory-read.js";
import { logHookError } from "../commands/agent-hook.js";

function freshPaths(): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-task7-fix6-"));
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
    id: "round6-triple",
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

function emptyMemory(overrides: Partial<MemoryQueries> = {}): MemoryQueries {
  return {
    recall: () => [],
    recentFailures: () => [],
    stats: () => ({ failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }),
    searchKnowledge: () => [],
    fetchRecord: () => undefined,
    whyFile: () => [],
    ...overrides,
  };
}

function registry(memory: MemoryQueries, exposure: "sanitized" | "raw" = "sanitized") {
  return createToolRegistry({ exposure, memory, recallWithAi: disabledRecallWithAi });
}

const TEST_SIGNAL = new AbortController().signal;

test("claimBatch recovers copied claim sidecar before live unlink", () => {
  const paths = freshPaths();
  const key = "copy-before-unlink";
  const id = "a".repeat(32);
  try {
    assert.equal(appendEvent(key, mechanism("old.ts"), paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["old.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    const live = join(paths.spoolDir, `${key}.jsonl`);
    const liveCoverage = join(paths.spoolDir, `${key}.coverage.json`);
    const claimPath = join(paths.spoolDir, `${key}.claim.${id}.jsonl`);
    const claimCoverage = join(paths.spoolDir, `${key}.claim.${id}.coverage.json`);
    mkdirSync(paths.spoolDir, { recursive: true });
    linkSync(live, claimPath);
    const stats = lstatSync(claimPath, { bigint: true });
    const snapshot = readCoverage(key, paths);
    assert.ok(snapshot);
    writeFileSync(claimCoverage, JSON.stringify({
      ...snapshot,
      claimId: id,
      claimDev: stats.dev.toString(),
      claimIno: stats.ino.toString(),
    }));
    assert.equal(lstatSync(liveCoverage).isFile(), true);
    const claim = claimBatch(key, paths);
    assert.ok(claim, "retry must recover copied claim sidecar");
    assert.throws(() => lstatSync(live), /ENOENT/u, "recovered claim may now detach live JSONL");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("coverage aliases resolve against turn cwd before durable cap", async () => {
  const paths = freshPaths();
  const key = "cwd-cap-union";
  const spellings = ["src/a.ts", "/repo/src/a.ts", ...Array.from({ length: 7 }, (_, i) => `src/${i + 1}.ts`)];
  try {
    const intent = { v: 1 as const, agent: "codex" as const, kind: "intent" as const, ts: 1, cwd: "/repo", text: "edit" };
    assert.equal(appendPayload(key, [intent, mechanism("src/a.ts")], {
      agent: "codex", paths: spellings, candidateCount: spellings.length,
      candidateCountExact: true, pathsComplete: true,
      cwd: "/repo",
    } as CoverageInput, paths).some(Boolean), true);
    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.equal(triple.mechanism.files.length, 8);
    assert.equal(triple.mechanism.truncatedFiles, 0);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("pathsComplete false without explicit adapter cap proof stays unknown", async () => {
  const paths = freshPaths();
  const key = "incomplete-count-only";
  try {
    assert.equal(appendEvent(key, mechanism("src/a.ts"), paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["src/a.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: false,
    }, paths), true);
    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.equal(triple.mechanism.coverageStatus, "unknown");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("mechanism without sidecar or complete marker discloses unknown coverage", async () => {
  const paths = freshPaths();
  const key = "missing-proof";
  try {
    assert.equal(appendEvent(key, mechanism("src/a.ts"), paths), true);
    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.equal(triple.mechanism.coverageStatus, "unknown");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("identical capped replay is idempotent while distinct capped payloads stay unknown", () => {
  const paths = freshPaths();
  const key = "capped-replay";
  const first = Array.from({ length: 256 }, (_, index) => `first/${index}.ts`);
  const second = Array.from({ length: 256 }, (_, index) => `second/${index}.ts`);
  const input = (pathsValue: string[]): CoverageInput => ({
    agent: "codex", paths: pathsValue, candidateCount: 300,
    candidateCountExact: true, pathsComplete: false,
  });
  try {
    assert.equal(recordCoverage(key, input(first), paths), true);
    const initial = readCoverage(key, paths);
    assert.ok(initial);
    assert.equal(initial.candidateCountExact, true);
    assert.equal(initial.pathsComplete, false);
    assert.equal(recordCoverage(key, input(first), paths), true);
    const replay = readCoverage(key, paths);
    assert.ok(replay);
    assert.equal(replay.payloads, 1);
    assert.equal(replay.candidateCountExact, true);
    assert.equal(recordCoverage(key, input(first.slice().reverse()), paths), true);
    const reorderedReplay = readCoverage(key, paths);
    assert.ok(reorderedReplay);
    assert.equal(reorderedReplay.payloads, 1);
    assert.equal(recordCoverage(key, input(second), paths), true);
    const distinct = readCoverage(key, paths);
    assert.ok(distinct);
    assert.equal(distinct.candidateCountExact, false);
    assert.equal(distinct.pathsComplete, false);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("a replay token cannot hide mutated coverage semantics", () => {
  const paths = freshPaths();
  const key = "capped-replay-mutated";
  const candidates = Array.from({ length: 256 }, (_, index) => `mutated/${index}.ts`);
  const digest = "b".repeat(64);
  try {
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: candidates, candidateCount: 300,
      candidateCountExact: true, pathsComplete: false, payloadDigest: digest,
    }, paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: candidates, candidateCount: 301,
      candidateCountExact: true, pathsComplete: false, payloadDigest: digest,
    }, paths), true);
    const snapshot = readCoverage(key, paths);
    assert.ok(snapshot);
    assert.equal(snapshot.payloads, 2);
    assert.equal(snapshot.candidateCountExact, false);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("MCP canonical stats total counts a mixed fix record once", async () => {
  const failure: FailureRecord = {
    kind: "failure", id: "failure-r6", ts: 1, cwd: "/repo", cmd: "npm test", exitCode: 1,
    fingerprint: "0123456789abcdef", signature: ["failure"], excerpt: "failure", origin: "run",
  };
  const fix: FixRecord = {
    kind: "fix", id: "fix-r6", ts: 2, cwd: "/repo", cmd: "npm test", failureIds: [failure.id],
    links: [
      { id: failure.id, basis: "identity", confidence: "confirmed" },
      { id: "possible-r6", basis: "program", confidence: "possible" },
    ],
  };
  const result = await registry(createMemoryQueries(() => [failure, fix])).call("stats", {}, TEST_SIGNAL);
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { total?: number }).total, 2);
});

test("why_file refuses suffix rationale across trusted roots for canonical and custom providers", async () => {
  const record = completeTriple("../other/src/a.ts");
  const custom = emptyMemory({ whyFile: () => [record] });
  const customResult = await registry(custom).call("why_file", { path: "src/a.ts" }, TEST_SIGNAL);
  assert.deepEqual((customResult.structuredContent as { items?: unknown[] }).items, []);
  const canonical = createMemoryQueries(() => [record]);
  const canonicalResult = await registry(canonical).call("why_file", { path: "src/a.ts" }, TEST_SIGNAL);
  assert.deepEqual((canonicalResult.structuredContent as { items?: unknown[] }).items, []);
});

test("custom trusted roots never use suffix-only rationale even inside the root", async () => {
  const record = completeTriple("packages/foo/src/a.ts");
  const result = await registry(emptyMemory({ whyFile: () => [record] })).call(
    "why_file", { path: "src/a.ts" }, TEST_SIGNAL,
  );
  assert.deepEqual((result.structuredContent as { items?: unknown[] }).items, []);
});

test("custom why_file bounds hostile nested files tags and possible before traversal", async () => {
  let fileReads = 0;
  let tagReads = 0;
  let possibleReads = 0;
  const files = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") return 1_000_000;
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        fileReads += 1;
        return { path: "src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const tags = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") return 1_000_000;
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        tagReads += 1;
        return "tag";
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const possible = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") return 1_000_000;
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        possibleReads += 1;
        return { id: "possible", ts: 1, source: "agent-hook", reason: "path_may_be_omitted" };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const hostile = completeTriple("src/a.ts", {
    rationale: { text: "why", tags },
    mechanism: { files, truncatedFiles: 0, baseline: "captured", coverageStatus: "complete" },
  });
  const memory = emptyMemory({
    whyFileEvidence: () => ({ matches: [hostile], possible, coverage: { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 }, coverageIncomplete: true }),
  });
  const result = await registry(memory).call("why_file", { path: "src/a.ts", limit: 10 }, TEST_SIGNAL);
  assert.equal(result.isError, undefined);
  assert.ok(fileReads < 1024, `files traversed: ${fileReads}`);
  assert.ok(tagReads < 1024, `tags traversed: ${tagReads}`);
  assert.ok(possibleReads < 1024, `possible traversed: ${possibleReads}`);
});

test("core why_file bounds a hostile mechanism array before matching", () => {
  let reads = 0;
  const files = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") return 1_000_000;
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        reads += 1;
        return { path: "src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" };
      }
      if (property === Symbol.iterator) {
        return function* hostileIterator(): Generator<unknown> {
          while (true) yield { path: "never.ts", plusMinus: [1, 0], props: [] };
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const record = completeTriple("src/a.ts", {
    mechanism: { files, truncatedFiles: 0, baseline: "captured", coverageStatus: "complete" },
  });
  const evidence = whyFileEvidence([record], "src/a.ts");
  assert.ok(reads < 1024, `core files traversed: ${reads}`);
  assert.equal(evidence.coverageIncomplete, true);
});

test("branded canonical MemoryQueries is immutable", () => {
  const queries = createMemoryQueries(() => []);
  assert.equal(Object.isFrozen(queries), true);
});

test("hook log refuses a symlink target when the host supports symlinks", () => {
  const paths = freshPaths();
  try {
    mkdirSync(paths.home, { recursive: true });
    const target = join(paths.home, "sentinel.log");
    const link = paths.agentLog;
    writeFileSync(target, "keep\n");
    try {
      symlinkSync(target, link);
    } catch {
      return;
    }
    logHookError("must not follow", paths);
    assert.equal(readFileSync(target, "utf8"), "keep\n");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("filesystem identity helper rejects zero and unsafe numeric identities", () => {
  const file = (dev: number, ino: number) => ({
    dev,
    ino,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  assert.equal(sameFilesystemIdentity(file(0, 0) as never, file(0, 0) as never), false);
  assert.equal(
    sameFilesystemIdentity(file(1, Number.MAX_SAFE_INTEGER + 1) as never, file(1, Number.MAX_SAFE_INTEGER + 1) as never),
    false,
  );
});
