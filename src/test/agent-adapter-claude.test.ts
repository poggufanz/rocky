import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MAX_RATIONALE_CHARS } from "../agent/schema.js";
import { parseClaudeHookPayload, rationaleFromTranscript } from "../agent/adapters/claude-code.js";
import { skipIfSymlinkUnavailable } from "./symlink-capability.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(packageRoot, "src", "test", "fixtures", "claude-hooks", name), "utf8"));

function tempTranscript(contents: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "rocky-transcript-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, contents);
  return { dir, path };
}

test("UserPromptSubmit becomes an intent append with session+prompt batch key", () => {
  const parsed = parseClaudeHookPayload(fixture("user-prompt-submit.json"), 42);
  assert.ok(parsed && parsed.action === "append");
  assert.equal(parsed.key, "claude-code-s1-p1");
  assert.ok(parsed.event.kind === "intent" && parsed.event.text === "naikin dikit dong buttonnya");
});

test("PostToolUse Edit becomes a mechanism append carrying new_string excerpt", () => {
  const parsed = parseClaudeHookPayload(fixture("post-tool-use-edit.json"), 42);
  assert.ok(parsed && parsed.action === "append" && parsed.event.kind === "mechanism");
  assert.equal(parsed.event.path, "src/app.css");
  assert.equal(parsed.event.excerpt, "margin-top: 8px");
});

test("Stop closes the batch and uses transcript rationale as best effort", () => {
  const transcript = tempTranscript([
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "margin fixes spacing" }] } }),
  ].join("\n") + "\n");
  try {
    const payload = { ...(fixture("stop.json") as Record<string, unknown>), transcript_path: transcript.path };
    const parsed = parseClaudeHookPayload(payload, 42);
    assert.ok(parsed && parsed.action === "close" && parsed.key === "claude-code-s1-p1");
    assert.equal(parsed.rationale?.text, "margin fixes spacing");
    assert.equal(rationaleFromTranscript("/definitely/missing.jsonl"), undefined);
  } finally {
    rmSync(transcript.dir, { recursive: true, force: true });
  }
});

test("Stop prefers current last_assistant_message over transcript fallback", () => {
  const transcript = tempTranscript(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "stale transcript rationale" }] },
  }) + "\n");
  try {
    const payload = {
      ...(fixture("stop.json") as Record<string, unknown>),
      transcript_path: transcript.path,
      last_assistant_message: "official stop rationale",
    };
    const parsed = parseClaudeHookPayload(payload, 42);
    assert.ok(parsed && parsed.action === "close");
    assert.equal(parsed.rationale?.text, "official stop rationale");
  } finally {
    rmSync(transcript.dir, { recursive: true, force: true });
  }
});

test("Stop caps direct rationale through the shared schema", () => {
  const parsed = parseClaudeHookPayload({
    ...(fixture("stop.json") as Record<string, unknown>),
    last_assistant_message: "r".repeat(MAX_RATIONALE_CHARS + 50),
  }, 42);
  assert.ok(parsed && parsed.action === "close" && parsed.rationale);
  assert.equal(parsed.rationale.text.length, MAX_RATIONALE_CHARS);
});

test("MultiEdit records only the first edit path and excerpt", () => {
  const parsed = parseClaudeHookPayload({
    session_id: "s1",
    prompt_id: "p1",
    hook_event_name: "PostToolUse",
    cwd: "/w",
    tool_name: "MultiEdit",
    tool_input: {
      edits: [
        { file_path: "first.ts", old_string: "one", new_string: "first change" },
        { file_path: "second.ts", old_string: "two", new_string: "second change" },
      ],
    },
  }, 42);
  assert.ok(parsed && parsed.action === "append" && parsed.event.kind === "mechanism");
  assert.equal(parsed.event.path, "first.ts");
  assert.equal(parsed.event.excerpt, "first change");
});

