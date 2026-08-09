import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, notify, notifyArgv, spokenDuration } from "../core/notify.js";

test("formatDuration formats seconds, minutes, and hours compactly", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(812_000), "13m32s");
  assert.equal(formatDuration(3_723_000), "1h02m03s");
  assert.equal(formatDuration(0), "0s");
});

test("spokenDuration counts precisely in total seconds", () => {
  assert.equal(spokenDuration(812_000), "812 seconds");
  assert.equal(spokenDuration(1000), "1 second");
  assert.equal(spokenDuration(0), "0 seconds");
});

test("notifyArgv on linux uses notify-send with the title and exact body", () => {
  const argv = notifyArgv({ cmd: "npm test", ok: true, durationMs: 45_000 }, "linux");
  assert.ok(argv);
  assert.equal(argv.file, "notify-send");
  assert.ok(argv.args.includes("rocky"));
  assert.ok(argv.args.includes("npm test — ok — 45s"));
});

test("notifyArgv on darwin uses osascript", () => {
  const argv = notifyArgv({ cmd: "npm test", ok: false, durationMs: 45_000 }, "darwin");
  assert.ok(argv);
  assert.equal(argv.file, "osascript");
});

test("notifyArgv on an unsupported platform returns undefined", () => {
  const argv = notifyArgv({ cmd: "npm test", ok: true, durationMs: 45_000 }, "win32");
  assert.equal(argv, undefined);
});

test("notifyArgv truncates a long command to 60 characters in the body", () => {
  const cmd = "x".repeat(200);
  const argv = notifyArgv({ cmd, ok: true, durationMs: 0 }, "linux");
  assert.ok(argv);
  const body = argv.args[1];
  assert.ok(body.startsWith("x".repeat(60) + " — "));
  assert.ok(!body.includes("x".repeat(61)));
});

// @types/node@18 doesn't declare this (stable since Node 17.3); the runtime has it (engines: node>=18, actively Node 22 here).
const activeResourcesProcess = process as unknown as { getActiveResourcesInfo(): string[] };

function activeTimeoutCount(): number {
  return activeResourcesProcess.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

// Regression guard for Important 1: spawn's `timeout` option installs a ref'd
// setTimeout cleared only on the child's 'exit' event, which an ENOENT spawn
// never emits (it emits 'error' instead) — that held the event loop open for
// 2s on any machine with no notifier binary. notify() no longer passes
// `timeout`, so no Timeout resource should exist after calling it.
test("notify leaves no active Timeout resource behind when the notifier binary is missing", (t: TestContext) => {
  const originalPath = process.env.PATH;
  const originalWrite = process.stderr.write;
  // notify() correctly writes a \x07 bell to stderr on this ENOENT path — that's
  // expected behavior, just not something this test's output needs to show.
  process.stderr.write = (() => true) as typeof process.stderr.write;
  t.after(() => {
    process.env.PATH = originalPath;
    process.stderr.write = originalWrite;
  });

  const before = activeTimeoutCount();
  process.env.PATH = ""; // force ENOENT: no real notifier binary is resolvable
  notify({ cmd: "x", ok: true, durationMs: 1 });
  const after = activeTimeoutCount();

  assert.equal(after, before);
});
