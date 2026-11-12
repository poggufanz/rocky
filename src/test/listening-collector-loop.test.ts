import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setRepoCapture } from "../listening/consent.js";
import {
  COLLECTOR_TICK_MS,
  startCollectorLoop,
  type CollectorLoop,
  type ReconcileReport,
  type RootOwnership,
} from "../listening/collector-loop.js";
import { readListeningTail } from "../listening/event-log-read.js";
import { normalizeRepoRoot } from "../listening/repo-consent-read.js";
import { collectorPath, repoDir } from "../listening/store-paths.js";
import { startGui, type GuiHandle } from "../gui/server.js";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const noGit = hasGit() ? false : "git unavailable";

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeRepo(): string {
  const dir = scratch("rocky-loop-repo-");
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  writeFileSync(join(dir, "kept.txt"), "hello\n");
  mkdirSync(join(dir, "ignored"));
  writeFileSync(join(dir, "ignored", "bulk.txt"), "noise\n");
  return dir;
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function capturedFiles(repo: string, home?: string): string[] {
  return readListeningTail(repo, { limit: 200, newest: true }, home).events
    .map((event) => event.refs.fileRel ?? "")
    .filter((rel) => rel.length > 0);
}

function leaseExpires(repo: string, home?: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(collectorPath(repo, home), "utf8")) as { expires: number }).expires;
  } catch {
    return undefined;
  }
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return check();
}

/** Resolves true once the repo's lease expiry moved `count` times. Each move is one tick of the owner. */
async function untilLeaseRenewed(repo: string, home: string, count: number): Promise<boolean> {
  let seen = leaseExpires(repo, home);
  let moved = 0;
  return until(() => {
    const now = leaseExpires(repo, home);
    if (now !== undefined && now !== seen) {
      seen = now;
      moved += 1;
    }
    return moved >= count;
  });
}

const CONSENT = { yes: true, actor: "cli", onRevoke: "delete" } as const;

/** Repo with one commit, so `git worktree add` has a HEAD to branch from. */
function makeCommittedRepo(): string {
  const dir = realpathSync.native(makeRepo());
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    { cwd: dir, stdio: "ignore" },
  );
  return dir;
}

test("collector loop captures a consented repo with no manual step and skips gitignored bulk", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  let loop: CollectorLoop | undefined;
  t.after(async () => {
    await loop?.stop();
    cleanup(home, repo);
  });
  assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  // a long tick proves the first capture comes from the start-up tick alone
  loop = startCollectorLoop({ proc: "gui", home, tickMs: 60_000, fullEveryMs: COLLECTOR_TICK_MS });
  assert.ok(await until(() => capturedFiles(repo, home).includes("kept.txt")), "consented file must be captured automatically");
  const captured = capturedFiles(repo, home);
  assert.ok(captured.includes(".gitignore"), "untracked, not-ignored files count too");
  assert.ok(!captured.some((rel) => rel.startsWith("ignored/")), "gitignored files must never snapshot");
  await loop.stop();
  assert.equal(leaseExpires(repo, home), 0, "stop releases the lease for the next owner");
});

test("collector loop releases a revoked repo and keeps its history", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  let loop: CollectorLoop | undefined;
  t.after(async () => {
    await loop?.stop();
    cleanup(home, repo);
  });
  setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  loop = startCollectorLoop({ proc: "gui", home, tickMs: 60_000, fullEveryMs: COLLECTOR_TICK_MS });
  assert.ok(await until(() => capturedFiles(repo, home).includes("kept.txt")));
  assert.ok((leaseExpires(repo, home) ?? 0) > Date.now(), "owner holds a live lease while listening");
  assert.equal(setRepoCapture(repo, false, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  loop.kick();
  assert.ok(await until(() => leaseExpires(repo, home) === 0), "revoke releases the lease on the next tick");
  assert.ok(capturedFiles(repo, home).includes("kept.txt"), "revoke keeps history");
});

test("gui loop skips a repo whose daemon lease is live", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const held = makeRepo();
  const witness = makeRepo();
  let loop: CollectorLoop | undefined;
  t.after(async () => {
    await loop?.stop();
    cleanup(home, held, witness);
  });
  setRepoCapture(held, true, CONSENT, home);
  setRepoCapture(witness, true, CONSENT, home);
  mkdirSync(repoDir(held, home), { recursive: true });
  const lease = { proc: "daemon", pid: process.pid, token: "daemon-token", expires: Date.now() + 60_000 };
  writeFileSync(collectorPath(held, home), JSON.stringify(lease));
  loop = startCollectorLoop({ proc: "gui", home, tickMs: 50, fullEveryMs: COLLECTOR_TICK_MS });
  // the witness repo is ours, so each tick renews its lease; consented repos
  // are visited in order, so three renewals mean the held repo was read on three ticks
  assert.ok(await untilLeaseRenewed(witness, home, 3), "loop must keep ticking");
  assert.deepEqual(JSON.parse(readFileSync(collectorPath(held, home), "utf8")), lease, "a live daemon lease is left alone");
  assert.deepEqual(capturedFiles(held, home), [], "the loop must not capture a repo it does not own");
});

