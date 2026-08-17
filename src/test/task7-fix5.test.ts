import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { annotateBatch } from "../agent/annotate.js";
import {
  appendEvent,
  appendPayload,
  claimBatch,
  readCoverage,
  readBatch,
  recordCoverage,
  removeBatch,
  type CoverageInput,
} from "../agent/spool.js";
import { boundTripleMechanism, boundTripleRecord, loadMemory, parseMemoryRecord, pathIdentityHash, type MemoryRecord, type TripleRecord } from "../core/memory-read.js";
import { whyFileEvidence, type MemoryQueries } from "../core/memory-query.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { recordTriple } from "../core/memory.js";
import { createToolRegistry } from "../mcp/tools.js";
import { projectKnowledgeHits, projectMemoryRecord } from "../mcp/privacy.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

function freshPaths(): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-task7-fix5-"));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

function mechanism(path: string, provenance: "tool-observed" | "git-diff-inferred" | "unknown" = "tool-observed") {
  return {
    v: 1 as const,
    agent: "codex" as const,
    kind: "mechanism" as const,
    ts: 2,
    tool: "Edit",
    path,
    provenance,
  };
}

function completeTriple(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "triple",
    id: "triple-fix5",
    ts: 10,
    cwd: "/repo",
    schemaV: 1,
    agent: "codex",
    origin: "agent-hook",
    platform: "linux",
    mechanism: {
      files: [{ path: "src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
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

function agentHookRegistry(memory: MemoryQueries) {
  return createToolRegistry({ exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi });
}

test("coverage is claim-scoped when late append creates a new live generation", async () => {
  const paths = freshPaths();
  const key = "claim-generation";
  try {
    assert.equal(appendEvent(key, mechanism("old.ts"), paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["old.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    const claim = claimBatch(key, paths);
    assert.ok(claim);
    assert.equal(appendEvent(key, mechanism("new.ts"), paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["new.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    const triple = await annotateBatch(key, { paths, claim, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.deepEqual(triple.mechanism.files.map((file) => file.path), ["old.ts"]);
    assert.ok(readCoverage(key, paths), "late generation witness must survive old claim cleanup");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("disjoint complete coverage payloads retain exact union beyond adapter cap", async () => {
  const paths = freshPaths();
  const key = "coverage-union";
  const first = Array.from({ length: 200 }, (_, index) => `first/${index}.ts`);
  const second = Array.from({ length: 200 }, (_, index) => `second/${index}.ts`);
  try {
    assert.equal(appendEvent(key, mechanism(first[0]!), paths), true);
    const input = (values: string[]): CoverageInput => ({
      agent: "codex", paths: values, candidateCount: values.length,
      candidateCountExact: true, pathsComplete: true,
    });
    assert.equal(recordCoverage(key, input(first), paths), true);
    assert.equal(recordCoverage(key, input(second), paths), true);
    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.equal(triple.mechanism.truncatedFiles, 392);
    assert.equal(triple.mechanism.coverageStatus, "truncated");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("coverage sidecar accepts the full bounded path envelope without stale failure", () => {
  const paths = freshPaths();
  try {
    const values = Array.from({ length: 256 }, (_, index) => `${"x".repeat(1000)}-${index}.ts`);
    assert.equal(recordCoverage("long-envelope", {
      agent: "codex", paths: values, candidateCount: values.length,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    const snapshot = readCoverage("long-envelope", paths);
    assert.ok(snapshot);
    assert.ok(snapshot.paths.length <= 8);
    assert.equal(snapshot.identityHashes?.length, 256);
    assert.equal(snapshot.candidateCount, 256);
    assert.equal(snapshot.pathsComplete, true);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("malformed coverage metadata fails open instead of filtering into complete proof", () => {
  const paths = freshPaths();
  try {
    mkdirSync(paths.spoolDir, { recursive: true });
    const cases = [
      { key: "bad-entry", value: { v: 1, agent: "codex", paths: ["a.ts", 42], candidateCount: 2, candidateCountExact: true, pathsComplete: true, payloads: 1 } },
      { key: "bad-count", value: { v: 1, agent: "codex", paths: ["a.ts"], candidateCount: 300, candidateCountExact: true, pathsComplete: true, payloads: 1 } },
      { key: "bad-payloads", value: { v: 1, agent: "codex", paths: ["a.ts"], candidateCount: 1, candidateCountExact: true, pathsComplete: true, payloads: 0 } },
    ];
    for (const entry of cases) {
      writeFileSync(join(paths.spoolDir, `${entry.key}.coverage.json`), JSON.stringify(entry.value));
      assert.equal(readCoverage(entry.key, paths), undefined, entry.key);
    }
    writeFileSync(join(paths.spoolDir, "corrupt.coverage.json"), "{not-json");
    assert.equal(readCoverage("corrupt", paths), undefined);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("removeBatch cleans coverage witnesses with the bounded orphan lifecycle", () => {
  const paths = freshPaths();
  try {
    assert.equal(recordCoverage("remove-sidecar", {
      agent: "codex", paths: ["a.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    removeBatch("remove-sidecar", paths);
    assert.equal(readCoverage("remove-sidecar", paths), undefined);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("redacted cwd identity survives durable reload for absolute queries", async () => {
  const paths = freshPaths();
  const key = "redacted-reload";
  const cwd = "/home/password=secret/repo";
  const absolute = `${cwd}/src/a.ts`;
  try {
    assert.equal(appendEvent(key, {
      v: 1, agent: "codex", kind: "intent", ts: 1, cwd, text: "edit file",
      baseline: { status: "captured", head: "head" },
    }, paths), true);
    assert.equal(appendEvent(key, mechanism(absolute), paths), true);
    const triple = await annotateBatch(key, {
      paths,
      git: (args) => args[0] === "rev-parse" ? "head" : "",
      queueLabel: () => {},
    });
    assert.ok(triple);
    const records = loadMemory(paths.memory);
    const evidence = whyFileEvidence(records, absolute);
    // The opaque discriminator must still associate this absolute query after
    // reload; baseline may remain conservative when no repository is present.
    assert.equal(evidence.matches.length, 0);
    assert.equal(evidence.possible.length, 1);
    assert.equal(evidence.coverageIncomplete, true);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("known root prevents suffix fallback from crossing a relative parent", () => {
  const record = completeTriple({
    mechanism: {
      files: [{ path: "../other/src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  }) as unknown as MemoryRecord;
  const evidence = whyFileEvidence([record], "src/a.ts");
  assert.deepEqual(evidence.matches, []);
  assert.equal(evidence.coverageIncomplete, true);
});

test("whyFileEvidence is total over hostile arrays and requires complete proof", () => {
  const hostile = new Proxy([] as MemoryRecord[], {
    get(_target, property) {
      if (property === Symbol.iterator || property === "length") throw new Error("hostile traversal");
      return undefined;
    },
  });
  assert.doesNotThrow(() => whyFileEvidence(hostile, "src/a.ts"));
  const missingProof = completeTriple({
    mechanism: {
      files: [{ path: "src/a.ts", plusMinus: [1, 0], props: [] }],
      truncatedFiles: 0, coverageStatus: "complete",
    },
  }) as unknown as MemoryRecord;
  const evidence = whyFileEvidence([missingProof], "src/a.ts");
  assert.equal(evidence.matches.length, 0);
  assert.equal(evidence.coverageIncomplete, true);
});

test("redacted duplicate displays require distinct durable discriminators", () => {
  const duplicate = boundTripleMechanism({
    files: [
      { path: "[redacted]/src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" },
      { path: "[redacted]/src/a.ts", plusMinus: [2, 0], props: [], provenance: "tool-observed" },
    ],
    truncatedFiles: 0, coverageStatus: "complete",
  });
  assert.equal(duplicate.files.length, 1);
  assert.equal(duplicate.coverageStatus, "unknown");
  const distinct = boundTripleMechanism({
    files: [
      { path: "[redacted]/src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed", identityHash: "0123456789abcdef0123456789abcdef" },
      { path: "[redacted]/src/a.ts", plusMinus: [2, 0], props: [], provenance: "tool-observed", identityHash: "fedcba9876543210fedcba9876543210" },
    ],
    truncatedFiles: 0, coverageStatus: "complete",
  });
  assert.equal(distinct.files.length, 2);
  assert.equal(distinct.coverageStatus, "complete");
});

test("control-bearing aliases downgrade durable coverage", () => {
  const bounded = boundTripleMechanism({
    files: [{ path: "src/\u0000a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
    truncatedFiles: 0, coverageStatus: "complete",
  });
  assert.equal(bounded.coverageStatus, "unknown");
});

test("caller-supplied knowledge proof cannot forge complete status", () => {
  const projected = projectKnowledgeHits([{
    id: "forged-proof", ts: 1, kind: "triple", snippet: "change", score: 1,
    agent: "codex", source: "agent-hook", filesCovered: ["src/a.ts"],
    truncatedFiles: 0, coverageStatus: "complete", complete: true,
    coverageProof: true,
  } as never], "raw");
  assert.equal(projected.items[0]?.complete, false);
  assert.equal(projected.items[0]?.coverageStatus, "unknown");
});

test("custom provider null fetch fails open", async () => {
  const registry = agentHookRegistry(emptyMemory({ fetchRecord: () => null as never }));
  const result = await registry.call("fetch_record", { id: "missing" }, new AbortController().signal);
  assert.ok(result.structuredContent.record === null || result.structuredContent.error !== undefined);
});

test("sanitized fetch bounds and cleans nested fix identifiers", async () => {
  const secret = "sk-ant-api-secret-012345678901234567890123";
  const record = {
    kind: "fix", id: "fix-safe", ts: 1, cwd: "/work", cmd: "ok",
    failureIds: [secret, "\u001b[31msecret"],
    candidateFailureIds: [secret],
    links: [{ id: secret, basis: "identity" }],
  } as never;
  const registry = agentHookRegistry(emptyMemory({ fetchRecord: () => record }));
  const result = await registry.call("fetch_record", { id: "fix-safe" }, new AbortController().signal);
  const encoded = JSON.stringify(result.structuredContent);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("\u001b"), false);
});

test("custom fetch_record retains a fix link with an unrecognized basis and normalizes confirmed confidence to possible", async () => {
  const record = {
    kind: "fix", id: "fix-basis-unknown", ts: 1, cwd: "/work", cmd: "ok",
    failureIds: ["f1"],
    links: [{ id: "f1", basis: "banana", confidence: "confirmed" }],
  } as never;
  const registry = agentHookRegistry(emptyMemory({ fetchRecord: () => record }));
  const result = await registry.call("fetch_record", { id: "fix-basis-unknown" }, new AbortController().signal);
  const projected = result.structuredContent.record as { links?: { basis: string; confidence?: string }[] } | null;
  assert.equal(projected?.links?.[0]?.basis, "banana");
  assert.equal(projected?.links?.[0]?.confidence, "possible");
});

test("custom fetch_record still rejects a fix whose link basis is out of bounds", async () => {
  const controlBasis = {
    kind: "fix", id: "fix-basis-control", ts: 1, cwd: "/work", cmd: "ok",
    failureIds: ["f1"],
    links: [{ id: "f1", basis: "bad\u0000basis" }],
  } as never;
  const overLongBasis = {
    kind: "fix", id: "fix-basis-long", ts: 1, cwd: "/work", cmd: "ok",
    failureIds: ["f1"],
    links: [{ id: "f1", basis: "x".repeat(16 * 1024 + 1) }],
  } as never;
  for (const record of [controlBasis, overLongBasis]) {
    const registry = agentHookRegistry(emptyMemory({ fetchRecord: () => record }));
    const result = await registry.call("fetch_record", { id: (record as { id: string }).id }, new AbortController().signal);
    assert.ok(result.structuredContent.record === null || result.structuredContent.error !== undefined);
  }
});

test("projectFixRecord retains a fix link with an unrecognized basis and normalizes confidence to possible", () => {
  const fix = {
    kind: "fix", id: "project-basis-unknown", ts: 1, cwd: "/work", cmd: "ok", failureIds: ["f1"],
    links: [{ id: "f1", basis: "banana", confidence: "confirmed" }],
  } as never;
  const projected = projectMemoryRecord(fix, "sanitized", true) as { links?: { basis: string; confidence?: string }[]; truncatedFields: string[] };
  assert.equal(projected.links?.[0]?.basis, "banana");
  assert.equal(projected.links?.[0]?.confidence, "possible");
  assert.equal(projected.truncatedFields.includes("record.links"), false);
});

test("projectFixRecord still truncates a fix link whose basis is out of bounds", () => {
  const fix = {
    kind: "fix", id: "project-basis-bad", ts: 1, cwd: "/work", cmd: "ok", failureIds: ["f1"],
    links: [{ id: "f1", basis: "bad\u0000basis" }, { id: "f2", basis: "x".repeat(16 * 1024 + 1) }],
  } as never;
  const projected = projectMemoryRecord(fix, "sanitized", true) as { links?: unknown[]; truncatedFields: string[] };
  assert.deepEqual(projected.links, []);
  assert.equal(projected.truncatedFields.includes("record.links"), true);
});

test("custom recall bounds nested signature traversal before projection", async () => {
  let numericReads = 0;
  const signature = new Proxy(Array.from({ length: 100_000 }, () => "line"), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) numericReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const failure = {
    kind: "failure", id: "failure-safe", ts: 1, cwd: "/work", cmd: "bad", exitCode: 1,
    fingerprint: "fp", signature, excerpt: "bad", origin: "run",
  } as never;
  const registry = agentHookRegistry(emptyMemory({ recall: () => [{ failure, score: 0.5 }] }));
  const result = await registry.call("recall", { query: "bad" }, new AbortController().signal);
  assert.ok(numericReads <= 1024, `signature reads must stay bounded, got ${numericReads}`);
  assert.ok(JSON.stringify(result.structuredContent).length < 512 * 1024);
});

test("stats recomputes total from normalized counters", async () => {
  const registry = agentHookRegistry(emptyMemory({ stats: () => ({
    failures: 2, fixEvents: 3, resolved: 1, unresolved: 1,
    confirmedFixes: 4, possibleFixes: 5, triples: 6, notes: 7, total: 999,
  }) }));
  const result = await registry.call("stats", {}, new AbortController().signal);
  assert.equal(result.structuredContent.total, 23);
});

test("missing platform does not prove complete for absolute durable paths", () => {
  const record = completeTriple({
    platform: undefined,
    cwd: "/repo",
    mechanism: {
      files: [{ path: "/repo/src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  }) as unknown as TripleRecord;
  const bounded = boundTripleRecord(record);
  assert.equal(bounded.mechanism.coverageStatus, "unknown");
});

test("repeated redacted displays with the same hash are ambiguous after reload", () => {
  const bounded = boundTripleMechanism({
    files: [
      { path: "[redacted]/src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed", identityHash: "0123456789abcdef0123456789abcdef" },
      { path: "[redacted]/src/a.ts", plusMinus: [2, 0], props: [], provenance: "tool-observed", identityHash: "0123456789abcdef0123456789abcdef" },
    ],
    truncatedFiles: 0, coverageStatus: "complete",
  });
  assert.equal(bounded.coverageStatus, "unknown");
});

test("only canonical in-process knowledge hits retain complete proof", async () => {
  const triple = completeTriple({
    intent: { text: "change button" },
    mechanism: {
      files: [{ path: "src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  }) as unknown as TripleRecord;
  const canonical = createMemoryQueries(() => [triple]);
  const canonicalHit = canonical.searchKnowledge({ query: "button", kind: "triple" })[0];
  assert.ok(canonicalHit);
  for (const exposure of ["sanitized", "raw"] as const) {
    const customRegistry = agentHookRegistry(emptyMemory({ searchKnowledge: () => [{
      ...canonicalHit!, coverageProof: true,
    } as never] }));
    const customResult = await customRegistry.call("search_knowledge", { query: "button" }, new AbortController().signal);
    const customItem = (customResult.structuredContent.items as Array<Record<string, unknown>>)[0];
    assert.equal(customItem?.complete, false);
    const canonicalRegistry = createToolRegistry({ exposure, memory: canonical, recallWithAi: disabledRecallWithAi });
    const canonicalResult = await canonicalRegistry.call("search_knowledge", { query: "button" }, new AbortController().signal);
    const canonicalItem = (canonicalResult.structuredContent.items as Array<Record<string, unknown>>)[0];
    assert.equal(canonicalItem?.complete, true);
  }
});

test("provider throws and post-call hostile proxies fail open across MCP reads", async () => {
  const throwing = emptyMemory({
    recall: () => { throw new Error("provider recall"); },
    recentFailures: () => { throw new Error("provider recent"); },
    stats: () => { throw new Error("provider stats"); },
    searchKnowledge: () => { throw new Error("provider search"); },
    fetchRecord: () => new Proxy({}, { get() { throw new Error("getter"); } }) as never,
    whyFileEvidence: () => new Proxy({}, { get() { throw new Error("evidence getter"); } }) as never,
  });
  const registry = agentHookRegistry(throwing);
  const signal = new AbortController().signal;
  for (const [name, args] of [
    ["recall", { query: "x" }], ["recent_failures", {}], ["stats", {}],
    ["search_knowledge", { query: "x" }], ["fetch_record", { id: "x" }], ["why_file", { path: "src/x.ts" }],
  ] as const) {
    await assert.doesNotReject(() => registry.call(name, args, signal), name);
  }
  const hostileHits = new Proxy([] as unknown as Array<never>, {
    get(target, property, receiver) {
      if (property === "length") return 1;
      if (property === "0") throw new Error("post-call index");
      return Reflect.get(target, property, receiver);
    },
  });
  const hostileRegistry = agentHookRegistry(emptyMemory({ searchKnowledge: () => hostileHits as never }));
  await assert.doesNotReject(() => hostileRegistry.call("search_knowledge", { query: "x" }, signal));
});

test("why evidence never forwards unsafe identity scalars", () => {
  const hostile = {
    kind: "triple", id: 42, ts: Number.POSITIVE_INFINITY, cwd: "/repo", schemaV: 1,
    agent: "evil", origin: "agent-hook",
    mechanism: {
      files: [{ path: "src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 1, baseline: "unknown", coverageStatus: "unknown",
    },
  };
  const evidence = whyFileEvidence([hostile as never], "src/a.ts");
  assert.equal(evidence.matches.length, 0);
  assert.equal(evidence.possible.length, 0);
  assert.equal(evidence.coverageIncomplete, true);
  assert.doesNotThrow(() => JSON.stringify(evidence));
});

test("afterPersist append creates a surviving next-generation witness", async () => {
  const paths = freshPaths();
  const key = "after-persist-generation";
  try {
    assert.equal(appendEvent(key, mechanism("old.ts"), paths), true);
    assert.equal(recordCoverage(key, { agent: "codex", paths: ["old.ts"], candidateCount: 1, candidateCountExact: true, pathsComplete: true }, paths), true);
    const triple = await annotateBatch(key, {
      paths,
      git: () => undefined,
      queueLabel: () => {},
      afterPersist: () => {
        appendEvent(key, mechanism("next.ts"), paths);
        recordCoverage(key, { agent: "codex", paths: ["next.ts"], candidateCount: 1, candidateCountExact: true, pathsComplete: true }, paths);
      },
    });
    assert.ok(triple);
    assert.ok(readCoverage(key, paths));
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("overlapping duplicate coverage retries keep exact union", async () => {
  const paths = freshPaths();
  const key = "coverage-overlap";
  const values = Array.from({ length: 200 }, (_, index) => `same/${index}.ts`);
  try {
    assert.equal(appendEvent(key, mechanism(values[0]!), paths), true);
    const input: CoverageInput = { agent: "codex", paths: values, candidateCount: values.length, candidateCountExact: true, pathsComplete: true };
    assert.equal(recordCoverage(key, input, paths), true);
    assert.equal(recordCoverage(key, input, paths), true);
    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.equal(triple.mechanism.truncatedFiles, 192);
    assert.equal(triple.mechanism.coverageStatus, "truncated");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("coverage union overflow is explicit unknown and never falsely exact", () => {
  const paths = freshPaths();
  const key = "coverage-hard-cap";
  const first = Array.from({ length: 1_300 }, (_, index) => `first/${index}.ts`);
  const second = Array.from({ length: 200 }, (_, index) => `second/${index}.ts`);
  try {
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: first, candidateCount: first.length,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: second, candidateCount: second.length,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    const snapshot = readCoverage(key, paths);
    assert.ok(snapshot);
    assert.equal(snapshot.candidateCountExact, false);
    assert.equal(snapshot.pathsComplete, false);
    assert.ok((snapshot.identityHashes?.length ?? 0) <= 1_400);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("failed sidecar replacement never leaves a readable stale proof", () => {
  const paths = freshPaths();
  const key = "coverage-replace-fail";
  try {
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["old.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: true,
    }, paths), true);
    const target = join(paths.spoolDir, `${key}.coverage.json`);
    rmSync(target, { force: true });
    mkdirSync(target);
    assert.equal(recordCoverage(key, {
      agent: "codex", paths: ["new.ts"], candidateCount: 1,
      candidateCountExact: true, pathsComplete: true,
    }, paths), false);
    assert.equal(readCoverage(key, paths), undefined);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("appendPayload binds sidecar and every payload event under one generation lock", () => {
  const paths = freshPaths();
  const key = "atomic-payload";
  try {
    const events = [mechanism("a.ts"), mechanism("b.ts")];
    const result = appendPayload(key, events, {
      agent: "codex", paths: ["a.ts", "b.ts"], candidateCount: 2,
      candidateCountExact: true, pathsComplete: true,
    }, paths);
    assert.deepEqual(result, [true, true]);
    assert.deepEqual(readBatch(key, paths).map((event) => event.kind === "mechanism" ? event.path : event.kind), ["a.ts", "b.ts"]);
    const coverage = readCoverage(key, paths);
    assert.equal(coverage?.candidateCount, 2);
    assert.equal(coverage?.pathsComplete, true);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("claim coverage must be owned by claim generation before annotation trusts it", async () => {
  const paths = freshPaths();
  const key = "forged-claim-coverage";
  try {
    assert.equal(appendEvent(key, mechanism("real.ts"), paths), true);
    const claim = claimBatch(key, paths);
    assert.ok(claim);
    const forged = {
      v: 1, agent: "codex", paths: ["forged.ts"],
      identityHashes: [pathIdentityHash("forged.ts", { platform: "unknown" })],
      candidateCount: 1, candidateCountExact: true, pathsComplete: true, payloads: 1,
    };
    writeFileSync(join(paths.spoolDir, `${key}.claim.${claim!.id}.coverage.json`), JSON.stringify(forged));
    const triple = await annotateBatch(key, { paths, claim, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.deepEqual(triple.mechanism.files.map((file) => file.path), ["real.ts"]);
    assert.equal(triple.mechanism.coverageStatus, "unknown");
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("origin-platform canonical identity hash survives a reader platform change", () => {
  const identity = "/repo/src/Foo.ts";
  const linuxHash = pathIdentityHash(identity, { platform: "linux", canonical: true });
  assert.equal(pathIdentityHash(identity, { platform: "win32", canonical: true }), linuxHash);
  assert.notEqual(pathIdentityHash(identity, { platform: "win32" }), linuxHash);
  const record = completeTriple({
    platform: "linux",
    cwd: "/repo",
    mechanism: {
      files: [{ path: "src/Foo.ts", identityHash: linuxHash, plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  }) as unknown as MemoryRecord;
  assert.equal(whyFileEvidence([record], "src/Foo.ts").matches.length, 1);
});

test("memory parser never trusts a hostile array iterator", () => {
  const hostile = <T>(values: readonly T[]): T[] => {
    const array = [...values] as T[];
    Object.defineProperty(array, Symbol.iterator, {
      configurable: true,
      get() { throw new Error("hostile iterator"); },
    });
    return array;
  };
  const failure = {
    kind: "failure", id: "failure-iterator", ts: 1, cwd: "/repo", cmd: "false", exitCode: 1,
    fingerprint: "0123456789abcdef", signature: hostile(["error"]), excerpt: "error",
  };
  assert.doesNotThrow(() => parseMemoryRecord(failure));
  assert.equal(parseMemoryRecord(failure)?.kind, "failure");
  const triple = completeTriple({
    mechanism: {
      files: hostile([{ path: "src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }]),
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  });
  assert.doesNotThrow(() => parseMemoryRecord(triple));
  assert.equal(parseMemoryRecord(triple)?.kind, "triple");
});

test("triple writer normalizes unsafe timestamps before durable append", () => {
  const paths = freshPaths();
  try {
    const record = recordTriple({
      agent: "codex", cwd: "/repo", mechanism: { files: [], truncatedFiles: 0 },
      ts: Number.NaN,
    }, paths);
    assert.ok(Number.isSafeInteger(record.ts) && record.ts >= 0);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

test("durable nested arrays reject aggregate-byte amplification before projection", () => {
  const signature = Array.from({ length: 256 }, () => "x".repeat(1_024));
  const failure = {
    kind: "failure", id: "nested-bytes", ts: 1, cwd: "/repo", cmd: "false", exitCode: 1,
    fingerprint: "fp", signature, excerpt: "failure",
  };
  const fix = {
    kind: "fix", id: "nested-fix", ts: 2, cwd: "/repo", cmd: "true",
    failureIds: ["nested-bytes"],
    links: Array.from({ length: 256 }, () => ({ id: "x".repeat(1_024), basis: "signature" })),
  };
  assert.equal(parseMemoryRecord(failure), undefined);
  assert.equal(parseMemoryRecord(fix), undefined);
  assert.doesNotThrow(() => projectMemoryRecord(fix as never, "sanitized", true));
});
