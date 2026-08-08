import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, notifyArgv, spokenDuration } from "../core/notify.js";

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
