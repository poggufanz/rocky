import assert from "node:assert/strict";
import fs, {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { gateEvent } from "../agent/gate.js";
import {
  FIXTOUCH_CACHE_MAX_BYTES, FIXTOUCH_CMD_MAX, FIXTOUCH_SIGNATURE_MAX,
  fixTouchCachePath, rootKey, type FixTouchEntry,
} from "../core/fixtouch-cache.js";
import { causalWordViolations } from "./causal-words.js";
import { skipIfSymlinkUnavailable } from "./symlink-capability.js";

const NOW = Date.UTC(2026, 10, 25);
const REL = "src/session.ts";
const VAGUE = "it is broken, this thing does that stuff with those things and it fails";
const CLARITY_TEXT = "rocky: Prompt is vague (29/100). Start with an imperative verb such as fix, add, update, or test.";
const TOUCH_TEXT = 'rocky: Earlier record for src/session.ts: edited between a failing and a passing run of npm test (2026-11-12, error "TypeError: token undefined"). Rocky records order, not cause.';

function advice(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
  });
}

function context(stdout: string): string {
  const result = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext: string } };
  assert.ok(result.hookSpecificOutput, "expected an advisory");
  return result.hookSpecificOutput.additionalContext;
}

function assertSilentWithoutOpening(t: TestContext, edit: () => string, ...paths: string[]): void {
  const open = t.mock.method(fs, "openSync");
  syncBuiltinESMExports();
  try {
    assert.equal(edit(), "{}");
    for (const path of paths) {
      assert.equal(open.mock.calls.some(({ arguments: args }) => args[0] === path), false, path);
    }
  } finally {
    open.mock.restore();
    syncBuiltinESMExports();
  }
}

function fixture(t: TestContext, now = NOW) {
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-gate-fixtouch-")));
  const home = join(temp, "home");
  const cwd = join(temp, "repo");
  const stateDir = join(home, "gate-state");
  const cache = fixTouchCachePath(home);
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(dirname(cache), { recursive: true });
  const oldHome = process.env.ROCKY_HOME;
  const oldClarity = process.env.ROCKY_CLARITY_ADVISORY;
  process.env.ROCKY_HOME = home;
  delete process.env.ROCKY_CLARITY_ADVISORY;
  t.mock.method(Date, "now", () => now);
  t.after(() => {
    if (oldHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = oldHome;
    if (oldClarity === undefined) delete process.env.ROCKY_CLARITY_ADVISORY;
    else process.env.ROCKY_CLARITY_ADVISORY = oldClarity;
    rmSync(temp, { recursive: true, force: true });
  });

  const entry: FixTouchEntry = {
    root: cwd, path: REL, cmd: "npm test", signature: "TypeError: token undefined",
    ts: Date.UTC(2026, 10, 12),
  };

  function edit(filePath = join(cwd, REL), session = "s1", rationale?: string): string {
    const result = gateEvent("claude-code", JSON.stringify({
      tool_name: "Edit", tool_input: { file_path: filePath }, session_id: session, cwd, rationale,
    }));
    assert.equal(result.exitCode, 0);
    return result.stdout;
  }

  function seed(entries = [entry], builtAt = now): void {
    writeFileSync(cache, JSON.stringify({ v: 1, builtAt, entries }), "utf8");
  }

  return {
    home, cwd, cache, stateDir, entry, edit, seed,
    enable: () => writeFileSync(join(home, "fixtouch-on"), ""),
  };
}

test("fix-touch is silent without its marker even with a fresh matching cache", (t) => {
  const f = fixture(t);
  f.seed();
  assert.equal(f.edit(), "{}");
  assert.equal(existsSync(f.stateDir), false);
});

test("default-off fix-touch preserves main's clarity stdout byte for byte", (t) => {
  const f = fixture(t);
  f.seed();
  assert.equal(f.edit(REL, "s1", VAGUE), advice(CLARITY_TEXT));
  assert.equal(existsSync(f.stateDir), false);
});

test("enabled fix-touch prints the exact cache-backed note and passes causal-words lint", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  const text = context(f.edit());
  assert.equal(text, TOUCH_TEXT);
  assert.deepEqual(causalWordViolations([text]), []);
});

