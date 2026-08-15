import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idleLine, parseWatchArgs, unseenLabels, watch, WATCH_IDLE_MS } from "../commands/watch.js";
import { fingerprint, FINGERPRINT_ALGORITHM_VERSION } from "../core/fingerprint.js";
import { quoteShellPath } from "../core/shell-quote.js";
import { validateRockyPhrase } from "../ui/phrases.js";
import type { NotifyInput } from "../core/notify.js";
import type { ExecResult } from "../core/exec.js";

function sandboxHome(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-watch-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "rocky-home");
}

async function withRockyHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = dir;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr };
  } finally {
    process.stderr.write = original;
  }
}

function fakeNotifier(): { calls: NotifyInput[]; notify: (input: NotifyInput) => void } {
  const calls: NotifyInput[] = [];
  return { calls, notify: (input) => { calls.push(input); } };
}

/**
 * A shell command whose stderr is exactly `marker`, so the fingerprint
 * watch's onFailure computes from real stderr can be predicted and seeded
 * ahead of time. Mirrors cli-process.test.ts's failingCommandPrinting.
 */
function failingCommandPrinting(marker: string): string {
  const script = `console.error('${marker}');process.exit(1)`;
  return `${quoteShellPath(process.execPath, process.platform)} -e ${quoteShellPath(script, process.platform)}`;
}

function nodeCommand(source: string): string {
  return `${quoteShellPath(process.execPath, process.platform)} -e ${quoteShellPath(source, process.platform)}`;
}

function exitCommand(code: number): string {
  return nodeCommand(`process.exit(${code})`);
}

function sleepCommand(ms: number): string {
  return nodeCommand(`setTimeout(() => process.exit(0), ${ms})`);
}

function stderrExitCommand(message: string, code: number): string {
  const literal = message.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  return nodeCommand(`process.stderr.write('${literal}\\n'); process.exit(${code})`);
}

test("parseWatchArgs parses --quiet, a positional command, the -- escape, and rejects unknown flags", () => {
  assert.deepEqual(parseWatchArgs(["--quiet", "npm", "run", "build"]), { quiet: true, cmd: "npm run build" });
  assert.deepEqual(parseWatchArgs(["npm run build"]), { quiet: false, cmd: "npm run build" });
  assert.deepEqual(parseWatchArgs(["--", "--quiet"]), { quiet: false, cmd: "--quiet" });
  assert.throws(() => parseWatchArgs(["--bogus"]));
  assert.deepEqual(
    parseWatchArgs(["--quiet", "--quiet", "npm", "test"]),
    { quiet: true, cmd: "npm test" },
  );
});

test("WATCH_IDLE_MS is ten minutes", () => {
  assert.equal(WATCH_IDLE_MS, 1000 * 60 * 10);
});

test("idleLine composes the voice-valid idle sentence for a given elapsed duration", () => {
  assert.equal(idleLine(600_000), "still waiting. 10 minutes. waiting is easy for me");
  assert.equal(idleLine(60_000), "still waiting. 1 minute. waiting is easy for me");
  assert.deepEqual(validateRockyPhrase(idleLine(600_000)), []);
});

test("unseenLabels returns each non-empty label once and mutates the session set", () => {
  const seen = new Set<string>();

  assert.deepEqual(unseenLabels(seen, "a\nb\n"), ["a", "b"]);
  assert.deepEqual([...seen], ["a", "b"]);
  assert.deepEqual(unseenLabels(seen, "a\nb\n"), []);
  assert.deepEqual(unseenLabels(seen, "\na\n\nb\n"), []);
});

test("unseenLabels strips CRLF separators without leaving carriage returns in labels", () => {
  const seen = new Set<string>();

  assert.deepEqual(unseenLabels(seen, "first\r\nsecond\r\n"), ["first", "second"]);
  assert.equal([...seen].some((line) => line.includes("\r")), false);
});

