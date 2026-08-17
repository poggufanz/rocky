import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseClaudeHookPayload } from "../agent/adapters/claude-code.js";
import { parseCodexHookPayload } from "../agent/adapters/codex.js";
import { annotateBatch } from "../agent/annotate.js";
import { boundTripleMechanism, boundTripleRecord, canonicalPath, type MemoryRecord, type TripleRecord } from "../core/memory-read.js";
import { whyFileEvidence, type KnowledgeSearchHit, type MemoryQueries, type WhyFileEvidence } from "../core/memory-query.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { agentEvent } from "../commands/agent-hook.js";
import { createToolRegistry } from "../mcp/tools.js";
import { projectKnowledgeHits } from "../mcp/privacy.js";
import { appendEvent, readBatch } from "../agent/spool.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

function legacyTriple(): TripleRecord {
  return {
    kind: "triple", id: "legacy-triple", ts: 1, cwd: "/work", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: "legacy change" },
    mechanism: {
      files: [{ path: "src/legacy.ts", plusMinus: [1, 0], props: ["legacy"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured",
    },
  };
}

function memoryWith(overrides: Partial<MemoryQueries>): MemoryQueries {
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

function freshPaths(): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-task7-fix3-"));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = "";
  const original = process.stdout.write;
  (process.stdout as unknown as { write: (chunk: string, callback?: (error?: Error) => void) => boolean }).write = (chunk, callback) => {
    out += chunk;
    callback?.();
    return true;
  };
  try {
    return { code: await fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

test("MCP why_file bounds and validates hostile possible evidence without throwing", async () => {
  const evidence: WhyFileEvidence = {
    matches: [],
    possible: [
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `possible-${index}`,
        ts: index,
        source: "agent-hook" as const,
        reason: "path_may_be_omitted" as const,
      })),
      { id: "\u0000bad", ts: Number.POSITIVE_INFINITY, source: "evil", reason: "nope" },
    ] as unknown as WhyFileEvidence["possible"],
    coverage: { status: "unknown" as const, complete: false, filesCovered: 0, truncatedFiles: 0 },
    coverageIncomplete: true,
  };
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: memoryWith({ whyFileEvidence: () => evidence }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: "src/maybe.ts", limit: 10 }, new AbortController().signal);
  const payload = result.structuredContent as Record<string, unknown>;
  assert.ok(Array.isArray(payload.possible));
  assert.ok((payload.possible as unknown[]).length <= 10);
  assert.equal(payload.coverageIncomplete, true);
  assert.equal(typeof payload.truncated, "boolean");
  assert.ok(Buffer.byteLength(result.content[0]!.text, "utf8") <= 512 * 1024);
});

test("MCP why_file possible evidence forces conservative coverage", async () => {
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: memoryWith({ whyFileEvidence: () => ({
      matches: [],
      possible: [{ id: "maybe", ts: 1, source: "agent-hook", reason: "path_may_be_omitted" }],
      coverage: { status: "complete", complete: true, filesCovered: 1, truncatedFiles: 0 },
      coverageIncomplete: false,
    }) }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: "src/maybe.ts" }, new AbortController().signal);
  const payload = result.structuredContent as Record<string, unknown>;
  assert.equal(payload.coverageStatus, "unknown");
  assert.equal(payload.coverageIncomplete, true);
  assert.equal((payload.possible as unknown[]).length, 1);
  assert.equal(payload.truncated, false);
});

test("MCP why_file bounds hostile custom matches before response projection", async () => {
  const matches = Array.from({ length: 20_000 }, (_, index) => ({
    ...legacyTriple(), id: `match-${index}`,
    mechanism: {
      ...legacyTriple().mechanism,
      coverageStatus: "unknown" as const,
    },
  }));
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: memoryWith({ whyFileEvidence: () => ({
      matches,
      possible: [],
      coverage: { status: "unknown", complete: false, filesCovered: 1, truncatedFiles: 0 },
      coverageIncomplete: true,
    }) }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: "src/legacy.ts", limit: 1 }, new AbortController().signal);
  assert.equal((result.structuredContent.items as unknown[]).length, 1);
  assert.equal(result.structuredContent.truncated, false);
});

