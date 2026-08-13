import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { agentEvent, logHookError } from "../commands/agent-hook.js";
import { readBatch } from "../agent/spool.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
const STDIN_CAP_BYTES = 2 * 1024 * 1024;
const LOG_CAP_BYTES = 64 * 1024;
const INVISIBLE_FORMAT_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ["U+061C", "\u061C"],
  ["U+200B", "\u200B"],
  ["U+200C", "\u200C"],
  ["U+200D", "\u200D"],
  ["U+200E", "\u200E"],
  ["U+200F", "\u200F"],
  ["U+202A", "\u202A"],
  ["U+202B", "\u202B"],
  ["U+202C", "\u202C"],
  ["U+202D", "\u202D"],
  ["U+202E", "\u202E"],
  ["U+2060", "\u2060"],
  ["U+2061", "\u2061"],
  ["U+2062", "\u2062"],
  ["U+2063", "\u2063"],
  ["U+2064", "\u2064"],
  ["U+2065", "\u2065"],
  ["U+2066", "\u2066"],
  ["U+2067", "\u2067"],
  ["U+2068", "\u2068"],
  ["U+2069", "\u2069"],
  ["U+206A", "\u206A"],
  ["U+206B", "\u206B"],
  ["U+206C", "\u206C"],
  ["U+206D", "\u206D"],
  ["U+206E", "\u206E"],
  ["U+206F", "\u206F"],
  ["U+FEFF", "\uFEFF"],
];

function freshPaths(t: TestContext): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-hookentry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return resolveRockyPaths({ ROCKY_HOME: home });
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

const submitPayload = JSON.stringify({
  session_id: "s1",
  prompt_id: "p1",
  hook_event_name: "UserPromptSubmit",
  cwd: "/w",
  prompt: "naikin",
});

function enableLocalAi(paths: RockyPaths): void {
  writeFileSync(paths.config, JSON.stringify({
    version: 1,
    ai: { enabled: true, provider: "ollama", model: "ambiguity-test", exposure: "sanitized" },
  }), { encoding: "utf8", mode: 0o600 });
}

function mechanismPayload(): string {
  return JSON.stringify({
    session_id: "s1",
    prompt_id: "p2",
    hook_event_name: "PostToolUse",
    cwd: "/w",
    tool_name: "Edit",
    tool_input: { file_path: "src/button.tsx", new_string: "button" },
  });
}

test("valid UserPromptSubmit payload appends intent, prints {} and returns 0", async (t) => {
  const paths = freshPaths(t);
  const spawned: string[] = [];
  const result = await captureStdout(() => agentEvent("claude-code", {
    stdin: async () => submitPayload,
    spawnAnnotate: (key) => spawned.push(key),
    paths,
  }));

  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  assert.equal(readBatch("claude-code-s1-p1", paths).length, 1);
  assert.deepEqual(spawned, []);
  assert.equal(existsSync(paths.memory), false);
});

test("enabled intent append spawns ambiguity once while preserving exact stdout", async (t) => {
  const paths = freshPaths(t);
  enableLocalAi(paths);
  const spawned: string[] = [];
  const result = await captureStdout(() => agentEvent("claude-code", {
    stdin: async () => submitPayload,
    spawnAmbiguity: (text: string) => spawned.push(text),
    paths,
  }));

  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  assert.deepEqual(spawned, ["naikin"]);
  assert.equal(readBatch("claude-code-s1-p1", paths).length, 1);
});

test("enabled mechanism append never spawns ambiguity and preserves exact stdout", async (t) => {
  const paths = freshPaths(t);
  enableLocalAi(paths);
  const spawned: string[] = [];
  const result = await captureStdout(() => agentEvent("claude-code", {
    stdin: async () => mechanismPayload(),
    spawnAmbiguity: (text: string) => spawned.push(text),
    paths,
  }));

  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  assert.deepEqual(spawned, []);
  assert.equal(readBatch("claude-code-s1-p2", paths).length, 1);
});

test("disabled config does not invoke ambiguity injection seam", async (t) => {
  const paths = freshPaths(t);
  const spawned: string[] = [];
  const result = await captureStdout(() => agentEvent("claude-code", {
    stdin: async () => submitPayload,
    spawnAmbiguity: (text: string) => spawned.push(text),
    paths,
  }));

  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  assert.deepEqual(spawned, []);
  assert.equal(readBatch("claude-code-s1-p1", paths).length, 1);
});

