import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  NOTE_EXPECTATION_STDIN_CAP_BYTES,
  noteExpectationHook,
  type NoteExpectationReply,
} from "../commands/note-expectation.js";
import { recordRationale } from "../core/memory.js";
import { loadMemory, loadMemoryChecked, tailReadable, type FailureRecord, type MemoryRecord, type RationaleRecord } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { causalWordViolations } from "./causal-words.js";
import { withRecordCap } from "./memory-cap-fixture.js";

const minute = 60_000;
const hour = 60 * minute;
const now = 1_800_000_000_000;
const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
const payload = { text: "The next run should pass.", command: "npm test", agent: "codex" };

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "rocky-note-expectation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const memory = join(home, "memory.jsonl");
  const cwd = join(home, "repo");
  const elsewhere = join(home, "other");
  const env = { ROCKY_HOME: home };
  const opts = { now, cwd, env };
  const invoke = (input: unknown = payload, overrides: Partial<Parameters<typeof noteExpectationHook>[1]> = {}) =>
    JSON.parse(noteExpectationHook(
      Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input)),
      { ...opts, ...overrides },
    )) as NoteExpectationReply;
  const seed = (...records: MemoryRecord[]) => {
    writeFileSync(memory, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  };
  const notes = () => loadMemory(memory).filter((record): record is RationaleRecord => record.kind === "rationale");
  return { home, memory, cwd, elsewhere, env, invoke, seed, notes };
}

function failure(id: string, ts: number, cwd: string): FailureRecord {
  return {
    kind: "failure", id, ts, cwd, cmd: "npm test", exitCode: 1,
    fingerprint: "0123456789abcdef", signature: ["test failed"], excerpt: "test failed",
  };
}

test("records a raw MCP rationale and command without a linked failure", (t) => {
  const { invoke, notes, cwd } = fixture(t);
  const result = invoke();
  assert.ok(result.id);
  assert.deepEqual(result, { recorded: true, id: result.id, linkedFailure: false });
  assert.deepEqual(notes(), [{
    kind: "rationale", v: 1, id: result.id, ts: now, cwd, agent: "codex",
    source: "mcp", rationale_fidelity: "raw", excerpt: payload.text, expectedCommand: payload.command,
  }]);
});

test("links the requested failure ahead of a newer unresolved failure in the same cwd", (t) => {
  const { invoke, seed, notes, cwd } = fixture(t);
  const requested = failure("failure-requested", now - hour, cwd);
  seed(requested, failure("failure-newer", now - minute, cwd));
  assert.equal(invoke({ ...payload, failureId: requested.id }).linkedFailure, true);
  assert.deepEqual(notes()[0].links, { failureId: requested.id });
});

test("falls back from an old explicit failure to the newest unresolved failure in the link window", (t) => {
  const { invoke, seed, notes, cwd } = fixture(t);
  const old = failure("failure-old", now - 9 * hour, cwd);
  const oldestEligible = failure("failure-oldest-eligible", now - 8 * hour, cwd);
  const newestUnresolved = failure("failure-unresolved", now - 2 * minute, cwd);
  const resolved = failure("failure-resolved", now - minute, cwd);
  seed(old, newestUnresolved, oldestEligible, resolved, {
    kind: "fix", id: "fix-example", ts: now, cwd, cmd: "npm test", failureIds: [resolved.id],
  }, failure("failure-future", now + 1, cwd));
  const result = invoke({ ...payload, failureId: old.id });
  assert.equal(result.linkedFailure, true);
  assert.deepEqual(notes()[0].links, { failureId: newestUnresolved.id });
});

test("ignores an explicit failure in another cwd and leaves an optional command absent", (t) => {
  const { invoke, seed, notes, cwd, elsewhere } = fixture(t);
  const foreign = failure("failure-foreign", now - hour, elsewhere);
  seed(foreign, failure("failure-too-old", now - 9 * hour, cwd));
  const result = invoke({ text: payload.text, agent: "claude-code", failureId: foreign.id });
  assert.equal(result.recorded, true);
  assert.equal(result.linkedFailure, false);
  assert.equal(notes()[0].links, undefined);
  assert.equal(notes()[0].expectedCommand, undefined);
});

