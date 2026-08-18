import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseCodexHookPayload } from "../agent/adapters/codex.js";
import { agentEvent } from "../commands/agent-hook.js";
import { MAX_EXCERPT_CHARS, MAX_RATIONALE_CHARS } from "../agent/schema.js";
import { readBatch } from "../agent/spool.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(packageRoot, "src", "test", "fixtures", "codex-hooks", name), "utf8"));

function freshPaths(): { home: string; paths: RockyPaths } {
  const home = mkdtempSync(join(tmpdir(), "rocky-codex-adapter-"));
  return { home, paths: resolveRockyPaths({ ROCKY_HOME: home }) };
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = "";
  const original = process.stdout.write;
  (process.stdout as unknown as {
    write: (chunk: string, callback?: (error?: Error) => void) => boolean;
  }).write = (chunk: string, callback?: (error?: Error) => void) => {
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

test("official notify agent-turn-complete closes with capped notify rationale", () => {
  const parsed = parseCodexHookPayload(fixture("notify-turn-complete.json"), 42);
  assert.ok(parsed && parsed.action === "close");
  assert.equal(parsed.key, "codex-th4-t9");
  assert.equal(parsed.rationale?.source, "notify");
  assert.equal(parsed.rationale?.text, "margin-top handles spacing here");
});

test("official current hook fixtures map prompt, apply_patch, and Stop", () => {
  const intent = parseCodexHookPayload(fixture("user-prompt-submit.json"), 42);
  assert.ok(intent && intent.action === "append" && intent.event.kind === "intent");
  assert.equal(intent.key, "codex-th4-t9");
  assert.equal(intent.event.text, "naikin dikit");

  const mechanism = parseCodexHookPayload(fixture("post-tool-use.json"), 42);
  assert.ok(mechanism && mechanism.action === "append" && mechanism.event.kind === "mechanism");
  assert.equal(mechanism.key, "codex-th4-t9");
  assert.equal(mechanism.event.path, "src/app.css");

  const stop = parseCodexHookPayload(fixture("stop.json"), 42);
  assert.ok(stop && stop.action === "close");
  assert.equal(stop.key, "codex-th4-t9");
  assert.equal(stop.rationale?.source, "notify");
  assert.equal(stop.rationale?.text, "margin-top handles spacing here");
});

test("modern and legacy close events normalize to one key", () => {
  const stop = parseCodexHookPayload({
    hook_event_name: "Stop",
    session_id: "th4",
    turn_id: "t9",
  }, 42);
  const notify = parseCodexHookPayload({
    type: "agent-turn-complete",
    "thread-id": "th4",
    "turn-id": "t9",
  }, 42);
  assert.ok(stop && stop.action === "close");
  assert.ok(notify && notify.action === "close");
  assert.equal(stop.key, notify.key);
});

test("modern identity aliases work but missing identity never uses fallback constants", () => {
  const base = {
    hookEventName: "UserPromptSubmit",
    sessionId: "alias-session",
    turnId: "alias-turn",
    prompt: "remember this",
  };
  const parsed = parseCodexHookPayload(base, 42);
  assert.ok(parsed && parsed.action === "append");
  assert.match(parsed.key, /^codex-alias-session-alias-turn-[a-f0-9]{16}$/);

  assert.equal(parseCodexHookPayload({ ...base, sessionId: undefined }), undefined);
  assert.equal(parseCodexHookPayload({ ...base, turnId: undefined }), undefined);
  assert.equal(parseCodexHookPayload({ ...base, sessionId: undefined, session: undefined }), undefined);
  assert.equal(parseCodexHookPayload({ ...base, turnId: undefined, turn: undefined }), undefined);
  assert.equal(parseCodexHookPayload({
    type: "agent-turn-complete",
    "thread-id": "",
    "turn-id": "t9",
  }), undefined);
  assert.equal(parseCodexHookPayload({
    type: "agent-turn-complete",
    "thread-id": "th4",
    "turn-id": "",
  }), undefined);
  assert.equal(parseCodexHookPayload({
    type: "agent-turn-complete",
    "thread-id": "th4",
    prompt_id: "p1",
  }), undefined);
});

test("compatible modern and notify identity aliases are accepted", () => {
  const modern = parseCodexHookPayload({
    event: "UserPromptSubmit",
    "session-id": "th4",
    "turn-id": "t9",
    prompt: "alias prompt",
  }, 42);
  const notify = parseCodexHookPayload({
    type: "agent-turn-complete",
    thread_id: "th4",
    turn_id: "t9",
  }, 42);
  assert.ok(modern && modern.action === "append");
  assert.equal(modern.key, "codex-th4-t9");
  assert.ok(notify && notify.action === "close");
  assert.equal(notify.key, "codex-th4-t9");
});

test("apply_patch extracts first Update, Add, and Delete path without executing command", () => {
  const command = [
    "*** Begin Patch",
    "*** Update File: first.css",
    "@@",
    "*** Add File: second.ts",
    "*** Delete File: third.js",
    "*** End Patch",
  ].join("\n");
  const parsed = parseCodexHookPayload({
    hook_event_name: "PostToolUse",
    session_id: "s",
    turn_id: "t",
    tool_name: "apply_patch",
    tool_input: { command },
  }, 42);
  assert.ok(parsed && parsed.action === "append" && parsed.event.kind === "mechanism");
  assert.equal(parsed.event.path, "first.css");

  for (const [marker, path] of [["*** Add File:", "new.ts"], ["*** Delete File:", "old.ts"]] as const) {
    const result = parseCodexHookPayload({
      hook_event_name: "PostToolUse",
      session_id: "s",
      turn_id: "t",
      tool_name: "apply_patch",
      tool_input: { command: `*** Begin Patch\n${marker} ${path}\n*** End Patch` },
    }, 42);
    assert.ok(result && result.action === "append" && result.event.kind === "mechanism");
    assert.equal(result.event.path, path);
  }
});

test("apply_patch emits every file marker and deduplicates paths", () => {
  const command = [
    "*** Begin Patch",
    "*** Update File: first.css",
    "@@",
    "*** Add File: second.ts",
    "*** Delete File: third.js",
    "*** Update File: first.css",
    "*** End Patch",
  ].join("\n");
  const parsed = parseCodexHookPayload({
    hook_event_name: "PostToolUse",
    session_id: "s",
    turn_id: "t",
    tool_name: "apply_patch",
    tool_input: { command },
  }, 42);
  assert.ok(parsed && parsed.action === "append");
  assert.deepEqual(parsed.events.filter((event) => event.kind === "mechanism").map((event) => event.path), [
    "first.css", "second.ts", "third.js",
  ]);
});

test("apply_patch emits ten unique paths so annotate can disclose triple cap overflow", () => {
  const command = [
    "*** Begin Patch",
    ...Array.from({ length: 10 }, (_, index) => `*** Update File: file-${index}.ts`),
    "*** End Patch",
  ].join("\n");
  const parsed = parseCodexHookPayload({
    hook_event_name: "PostToolUse",
    session_id: "s",
    turn_id: "t",
    tool_name: "apply_patch",
    tool_input: { command },
  }, 42);
  assert.ok(parsed && parsed.action === "append");
  assert.equal(parsed.events.filter((event) => event.kind === "mechanism").length, 10);
});

test("legacy edit aliases and first-edit aliases map one mechanism", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "write_file", "edit_file"]) {
    const input = tool === "MultiEdit"
      ? { edits: [{ file_path: "first.ts", content: "first" }, { file_path: "second.ts" }] }
      : { path: "src/app.ts", content: "changed" };
    const parsed = parseCodexHookPayload({
      hook_event_name: "PostToolUse",
      session_id: "s",
      turn_id: "t",
      tool_name: tool,
      tool_input: input,
    }, 42);
    assert.ok(parsed && parsed.action === "append" && parsed.event.kind === "mechanism");
    assert.equal(parsed.event.path, tool === "MultiEdit" ? "first.ts" : "src/app.ts");
  }
});