test("daemon loop takes a repo after the gui releases it", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  let gui: CollectorLoop | undefined;
  let daemon: CollectorLoop | undefined;
  t.after(async () => {
    await daemon?.stop();
    await gui?.stop();
    cleanup(home, repo);
  });
  setRepoCapture(repo, true, CONSENT, home);
  const key = normalizeRepoRoot(repo);
  gui = startCollectorLoop({ proc: "gui", home, tickMs: 60_000, fullEveryMs: COLLECTOR_TICK_MS });
  assert.ok(await until(() => (leaseExpires(repo, home) ?? 0) > Date.now()), "gui must own the lease first");
  const calls: RootOwnership[][] = [];
  daemon = startCollectorLoop({
    proc: "daemon",
    home,
    tickMs: 50,
    fullEveryMs: 60_000,
    onRoots: (roots) => calls.push(roots),
  });
  assert.ok(await until(() => calls.length > 0), "onRoots fires after the first tick");
  assert.deepEqual(calls[0], [{ root: key, owner: false }]);
  await gui.stop();
  assert.ok(await until(() => calls.some((roots) => roots.some((entry) => entry.root === key && entry.owner))));
  assert.deepEqual(calls.at(-1), [{ root: key, owner: true }]);
  assert.ok(await untilLeaseRenewed(repo, home, 2), "daemon keeps renewing");
  assert.equal(calls.length, 2, "onRoots stays quiet while nothing changes");
});

test("full reconcile waits for fullEveryMs but request runs now", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  let loop: CollectorLoop | undefined;
  t.after(async () => {
    await loop?.stop();
    cleanup(home, repo);
  });
  setRepoCapture(repo, true, CONSENT, home);
  const reports: ReconcileReport[] = [];
  loop = startCollectorLoop({
    proc: "daemon",
    home,
    tickMs: 50,
    fullEveryMs: 600_000,
    onResult: (report) => reports.push(report),
  });
  assert.ok(await until(() => reports.length === 1), "the first tick reconciles a root never posted");
  const versions = (): number => capturedFiles(repo, home).filter((rel) => rel === "kept.txt").length;
  const before = versions();
  writeFileSync(join(repo, "kept.txt"), "changed\n");
  assert.ok(await untilLeaseRenewed(repo, home, 2), "loop must keep ticking");
  assert.equal(reports.length, 1, "no full reconcile before fullEveryMs");
  assert.equal(versions(), before, "the edit stays unseen until a reconcile runs");
  loop.request(repo);
  assert.ok(await until(() => reports.length === 2), "request reconciles now");
  assert.ok(versions() > before, "the edit is captured as a new version");
});

test("request during a reconcile runs one more reconcile", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  let loop: CollectorLoop | undefined;
  t.after(async () => {
    await loop?.stop();
    cleanup(home, repo);
  });
  setRepoCapture(repo, true, CONSENT, home);
  const key = normalizeRepoRoot(repo);
  const reports: ReconcileReport[] = [];
  loop = startCollectorLoop({
    proc: "daemon",
    home,
    tickMs: 50,
    fullEveryMs: 600_000,
    onResult: (report) => reports.push(report),
  });
  assert.ok(await until(() => reports.length === 1), "wait for the first tick's report");
  // back to back: the first request posts, the second finds it in flight and marks it dirty
  loop.request(repo);
  loop.request(repo);
  assert.ok(await until(() => reports.length === 3), "two requests give two more reports");
  assert.ok(await untilLeaseRenewed(repo, home, 2), "loop must keep ticking");
  assert.equal(reports.length, 3, "no third request-driven report");
  assert.ok(reports.every((report) => report.root === key));
});

