import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLineReader, listenCommand, MAX_LINE_BYTES, parseRequestLine } from "../commands/listen.js";
import { setRepoCapture } from "../listening/consent.js";
import {
  COLLECTOR_TICK_MS,
  startCollectorLoop,
  type CollectorLoop,
  type ReconcileReport,
} from "../listening/collector-loop.js";
import { normalizeRepoRoot } from "../listening/repo-consent-read.js";
import { collectorPath, eventsPath, objectsDir } from "../listening/store-paths.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = join(packageRoot, "dist", "index.js");
const CONSENT = { yes: true, actor: "cli", onRevoke: "delete" } as const;
// Anti-hang guard only: a child process plus a worker thread start slowly under load.
const WAIT_MS = 30_000;

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const noGit = hasGit() ? false : "git unavailable";

async function until(check: () => boolean, ms = WAIT_MS): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return check();
}

type Line = Record<string, unknown>;

/** A running `rocky listen ...` child with its stdout split into lines. */
interface Listen {
  lines: string[];
  results(): Line[];
  stderr(): string;
  send(value: unknown): void;
  endInput(): void;
  /** Close our end of the child's stdout pipe, as a daemon that went away would. */
  dropOutput(): void;
  exited: Promise<number | null>;
  kill(): void;
}

function spawnListen(home: string, userHome: string, args: string[]): Listen {
  const child = spawn(process.execPath, [ENTRY, "listen", ...args], {
    env: { ...process.env, ROCKY_HOME: home, HOME: userHome, USERPROFILE: userHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines: string[] = [];
  let pending = "";
  let errText = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    lines.push(...parts);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errText += chunk;
  });
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  return {
    lines,
    results: () => lines.map((line) => JSON.parse(line) as Line).filter((line) => line.kind === "result"),
    stderr: () => errText,
    send: (value) => {
      child.stdin.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    },
    endInput: () => child.stdin.end(),
    dropOutput: () => child.stdout.destroy(),
    exited,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/** Owns every directory, child, and loop of one test and tears them down in a safe order. */
class Scratch {
  private readonly dirs: string[] = [];
  private readonly children: Listen[] = [];
  private readonly loops: CollectorLoop[] = [];
  readonly userHome: string;

  constructor(t: TestContext) {
    this.userHome = this.dir("rocky-listen-user-");
    t.after(() => this.dispose());
  }

  dir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    this.dirs.push(dir);
    return dir;
  }

  /** A Git repo with one commit, a gitignored directory, and a nested file. */
  repo(): string {
    const dir = this.dir("rocky-listen-repo-");
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".gitignore"), "ignored/\n");
    writeFileSync(join(dir, "kept.txt"), "hello\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.ts"), "export const answer = 42;\n");
    mkdirSync(join(dir, "ignored"));
    writeFileSync(join(dir, "ignored", "bulk.txt"), "noise\n");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
      { cwd: dir, stdio: "ignore" },
    );
    return dir;
  }

  copyOf(source: string): string {
    const dir = this.dir("rocky-listen-copy-");
    cpSync(source, dir, { recursive: true });
    return dir;
  }

  listen(home: string, args: string[] = ["collect", "--stdio"]): Listen {
    const child = spawnListen(home, this.userHome, args);
    this.children.push(child);
    return child;
  }

  loop(opts: Parameters<typeof startCollectorLoop>[0]): CollectorLoop {
    const loop = startCollectorLoop(opts);
    this.loops.push(loop);
    return loop;
  }

  private async dispose(): Promise<void> {
    for (const loop of this.loops) await loop.stop();
    for (const child of this.children) {
      child.kill();
      await child.exited;
    }
    for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function leaseExpires(repo: string, home: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(collectorPath(repo, home), "utf8")) as { expires: number }).expires;
  } catch {
    return undefined;
  }
}

