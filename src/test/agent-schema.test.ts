import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  batchKey,
  MAX_EXCERPT_CHARS,
  MAX_INTENT_CHARS,
  MAX_RATIONALE_CHARS,
  parseAgentEvent,
} from "../agent/schema.js";

test("parseAgentEvent accepts a valid intent event and caps text", () => {
  const parsed = parseAgentEvent({
    v: 1,
    agent: "claude-code",
    kind: "intent",
    ts: 5,
    cwd: "/w",
    text: "x".repeat(MAX_INTENT_CHARS + 50),
  });
  assert.ok(parsed && parsed.kind === "intent");
  assert.equal(parsed.text.length, MAX_INTENT_CHARS);
  assert.equal(parsed.cwd, "/w");
});

test("parseAgentEvent caps mechanism excerpt and requires path", () => {
  const parsed = parseAgentEvent({
    v: 1,
    agent: "codex",
    kind: "mechanism",
    ts: 5,
    tool: "Edit",
    path: "a.css",
    excerpt: "y".repeat(1000),
  });
  assert.ok(parsed && parsed.kind === "mechanism");
  assert.equal(parsed.excerpt?.length, MAX_EXCERPT_CHARS);
  assert.equal(parseAgentEvent({ v: 1, agent: "codex", kind: "mechanism", ts: 5, tool: "Edit" }), undefined);
});

test("parseAgentEvent accepts and caps rationale text for each supported source", () => {
  const transcript = parseAgentEvent({
    v: 1,
    agent: "claude-code",
    kind: "rationale",
    ts: 5,
    source: "transcript",
    text: "r".repeat(MAX_RATIONALE_CHARS + 50),
  });
  const notify = parseAgentEvent({
    v: 1,
    agent: "codex",
    kind: "rationale",
    ts: 6,
    source: "notify",
    text: "why",
  });
  assert.ok(transcript && transcript.kind === "rationale");
  assert.equal(transcript.text.length, MAX_RATIONALE_CHARS);
  assert.ok(notify && notify.kind === "rationale");
  assert.equal(notify.source, "notify");
});

test("parseAgentEvent rejects wrong rationale source and malformed fields", () => {
  assert.equal(parseAgentEvent({
    v: 1,
    agent: "claude-code",
    kind: "rationale",
    ts: 5,
    source: "model",
    text: "not supported",
  }), undefined);
  assert.equal(parseAgentEvent({
    v: 1,
    agent: "claude-code",
    kind: "rationale",
    ts: Number.NaN,
    source: "transcript",
    text: "why",
  }), undefined);
  assert.equal(parseAgentEvent({
    v: 1,
    agent: "codex",
    kind: "mechanism",
    ts: 5,
    tool: "",
    path: "a.css",
  }), undefined);
});

test("parseAgentEvent rejects wrong version, agent, kind, and non-objects", () => {
  assert.equal(parseAgentEvent({ v: 2, agent: "claude-code", kind: "intent", ts: 1, text: "a" }), undefined);
  assert.equal(parseAgentEvent({ v: 1, agent: "cursor", kind: "intent", ts: 1, text: "a" }), undefined);
  assert.equal(parseAgentEvent({ v: 1, agent: "codex", kind: "thought", ts: 1, text: "a" }), undefined);
  assert.equal(parseAgentEvent("nope"), undefined);
  assert.equal(parseAgentEvent(null), undefined);
});

test("batchKey sanitizes to filename-safe and bounded", () => {
  const key = batchKey("claude-code", "sess/../evil", "p".repeat(300));
  assert.match(key, /^[A-Za-z0-9_-]+$/);
  assert.ok(key.length <= 120);
  assert.ok(key.startsWith("claude-code-"));
});

test("batchKey preserves an ordinary short filename-safe key exactly", () => {
  assert.equal(batchKey("codex", "session_01", "turn-2"), "codex-session_01-turn-2");
});

test("batchKey keeps distinct unsafe inputs distinct after sanitization", () => {
  const slash = batchKey("codex", "session/a", "turn");
  const underscore = batchKey("codex", "session_a", "turn");
  assert.notEqual(slash, underscore);
  assert.match(slash, /^[A-Za-z0-9_-]+$/);
  assert.match(underscore, /^[A-Za-z0-9_-]+$/);
});

test("batchKey keeps distinct oversized inputs distinct after truncation", () => {
  const prefix = "s".repeat(300);
  const first = batchKey("claude-code", `${prefix}-one`, "turn");
  const second = batchKey("claude-code", `${prefix}-two`, "turn");
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.match(second, /^[A-Za-z0-9_-]+$/);
  assert.ok(first.length <= 120);
  assert.ok(second.length <= 120);
});