test("deduplicates through ten minutes and records again after eleven", (t) => {
  const { invoke, notes } = fixture(t);
  assert.equal(invoke().recorded, true);
  for (const offset of [minute, 10 * minute]) {
    assert.deepEqual(invoke(payload, { now: now + offset }), {
      recorded: false, reason: "duplicate", linkedFailure: false,
    });
  }
  assert.equal(invoke(payload, { now: now + 11 * minute }).recorded, true);
  assert.equal(notes().length, 2);
});

test("uses the command, cwd, and resolved link in the deduplication key", (t) => {
  const { invoke, notes, seed, cwd, elsewhere } = fixture(t);
  const first = failure("failure-first", now - hour, cwd);
  const second = failure("failure-second", now - minute, cwd);
  seed(first, second);
  assert.equal(invoke({ ...payload, failureId: first.id }).recorded, true);
  assert.equal(invoke({ ...payload, failureId: second.id }).recorded, true);
  assert.equal(invoke({ ...payload, command: "npm run build", failureId: second.id }).recorded, true);
  assert.equal(invoke({ text: payload.text, agent: "generic" }).recorded, true);
  assert.equal(invoke({ text: payload.text, agent: "generic" }, { cwd: elsewhere }).recorded, true);
  assert.equal(invoke({ ...payload, agent: "generic" }).reason, "duplicate");
  assert.equal(notes().length, 5);
});

test("caps MCP rationales across cwds and excludes records exactly 24 hours old", (t) => {
  const { invoke, seed, notes, cwd, elsewhere } = fixture(t);
  const prior: RationaleRecord[] = Array.from({ length: 100 }, (_, i) => ({
    kind: "rationale", v: 1, id: `rationale-${i}`, ts: now - 24 * hour + 1,
    cwd: i % 2 === 0 ? cwd : elsewhere, agent: "generic", source: "mcp",
    rationale_fidelity: "raw", excerpt: "An earlier expectation.",
  }));
  seed(...prior, { ...prior[0], id: "rationale-human", source: "human" });
  assert.deepEqual(invoke(), { recorded: false, reason: "cap", linkedFailure: false });
  assert.equal(notes().length, 101);
  seed(...prior.slice(1), { ...prior[0], ts: now - 24 * hour }, {
    ...prior[0], id: "rationale-human", source: "human",
  });
  assert.equal(invoke().recorded, true);
});

test("uses the readable short tail for deduplication, the cap, and new writes", (t) => {
  withRecordCap(t, 101);
  const { invoke, seed, notes, memory, cwd, elsewhere } = fixture(t);
  const matching: RationaleRecord = {
    kind: "rationale", v: 1, id: "rationale-matching", ts: now - minute,
    cwd, agent: "codex", source: "mcp", rationale_fidelity: "raw",
    excerpt: payload.text, expectedCommand: payload.command,
  };
  seed(
    failure("failure-outside-tail", now - 25 * hour, elsewhere),
    { ...matching, id: "rationale-human", ts: now - 6 * hour, source: "human" },
    failure("failure-in-tail", now - 6 * hour, elsewhere),
    ...Array.from({ length: 98 }, (_, i) => ({
      ...matching, id: `rationale-prior-${i}`, cwd: elsewhere,
    })),
    matching,
  );
  const { coverage } = loadMemoryChecked(memory, now);
  assert.equal(coverage.window, "tail");
  assert.equal(coverage.oldestTs, now - 6 * hour);
  assert.equal(tailReadable(coverage), true);

  assert.deepEqual(invoke(), { recorded: false, reason: "duplicate", linkedFailure: false });
  const result = invoke({ ...payload, text: "A new expectation." });
  assert.ok(result.id);
  assert.deepEqual(result, { recorded: true, id: result.id, linkedFailure: false });
  assert.equal(notes().find((record) => record.id === result.id)?.excerpt, "A new expectation.");
  const atCap = readFileSync(memory);
  assert.deepEqual(invoke({ ...payload, text: "Another expectation." }), {
    recorded: false, reason: "cap", linkedFailure: false,
  });
  assert.deepEqual(readFileSync(memory), atCap);
});