test("collect reports roots and results as JSON lines only", { skip: noGit }, async (t) => {
  const s = new Scratch(t);
  const home = s.dir("rocky-listen-home-");
  const repo = s.repo();
  const key = normalizeRepoRoot(repo);
  assert.equal(setRepoCapture(repo, true, CONSENT, home).ok, true);
  const proc = s.listen(home);
  proc.send({ v: 1, root: repo });
  assert.ok(await until(() => proc.results().some((line) => line.root === key)), "a result line for the consented root");
  assert.ok(proc.lines.length >= 2, "at least one roots line and one result line");
  for (const raw of proc.lines) {
    const line = JSON.parse(raw) as Line;
    assert.equal(line.v, 1, raw);
    assert.ok(line.kind === "roots" || line.kind === "result", raw);
  }
  const roots = proc.lines.map((raw) => JSON.parse(raw) as Line).find((line) => line.kind === "roots");
  assert.deepEqual(roots, { v: 1, kind: "roots", roots: [{ root: key, owner: true }] });
  const result = proc.results().find((line) => line.root === key);
  assert.ok(result !== undefined);
  assert.deepEqual(Object.keys(result).sort(), ["at_ms", "coverage", "gaps", "kind", "reason", "root", "v"]);
  assert.equal(result.coverage, "complete");
  assert.equal(result.gaps, 0);
  assert.equal(result.reason, null);
  assert.equal(typeof result.at_ms, "number");
  assert.ok((result.at_ms as number) > 0);
});

test("collect exits 0 and releases its leases when stdin ends", { skip: noGit }, async (t) => {
  const s = new Scratch(t);
  const home = s.dir("rocky-listen-home-");
  const repo = s.repo();
  assert.equal(setRepoCapture(repo, true, CONSENT, home).ok, true);
  const proc = s.listen(home);
  assert.ok(await until(() => (leaseExpires(repo, home) ?? 0) > Date.now()), "the process holds a live lease");
  proc.endInput();
  assert.equal(await proc.exited, 0);
  assert.equal(leaseExpires(repo, home), 0, "ending stdin releases the lease for the next owner");
  for (const raw of proc.lines) assert.equal((JSON.parse(raw) as Line).v, 1, raw);
});

test("collect rejects other arguments", (t) => {
  const s = new Scratch(t);
  const home = s.dir("rocky-listen-home-");
  const rejected = [[], ["other"], ["collect"], ["collect", "--stdio", "extra"], ["--stdio"]];
  return Promise.all(rejected.map(async (args) => {
    const proc = s.listen(home, args);
    assert.equal(await proc.exited, 2, `args: ${args.join(" ")}`);
    assert.deepEqual(proc.lines, [], `stdout must stay empty for: ${args.join(" ")}`);
    const usage = proc.stderr().split("\n").filter((line) => line.length > 0);
    assert.equal(usage.length, 1, `one usage line for: ${args.join(" ")}`);
  }));
});

/** Resolves true once `proc` has printed `count` result lines for `root`. */
function untilResults(proc: Listen, root: string, count: number): Promise<boolean> {
  return until(() => proc.results().filter((line) => line.root === root).length >= count);
}

// The tick reconciles a root once and the next full pass is a minute away
// (CAPTURE_FULL_EVERY_MS), so a second result for the same root inside the wait
// can only come from a request line.
test("collect ignores a root without consent", { skip: noGit }, async (t) => {
  const s = new Scratch(t);
  const home = s.dir("rocky-listen-home-");
  const target = s.repo();
  const stranger = s.repo();
  const key = normalizeRepoRoot(target);
  assert.equal(setRepoCapture(target, true, CONSENT, home).ok, true);
  const proc = s.listen(home);
  assert.ok(await untilResults(proc, key, 1), "the first pass reconciles the consented root");
  // Lines are handled in order: once the second result shows up, the stranger line before it was already handled.
  proc.send({ v: 1, root: stranger });
  proc.send({ v: 1, root: target });
  assert.ok(await untilResults(proc, key, 2), "a request line reconciles the consented root again");
  const strangerKey = normalizeRepoRoot(stranger);
  assert.ok(!proc.results().some((line) => line.root === strangerKey), "no result for the unconsented root");
  assert.ok(!proc.lines.some((raw) => raw.includes(JSON.stringify(strangerKey).slice(1, -1))), "the root is never named");
  assert.equal(existsSync(collectorPath(stranger, home)), false, "no lease file for the unconsented root");
});