test("watch polls labels during an active command, speaks appends once, and never mutates the file", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  const labelsPath = join(home, "labels");
  writeFileSync(labelsPath, "first\n", "utf8");
  const spoken: string[] = [];
  let poll: (() => void) | undefined;
  let clearCalls = 0;
  let unrefCalls = 0;
  const timer = { unref: () => { unrefCalls += 1; } };
  const dependencies = {
    notify: () => {},
    setInterval: (callback: () => void) => {
      poll = callback;
      return timer as unknown as NodeJS.Timeout;
    },
    clearInterval: () => { clearCalls += 1; },
    say: (line: string) => { spoken.push(line); },
  };

  const running = withRockyHome(home, () => watch([sleepCommand(150)], dependencies));
  assert.ok(poll, "watch must install a recurring label poll");
  assert.deepEqual(spoken, ["first"], "watch must perform an immediate poll");
  assert.equal(clearCalls, 0, "poll timer must remain active while command runs");

  writeFileSync(labelsPath, "first\nsecond\n", "utf8");
  poll!();
  writeFileSync(labelsPath, "first\nsecond\nthird\n", "utf8");
  poll!();
  poll!();

  const expectedBytes = "first\nsecond\nthird\n";
  assert.equal(readFileSync(labelsPath, "utf8"), expectedBytes);
  assert.deepEqual(spoken, ["first", "second", "third"]);
  assert.equal(await running, 0);
  assert.equal(clearCalls, 1, "poll timer must be cleared after success");
  assert.equal(unrefCalls, 1, "poll timer must not keep the process alive");
  assert.equal(readFileSync(labelsPath, "utf8"), expectedBytes);
});

test("watch sanitizes terminal and invisible controls from labels read from the real file", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  const labelsPath = join(home, "labels");
  const original = Buffer.from([
    "keep CSI \u001b[31mred\u001b[0m",
    "keep OSC \u001b]0;terminal-title\u0007safe after OSC",
    "keep C0\u0000NUL\u0007BEL\u000bVT\u007fDEL\u0085C1",
    "keep bidi\u202Ehidden\u2060zero\u200Bwidth\uFEFFend",
    "keep incomplete \u001b[31",
    "\r\n",
  ].join("\r\n"), "utf8");
  writeFileSync(labelsPath, original);

  const spoken: string[] = [];
  let poll: (() => void) | undefined;
  const timer = { unref: () => {} };
  const dependencies = {
    notify: () => {},
    setInterval: (callback: () => void) => {
      poll = callback;
      return timer as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {},
    say: (line: string) => { spoken.push(line); },
  };

  const running = withRockyHome(home, () => watch([sleepCommand(150)], dependencies));
  assert.ok(poll, "watch must poll the real labels file");
  assert.equal(await running, 0);

  const terminalOrControl = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u001B]/u;
  assert.ok(spoken.some((line) => line.includes("keep CSI") && line.includes("red")));
  assert.ok(spoken.some((line) => line.includes("safe after OSC")));
  assert.ok(spoken.some((line) => line.includes("keep incomplete")));
  assert.ok(spoken.some((line) => line.includes("keep C0") && line.includes("C1")));
  assert.ok(spoken.some((line) => line.includes("keep bidi") && line.includes("end")));
  for (const line of spoken) {
    assert.doesNotMatch(line, terminalOrControl);
    assert.doesNotMatch(line, /[\r\n]/u);
    assert.ok(line.length <= 400, `label exceeded 400 characters: ${line.length}`);
  }
  assert.deepEqual(readFileSync(labelsPath), original, "watch must not rewrite labels bytes");
});