test("legacy custom MemoryQueries keep missing triple coverage conservatively unknown", async () => {
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: memoryWith({ whyFile: () => [legacyTriple()] }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: "src/legacy.ts" }, new AbortController().signal);
  const payload = result.structuredContent as Record<string, unknown>;
  const coverage = payload.coverage as Record<string, unknown>;
  assert.equal(coverage.status, "unknown");
  assert.equal(coverage.complete, false);
  assert.equal(payload.coverageStatus, "unknown");
  assert.equal(payload.coverageIncomplete, true);
  const items = payload.items as Array<Record<string, unknown>>;
  assert.equal(items[0]?.coverageStatus, "unknown");
  assert.equal(items[0]?.complete, false);
});

test("MCP legacy why fallback preserves origin-platform path identity", async () => {
  const record: TripleRecord = {
    ...legacyTriple(),
    id: "windows-triple",
    cwd: "C:/Work",
    platform: "win32",
    mechanism: {
      files: [{ path: "src/Foo.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: memoryWith({ whyFile: () => [record] }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: "C:/work/src/foo.ts" }, new AbortController().signal);
  const payload = result.structuredContent as Record<string, unknown>;
  assert.equal((payload.items as unknown[]).length, 1);
});

test("MCP legacy why fallback discloses missing-platform coverage conservatively", async () => {
  const record: TripleRecord = {
    ...legacyTriple(),
    id: "complete-unrelated",
    mechanism: {
      files: [{ path: "src/known.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: memoryWith({ whyFile: () => [record] }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: "src/missing.ts" }, new AbortController().signal);
  const payload = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(payload.possible, []);
  assert.equal(payload.coverageIncomplete, true);
  assert.equal(payload.coverageStatus, "unknown");
});

test("MCP custom why evidence cannot associate an unrelated match", async () => {
  const record: TripleRecord = {
    ...legacyTriple(),
    id: "forged-match",
    mechanism: {
      files: [{ path: "src/known.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: memoryWith({
      whyFileEvidence: () => ({
        matches: [record], possible: [],
        coverage: { status: "complete", complete: true, filesCovered: 1, truncatedFiles: 0 },
        coverageIncomplete: false,
      }),
    }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: "src/missing.ts" }, new AbortController().signal);
  const payload = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(payload.items, []);
  assert.equal(payload.coverageIncomplete, true);
});

test("MCP legacy why fallback refuses ambiguous suffix rationale", async () => {
  const suffix = (id: string, path: string): TripleRecord => ({
    ...legacyTriple(), id,
    mechanism: {
      files: [{ path, plusMinus: [1, 0], props: [id], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  });
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: memoryWith({ whyFile: () => [
      suffix("one", "one/src/missing.ts"),
      suffix("two", "two/src/missing.ts"),
    ] }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await registry.call("why_file", { path: "src/missing.ts" }, new AbortController().signal);
  const payload = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(payload.items, []);
  assert.equal(payload.coverageStatus, "unknown");
  assert.equal(payload.coverageIncomplete, true);
});

test("knowledge projection skips forged top-level fields and clamps scores without mutating frozen input", () => {
  const forged = Object.freeze({
    id: 42,
    ts: Number.POSITIVE_INFINITY,
    kind: "corrupt",
    snippet: null,
    score: Number.NaN,
    agent: "intruder",
    source: { leak: true },
  });
  const valid = Object.freeze({
    id: "valid", ts: 10, kind: "triple" as const, snippet: "remember", score: 9,
    agent: "codex" as const, source: "agent-hook", filesCovered: Object.freeze(["src/a.ts"]),
    truncatedFiles: 1, coverageStatus: "complete" as const, complete: true,
  });
  const projected = projectKnowledgeHits(
    Object.freeze([forged, valid]) as unknown as readonly KnowledgeSearchHit[],
    "sanitized",
  );
  assert.equal(projected.items.length, 1);
  const item = projected.items[0]!;
  assert.equal(item.id, "valid");
  assert.equal(item.score, 1);
  assert.equal(item.kind, "triple");
  assert.equal(item.complete, false);
  assert.equal(item.coverageStatus, "truncated");
  assert.equal(Object.isFrozen(valid.filesCovered), true);

  const nonTripleCoverage = projectKnowledgeHits([{
    id: "failure", ts: 1, kind: "failure", snippet: "failure", score: 0.5,
    source: "run", filesCovered: ["src/a.ts"], truncatedFiles: 0, coverageStatus: "complete", complete: true,
  }], "sanitized").items[0];
  assert.equal(nonTripleCoverage?.coverageStatus, "unknown");
  assert.equal(nonTripleCoverage?.complete, false);

  const caseDistinct = ["Case.ts", "cASE.ts", "caSE.ts", "casE.ts", "CAse.ts", "CaSe.ts", "CAsE.ts", "cASe.ts", "CaSE.ts"]
    .map((file) => `src/${file}`);
  const caseProjected = projectKnowledgeHits([{
    id: "case-distinct", ts: 11, kind: "triple", snippet: "case", score: 0.5,
    source: "agent-hook", filesCovered: caseDistinct, truncatedFiles: 0,
    coverageStatus: "complete", complete: true,
  }], "raw").items[0];
  assert.equal(caseProjected?.filesCovered?.length, 8);
  assert.equal(caseProjected?.truncatedFiles, 1);
  assert.equal(caseProjected?.coverageStatus, "truncated");
  assert.equal(caseProjected?.complete, false);

  const mixedSpelling = projectKnowledgeHits([{
    id: "mixed-spelling", ts: 12, kind: "triple", snippet: "mixed", score: 0.5,
    source: "agent-hook", filesCovered: ["C:/work/src/a.ts", "src/a.ts"], truncatedFiles: 0,
    coverageStatus: "complete", complete: true,
  }], "raw").items[0];
  assert.equal(mixedSpelling?.coverageStatus, "unknown");
  assert.equal(mixedSpelling?.complete, false);

  const invalidEnum = projectKnowledgeHits([{
    id: "invalid-source", ts: 13, kind: "triple", snippet: "bad source", score: 0.5,
    source: "spoof", filesCovered: ["src/a.ts"], truncatedFiles: 0,
    coverageStatus: "complete", complete: true,
  }], "sanitized");
  assert.deepEqual(invalidEnum.items, []);
});

test("duplicate identity hashes preserve distinct paths and downgrade coverage", () => {
  const files = Array.from({ length: 20 }, (_, index) => ({
    path: `src/hash-${index}.ts`, plusMinus: [1, 0] as [number, number], props: ["edit"],
    provenance: "tool-observed" as const, identityHash: "0123456789abcdef0123456789abcdef",
  }));
  const bounded = boundTripleMechanism({
    files, truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
  });
  assert.equal(bounded.files.length, 8);
  assert.equal(bounded.truncatedFiles, 12);
  assert.equal(bounded.coverageStatus, "unknown");

  const namespace = boundTripleMechanism({
    files: [
      { path: "0123456789abcdef0123456789abcdef", plusMinus: [0, 0], props: [] },
      { path: "src/distinct.ts", plusMinus: [0, 0], props: [], identityHash: "0123456789abcdef0123456789abcdef" },
    ], truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
  });
  assert.equal(namespace.files.length, 2);
  assert.equal(namespace.coverageStatus, "complete");

  const longPath = boundTripleMechanism({
    files: [
      { path: `${"x".repeat(1_025)}.ts`, plusMinus: [1, 0], props: [] },
      { path: "src/retained.ts", plusMinus: [1, 0], props: [] },
    ], truncatedFiles: 0, coverageStatus: "complete",
  });
  assert.equal(longPath.files.length, 1);
  assert.equal(longPath.coverageStatus, "unknown");
});

test("oversized triple cwd cannot prove a why-file match", () => {
  const record: TripleRecord = {
    ...legacyTriple(),
    id: "oversized-cwd",
    cwd: "c".repeat(64 * 1024),
    platform: "linux",
    mechanism: {
      files: [{ path: "src/legacy.ts", plusMinus: [1, 0], props: ["legacy"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const evidence = whyFileEvidence([record], "src/legacy.ts", 5, 10);
  assert.deepEqual(evidence.matches, []);
  assert.equal(evidence.coverageIncomplete, true);
  assert.equal(evidence.coverage.status, "unknown");
});

test("Codex apply_patch emits Move to destinations with other patch markers", () => {
  const parsed = parseCodexHookPayload({
    event: "PostToolUse", session_id: "session", turn_id: "turn", tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: src/old.ts",
        "*** Move to: src/new.ts",
        "*** Add File: src/add.ts",
        "*** Delete File: src/delete.ts",
        "*** End Patch",
      ].join("\n"),
    },
  }, 1_700_000_000_000);
  assert.ok(parsed?.action === "append");
  const paths = parsed.events.filter((event) => event.kind === "mechanism").map((event) => event.path);
  assert.deepEqual(paths, ["src/old.ts", "src/new.ts", "src/add.ts", "src/delete.ts"]);
});

test("canonical path identity preserves roots, drive-relative spelling, and explicit platform case", () => {
  const canonicalWithOptions = canonicalPath as unknown as (value: string, options?: { platform?: NodeJS.Platform | "unknown" }) => string;
  assert.equal(canonicalPath("/"), "/");
  assert.equal(canonicalPath("//"), "/");
  assert.equal(canonicalPath("/a"), "/a");
  assert.equal(canonicalWithOptions("//server/share", { platform: "win32" }), "//server/share");
  assert.equal(canonicalWithOptions("C:/", { platform: "win32" }), "c:/");
  assert.equal(canonicalWithOptions("C:", { platform: "win32" }), "c:");
  assert.equal(canonicalWithOptions("C:folder", { platform: "win32" }), "c:folder");
  assert.equal(canonicalWithOptions("/Work/Case.ts", { platform: "linux" }), "/Work/Case.ts");
});

test("ordinary multi-file adapter coverage survives a failed first append and long paths cannot claim complete", async () => {
  const parsed = parseClaudeHookPayload({
    session_id: "session", prompt_id: "ordinary", hook_event_name: "PostToolUse", tool_name: "MultiEdit",
    tool_input: { edits: [{ file_path: "a.ts", new_string: "a" }, { file_path: "b.ts", new_string: "b" }] },
  }, 10);
  assert.ok(parsed && parsed.action === "append");
  assert.deepEqual(parsed.coveragePaths, ["a.ts", "b.ts"]);
  assert.equal(parsed.coveragePathsComplete, true);

  const oversizedCoverage = parseClaudeHookPayload({
    session_id: "session", prompt_id: "coverage-cap", hook_event_name: "PostToolUse", tool_name: "MultiEdit",
    tool_input: { edits: Array.from({ length: 300 }, (_, index) => ({ file_path: `cap-${index}.ts`, new_string: "x" })) },
  }, 10);
  assert.ok(oversizedCoverage && oversizedCoverage.action === "append");
  assert.equal(oversizedCoverage?.coveragePaths?.length, 256);
  assert.equal(oversizedCoverage?.coveragePathsComplete, false);
  assert.equal(oversizedCoverage?.truncatedFiles, 236);

  const paths = freshPaths();
  let attempts = 0;
  const captured = await captureStdout(() => agentEvent("claude-code", {
    paths,
    stdin: async () => JSON.stringify({
      session_id: "session", prompt_id: "ordinary", hook_event_name: "PostToolUse", tool_name: "MultiEdit",
      tool_input: { edits: [{ file_path: "a.ts", new_string: "a" }, { file_path: "b.ts", new_string: "b" }] },
    }),
    appendEvent: (key, event, target) => {
      attempts += 1;
      if (attempts === 1) return false;
      return appendEvent(key, event, target);
    },
  }));
  try {
    assert.equal(captured.out, "{}");
    const events = readBatch(parsed.key, paths).filter((event) => event.kind === "mechanism");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.kind === "mechanism" ? events[0].coveragePaths : undefined, ["a.ts", "b.ts"]);
    assert.equal(events[0]?.kind === "mechanism" ? events[0].coveragePathsComplete : undefined, true);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }

  const longPath = `${"x".repeat(1_025)}.ts`;
  const malformed = parseClaudeHookPayload({
    session_id: "session", prompt_id: "long", hook_event_name: "PostToolUse", tool_name: "MultiEdit",
    tool_input: { edits: [{ file_path: longPath, new_string: "x" }, { file_path: "valid.ts", new_string: "v" }] },
  }, 10);
  assert.ok(malformed === undefined || (malformed.action === "append" && malformed.coveragePathsComplete === false));
});

test("why-file evidence is unknown without triples and never silently chooses ambiguous suffixes", () => {
  const empty = whyFileEvidence([], "src/missing.ts");
  assert.equal(empty.matches.length, 0);
  assert.equal(empty.coverageIncomplete, true);
  assert.equal(empty.coverage.status, "unknown");

  const suffix = (id: string, path: string, status: "complete" | "unknown"): TripleRecord => ({
    ...legacyTriple(), id, mechanism: {
      files: [{ path, plusMinus: [1, 0], props: [id], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: status,
    },
  });
  const ambiguous = whyFileEvidence([
    suffix("one", "one/src/missing.ts", "complete"),
    suffix("two", "two/src/missing.ts", "complete"),
  ], "src/missing.ts");
  assert.deepEqual(ambiguous.matches, []);
  assert.equal(ambiguous.coverageIncomplete, true);
  const incomplete = whyFileEvidence([suffix("unknown", "one/src/missing.ts", "unknown")], "src/missing.ts");
  assert.deepEqual(incomplete.matches, []);
  assert.equal(incomplete.possible[0]?.id, "unknown");
});

test("persisted path identity uses known cwd and origin platform without collapsing distinct POSIX case", () => {
  const record = boundTripleRecord({
    ...legacyTriple(), platform: "linux",
    cwd: "/work",
    mechanism: {
      files: [
        { path: "/work/src/a.ts", plusMinus: [1, 0], props: [] },
        { path: "src/a.ts", plusMinus: [2, 0], props: [] },
        { path: "src/A.ts", plusMinus: [3, 0], props: [] },
      ],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  } as unknown as TripleRecord);
  assert.equal(record.mechanism.files.length, 2);
  assert.deepEqual(record.mechanism.files.map((file) => file.path), ["src/a.ts", "src/A.ts"]);
});

test("annotate merges absolute and relative spellings of one turn file before the durable cap", async () => {
  const paths = freshPaths();
  const key = "absolute-relative";
  try {
    assert.equal(appendEvent(key, {
      v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "same file",
      baseline: { status: "unknown" },
    }, paths), true);
    assert.equal(appendEvent(key, {
      v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit",
      path: join(paths.home, "src", "same.ts"), provenance: "tool-observed",
    }, paths), true);
    assert.equal(appendEvent(key, {
      v: 1, agent: "codex", kind: "mechanism", ts: 3, tool: "Edit",
      path: "src/same.ts", provenance: "tool-observed",
    }, paths), true);
    const record = await annotateBatch(key, {
      paths, git: () => undefined, queueLabel: () => {},
    });
    assert.ok(record);
    assert.equal(record.mechanism.files.length, 1);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});