test("Stop payload appends direct rationale before spawning annotate once", async (t) => {
  const paths = freshPaths(t);
  const spawned: string[] = [];
  const stop = JSON.stringify({
    session_id: "s1",
    prompt_id: "p1",
    hook_event_name: "Stop",
    cwd: "/w",
    last_assistant_message: "fixed spacing in button",
  });
  const result = await captureStdout(() => agentEvent("claude-code", {
    stdin: async () => stop,
    spawnAnnotate: (key) => spawned.push(key),
    paths,
  }));

  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  assert.deepEqual(spawned, ["claude-code-s1-p1"]);
  const events = readBatch("claude-code-s1-p1", paths);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "rationale");
  assert.equal(events[0]?.kind === "rationale" ? events[0].text : undefined, "fixed spacing in button");
});

test("Stop payload without rationale still spawns annotate once", async (t) => {
  const paths = freshPaths(t);
  const spawned: string[] = [];
  const stop = JSON.stringify({
    session_id: "s1",
    prompt_id: "p1",
    hook_event_name: "Stop",
    cwd: "/w",
    transcript_path: "/missing/transcript.jsonl",
  });
  const result = await captureStdout(() => agentEvent("claude-code", {
    stdin: async () => stop,
    spawnAnnotate: (key) => spawned.push(key),
    paths,
  }));

  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  assert.deepEqual(spawned, ["claude-code-s1-p1"]);
  assert.deepEqual(readBatch("claude-code-s1-p1", paths), []);
});

test("garbage, unknown, codex, and oversized inputs return 0 with exact {}", async (t) => {
  const paths = freshPaths(t);
  const cases: Array<() => Promise<number>> = [
    () => agentEvent("claude-code", { stdin: async () => "not json", paths }),
    () => agentEvent("cursor", { stdin: async () => submitPayload, paths }),
    () => agentEvent("codex", { stdin: async () => submitPayload, paths }),
    () => agentEvent("claude-code", { stdin: async () => "x".repeat(STDIN_CAP_BYTES + 1), paths }),
    () => agentEvent("claude-code", { stdin: async () => { throw new Error("boom"); }, paths }),
  ];

  for (const run of cases) {
    const result = await captureStdout(run);
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
  }
  assert.equal(existsSync(paths.memory), false);
});

test("stdout async EPIPE is swallowed after one attempted response and listener cleanup", async (t) => {
  const paths = freshPaths(t);
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const originalOutput = process.stdout;
  const output = new EventEmitter() as EventEmitter & {
    write: (chunk: string, callback?: (error?: Error) => void) => boolean;
  };
  const originalWrite = originalOutput.write.bind(originalOutput);
  let armed = false;
  output.write = (chunk: string, callback?: (error?: Error) => void) => {
    if (!armed || chunk !== "{}") return originalWrite(chunk, callback);
    armed = false;
    writes += 1;
    listenersAtWrite = output.listenerCount("error");
    setImmediate(() => {
      const error = Object.assign(new Error("closed stream"), { code: "EPIPE" });
      output.emit("error", error);
      callback?.(error);
    });
    return true;
  };
  Object.defineProperty(process, "stdout", { value: output, configurable: true, enumerable: true });
  const listenersBefore = output.listenerCount("error");
  const testListener = () => {};
  output.on("error", testListener);
  let writes = 0;
  let listenersAtWrite = 0;
  try {
    armed = true;
    const code = await agentEvent("claude-code", { stdin: async () => "not json", paths });
    assert.equal(code, 0);
    assert.equal(writes, 1);
    assert.equal(listenersAtWrite, listenersBefore + 2);
    assert.equal(output.listenerCount("error"), listenersBefore + 1);
  } finally {
    output.removeListener("error", testListener);
    if (originalDescriptor) Object.defineProperty(process, "stdout", originalDescriptor);
  }
});

