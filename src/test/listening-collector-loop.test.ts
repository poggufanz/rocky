import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setRepoCapture } from "../listening/consent.js";
import { startCollectorLoop } from "../listening/collector-loop.js";
import { readListeningTail } from "../listening/event-log-read.js";
import { collectorPath } from "../listening/store-paths.js";
import { startGui } from "../gui/server.js";

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

function heardFiles(repo: string, home?: string): string[] {
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

test("collector loop captures a consented repo with no manual step and skips gitignored bulk", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  t.after(() => cleanup(home, repo));
  assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli" }, home).ok, true);
  // a long tick proves the first capture comes from the start-up tick alone
  const loop = startCollectorLoop({ proc: "gui", home, tickMs: 60_000 });
  t.after(() => loop.stop());
  assert.ok(await until(() => heardFiles(repo, home).includes("kept.txt")), "consented file must be captured automatically");
  const heard = heardFiles(repo, home);
  assert.ok(heard.includes(".gitignore"), "untracked, not-ignored files count too");
  assert.ok(!heard.some((rel) => rel.startsWith("ignored/")), "gitignored files must never snapshot");
  loop.stop();
  assert.equal(leaseExpires(repo, home), 0, "stop releases the lease for the next owner");
});

test("collector loop releases a revoked repo and keeps its history", { skip: noGit }, async (t) => {
  const home = scratch("rocky-loop-home-");
  const repo = makeRepo();
  t.after(() => cleanup(home, repo));
  setRepoCapture(repo, true, { yes: true, actor: "cli" }, home);
  const loop = startCollectorLoop({ proc: "gui", home, tickMs: 60_000 });
  t.after(() => loop.stop());
  assert.ok(await until(() => heardFiles(repo, home).includes("kept.txt")));
  assert.ok((leaseExpires(repo, home) ?? 0) > Date.now(), "owner holds a live lease while listening");
  assert.equal(setRepoCapture(repo, false, { yes: true, actor: "cli" }, home).ok, true);
  loop.kick();
  assert.ok(await until(() => leaseExpires(repo, home) === 0), "revoke releases the lease on the next tick");
  assert.ok(heardFiles(repo, home).includes("kept.txt"), "revoke keeps history");
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
  setRepoCapture(other, true, { yes: true, actor: "cli" });
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