test("unsupported tools, unparseable edits, malformed nested records, and unknown events fail open", () => {
  const base = { hook_event_name: "PostToolUse", session_id: "s", turn_id: "t" };
  assert.equal(parseCodexHookPayload({ ...base, tool_name: "Shell", tool_input: { command: "*** Update File: x" } }), undefined);
  assert.equal(parseCodexHookPayload({ ...base, tool_name: "apply_patch", tool_input: { command: "echo '*** Update File: x'" } }), undefined);
  assert.equal(parseCodexHookPayload({ ...base, tool_name: "apply_patch", tool_input: { command: "not a patch" } }), undefined);
  assert.equal(parseCodexHookPayload({ ...base, tool_name: "Edit", tool_input: [] }), undefined);
  assert.equal(parseCodexHookPayload({ ...base, tool_name: "Edit", tool_input: { edits: [null] } }), undefined);
  assert.equal(parseCodexHookPayload({ ...base, tool_name: "Edit", tool_input: { file_path: { nested: true } } }), undefined);
  assert.equal(parseCodexHookPayload({ hook_event_name: "Unknown", session_id: "s", turn_id: "t" }), undefined);
  assert.equal(parseCodexHookPayload({ type: "something-else", "thread-id": "s", "turn-id": "t" }), undefined);
  assert.equal(parseCodexHookPayload([]), undefined);
  assert.equal(parseCodexHookPayload(null), undefined);
  assert.equal(parseCodexHookPayload(7), undefined);
});

