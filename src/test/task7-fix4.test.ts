import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseClaudeHookPayload } from "../agent/adapters/claude-code.js";
import { parseCodexHookPayload } from "../agent/adapters/codex.js";
import { annotateBatch } from "../agent/annotate.js";
import { appendEvent } from "../agent/spool.js";
import { agentEvent } from "../commands/agent-hook.js";
import { boundTripleMechanism, canonicalPath, parseMemoryRecord, type MemoryRecord, type TripleRecord } from "../core/memory-read.js";
import { whyFileEvidence, type MemoryQueries } from "../core/memory-query.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { createToolRegistry } from "../mcp/tools.js";
import { projectKnowledgeHits } from "../mcp/privacy.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

function freshPaths(): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-task7-fix4-"));
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

async function hook(
  adapter: "claude-code" | "codex",
  payload: unknown,
  paths: RockyPaths,
  append?: (key: string, event: Parameters<typeof appendEvent>[1], target?: RockyPaths) => boolean,
): Promise<void> {
  const result = await captureStdout(() => agentEvent(adapter, {
    paths,
    stdin: async () => JSON.stringify(payload),
    appendEvent: append,
    spawnAnnotate: () => {},
  }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
}

function claudeMultiEdit(count: number, session = "session", turn = "turn"): Record<string, unknown> {
  return {
    session_id: session,
    prompt_id: turn,
    hook_event_name: "PostToolUse",
    tool_name: "MultiEdit",
    tool_input: {
      edits: Array.from({ length: count }, (_, index) => ({
        file_path: `src/claude-${index}.ts`,
        new_string: `value-${index}`,
      })),
    },
  };
}

function codexPatch(count: number, session = "session", turn = "turn"): Record<string, unknown> {
  return {
    event: "PostToolUse",
    session_id: session,
    turn_id: turn,
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        ...Array.from({ length: count }, (_, index) => `*** Update File: src/codex-${index}.ts`),
        "*** End Patch",
      ].join("\n"),
    },
  };
}

test("300 unique Claude and Codex paths retain exact durable omission 292", async () => {
  for (const [adapter, payload] of [
    ["claude-code" as const, claudeMultiEdit(300, "claude-300", "turn-300")],
    ["codex" as const, codexPatch(300, "codex-300", "turn-300")],
  ] as const) {
    const paths = freshPaths();
    try {
      const parsed = adapter === "claude-code"
        ? parseClaudeHookPayload(payload, 1)
        : parseCodexHookPayload(payload, 1);
      assert.ok(parsed?.action === "append");
      assert.equal(parsed.truncatedFiles, 236);
      assert.equal(parsed.coveragePaths?.length, 256);
      await hook(adapter, payload, paths);
      const triple = await annotateBatch(parsed.key, { paths, git: () => undefined, queueLabel: () => {} });
      assert.ok(triple);
      assert.equal(triple.mechanism.files.length, 8);
      assert.equal(triple.mechanism.truncatedFiles, 292);
      assert.equal(triple.mechanism.coverageStatus, "truncated");
    } finally {
      rmSync(paths.home, { recursive: true, force: true });
    }
  }
});

test("turn-level coverage survives first, middle, and last single-file append loss", async () => {
  for (const lost of [0, 1, 2]) {
    const paths = freshPaths();
    const payloads = ["a.ts", "b.ts", "c.ts"].map((path, index) => ({
      session_id: "loss-session",
      prompt_id: `loss-${lost}`,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path, new_string: `value-${index}` },
    }));
    let calls = 0;
    try {
      const append = (key: string, event: Parameters<typeof appendEvent>[1], target?: RockyPaths): boolean => {
        const shouldLose = calls++ === lost;
        return shouldLose ? false : appendEvent(key, event, target);
      };
      const parsed = parseClaudeHookPayload(payloads[0], 1);
      assert.ok(parsed?.action === "append");
      for (const payload of payloads) await hook("claude-code", payload, paths, append);
      const triple = await annotateBatch(parsed.key, { paths, git: () => undefined, queueLabel: () => {} });
      assert.ok(triple);
      assert.deepEqual(triple.mechanism.files.map((file) => file.path).sort(), ["a.ts", "b.ts", "c.ts"]);
      assert.equal(triple.mechanism.truncatedFiles, 0);
      assert.equal(triple.mechanism.coverageStatus, "complete");
    } finally {
      rmSync(paths.home, { recursive: true, force: true });
    }
  }
});