test("request for a revoked root writes nothing and releases it", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  const witness = makeRepo();
  let loop: CollectorLoop | undefined;
  t.after(async () => {
    await loop?.stop();
    cleanup(home, repo, witness);
  });
  setRepoCapture(repo, true, CONSENT, home);
  setRepoCapture(witness, true, CONSENT, home);
  const key = normalizeRepoRoot(repo);
  const reports: ReconcileReport[] = [];
  loop = startCollectorLoop({
    proc: "daemon",
    home,
    tickMs: 50,
    fullEveryMs: 600_000,
    onResult: (report) => reports.push(report),
  });
  const forRepo = (): ReconcileReport[] => reports.filter((report) => report.root === key);
  assert.ok(await until(() => forRepo().length === 1), "capture runs while consent stands");
  const before = capturedFiles(repo, home);
  writeFileSync(join(repo, "kept.txt"), "changed after revoke\n");
  // The loop re-reads the consent file every 50ms and Windows can fail a rename
  // that races a reader, so the revoke is retried until it lands.
  assert.ok(await until(() => setRepoCapture(repo, false, CONSENT, home).ok), "revoke must land");
  loop.request(repo);
  assert.ok(await until(() => leaseExpires(repo, home) === 0), "the next tick releases the revoked repo");
  assert.ok(await untilLeaseRenewed(witness, home, 2), "loop must keep ticking");
  assert.equal(forRepo().length, 1, "a revoked root gets no new report");
  assert.deepEqual(capturedFiles(repo, home), before, "a revoked root gets no new version");
});

test("request adds an allowed linked worktree and ignores an undecided repo", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const main = makeCommittedRepo();
  const undecided = makeRepo();
  const worktreeParent = scratch("rocky-loop-wt-");
  const worktree = join(realpathSync.native(worktreeParent), "wt");
  let loop: CollectorLoop | undefined;
  t.after(async () => {
    await loop?.stop();
    cleanup(home, main, undecided, worktreeParent);
  });
  execFileSync("git", ["worktree", "add", "-q", "-b", "linked", worktree], { cwd: main, stdio: "ignore" });
  setRepoCapture(main, true, CONSENT, home);
  loop = startCollectorLoop({ proc: "daemon", home, tickMs: 50, fullEveryMs: 600_000 });
  loop.request(worktree);
  loop.request(undecided);
  assert.ok(await until(() => capturedFiles(worktree, home).includes("kept.txt")), "the worktree is captured into its own store");
  assert.ok((leaseExpires(worktree, home) ?? 0) > Date.now(), "the worktree has its own live lease");
  assert.ok(await untilLeaseRenewed(main, home, 2), "loop must keep ticking");
  assert.equal(existsSync(collectorPath(undecided, home)), false, "an undecided repo gets no lease file");
  assert.deepEqual(capturedFiles(undecided, home), []);
});

test("reports carry counts and a reason, never file names", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  const vanished = makeRepo();
  let loop: CollectorLoop | undefined;
  t.after(async () => {
    await loop?.stop();
    cleanup(home, repo, vanished);
  });
  writeFileSync(join(repo, "blob-secret-name.bin"), Buffer.from([0, 1, 2, 3]));
  setRepoCapture(repo, true, CONSENT, home);
  setRepoCapture(vanished, true, CONSENT, home);
  const repoKey = normalizeRepoRoot(repo);
  const vanishedKey = normalizeRepoRoot(vanished);
  cleanup(vanished);
  const reports: ReconcileReport[] = [];
  loop = startCollectorLoop({
    proc: "daemon",
    home,
    tickMs: 60_000,
    fullEveryMs: 600_000,
    onResult: (report) => reports.push(report),
  });
  assert.ok(await until(() => reports.length === 2));
  const partial = reports.find((report) => report.root === repoKey);
  assert.ok(partial !== undefined);
  assert.equal(partial.coverage, "partial");
  assert.equal(partial.gaps, 1);
  assert.equal("reason" in partial, false, "reason belongs to unknown coverage only");
  assert.equal(typeof partial.atMs, "number");
  const unknown = reports.find((report) => report.root === vanishedKey);
  assert.ok(unknown !== undefined);
  assert.equal(unknown.coverage, "unknown");
  assert.equal(unknown.reason, "root-unusable");
  assert.equal(JSON.stringify(reports).includes("blob-secret-name"), false, "file names never leave the worker");
});

test("done resolves stopped after stop", async (t) => {
  const home = scratch("rocky-loop-home-");
  t.after(() => cleanup(home));
  const loop = startCollectorLoop({ proc: "daemon", home, tickMs: 50, fullEveryMs: 60_000 });
  await loop.stop();
  const guard = new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 10_000).unref());
  assert.equal(await Promise.race([loop.done, guard]), "stopped");
});