test("current Stop rationale is capped and marked notify", () => {
  const parsed = parseCodexHookPayload({
    hook_event_name: "Stop",
    session_id: "s",
    turn_id: "t",
    last_assistant_message: "r".repeat(MAX_RATIONALE_CHARS + 20),
  }, 42);
  assert.ok(parsed && parsed.action === "close" && parsed.rationale);
  assert.equal(parsed.rationale.source, "notify");
  assert.equal(parsed.rationale.text.length, MAX_RATIONALE_CHARS);
});

test("mechanism excerpt is bounded by parseAgentEvent", () => {
  const parsed = parseCodexHookPayload({
    hook_event_name: "PostToolUse",
    session_id: "s",
    turn_id: "t",
    tool_name: "Edit",
    tool_input: { filename: "x.ts", content: "e".repeat(MAX_EXCERPT_CHARS + 20) },
  }, 42);
  assert.ok(parsed && parsed.action === "append" && parsed.event.kind === "mechanism");
  assert.equal(parsed.event.excerpt?.length, MAX_EXCERPT_CHARS);
});

test("agentEvent accepts modern Codex stdin, appends, prints exact {}, and returns zero", async () => {
  const { home, paths } = freshPaths();
  try {
    const result = await captureStdout(() => agentEvent("codex", {
      stdin: async () => JSON.stringify(fixture("user-prompt-submit.json")),
      paths,
      now: () => 42,
    }));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.equal(readBatch("codex-th4-t9", paths).length, 1);
    assert.equal(existsSync(paths.memory), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agentEvent prefers legacy final argv payload, closes, and spawns once", async () => {
  const { home, paths } = freshPaths();
  const spawned: string[] = [];
  try {
    const result = await captureStdout(() => agentEvent("codex", {
      argvPayload: JSON.stringify(fixture("notify-turn-complete.json")),
      stdin: async () => JSON.stringify(fixture("user-prompt-submit.json")),
      spawnAnnotate: (key) => spawned.push(key),
      paths,
      now: () => 42,
    }));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.deepEqual(spawned, ["codex-th4-t9"]);
    const events = readBatch("codex-th4-t9", paths);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "rationale");
    assert.equal(events[0]?.kind === "rationale" ? events[0].source : undefined, "notify");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agentEvent malformed Codex input still emits exact {}, returns zero, and does not spool", async () => {
  const { home, paths } = freshPaths();
  try {
    const result = await captureStdout(() => agentEvent("codex", {
      argvPayload: "not json",
      stdin: async () => "also not used",
      paths,
    }));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.equal(existsSync(paths.memory), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI Codex modern stdin dispatch appends and emits exact {}, while legacy argv closes", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-codex-cli-"));
  try {
    const modern = spawnSync(process.execPath, [entry, "hook", "agent-event", "codex"], {
      cwd: packageRoot,
      env: { ...process.env, ROCKY_HOME: home },
      encoding: "utf8",
      input: JSON.stringify(fixture("user-prompt-submit.json")),
      // Hang guard only, not an assertion; generous for a loaded CI runner
      // (see cli-grammar.test.ts's CLI_HANG_GUARD_MS for the same reasoning).
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(modern.status, 0, modern.stderr);
    assert.equal(modern.stdout, "{}");
    assert.equal(modern.stderr, "");
    const paths = resolveRockyPaths({ ROCKY_HOME: home });
    assert.equal(readBatch("codex-th4-t9", paths).length, 1);

    const legacy = spawnSync(process.execPath, [
      entry,
      "hook",
      "agent-event",
      "codex",
      JSON.stringify(fixture("notify-turn-complete.json")),
    ], {
      cwd: packageRoot,
      env: { ...process.env, ROCKY_HOME: home },
      encoding: "utf8",
      input: "must be ignored",
      // Hang guard only, not an assertion; generous for a loaded CI runner
      // (see cli-grammar.test.ts's CLI_HANG_GUARD_MS for the same reasoning).
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(legacy.stdout, "{}");
    assert.equal(legacy.stderr, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