test("conflicting hashes for one ordinary path do not duplicate or displace a real path", () => {
  const bounded = boundTripleMechanism({
    files: [
      { path: "src/a.ts", plusMinus: [1, 0], props: ["first"], provenance: "tool-observed", identityHash: "0123456789abcdef0123456789abcdef" },
      { path: "src/a.ts", plusMinus: [2, 0], props: ["second"], provenance: "tool-observed", identityHash: "fedcba9876543210fedcba9876543210" },
      { path: "src/real.ts", plusMinus: [3, 0], props: ["real"], provenance: "tool-observed" },
    ],
    truncatedFiles: 0,
    coverageStatus: "complete",
  });
  assert.deepEqual(bounded.files.map((file) => file.path), ["src/a.ts", "src/real.ts"]);
  assert.equal(bounded.truncatedFiles, 0);
  assert.equal(bounded.coverageStatus, "unknown");
});

test("redacted cwd still unifies absolute and relative turn paths", async () => {
  const paths = freshPaths();
  const key = "redacted-cwd";
  const cwd = "/home/password=secret/repo";
  try {
    assert.equal(appendEvent(key, {
      v: 1, agent: "codex", kind: "intent", ts: 1, cwd, text: "edit file",
      baseline: { status: "unknown" },
    }, paths), true);
    assert.equal(appendEvent(key, {
      v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit",
      path: `${cwd}/src/a.ts`, provenance: "tool-observed",
    }, paths), true);
    assert.equal(appendEvent(key, {
      v: 1, agent: "codex", kind: "mechanism", ts: 3, tool: "Edit",
      path: "src/a.ts", provenance: "tool-observed",
    }, paths), true);
    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
    assert.equal(triple.mechanism.files.length, 1);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
});

function durableTriple(ts: number, agent: unknown = "codex"): Record<string, unknown> {
  return {
    kind: "triple", id: "triple-scalar", ts, cwd: "/work", schemaV: 1, agent, origin: "agent-hook",
    mechanism: {
      files: [{ path: "src/a.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
}

test("durable triple parser rejects unsafe timestamps", () => {
  for (const ts of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseMemoryRecord(durableTriple(ts)), undefined, `timestamp ${String(ts)}`);
  }
  assert.equal(parseMemoryRecord(durableTriple(Number.POSITIVE_INFINITY, "evil")), undefined);
});

function hostileMemory(): MemoryQueries {
  const malformedFailure = {
    kind: "failure", id: 42, ts: -1, cwd: "/work", cmd: "bad", exitCode: Number.NaN,
    fingerprint: "fp", signature: [], excerpt: "bad", origin: "evil",
  };
  return {
    recall: () => [{ failure: malformedFailure as never, score: Number.NaN } as never],
    recentFailures: () => [{ failure: malformedFailure as never } as never],
    stats: () => ({
      failures: Number.POSITIVE_INFINITY, fixEvents: -1, resolved: Number.NaN, unresolved: -2,
      confirmedFixes: Number.MAX_SAFE_INTEGER + 1, possibleFixes: -3, triples: Number.NaN,
      notes: Number.POSITIVE_INFINITY, total: -4, giantSecret: "do-not-leak",
    } as never),
    searchKnowledge: () => [{ id: 42, ts: -1, kind: "triple", snippet: null, score: Number.NaN } as never],
    fetchRecord: () => ({ ...malformedFailure } as never),
    whyFile: () => [{ ...durableTriple(-1), mechanism: null } as never],
  };
}

test("custom MCP query boundaries fail open to bounded safe schemas", async () => {
  const registry = createToolRegistry({ exposure: "sanitized", memory: hostileMemory(), recallWithAi: disabledRecallWithAi });
  const signal = new AbortController().signal;
  const stats = await registry.call("stats", {}, signal);
  const statsKeys = Object.keys(stats.structuredContent).sort();
  assert.deepEqual(statsKeys, [
    "confirmedFixes", "coverage", "exposure", "failures", "fixEvents", "memoryCoverage",
    "memoryCoverageIncomplete", "memoryVersion", "notes", "possibleFixes", "resolved", "total", "triples", "unresolved",
  ]);
  for (const key of statsKeys.filter((entry) => entry !== "exposure")) {
    const value = stats.structuredContent[key];
    if (key === "coverage" || key === "memoryCoverage") continue;
    if (key === "memoryCoverageIncomplete") {
      assert.equal(value, true);
      continue;
    }
    if (key === "memoryVersion") {
      assert.equal(value, 1);
      continue;
    }
    assert.equal(typeof value, "number");
    assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${key} must be bounded`);
  }
  assert.equal((stats.structuredContent.memoryCoverage as { complete: boolean }).complete, false);
  assert.equal(JSON.stringify(stats.structuredContent).includes("giantSecret"), false);

  const fetch = await registry.call("fetch_record", { id: "bad" }, signal);
  assert.ok(fetch.structuredContent.error || fetch.structuredContent.record === null);

  const recall = await registry.call("recall", { query: "bad" }, signal);
  const recent = await registry.call("recent_failures", {}, signal);
  assert.deepEqual(recall.structuredContent.items, []);
  assert.deepEqual(recent.structuredContent.items, []);

  const search = await registry.call("search_knowledge", { query: "bad" }, signal);
  assert.deepEqual(search.structuredContent.items, []);

  const why = await registry.call("why_file", { path: "src/a.ts" }, signal);
  assert.equal(why.structuredContent.coverageStatus, "unknown");
  assert.equal(why.structuredContent.coverageIncomplete, true);
});

test("custom knowledge hits cannot retain complete status without canonical proof", () => {
  const projected = projectKnowledgeHits([{
    id: "unproven-complete", ts: 1, kind: "triple", snippet: "change", score: 0.5,
    source: "agent-hook", filesCovered: ["src/a.ts"], coverageStatus: "complete",
  }], "sanitized");
  assert.equal(projected.items.length, 1);
  assert.equal(projected.items[0]?.coverageStatus, "unknown");
  assert.equal(projected.items[0]?.complete, false);
});

test("whyFileEvidence skips malformed mechanism shapes without throwing", () => {
  const hostile = Object.freeze({
    kind: "triple", id: "malformed", ts: -1, cwd: "/work", schemaV: 1,
    agent: "codex", origin: "agent-hook", mechanism: null,
  });
  assert.doesNotThrow(() => {
    const evidence = whyFileEvidence(Object.freeze([hostile]) as unknown as readonly MemoryRecord[], "src/a.ts");
    assert.equal(evidence.coverage.status, "unknown");
    assert.equal(evidence.coverageIncomplete, true);
  });
});

test("explicit Linux separators are not treated as Windows UNC roots", () => {
  assert.equal(canonicalPath("//server/share", { platform: "linux" }), "/server/share");
  assert.equal(canonicalPath("//server/share", { platform: "win32" }), "//server/share");
  assert.equal(canonicalPath("/", { platform: "linux" }), "/");
  assert.equal(canonicalPath("C:", { platform: "win32" }), "c:");
  assert.equal(canonicalPath("C:/", { platform: "win32" }), "c:/");
});