test("GUI responds while a consented collector waits for Git, then captures its files", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  const previousHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const entered = join(repo, ".git", "monitor-entered");
  const released = join(repo, ".git", "monitor-released");
  let handle: GuiHandle | undefined;
  t.after(async () => {
    writeFileSync(released, "");
    await handle?.close();
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
    cleanup(home, repo);
  });
  execFileSync("git", ["add", "kept.txt"], { cwd: repo, stdio: "ignore" });
  const hook = join(repo, ".git", "slow-monitor.cjs");
  // Git runs in another process: fake timers cannot drive it. The release
  // file is the awaited condition; the real deadline only breaks a deadlock.
  writeFileSync(hook, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(__dirname + "/monitor-entered", "");
const deadline = Date.now() + 6000;
function wait() {
  if (fs.existsSync(__dirname + "/monitor-released") || Date.now() >= deadline) {
    process.stdout.write("ready\\0");
  } else {
    setTimeout(wait, 25);
  }
}
wait();
`, { mode: 0o755 });
  execFileSync("git", ["config", "core.fsmonitor", hook.replace(/\\/g, "/")], { cwd: repo, stdio: "ignore" });
  assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }).ok, true);
  handle = await startGui({ port: 0, root: repo, collect: true });
  const base = `http://127.0.0.1:${handle.port}`;
  const started = performance.now();
  const responses = Promise.all([
    fetch(`${base}/`).then(async (response) => {
      await response.text();
      return response.status;
    }),
    fetch(`${base}/api/listening/consent?repo=${encodeURIComponent(repo)}`, {
      headers: { "X-Rocky-Token": handle.token },
    }).then(async (response) => ({ status: response.status, body: await response.json() })),
  ]).then((result) => ({ result, elapsedMs: performance.now() - started }));
  assert.ok(await until(() => existsSync(entered)), "collector must reach the slow Git operation");
  const { result, elapsedMs } = await responses;
  assert.equal(result[0], 200);
  assert.equal(result[1].status, 200);
  assert.equal(result[1].body.allowed, true);
  assert.ok(elapsedMs < 5000, "snapshot collection must not hold up HTML or Listening API responses");
  writeFileSync(released, "");
  assert.ok(await until(() => capturedFiles(repo).includes("kept.txt")), "keeping GUI responsive must not disable capture");
});

test("gui picker lists consented repos as id and label and resolves picks without granting", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const launch = makeRepo();
  const other = makeRepo();
  mkdirSync(join(launch, "src"));
  mkdirSync(join(other, "deep", "er"), { recursive: true });
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    cleanup(home, launch, other);
  });
  setRepoCapture(other, true, { yes: true, actor: "cli", onRevoke: "delete" });
  // launched from a subfolder: the picker still offers the repo root
  const handle = await startGui({ port: 0, root: join(launch, "src") });
  t.after(() => handle.close());
  const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
    });
    return { status: response.status, body: await response.json() };
  };

  const context = (await call("/api/listening/context")).body;
  assert.equal(context.launchRoot, launch);
  assert.equal(context.launchConsented, false);
  assert.equal(context.repos.length, 1);
  assert.deepEqual(Object.keys(context.repos[0]).sort(), ["id", "label"], "no consented path on the wire");
  assert.match(context.repos[0].id, /^[0-9a-f]{32}$/);
  assert.equal(context.repos[0].label.toLowerCase(), basename(other).toLowerCase());

  const byId = await call(`/api/listening/consent?repo=${context.repos[0].id}`);
  assert.equal(byId.body.allowed, true);
  assert.equal(byId.body.root, undefined, "an id pick never turns back into a path");
  const bySubfolder = await call(`/api/listening/consent?repo=${encodeURIComponent(join(other, "deep", "er"))}`);
  assert.equal(bySubfolder.body.id, context.repos[0].id, "a subfolder pick lifts to its repo root");
  assert.equal((await call(`/api/listening/consent?repo=${"0".repeat(32)}`)).status, 400, "unknown id is no repo");

  // picking the launch repo grants nothing; only the explicit yes does
  assert.equal((await call("/api/listening/consent", { method: "POST", body: JSON.stringify({ repo: launch, action: "allow" }) })).status, 403);
  assert.equal((await call("/api/listening/context")).body.launchConsented, false);
  const allowed = await call("/api/listening/consent", { method: "POST", body: JSON.stringify({ repo: launch, action: "allow", yes: true }) });
  assert.equal(allowed.body.ok, true);
  assert.equal(allowed.body.root, undefined);
  assert.equal((await call("/api/listening/context")).body.launchConsented, true);
});
