import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idleLine, parseWatchArgs, watch, WATCH_IDLE_MS } from "../commands/watch.js";
import { fingerprint } from "../core/fingerprint.js";
import { quoteShellPath } from "../core/shell-quote.js";
import { validateRockyPhrase } from "../ui/phrases.js";
import type { NotifyInput } from "../core/notify.js";

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

test("watch speaks the composed outcome line on success and on failure, and both pass the voice validator", async (t) => {
  const home = sandboxHome(t);
  const notifier = fakeNotifier();

  const ok = await withRockyHome(home, () => captureStderr(() => watch(["sh -c 'exit 0'"], { notify: notifier.notify })));
  assert.equal(ok.result, 0);
  const okLine = /\[Rocky\] (command finish\. good good\. \d+ seconds?\.)/.exec(ok.stderr);
  assert.ok(okLine, `expected a composed watch-ok line in stderr, got: ${ok.stderr}`);
  assert.deepEqual(validateRockyPhrase(okLine![1]!), []);

  const fail = await withRockyHome(home, () => captureStderr(() => watch(["sh -c 'exit 1'"], { notify: notifier.notify })));
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
    captureStderr(() => watch(["--quiet", "sh -c 'exit 0'"], { notify: notifier.notify })));
  assert.equal(ok.result, 0);
  assert.doesNotMatch(ok.stderr, /\[Rocky\]/);

  const fail = await withRockyHome(home, () =>
    captureStderr(() => watch(["--quiet", "sh -c \"echo boom >&2; exit 1\""], { notify: notifier.notify })));
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
      captureStderr(() => watch([`sh -c 'exit ${code}'`], { notify: notifier.notify })));
    assert.equal(result, code);
    assert.equal(stderr, "");
    assert.deepEqual(notifier.calls, []);
    assert.equal(existsSync(join(home, "memory.jsonl")), false);
  }
});

test("watch's failure path admits when the remembered fix comes from a different directory", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  const marker = "watch test boom elsewhere";
  const fp = fingerprint(marker);
  const here = process.cwd();
  const elsewhere = join(home, "elsewhere-project");
  const failure = {
    kind: "failure", id: "w-elsewhere-failure", ts: 1_700_000_000_000, cwd: here,
    cmd: "whatever failed before", exitCode: 1, fingerprint: fp, signature: [marker], excerpt: marker,
    origin: "watch",
  };
  const fix = {
    kind: "fix", id: "w-elsewhere-fix", ts: 1_700_000_001_000, cwd: elsewhere,
    cmd: "the remembered fix command", failureIds: ["w-elsewhere-failure"],
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
    cmd: "echo build-that-failed-before", exitCode: 1, fingerprint: "deadbeef",
    signature: ["echo build-that-failed-before"], excerpt: "irrelevant", origin: "watch",
  };
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(failure)}\n`, "utf8");
  const notifier = fakeNotifier();

  const { result, stderr } = await withRockyHome(home, () =>
    captureStderr(() => watch(["echo all-good"], { notify: notifier.notify })));

  assert.equal(result, 0);
  assert.match(stderr, /command works now\. you fix it\. I remember the fix\. good good good\./);
});

test("an unwritable watch log speaks watch-log-unwritable but still records the failure", async (t) => {
  const home = sandboxHome(t);
  mkdirSync(home, { recursive: true });
  // A file sitting where the watch/ directory belongs makes mkdirSync fail.
  writeFileSync(join(home, "watch"), "blocker", "utf8");
  const notifier = fakeNotifier();

  const { result, stderr } = await withRockyHome(home, () =>
    captureStderr(() => watch(["sh -c \"echo boom >&2; exit 1\""], { notify: notifier.notify })));

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
    captureStderr(() => watch(["sh -c \"echo boom >&2; exit 1\""], { notify: notifier.notify })));

  assert.equal(result, 1);
  assert.match(stderr, /I cannot write memory\. this one I forget\./);
  const logFiles = readdirSync(join(home, "watch")).filter((name) => name.endsWith(".log"));
  assert.equal(logFiles.length, 1);
  assert.match(stderr, new RegExp(`log: .*${logFiles[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("watch notifies via the injected dependency on both success and failure", async (t) => {
  const home = sandboxHome(t);
  const notifier = fakeNotifier();

  const ok = await withRockyHome(home, () => captureStderr(() => watch(["sh -c 'exit 0'"], { notify: notifier.notify })));
  assert.equal(ok.result, 0);

  const fail = await withRockyHome(home, () => captureStderr(() => watch(["sh -c 'exit 1'"], { notify: notifier.notify })));
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

  const { result } = await withRockyHome(home, () => captureStderr(() => watch(["sh -c 'exit 0'"], { notify: notifier.notify })));

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
      captureStderr(() => watch(["sh -c 'exit 0'"], { notify: notifier.notify })));
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