test("collect keeps serving after malformed input lines", { skip: noGit }, async (t) => {
  const s = new Scratch(t);
  const home = s.dir("rocky-listen-home-");
  const target = s.repo();
  const key = normalizeRepoRoot(target);
  assert.equal(setRepoCapture(target, true, CONSENT, home).ok, true);
  const proc = s.listen(home);
  assert.ok(await untilResults(proc, key, 1), "the first pass reconciles the consented root");
  proc.send("not json at all\n");
  proc.send(`{"v":2,"root":${JSON.stringify(target)}}\n`);
  proc.send(`{"v":1,"root":${JSON.stringify(`/${"a".repeat(MAX_LINE_BYTES + 10)}`)}}\n`);
  proc.send("\n");
  proc.send({ v: 1, root: target });
  assert.ok(await untilResults(proc, key, 2), "the valid line after the malformed ones is still served");
  for (const raw of proc.lines) assert.equal((JSON.parse(raw) as Line).v, 1, raw);
});

test("collect exits when its output pipe closes even if stdin stays open", { skip: noGit }, async (t) => {
  const s = new Scratch(t);
  const home = s.dir("rocky-listen-home-");
  const repo = s.repo();
  assert.equal(setRepoCapture(repo, true, CONSENT, home).ok, true);
  // Closed before the child starts, so its first roots line has nowhere to go.
  const proc = s.listen(home);
  proc.dropOutput();
  const guard = new Promise<string>((done) => {
    setTimeout(() => done("hung"), WAIT_MS).unref();
  });
  const outcome = await Promise.race([proc.exited, guard]);
  assert.equal(outcome, 0, "the process must exit on its own while stdin is still open");
  assert.equal(leaseExpires(repo, home), 0, "its leases are released");
});

/** A loop that records requests. It ends as `failed` at once when asked, else `stopped` on `stop()`. */
function fakeLoop(opts: { failed?: boolean; requests?: string[] } = {}): CollectorLoop {
  let finish: (result: "stopped" | "failed") => void = () => {};
  const done = new Promise<"stopped" | "failed">((resolve) => {
    finish = resolve;
  });
  if (opts.failed === true) finish("failed");
  return {
    kick: () => {},
    request: (root) => {
      opts.requests?.push(root);
    },
    stop: async () => finish("stopped"),
    done,
  };
}

test("a failed loop ends the command while the input stream is still open", async () => {
  const input = new PassThrough();
  const code = await listenCommand(["collect", "--stdio"], { startLoop: () => fakeLoop({ failed: true }), input });
  assert.equal(code, 1);
  assert.equal(input.destroyed, true, "stdin is released so the process can exit");
});

test("only valid request lines reach the loop, in order", async () => {
  const root = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
  const other = process.platform === "win32" ? "D:\\other" : "/other";
  const requests: string[] = [];
  const input = new PassThrough();
  const command = listenCommand(["collect", "--stdio"], { startLoop: () => fakeLoop({ requests }), input });
  input.write("not json\n");
  input.write(`{"v":2,"root":${JSON.stringify(root)}}\n`);
  input.write(`{"v":1,"root":${JSON.stringify(`${other}${"a".repeat(MAX_LINE_BYTES)}`)}}\n`);
  input.write(`{"v":1,"root":${JSON.stringify(root)}}\n`);
  input.write(`{"v":1,"root":${JSON.stringify(other)}}`);
  input.end();
  assert.equal(await command, 0);
  assert.deepEqual(requests, [root, other], "the last line counts even without a trailing newline");
});

test("request lines parse only a v1 object with an absolute root", () => {
  const root = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
  assert.equal(parseRequestLine(JSON.stringify({ v: 1, root })), root);
  assert.equal(parseRequestLine(`${JSON.stringify({ v: 1, root })}\r`), root);
  assert.equal(parseRequestLine(JSON.stringify({ v: 1, root, extra: true })), root);
  for (const bad of [
    "",
    "not json",
    "[]",
    "null",
    JSON.stringify({ v: 2, root }),
    JSON.stringify({ root }),
    JSON.stringify({ v: 1 }),
    JSON.stringify({ v: 1, root: "" }),
    JSON.stringify({ v: 1, root: "relative/repo" }),
    JSON.stringify({ v: 1, root: 7 }),
  ]) {
    assert.equal(parseRequestLine(bad), undefined, bad);
  }
});