test("fix-touch still prints its note when memory.jsonl is a directory", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  mkdirSync(join(f.home, "memory.jsonl"));
  assert.equal(context(f.edit()), TOUCH_TEXT);
});

test("fix-touch ignores a cache symlink to memory.jsonl containing a valid cache", (t) => {
  if (skipIfSymlinkUnavailable(t)) return;
  const f = fixture(t);
  f.enable();
  const memory = join(f.home, "memory.jsonl");
  writeFileSync(memory, JSON.stringify({ v: 1, builtAt: NOW, entries: [f.entry] }));
  symlinkSync(memory, f.cache, "file");

  assertSilentWithoutOpening(t, f.edit, f.cache, memory);
  assert.equal(existsSync(f.stateDir), false);
});

test("fix-touch ignores a shown-state symlink to memory.jsonl containing valid state", (t) => {
  if (skipIfSymlinkUnavailable(t)) return;
  const f = fixture(t);
  f.enable();
  f.seed();
  mkdirSync(f.stateDir);
  const memory = join(f.home, "memory.jsonl");
  const stateFile = join(f.stateDir, "s1.fixtouch.json");
  writeFileSync(memory, "[]");
  symlinkSync(memory, stateFile, "file");

  assertSilentWithoutOpening(t, f.edit, stateFile, memory);
  assert.deepEqual(readdirSync(f.stateDir), ["s1.fixtouch.json"]);
  assert.equal(readFileSync(memory, "utf8"), "[]");
});

for (const kind of ["derived", "gate-state"]) {
  test(`fix-touch ignores a linked ${kind} directory`, (t) => {
    if (process.platform !== "win32" && skipIfSymlinkUnavailable(t, "dir")) return;
    const f = fixture(t);
    f.enable();
    f.seed();
    const real = join(f.home, "real");
    const link = join(f.home, kind);
    if (kind === "derived") fs.renameSync(link, real);
    else mkdirSync(real);
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

    assertSilentWithoutOpening(t, f.edit, join(link, kind === "derived" ? "attempts-hot.json" : "s1.fixtouch.json"));
    assert.deepEqual(readdirSync(real), kind === "derived" ? ["attempts-hot.json"] : []);
  });
}

test("fix-touch ignores oversized shown-state data", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  mkdirSync(f.stateDir);
  const stateFile = join(f.stateDir, "s1.fixtouch.json");
  const oversized = "[]".padEnd(2 * 1024 * 1024 + 1);
  writeFileSync(stateFile, oversized);

  assert.equal(f.edit(), "{}");
  assert.equal(readFileSync(stateFile, "utf8"), oversized);
});

test("fix-touch bounds the descriptor read if shown state grows during the read", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  mkdirSync(f.stateDir);
  const stateFile = join(f.stateDir, "s1.fixtouch.json");
  writeFileSync(stateFile, "[]");

  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  let stateFd: number | undefined;
  let requested = 0;
  const open = t.mock.method(fs, "openSync", (...args: Parameters<typeof originalOpen>) => {
    const fd = originalOpen(...args);
    if (args[0] === stateFile) stateFd = fd;
    return fd;
  });
  const read = t.mock.method(fs, "readSync", (
    fd: number, buffer: Buffer, offset: number, length: number, position: number | null,
  ) => {
    if (fd === stateFd) {
      if (requested === 0) writeFileSync(stateFile, "[]".padEnd(2 * 1024 * 1024 + 1));
      requested += length;
    }
    return originalRead(fd, buffer, offset, length, position);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(f.edit(), "{}");
    assert.equal(requested, 3);
  } finally {
    open.mock.restore();
    read.mock.restore();
    syncBuiltinESMExports();
  }
});

test("relative and absolute file paths match the same cache entry", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  assert.equal(context(f.edit(REL)), TOUCH_TEXT);
  assert.equal(context(f.edit(join(f.cwd, REL), "s2")), TOUCH_TEXT);
});