test("watch ignores missing, empty, unchanged, and unreadable label polls", async (t) => {
  const home = sandboxHome(t);
  const spoken: string[] = [];
  let poll: (() => void) | undefined;
  let reads = 0;
  const timer = { unref: () => {} };
  const dependencies = {
    notify: () => {},
    readLabels: (_path: string) => {
      reads += 1;
      if (reads === 1) throw new Error("read failed");
      if (reads === 2) return "";
      return "label\n";
    },
    setInterval: (callback: () => void) => {
      poll = callback;
      return timer as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {},
    say: (line: string) => { spoken.push(line); },
  };

  const running = withRockyHome(home, () => watch([sleepCommand(150)], dependencies));
  assert.ok(poll);
  poll!();
  poll!();
  poll!();
  poll!();
  assert.equal(await running, 0);
  assert.deepEqual(spoken, ["label"]);
});

test("quiet watch neither reads nor speaks labels", async (t) => {
  const home = sandboxHome(t);
  let reads = 0;
  let timers = 0;
  const spoken: string[] = [];
  const dependencies = {
    notify: () => {},
    readLabels: () => { reads += 1; return "quiet label\n"; },
    setInterval: () => {
      timers += 1;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {},
    say: (line: string) => { spoken.push(line); },
  };

  const { result, stderr } = await withRockyHome(home, () =>
    captureStderr(() => watch(["--quiet", exitCommand(0)], dependencies)));
  assert.equal(result, 0);
  assert.equal(reads, 0);
  assert.equal(timers, 0);
  assert.deepEqual(spoken, []);
  assert.doesNotMatch(stderr, /quiet label/);
});

test("watch clears its label poll timer for success, failure, and cancellation", async (t) => {
  for (const [name, command, expected] of [
    ["success", exitCommand(0), 0],
    ["failure", exitCommand(1), 1],
    ["cancel", exitCommand(130), 130],
  ] as const) {
    const home = sandboxHome(t);
    let clearCalls = 0;
    const timer = { unref: () => {} };
    const dependencies = {
      notify: () => {},
      setInterval: () => timer as unknown as NodeJS.Timeout,
      clearInterval: () => { clearCalls += 1; },
      say: () => {},
    };
    const result = await withRockyHome(home, () => watch([command], dependencies));
    assert.equal(result, expected, name);
    assert.equal(clearCalls, 1, `${name} must clear label timer`);
  }
});

test("watch speaks the composed outcome line on success and on failure, and both pass the voice validator", async (t) => {
  const home = sandboxHome(t);
  const notifier = fakeNotifier();

  const ok = await withRockyHome(home, () => captureStderr(() => watch([exitCommand(0)], { notify: notifier.notify })));
  assert.equal(ok.result, 0);
  const okLine = /\[Rocky\] (command finish\. good good\. \d+ seconds?\.)/.exec(ok.stderr);
  assert.ok(okLine, `expected a composed watch-ok line in stderr, got: ${ok.stderr}`);
  assert.deepEqual(validateRockyPhrase(okLine![1]!), []);

  const fail = await withRockyHome(home, () => captureStderr(() => watch([exitCommand(1)], { notify: notifier.notify })));
  assert.equal(fail.result, 1);
  const failLine = /\[Rocky\] (command dies\. bad\. \d+ seconds?\.)/.exec(fail.stderr);
  assert.ok(failLine, `expected a composed watch-fail line in stderr, got: ${fail.stderr}`);
  assert.deepEqual(validateRockyPhrase(failLine![1]!), []);
});

test("watch() with an empty command speaks the same 'no command' line run uses and exits 2", async (t) => {
  const home = sandboxHome(t);
  const { result, stderr } = await withRockyHome(home, () => captureStderr(() => watch([""])));
  assert.equal(result, 2);
  assert.match(stderr, /no command\. give command, question/);
});

test("--quiet prints no [Rocky] prefix on success or failure, and never notifies", async (t) => {
  const home = sandboxHome(t);
  const notifier = fakeNotifier();

  const ok = await withRockyHome(home, () =>
    captureStderr(() => watch(["--quiet", exitCommand(0)], { notify: notifier.notify })));
  assert.equal(ok.result, 0);
  assert.doesNotMatch(ok.stderr, /\[Rocky\]/);

  const fail = await withRockyHome(home, () =>
    captureStderr(() => watch(["--quiet", stderrExitCommand("boom", 1)], { notify: notifier.notify })));
  assert.equal(fail.result, 1);
  assert.doesNotMatch(fail.stderr, /\[Rocky\]/);
  assert.match(fail.stderr, /duration:/);
  assert.match(fail.stderr, /exit: 1/);
  assert.match(fail.stderr, /log:/);

  assert.deepEqual(notifier.calls, []);
});

test("Ctrl-C-style exit codes (130, 143) pass through with no memory record, no log, no notification", async (t) => {
  for (const code of [130, 143]) {
    const home = sandboxHome(t);
    const notifier = fakeNotifier();
    const { result, stderr } = await withRockyHome(home, () =>
      captureStderr(() => watch([exitCommand(code)], { notify: notifier.notify })));
    assert.equal(result, code);
    assert.equal(stderr, "");
    assert.deepEqual(notifier.calls, []);
    assert.equal(existsSync(join(home, "memory.jsonl")), false);
  }
});

test("watch keeps spawn-not-started out of memory/logs but preserves facts and notification", async (t) => {
  const quietHome = sandboxHome(t);
  const quietResult: ExecResult = {
    started: false, code: 127, stderr: "spawn ENOENT", tail: ["spawn ENOENT"], durationMs: 5,
  };
  const quiet = await withRockyHome(quietHome, () => captureStderr(() => watch(
    ["--quiet", "synthetic-not-started"],
    { notify: () => { throw new Error("quiet watch must not notify"); }, runProcess: async () => quietResult },
  )));
  assert.equal(quiet.result, 127);
  assert.match(quiet.stderr, /duration:/);
  assert.match(quiet.stderr, /exit: 127/);
  assert.doesNotMatch(quiet.stderr, /log:/);
  assert.equal(existsSync(join(quietHome, "memory.jsonl")), false);
  assert.equal(existsSync(join(quietHome, "watch")), false);

  const publicHome = sandboxHome(t);
  const notifier = fakeNotifier();
  const publicResult = await withRockyHome(publicHome, () => captureStderr(() => watch(
    ["synthetic-not-started"],
    { notify: notifier.notify, runProcess: async () => quietResult },
  )));
  assert.equal(publicResult.result, 127);
  assert.deepEqual(notifier.calls, [{ cmd: "synthetic-not-started", ok: false, durationMs: 5 }]);
  assert.equal(existsSync(join(publicHome, "memory.jsonl")), false);
  assert.equal(existsSync(join(publicHome, "watch")), false);
});

test("watch records a started child that exits 127", async (t) => {
  const home = sandboxHome(t);
  const notifier = fakeNotifier();
  const childResult: ExecResult = {
    started: true, code: 127, stderr: "child-127", tail: ["child-127"], durationMs: 5,
  };
  const result = await withRockyHome(home, () => captureStderr(() => watch(
    ["synthetic-started-127"],
    { notify: notifier.notify, runProcess: async () => childResult },
  )));
  assert.equal(result.result, 127);
  assert.equal(existsSync(join(home, "memory.jsonl")), true);
  assert.equal(existsSync(join(home, "watch")), true);
  assert.deepEqual(notifier.calls, [{ cmd: "synthetic-started-127", ok: false, durationMs: 5 }]);
});

test("watch's failure path admits when the remembered fix comes from a different directory", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  const marker = "watch test boom elsewhere";
  const fp = fingerprint(marker, "whatever failed before", 1);
  const here = process.cwd();
  const elsewhere = join(home, "elsewhere-project");
  const failure = {
    kind: "failure", id: "w-elsewhere-failure", ts: 1_700_000_000_000, cwd: here,
    cmd: "whatever failed before", exitCode: 1, fingerprint: fp, fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: [marker], excerpt: marker,
    origin: "watch",
  };
  const fix = {
    kind: "fix", id: "w-elsewhere-fix", ts: 1_700_000_001_000, cwd: elsewhere,
    cmd: "whatever failed before", failureIds: ["w-elsewhere-failure"],
  };
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`, "utf8");
  const notifier = fakeNotifier();

  const { result, stderr } = await withRockyHome(home, () =>
    captureStderr(() => watch([failingCommandPrinting(marker)], { notify: notifier.notify })));

  assert.equal(result, 1);
  assert.match(stderr, /but fix comes from other place\./);
  assert.match(stderr, new RegExp(`place:\\s*${elsewhere.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("watch's success path links a fix exactly like run's onSuccess, using the same sentence", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  const cwd = process.cwd();
  const failure = {
    kind: "failure", id: "w-fix-failure", ts: Date.now() - 1000, cwd,
    cmd: "echo all-good", exitCode: 1, fingerprint: "deadbeef",
    signature: ["echo all-good"], excerpt: "irrelevant", origin: "watch",
  };
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(failure)}\n`, "utf8");
  writeFileSync(join(home, "pending"), "", "utf8");
  const notifier = fakeNotifier();

  const { result, stderr } = await withRockyHome(home, () =>
    captureStderr(() => watch(["echo all-good"], { notify: notifier.notify })));

  assert.equal(result, 0);
  assert.match(stderr, /command works now\. you fix it\. I remember the fix\. good good good\./);
  assert.equal(existsSync(join(home, "pending")), false, "run/watch shared resolver clears pending atomically");
});

test("an unwritable watch log speaks watch-log-unwritable but still records the failure", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  // A file sitting where the watch/ directory belongs makes mkdirSync fail.
  writeFileSync(join(home, "watch"), "blocker", "utf8");
  const notifier = fakeNotifier();

  const { result, stderr } = await withRockyHome(home, () =>
    captureStderr(() => watch([stderrExitCommand("boom", 1)], { notify: notifier.notify })));

  assert.equal(result, 1);
  assert.match(stderr, /watch folder does not open for me\. no log this time\. memory still remembers\./);

  const lines = readFileSync(join(home, "memory.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]!) as { origin?: string }).origin, "watch");
});

test("a memory-write failure on the watch failure path still writes the watch log (Minor 5)", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  // memory.jsonl as a directory makes recordWatchFailure's appendFileSync throw,
  // independent of watch/ which stays writable — the log must not be lost.
  mkdirSync(join(home, "memory.jsonl"), { recursive: true });
  const notifier = fakeNotifier();

  const { result, stderr } = await withRockyHome(home, () =>
    captureStderr(() => watch([stderrExitCommand("boom", 1)], { notify: notifier.notify })));

  assert.equal(result, 1);
  assert.match(stderr, /I cannot write memory\. this one I forget\./);
  const logFiles = readdirSync(join(home, "watch")).filter((name) => name.endsWith(".log"));
  assert.equal(logFiles.length, 1);
  assert.match(stderr, new RegExp(`log: .*${logFiles[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("watch notifies via the injected dependency on both success and failure", async (t) => {
  const home = sandboxHome(t);
  const notifier = fakeNotifier();

  const ok = await withRockyHome(home, () => captureStderr(() => watch([exitCommand(0)], { notify: notifier.notify })));
  assert.equal(ok.result, 0);

  const fail = await withRockyHome(home, () => captureStderr(() => watch([exitCommand(1)], { notify: notifier.notify })));
  assert.equal(fail.result, 1);

  assert.equal(notifier.calls.length, 2);
  assert.equal(notifier.calls[0]!.ok, true);
  assert.equal(notifier.calls[1]!.ok, false);
});

test("watch skips notification when config disables it, even without --quiet", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ version: 1, ai: { enabled: false }, watch: { notify: false } }),
    "utf8",
  );
  const notifier = fakeNotifier();

  const { result } = await withRockyHome(home, () => captureStderr(() => watch([exitCommand(0)], { notify: notifier.notify })));

  assert.equal(result, 0);
  assert.deepEqual(notifier.calls, []);
});

test("watch notifies by default when config is missing, invalid JSON, or unreadable", async (t) => {
  const setups: Array<(home: string) => void> = [
    () => {},
    (home) => { mkdirSync(home, { recursive: true }); writeFileSync(join(home, "config.json"), "{not json", "utf8"); },
    (home) => { mkdirSync(join(home, "config.json"), { recursive: true }); },
  ];

  for (const setup of setups) {
    const home = sandboxHome(t);
    setup(home);
    const notifier = fakeNotifier();
    const { result } = await withRockyHome(home, () =>
      captureStderr(() => watch([exitCommand(0)], { notify: notifier.notify })));
    assert.equal(result, 0);
    assert.equal(notifier.calls.length, 1);
  }
});

test("options are honoured after the command, the position --help documents", () => {
  // `rocky watch "sleep 1" --quiet` used to append the flag to the command:
  // `sleep 1 --quiet` really ran, a wrapped exit 0 became 1, and a failure that
  // never happened entered memory. Rocky must never edit the command he is handed.
  assert.deepEqual(parseWatchArgs(["sleep 1", "--quiet"]), { quiet: true, cmd: "sleep 1" });
  assert.deepEqual(parseWatchArgs(["--quiet", "sleep 1"]), { quiet: true, cmd: "sleep 1" });
  assert.deepEqual(parseWatchArgs(["npm", "run", "build", "--quiet"]), { quiet: true, cmd: "npm run build" });

  // A trailing unknown flag is rejected exactly like a leading one — never
  // silently appended to the command.
  assert.throws(() => parseWatchArgs(["true", "--bogus"]), /unknown option: --bogus/);
  assert.throws(() => parseWatchArgs(["--bogus", "true"]), /unknown option: --bogus/);

  // `--` still ends option parsing, so a literal flag token stays expressible.
  assert.deepEqual(parseWatchArgs(["--", "sleep 1", "--quiet"]), { quiet: false, cmd: "sleep 1 --quiet" });
});