test("line reader splits chunks, keeps multi-byte text whole, and drops over-long lines", () => {
  const got: string[] = [];
  const reader = createLineReader((line) => got.push(line), 16);
  const snowman = Buffer.from("\u2603 ok\n", "utf8");
  reader.push(Buffer.from("one\ntw"));
  reader.push(Buffer.from("o\n"));
  reader.push(snowman.subarray(0, 2));
  reader.push(snowman.subarray(2));
  reader.push(Buffer.from("x".repeat(40)));
  reader.push(Buffer.from("x".repeat(40)));
  reader.push(Buffer.from("tail\nafter\nlast"));
  reader.end();
  assert.deepEqual(got, ["one", "two", "\u2603 ok", "after", "last"]);
  const exact: string[] = [];
  const edge = createLineReader((line) => exact.push(line), 4);
  edge.push(Buffer.from("abcd\nabcde\n"));
  edge.end();
  assert.deepEqual(exact, ["abcd"], "a line of exactly the cap is kept, one byte over is dropped");
});

/** Events as stored, with run-specific fields removed and the repo path replaced by a placeholder. */
function storedEvents(repo: string, home: string): string[] {
  const dropped = new Set(["ts", "eventId", "nodeId", "nativeId"]);
  return readFileSync(eventsPath(repo, home), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) =>
      JSON.stringify(
        JSON.parse(line, (key, value: unknown) => {
          if (dropped.has(key)) return undefined;
          return key === "repoRoot" ? "<repo>" : value;
        }),
      ),
    )
    .sort();
}

test("daemon capture writes the same store as the dash collector", { skip: noGit }, async (t) => {
  const s = new Scratch(t);
  const homeA = s.dir("rocky-listen-home-");
  const homeB = s.dir("rocky-listen-home-");
  const original = s.repo();
  const guiRepo = s.copyOf(original);
  const daemonRepo = s.copyOf(original);
  assert.equal(setRepoCapture(guiRepo, true, CONSENT, homeA).ok, true);
  assert.equal(setRepoCapture(daemonRepo, true, CONSENT, homeB).ok, true);

  const reports: ReconcileReport[] = [];
  const gui = s.loop({ proc: "gui", home: homeA, fullEveryMs: COLLECTOR_TICK_MS, onResult: (report) => reports.push(report) });
  const daemon = s.listen(homeB);
  assert.ok(await until(() => reports.some((report) => report.coverage === "complete")), "dash collector finished");
  assert.ok(await until(() => daemon.results().some((line) => line.coverage === "complete")), "daemon capture finished");
  await gui.stop();
  daemon.endInput();
  assert.equal(await daemon.exited, 0);

  const fromGui = storedEvents(guiRepo, homeA);
  const fromDaemon = storedEvents(daemonRepo, homeB);
  assert.ok(fromGui.length > 0, "the dash collector stored events");
  assert.deepEqual(fromDaemon, fromGui, "same events once run-specific fields are removed");
  assert.deepEqual(
    readdirSync(objectsDir(daemonRepo, homeB)).sort(),
    readdirSync(objectsDir(guiRepo, homeA)).sort(),
    "same object file names",
  );
});

test("capture code opens no network", () => {
  // ponytail: text scan of the capture path; a new import there needs a look.
  const files = [
    "src/commands/listen.ts",
    ...["collector", "collector-loop", "watcher", "event-log", "repo-consent-read"].map((name) => `src/listening/${name}.ts`),
  ];
  const network = /node:net|node:http|node:https|node:dgram|fetch\(/;
  for (const file of files) {
    const text = readFileSync(join(packageRoot, file), "utf8");
    assert.doesNotMatch(text, network, `${file} must not open a socket`);
  }
});