test("missing, stale and oversized fix-touch caches stay silent", (t) => {
  const f = fixture(t);
  f.enable();
  assert.equal(f.edit(), "{}");
  f.seed([f.entry], NOW - 8 * 86_400_000);
  assert.equal(f.edit(), "{}");
  f.seed();
  const valid = readFileSync(f.cache, "utf8");
  writeFileSync(f.cache, valid.padEnd(FIXTOUCH_CACHE_MAX_BYTES + 1), "utf8");
  assert.equal(f.edit(), "{}");
  assert.equal(existsSync(f.stateDir), false);
});

test("fix-touch shows once per session and path", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed([f.entry, { ...f.entry, path: "src/other.ts" }]);
  assert.equal(context(f.edit()), TOUCH_TEXT);
  assert.equal(f.edit(REL), "{}");
  if (process.platform === "win32") assert.equal(f.edit(REL.toUpperCase()), "{}");
  assert.match(context(f.edit("src/other.ts")), /Earlier record for src\/other\.ts:/);
  assert.equal(context(f.edit(REL, "s2")), TOUCH_TEXT);
});

test("generic Read leaves fix-touch available for the next Edit in the same session", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  const call = (toolName: string) => gateEvent("generic", JSON.stringify({
    tool_name: toolName, tool_input: { file_path: REL }, session_id: "s1", cwd: f.cwd,
  }));
  assert.deepEqual(call("Read"), { stdout: "{}", exitCode: 0 });
  assert.equal(existsSync(f.stateDir), false);
  assert.deepEqual(call("Edit"), { stdout: advice(TOUCH_TEXT), exitCode: 0 });
});

test("leftover temp files leave future fix-touch state writes available", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  mkdirSync(f.stateDir);
  const stateFile = join(f.stateDir, "s1.fixtouch.json");
  writeFileSync(`${stateFile}.tmp`, "interrupted write");
  writeFileSync(`${stateFile}.${process.pid}.feedbeef.tmp`, "interrupted write");
  assert.equal(f.edit(), advice(TOUCH_TEXT));
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), [`${rootKey(f.cwd)}\n${REL}`]);
  assert.equal(f.edit(), "{}");
});

test("fix-touch reclaims a stale lock even when it contains a live PID", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  mkdirSync(f.stateDir);
  const stateFile = join(f.stateDir, "s1.fixtouch.json");
  const lock = `${stateFile}.lock`;
  writeFileSync(lock, String(process.pid));
  const stale = new Date(NOW - 10_000);
  utimesSync(lock, stale, stale);
  assert.equal(f.edit(), advice(TOUCH_TEXT));
  assert.equal(existsSync(lock), false);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), [`${rootKey(f.cwd)}\n${REL}`]);
  assert.equal(f.edit(), "{}");
});

test("two overlapping first edits emit exactly one fix-touch advisory", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  const stateFile = join(f.stateDir, "s1.fixtouch.json");
  const lock = `${stateFile}.lock`;
  const originalOpen = fs.openSync;
  let competing: string | undefined;
  fs.openSync = (...args: Parameters<typeof originalOpen>) => {
    const fd = originalOpen(...args);
    if (args[0] === lock && args[1] === "wx" && competing === undefined) {
      const fresh = new Date(NOW);
      utimesSync(lock, fresh, fresh);
      competing = f.edit();
    }
    return fd;
  };
  syncBuiltinESMExports();
  let winner: string;
  try {
    winner = f.edit();
  } finally {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(competing, "{}");
  assert.equal(winner, advice(TOUCH_TEXT));
  assert.equal(existsSync(lock), false);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), [`${rootKey(f.cwd)}\n${REL}`]);
  assert.equal(f.edit(), "{}");
});

test("year-10000 cache entries stay silent without consuming the session key", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed([{ ...f.entry, ts: Date.UTC(10000, 0, 1) }]);
  assert.equal(f.edit(), "{}");
  assert.equal(existsSync(f.stateDir), false);
  f.seed();
  assert.equal(f.edit(), advice(TOUCH_TEXT));
});

