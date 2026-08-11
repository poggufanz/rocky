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