test("MultiEdit emits every unique edit path as bounded mechanism events", () => {
  const parsed = parseClaudeHookPayload({
    session_id: "s1",
    prompt_id: "p2",
    hook_event_name: "PostToolUse",
    cwd: "/w",
    tool_name: "MultiEdit",
    tool_input: {
      edits: [
        { file_path: "first.ts", old_string: "one", new_string: "first change" },
        { file_path: "second.ts", old_string: "two", new_string: "second change" },
        { file_path: "first.ts", old_string: "three", new_string: "latest first change" },
      ],
    },
  }, 42);
  assert.ok(parsed && parsed.action === "append");
  assert.deepEqual(parsed.events.filter((event) => event.kind === "mechanism").map((event) => event.path), [
    "first.ts", "second.ts",
  ]);
  const first = parsed.events.find((event): event is Extract<typeof event, { kind: "mechanism" }> => event.kind === "mechanism" && event.path === "first.ts");
  assert.equal(first?.excerpt, "latest first change");
});

test("MultiEdit reports exact unique overflow separately from bounded events", () => {
  const edits = Array.from({ length: 70 }, (_, index) => ({
    file_path: `file-${index}.ts`, new_string: `value-${index}`,
  }));
  const parsed = parseClaudeHookPayload({
    session_id: "session", prompt_id: "prompt", hook_event_name: "PostToolUse",
    tool_name: "MultiEdit", tool_input: { edits },
  }, 42);
  assert.ok(parsed && parsed.action === "append");
  assert.equal(parsed.events.filter((event) => event.kind === "mechanism").length, 64);
  assert.equal(parsed.truncatedFiles, 6);
});

test("missing session or prompt identity fails open instead of sharing a fallback key", () => {
  const base = fixture("user-prompt-submit.json") as Record<string, unknown>;
  assert.equal(parseClaudeHookPayload({ ...base, session_id: "" }), undefined);
  assert.equal(parseClaudeHookPayload({ ...base, session_id: undefined }), undefined);
  assert.equal(parseClaudeHookPayload({ ...base, prompt_id: "" }), undefined);
  assert.equal(parseClaudeHookPayload({ ...base, prompt_id: undefined }), undefined);
});

test("unknown events and malformed nested records fail open without throwing", () => {
  assert.equal(parseClaudeHookPayload({ hook_event_name: "PreToolUse", session_id: "s", prompt_id: "p" }), undefined);
  assert.equal(parseClaudeHookPayload("junk"), undefined);
  assert.doesNotThrow(() => parseClaudeHookPayload({
    session_id: "s",
    prompt_id: "p",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: [],
  }));
  assert.doesNotThrow(() => parseClaudeHookPayload({
    session_id: "s",
    prompt_id: "p",
    hook_event_name: "PostToolUse",
    tool_name: "MultiEdit",
    tool_input: { edits: [null, { file_path: "second.ts" }] },
  }));
});

test("transcript tail parsing tolerates a partial first line and scans backward", () => {
  const transcript = tempTranscript([
    JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(70 * 1024) } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "tail rationale" }] } }),
  ].join("\n") + "\n");
  try {
    assert.equal(rationaleFromTranscript(transcript.path), "tail rationale");
  } finally {
    rmSync(transcript.dir, { recursive: true, force: true });
  }
});

test("transcript rationale is capped and malformed lines fail safely", () => {
  const transcript = tempTranscript([
    "not-json",
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [null, [], { type: "image", data: "x" }] } }),
  ].join("\n") + "\n");
  try {
    assert.equal(rationaleFromTranscript(transcript.path), undefined);
  } finally {
    rmSync(transcript.dir, { recursive: true, force: true });
  }

  const capped = tempTranscript(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "r".repeat(MAX_RATIONALE_CHARS + 100) }] },
  }) + "\n");
  try {
    assert.equal(rationaleFromTranscript(capped.path)?.length, MAX_RATIONALE_CHARS);
  } finally {
    rmSync(capped.dir, { recursive: true, force: true });
  }
});

test("non-regular and symlink transcript inputs return undefined", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await t.test("non-regular", () => {
    assert.equal(rationaleFromTranscript(dir), undefined);
  });
  await t.test("symlink", (st) => {
    if (skipIfSymlinkUnavailable(st)) return;
    const target = join(dir, "target.jsonl");
    const link = join(dir, "link.jsonl");
    writeFileSync(target, JSON.stringify({ type: "assistant", message: { content: "secret" } }) + "\n");
    symlinkSync(target, link);
    assert.equal(rationaleFromTranscript(link), undefined);
  });
});