test("the gate requires a four-digit year even when a cache timestamp is fresh", (t) => {
  const now = Date.UTC(10000, 0, 1);
  const f = fixture(t, now);
  f.enable();
  f.seed([{ ...f.entry, ts: now }]);
  assert.equal(f.edit(), "{}");
  assert.equal(existsSync(f.stateDir), false);
  f.seed([{ ...f.entry, ts: now - 1 }]);
  assert.equal(f.edit(), advice(TOUCH_TEXT.replace("2026-11-12", "9999-12-31")));
});

test("fix-touch evicts the oldest session key at the 256-key limit", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  mkdirSync(f.stateDir);
  const stateFile = join(f.stateDir, "s1.fixtouch.json");
  const prefix = `${rootKey(f.cwd, process.platform)}\n`;
  const keys = Array.from({ length: 256 }, (_, index) => `${prefix}src/old-${index}.ts`);
  writeFileSync(stateFile, JSON.stringify(keys), "utf8");
  assert.equal(context(f.edit()), TOUCH_TEXT);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), [...keys.slice(1), prefix + REL]);
});

test("unwritable fix-touch state suppresses only the fix-touch note", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  writeFileSync(f.stateDir, "");
  assert.equal(f.edit(), "{}");
  assert.equal(f.edit(REL, "s1", VAGUE), advice(CLARITY_TEXT));
});

test("unmatched paths and paths outside the cached root stay silent", (t) => {
  const f = fixture(t);
  f.enable();
  f.seed();
  assert.equal(f.edit("src/other.ts"), "{}");
  const other = join(f.cwd, "..", "other");
  mkdirSync(join(other, ".git"), { recursive: true });
  assert.equal(f.edit(join(other, REL)), "{}");
  assert.equal(existsSync(f.stateDir), false);
});

test("clarity and fix-touch both print when capped ASCII fields fit within 1024 bytes", (t) => {
  const f = fixture(t);
  const cmd = "x".repeat(FIXTOUCH_CMD_MAX);
  const signature = "y".repeat(FIXTOUCH_SIGNATURE_MAX);
  f.enable();
  f.seed([{ ...f.entry, cmd, signature }]);
  const stdout = f.edit(REL, "s1", VAGUE);
  assert.ok(Buffer.byteLength(stdout, "utf8") <= 1024);
  const touch = TOUCH_TEXT.slice("rocky: ".length)
    .replace("npm test", cmd).replace("TypeError: token undefined", signature);
  assert.equal(context(stdout), `${CLARITY_TEXT} ${touch}`);
});

test("a combined note over 1024 UTF-8 bytes falls back to clarity without consuming fix-touch", (t) => {
  const f = fixture(t);
  const cmd = "𐐀".repeat(FIXTOUCH_CMD_MAX);
  const signature = "𐐁".repeat(FIXTOUCH_SIGNATURE_MAX);
  f.enable();
  f.seed([{ ...f.entry, cmd, signature }]);
  const touch = TOUCH_TEXT.slice("rocky: ".length)
    .replace("npm test", cmd).replace("TypeError: token undefined", signature);
  const combined = advice(`${CLARITY_TEXT} ${touch}`);
  const touchOnly = advice(`rocky: ${touch}`);
  assert.ok(combined.length < 1024 && Buffer.byteLength(combined, "utf8") > 1024);
  assert.ok(Buffer.byteLength(touchOnly, "utf8") <= 1024);
  assert.equal(f.edit(REL, "s1", VAGUE), advice(CLARITY_TEXT));
  assert.equal(existsSync(f.stateDir), false);
  assert.equal(f.edit(REL), touchOnly);
});

test("hostile fix-touch cache text is redacted and rendered on one line", (t) => {
  const f = fixture(t);
  const token = `ghp_${"a".repeat(36)}`;
  f.enable();
  f.seed([{
    ...f.entry,
    cmd: `test\u202e\nwith ${token}`,
    signature: `Error: ${token}\u202e\nextra line`,
  }]);
  const text = context(f.edit());
  assert.match(text, /run of test with /);
  assert.match(text, /error "Error: /);
  assert.doesNotMatch(text, /ghp_|[\r\n\u202e\u2028\u2029]|extra line/u);
});