test("checks both write toggles before parsing, leaving memory untouched", (t) => {
  const { invoke, seed, memory, cwd, env, home } = fixture(t);
  seed(failure("failure-before", now - hour, cwd));
  const original = readFileSync(memory);
  const response = { recorded: false, reason: "disabled", linkedFailure: false };
  assert.deepEqual(invoke(Buffer.from("not JSON"), { env: { ...env, ROCKY_MCP_WRITE: "off" } }), response);
  assert.deepEqual(readFileSync(memory), original);
  writeFileSync(join(home, "mcp-write-off"), "");
  assert.deepEqual(invoke(), response);
  assert.deepEqual(readFileSync(memory), original);
});

test("rejects invalid payloads, including fields that become empty after sanitizing", (t) => {
  const { invoke, memory } = fixture(t);
  for (const input of [
    { ...payload, text: "🧪".repeat(201) },
    { ...payload, command: "🧪".repeat(201) },
    { ...payload, command: null },
    { ...payload, failureId: "has spaces" },
    { ...payload, agent: "human" },
    { ...payload, text: "\u202e" },
    { ...payload, command: "\u001b[31m\u202e" },
    null,
    Buffer.from("not JSON"),
  ]) {
    assert.deepEqual(invoke(input), { recorded: false, reason: "invalid_input", linkedFailure: false });
  }
  assert.equal(existsSync(memory), false);
});

test("preserves whitespace that survives sanitizing", (t) => {
  const { invoke, notes } = fixture(t);
  assert.equal(invoke({ ...payload, text: " ", command: " " }).recorded, true);
  assert.equal(notes()[0].excerpt, " ");
  assert.equal(notes()[0].expectedCommand, " ");
});

test("accepts exactly 200 code points and enforces the stdin byte cap", (t) => {
  const { invoke, notes } = fixture(t);
  const text = "🧪".repeat(200);
  const json = Buffer.from(JSON.stringify({ ...payload, text, command: text }));
  const padded = Buffer.concat([json, Buffer.alloc(NOTE_EXPECTATION_STDIN_CAP_BYTES - json.length, " ")]);
  assert.equal(invoke(padded).recorded, true);
  assert.deepEqual(invoke(Buffer.concat([padded, Buffer.from(" ")])), {
    recorded: false, reason: "invalid_input", linkedFailure: false,
  });
  assert.equal(notes()[0].excerpt, text);
  assert.equal(notes()[0].expectedCommand, text);
});

test("future-dated MCP rationales do not count toward deduplication or the cap", (t) => {
  const { invoke, seed, notes, cwd } = fixture(t);
  seed(...Array.from({ length: 100 }, (_, i): RationaleRecord => ({
    kind: "rationale", v: 1, id: `rationale-future-${i}`, ts: now + minute,
    cwd, agent: "codex", source: "mcp", rationale_fidelity: "raw",
    excerpt: payload.text, expectedCommand: payload.command,
  })));

  assert.equal(invoke({ ...payload, text: "A different expectation." }).recorded, true);
  assert.equal(invoke().recorded, true);
  assert.deepEqual(invoke(), { recorded: false, reason: "duplicate", linkedFailure: false });
  assert.equal(notes().filter((record) => record.ts === now).length, 2);
});

test("returns memory_unavailable without writing when memory is a directory", (t) => {
  const { invoke, home, memory } = fixture(t);
  mkdirSync(memory);
  assert.deepEqual(invoke(), { recorded: false, reason: "memory_unavailable", linkedFailure: false });
  assert.deepEqual(readdirSync(home), ["memory.jsonl"]);
  assert.deepEqual(readdirSync(memory), []);
});

test("declines when the memory tail becomes unreadable as the writer takes the lock", (t) => {
  const { cwd, env, home, memory, seed } = fixture(t);
  seed(failure("failure-before", now - hour, cwd));
  const original = readFileSync(memory, "utf8");
  const malformed = "invalid JSON\nanother invalid line\n";
  const lock = memory + ".triple.lock";
  const preload = join(home, "damage-at-lock.cjs");
  writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const open = fs.openSync;',
    'fs.openSync = (path, flags, ...rest) => {',
    '  const fd = open(path, flags, ...rest);',
    `  if (path === ${JSON.stringify(lock)} && flags === "wx") {`,
    `    fs.appendFileSync(${JSON.stringify(memory)}, ${JSON.stringify(malformed)});`,
    '  }',
    '  return fd;',
    '};',
    'require("node:module").syncBuiltinESMExports();',
  ].join("\n"));

  assert.equal(tailReadable(loadMemoryChecked(memory, now).coverage), true);
  const result = spawnSync(process.execPath, ["--require", preload, entry, "hook", "note-expectation"], {
    cwd: home, env: { ...process.env, ...env, ROCKY_MCP_WRITE: undefined },
    input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    recorded: false, reason: "memory_unavailable", linkedFailure: false,
  });
  assert.equal(readFileSync(memory, "utf8"), original + malformed);
  assert.equal(existsSync(lock), false);

  const human = recordRationale({
    cwd, ts: now, agent: "human", rationale_fidelity: "raw", source: "human", text: "Human note.",
  }, resolveRockyPaths(env, undefined, cwd));
  assert.equal(readFileSync(memory, "utf8"), original + malformed + JSON.stringify(human) + "\n");
});