test("default annotate child error is swallowed without changing hook success", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-hookentry-spawn-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const preload = join(home, "spawn-error.cjs");
  const marker = join(home, "spawn-called");
  writeFileSync(preload, [
    "const childProcess = require('node:child_process');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const { EventEmitter } = require('node:events');",
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "childProcess.spawn = (...args) => {",
    "  fs.writeFileSync(marker, JSON.stringify(args[2]));",
    "  const child = new EventEmitter();",
    "  child.unref = () => {};",
    "  process.nextTick(() => child.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));",
    "  return child;",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"), "utf8");
  const stop = JSON.stringify({
    session_id: "s1",
    prompt_id: "p1",
    hook_event_name: "Stop",
    cwd: "/w",
    last_assistant_message: "fixed spacing in button",
  });
  const result = spawnSync(process.execPath, ["--require", preload, entry, "hook", "agent-event", "claude-code"], {
    cwd: packageRoot,
    env: { ...process.env, ROCKY_HOME: home },
    encoding: "utf8",
    input: stop,
    timeout: 5_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(existsSync(marker), true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.doesNotMatch(result.stderr, /Unhandled ['"]error['"]|EPIPE/);
});

test("default ambiguity child is detached, base64url-encoded, and error-swallowed", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-hookentry-ambiguity-spawn-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const preload = join(home, "spawn-recorder.cjs");
  const marker = join(home, "spawn-called");
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 1,
    ai: { enabled: true, provider: "ollama", model: "ambiguity-test", exposure: "sanitized" },
  }), "utf8");
  writeFileSync(preload, [
    "const childProcess = require('node:child_process');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const { EventEmitter } = require('node:events');",
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "childProcess.spawn = (...args) => {",
    "  const child = new EventEmitter();",
    "  child.unref = () => fs.appendFileSync(marker, JSON.stringify({ unref: true }) + '\\n');",
    "  fs.writeFileSync(marker, JSON.stringify({ args }) + '\\n');",
    "  process.nextTick(() => child.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));",
    "  return child;",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"), "utf8");
  const result = spawnSync(process.execPath, ["--require", preload, entry, "hook", "agent-event", "claude-code"], {
    cwd: packageRoot,
    env: { ...process.env, ROCKY_HOME: home },
    encoding: "utf8",
    input: submitPayload,
    timeout: 5_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.doesNotMatch(result.stderr, /Unhandled ['"]error['"]|EPIPE/);
  const markerText = readFileSync(marker, "utf8");
  const lines = markerText.trim().split("\n");
  const first = JSON.parse(lines[0] ?? "{}") as { args?: unknown[] };
  // The preload appends unref evidence after recording the spawn arguments.
  assert.match(markerText, /"unref":true/u);
  assert.deepEqual(first.args?.[1], [entry, "_ambiguity", Buffer.from("naikin", "utf8").toString("base64url")]);
  assert.deepEqual(first.args?.[2], {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
});

test("logHookError redacts secrets and collapses ANSI, control, bidi, and newlines", (t) => {
  const paths = freshPaths(t);
  logHookError(
    "bad\n\t\u001b[31mAKIAABCDEFGHIJKLMNOP\u001b[0m\u0000\u202E next",
    paths,
  );
  const log = readFileSync(paths.agentLog, "utf8");
  assert.ok(log.includes("[redacted aws access key]"));
  assert.equal(log.includes("AKIAABCDEFGHIJKLMNOP"), false);
  assert.equal(/\u001b|\u0000|\u202E/.test(log), false);
  assert.equal(log.split("\n").filter(Boolean).length, 1);
  assert.match(log, /bad .* next/);
});

test("logHookError strips every shared invisible format control before redaction", (t) => {
  const paths = freshPaths(t);
  for (const [name, control] of INVISIBLE_FORMAT_CONTROLS) {
    const token = `sk-${control}ant-abcdefghijklmnopqrst123`;
    logHookError(`bad ${token} next`, paths);
    const log = readFileSync(paths.agentLog, "utf8");
    assert.doesNotMatch(log, /sk-ant-|abcdefghijklmnopqrst123/u, name);
    assert.match(log, /\[redacted anthropic key\]/u, name);
  }
});

test("logHookError redacts a token after visible text and an invisible control", (t) => {
  const paths = freshPaths(t);
  const token = "sk-ant-abcdefghijklmnopqrst123";
  logHookError(`prefix\u2065${token}`, paths);
  const log = readFileSync(paths.agentLog, "utf8");
  assert.doesNotMatch(log, /sk-ant-|abcdefghijklmnopqrst123/u);
  assert.match(log, /prefix\[redacted anthropic key\]/u);
});

test("logHookError scrubs a recognizable fragment exposed by its scan cap", (t) => {
  const paths = freshPaths(t);
  const token = "sk-ant-abcdefghijklmnopqrst123";
  logHookError(`${"\u2065".repeat(2724)}${token}`, paths);
  const log = readFileSync(paths.agentLog, "utf8");
  assert.doesNotMatch(log, /sk-ant-|abcdefghijklmnopqrst123/u);
});

test("logHookError retains C0 and ANSI removal offsets", (t) => {
  const token = "sk-ant-abcdefghijklmnopqrst123";
  for (const [name, control] of [["c0", "\u0000"], ["ansi", "\u001b[31m"]] as const) {
    const paths = freshPaths(t);
    logHookError(`prefix${control}${token}`, paths);
    const log = readFileSync(paths.agentLog, "utf8");
    assert.doesNotMatch(log, /sk-ant-|abcdefghijklmnopqrst123|\u001b|\u0000/u, name);
    assert.match(log, /prefix\[redacted anthropic key\]/u, name);
  }
});

test("logHookError consumes ANSI payloads before redacting adjacent secrets", (t) => {
  const token = "sk-ant-abcdefghijklmnopqrst123";
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["c1-csi", `prefix\u009b31m${token}`],
    ["c1-ss2", `prefix\u008em${token}`],
    ["c1-ss3", `prefix\u008fm${token}`],
    ["esc-ss2", `prefix\u001bNm${token}`],
    ["esc-ss3", `prefix\u001bOm${token}`],
    ["esc-dcs", `prefix\u001bP31m\u001b\\${token}`],
    ["esc-sos", `prefix\u001bX31m\u001b\\${token}`],
    ["esc-pm", `prefix\u001b^31m\u001b\\${token}`],
    ["esc-apc", `prefix\u001b_31m\u001b\\${token}`],
    ["c1-osc", `prefix\u009d31m\u009c${token}`],
    ["c1-dcs", `prefix\u009031m\u009c${token}`],
    ["c1-sos", `prefix\u009831m\u009c${token}`],
    ["c1-pm", `prefix\u009e31m\u009c${token}`],
    ["c1-apc", `prefix\u009f31m\u009c${token}`],
  ];

  for (const [name, candidate] of cases) {
    const paths = freshPaths(t);
    logHookError(candidate, paths);
    const log = readFileSync(paths.agentLog, "utf8");
    assert.equal(log.includes(token), false, name);
    assert.match(log, /prefix\[redacted anthropic key\]/u, name);
    assert.doesNotMatch(log, /31m|\u001b|[\u008e\u008f\u009b]/u, name);
  }
});

test("logHookError consumes DCS payload through BEL until ST", (t) => {
  const paths = freshPaths(t);
  const token = "sk-ant-abcdefghijklmnopqrst123";
  logHookError(`prefix\u009031m\u0007${token}\u009c`, paths);
  const log = readFileSync(paths.agentLog, "utf8");
  assert.match(log, /prefix\s*$/u);
  assert.doesNotMatch(log, /31m|sk-ant-|abcdefghijklmnopqrst123|\u0090|\u009c/u);
});

test("logHookError keeps the complete file within the strict 64 KiB cap", (t) => {
  const paths = freshPaths(t);
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.agentLog, "x".repeat(LOG_CAP_BYTES - 2), "utf8");
  logHookError("y".repeat(LOG_CAP_BYTES), paths);
  assert.ok(statSync(paths.agentLog).size <= LOG_CAP_BYTES);
});

test("logHookError bounds hostile diagnostic scanning before persistence", (t) => {
  const paths = freshPaths(t);
  const secret = "AKIAABCDEFGHIJKLMNOP";
  logHookError(`${"prefix ".repeat(4096)}${secret}`, paths);
  const log = readFileSync(paths.agentLog, "utf8");
  assert.ok(statSync(paths.agentLog).size <= LOG_CAP_BYTES);
  assert.equal(log.includes(secret), false);
});

test("logHookError rejects symlink and non-regular destinations", (t) => {
  const paths = freshPaths(t);
  mkdirSync(paths.home, { recursive: true });
  const target = join(paths.home, "target.log");
  writeFileSync(target, "target\n", "utf8");
  try {
    symlinkSync(target, paths.agentLog);
  } catch {
    // Symlinks may be unavailable on a restricted Windows runner.
  }
  if (existsSync(paths.agentLog) && lstatSync(paths.agentLog).isSymbolicLink()) {
    logHookError("must not follow", paths);
    assert.equal(readFileSync(target, "utf8"), "target\n");
  }

  rmSync(paths.agentLog, { force: true });
  mkdirSync(paths.agentLog, { recursive: true });
  logHookError("must not write directory", paths);
  assert.ok(lstatSync(paths.agentLog).isDirectory());
});

test("CLI hook agent-event dispatch emits {} and appends the Claude event", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-hookentry-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [entry, "hook", "agent-event", "claude-code"], {
    cwd: packageRoot,
    env: { ...process.env, ROCKY_HOME: home },
    encoding: "utf8",
    input: submitPayload,
    timeout: 5_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.equal(result.stderr, "");
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  assert.equal(readBatch("claude-code-s1-p1", paths).length, 1);
  assert.equal(existsSync(paths.memory), false);
});