test("CLI export sanitizes imported MCP testimony fields", (t) => {
  const { cwd, env, home, memory, seed } = fixture(t);
  const token = "glpat-FakeExport-12345";
  const imported: RationaleRecord = {
    kind: "rationale", v: 1, id: "rationale-imported", ts: now, cwd,
    agent: "codex", source: "mcp", rationale_fidelity: "raw",
    excerpt: `expect \u202e${token} to work`, expectedCommand: `check ${token}\u202e`,
  };
  const withoutCommand: RationaleRecord = {
    kind: "rationale", v: 1, id: "rationale-no-command", ts: now, cwd,
    agent: "codex", source: "mcp", rationale_fidelity: "raw", excerpt: imported.excerpt,
  };
  seed(imported, withoutCommand);
  const original = readFileSync(memory, "utf8");
  const result = spawnSync(process.execPath, [entry, "export"], {
    cwd: home, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(token), false);
  assert.doesNotMatch(result.stdout, /\u202e/u);
  assert.deepEqual(result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line)), [
    { ...imported, excerpt: "expect [redacted gitlab token] to work", expectedCommand: "check [redacted gitlab token]" },
    { ...withoutCommand, excerpt: "expect [redacted gitlab token] to work" },
  ]);
  assert.equal(readFileSync(memory, "utf8"), original);
});

test("sanitizes testimony and commands on write and deduplicates the stored values", (t) => {
  const { invoke, memory, notes } = fixture(t);
  const text = "show \u202e\u001b[31mAKIAABCDEFGHIJKLMNOP";
  const command = `show AKIAABCDEFGHIJKLMNOP ${"a".repeat(174)}`;
  const input = { ...payload, text, command };
  assert.equal(invoke(input).recorded, true);
  assert.equal(invoke(input).reason, "duplicate");
  const [record] = notes();
  assert.match(record.excerpt, /\[redacted aws access key\]/u);
  assert.match(record.expectedCommand ?? "", /\[redacted aws access key\]/u);
  assert.equal([...(record.expectedCommand ?? "")].length, 200);
  assert.doesNotMatch(readFileSync(memory, "utf8"), /AKIAABCDEFGHIJKLMNOP|\u202e|\\u001b/u);
});

test("CLI accepts stdin and prints one JSON reply line", (t) => {
  const { env, notes } = fixture(t);
  const result = spawnSync(process.execPath, [entry, "hook", "note-expectation"], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ...env, ROCKY_MCP_WRITE: undefined },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^\{[^\r\n]*\}\r?\n$/u);
  const reply = JSON.parse(result.stdout) as NoteExpectationReply;
  assert.deepEqual(reply, { recorded: true, id: notes()[0].id, linkedFailure: false });
});

test("CLI drops oversized stdin without invoking the writer", (t) => {
  const { env, memory } = fixture(t);
  const result = spawnSync(process.execPath, [entry, "hook", "note-expectation"], {
    input: JSON.stringify(payload).padEnd(NOTE_EXPECTATION_STDIN_CAP_BYTES + 1), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ...env, ROCKY_MCP_WRITE: undefined },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(existsSync(memory), false);
});

test("CLI rejects extra arguments with usage on stderr", (t) => {
  const { env, memory } = fixture(t);
  const result = spawnSync(process.execPath, [entry, "hook", "note-expectation", "extra"], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ...env },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^rocky: /u);
  assert.match(result.stderr, /usage.*note-expectation/iu);
  assert.deepEqual(causalWordViolations([result.stderr]), []);
  assert.equal(existsSync(memory), false);
});
