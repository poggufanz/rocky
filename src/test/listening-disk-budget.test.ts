import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup, type SetupDependencies } from "../commands/setup.js";
import { startGui } from "../gui/server.js";
import { setRepoCapture } from "../listening/consent.js";
import { appendListeningEvent, purgeListeningStore, storeListeningObject } from "../listening/event-log.js";
import { listeningStoreUsage } from "../listening/event-log-read.js";
import { isRepoCaptureAllowed } from "../listening/repo-consent-read.js";
import { repoDir } from "../listening/store-paths.js";
import { LISTENING_DISK_BUDGET_BYTES_PER_REPO, type EventEnvelope } from "../listening/types.js";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-budget-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

function gitRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-budget-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function grantedRepo(home: string): string {
  const root = gitRepo();
  const granted = setRepoCapture(root, true, { yes: true, actor: "cli" }, home);
  assert.equal(granted.ok, true);
  return granted.root ?? root;
}

function envelope(eventId: string): EventEnvelope {
  return {
    v: 1,
    eventId,
    source: "hook",
    ts: 1_700_000_000_000,
    adapterVersion: "test/1",
    consent: { host: true, repo: true, rawTrace: false },
    redaction: { applied: false, truncated: false },
    coverage: "complete",
    refs: {},
  };
}

function deps(home: string, answer: boolean): SetupDependencies {
  return {
    runner: undefined as never,
    platform: undefined as never,
    adapters: [],
    confirmation: { confirm: async () => answer },
    rockyHome: home,
  };
}

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("store usage is zero for a repo Rocky never heard", () => {
  const home = freshHome();
  assert.deepEqual(listeningStoreUsage(gitRepo(), home), { eventsBytes: 0, objectsBytes: 0, objects: 0 });
});

test("store usage counts the event log and every snapshot object", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  assert.equal(appendListeningEvent(root, envelope("e1"), undefined, home).ok, true);
  assert.equal(storeListeningObject(root, Buffer.from("alpha"), home).ok, true);
  assert.equal(storeListeningObject(root, Buffer.from("beta!!"), home).ok, true);
  const usage = listeningStoreUsage(root, home);
  assert.ok(usage.eventsBytes > 0);
  assert.equal(usage.objectsBytes, 11);
  assert.equal(usage.objects, 2);
});

test("purge refuses while capture is still allowed", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  storeListeningObject(root, Buffer.from("alpha"), home);
  const refused = purgeListeningStore(root, home);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "revoke-first");
  assert.equal(existsSync(repoDir(root, home)), true);
});

test("purge after revoke deletes the repo store and reports freed bytes", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  storeListeningObject(root, Buffer.from("alpha"), home);
  assert.equal(setRepoCapture(root, false, { yes: true, actor: "cli" }, home).ok, true);
  const purged = purgeListeningStore(root, home);
  assert.equal(purged.ok, true);
  assert.equal(purged.freedBytes, 5);
  assert.equal(existsSync(repoDir(root, home)), false);
  assert.deepEqual(purgeListeningStore(root, home), { ok: true, freedBytes: 0 });
});

test("parser accepts --purge-capture as a fourth exclusive repo action", () => {
  assert.equal(parseSetupArgs(["--repo", "/x", "--purge-capture"]).repoAction, "purge-capture");
  assert.throws(() => parseSetupArgs(["--repo", "/x", "--purge-capture", "--revoke-capture"]), SetupUsageError);
  assert.throws(() => parseSetupArgs(["--purge-capture"]), SetupUsageError);
});

test("allow-capture states the per-repo disk budget before consent", async () => {
  const home = freshHome();
  const root = gitRepo();
  const out = await captureStderr(() => setup(["--repo", root, "--allow-capture", "--yes"], deps(home, true)));
  assert.equal(out.code, 0);
  assert.match(out.stderr, /disk budget per repo 160 MiB/);
  assert.match(out.stderr, /events 32 MiB, snapshots 128 MiB/);
  assert.equal(isRepoCaptureAllowed(root, home), true);
});

test("check-capture reports held bytes against the budget", async () => {
  const home = freshHome();
  const root = grantedRepo(home);
  // Two objects: each stays under the 1 MiB per-file safety bound.
  assert.equal(storeListeningObject(root, Buffer.alloc(768 * 1024, 1), home).ok, true);
  assert.equal(storeListeningObject(root, Buffer.alloc(768 * 1024, 2), home).ok, true);
  const out = await captureStderr(() => setup(["--repo", root, "--check-capture"], deps(home, true)));
  assert.equal(out.code, 0);
  assert.match(out.stderr, /capture allowed/);
  assert.match(out.stderr, /disk 1\.5 MiB of 160 MiB budget/);
  assert.match(out.stderr, /snapshots 1\.5 MiB in 2 files/);
});

test("revoke keeps history and names the purge command", async () => {
  const home = freshHome();
  const root = grantedRepo(home);
  storeListeningObject(root, Buffer.from("alpha"), home);
  const out = await captureStderr(() => setup(["--repo", root, "--revoke-capture", "--yes"], deps(home, true)));
  assert.equal(out.code, 0);
  assert.match(out.stderr, /--purge-capture/);
  assert.equal(existsSync(repoDir(root, home)), true);
});

test("purge-capture revokes consent and deletes history", async () => {
  const home = freshHome();
  const root = grantedRepo(home);
  storeListeningObject(root, Buffer.from("alpha"), home);
  const out = await captureStderr(() => setup(["--repo", root, "--purge-capture", "--yes"], deps(home, true)));
  assert.equal(out.code, 0);
  assert.match(out.stderr, /no undo/);
  assert.equal(isRepoCaptureAllowed(root, home), false);
  assert.equal(existsSync(repoDir(root, home)), false);
});

test("GUI consent card states the same budget the CLI states", () => {
  const app = readFileSync(join(packageRoot, "assets", "gui", "app.js"), "utf8");
  const budgetMiB = LISTENING_DISK_BUDGET_BYTES_PER_REPO / (1024 * 1024);
  assert.match(app, new RegExp(`Disk budget: up to ${budgetMiB} MiB for this repo`));
  assert.match(app, /--purge-capture/);
});

test("relative --repo resolves against cwd and a missing path is refused", async (t) => {
  const home = freshHome();
  const root = grantedRepo(home);
  const previous = process.cwd();
  process.chdir(dirname(root));
  t.after(() => process.chdir(previous));
  const found = await captureStderr(() => setup(["--repo", basename(root), "--check-capture"], deps(home, true)));
  assert.equal(found.code, 0);
  assert.match(found.stderr, /capture allowed/);
  const missing = await captureStderr(() => setup(["--repo", "no-such-repo-here", "--check-capture"], deps(home, true)));
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /does not exist/);
  assert.doesNotMatch(missing.stderr, /capture off/);
});

test("purge-capture clears a stale consent whose folder is gone", async () => {
  const home = freshHome();
  const root = grantedRepo(home);
  storeListeningObject(root, Buffer.from("alpha"), home);
  rmSync(root, { recursive: true, force: true });
  const out = await captureStderr(() => setup(["--repo", root, "--purge-capture", "--yes"], deps(home, true)));
  assert.equal(out.code, 0);
  assert.equal(isRepoCaptureAllowed(root, home), false);
  assert.equal(existsSync(repoDir(root, home)), false);
});

test("GUI consent read carries disk usage and the budget", async (t) => {
  const home = freshHome();
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  const root = grantedRepo(home);
  storeListeningObject(root, Buffer.from("alpha"), home);
  const handle = await startGui({ port: 0, root });
  t.after(() => handle.close());
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/listening/consent?repo=${encodeURIComponent(root)}`, {
    headers: { "X-Rocky-Token": handle.token },
  });
  const body = await response.json() as { allowed: boolean; usage: Record<string, number> };
  assert.equal(body.allowed, true);
  assert.equal(body.usage.objectsBytes, 5);
  assert.equal(body.usage.objects, 1);
  assert.equal(body.usage.budgetBytes, LISTENING_DISK_BUDGET_BYTES_PER_REPO);
  const app = readFileSync(join(packageRoot, "assets", "gui", "app.js"), "utf8");
  assert.match(app, /listen-disk/);
});

test("GUI purge needs explicit yes, then stops capture and deletes history", async (t) => {
  const home = freshHome();
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  const root = grantedRepo(home);
  storeListeningObject(root, Buffer.from("alpha"), home);
  const handle = await startGui({ port: 0, root });
  t.after(() => handle.close());
  const post = async (body: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/listening/consent`, {
      method: "POST",
      headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post({ repo: root, action: "purge" })).status, 403, "purge without yes writes nothing");
  assert.equal(existsSync(repoDir(root, home)), true);
  const purged = await post({ repo: root, action: "purge", yes: true });
  assert.equal(purged.status, 200);
  assert.equal(purged.body.ok, true);
  assert.equal(purged.body.freedBytes, 5);
  assert.equal(purged.body.root, undefined, "reply never carries the resolved root");
  assert.equal(isRepoCaptureAllowed(root, home), false);
  assert.equal(existsSync(repoDir(root, home)), false);
  const app = readFileSync(join(packageRoot, "assets", "gui", "app.js"), "utf8");
  assert.match(app, /Delete history/);
  assert.match(app, /no undo/);
});

test("purge-capture declined by the human changes nothing", async () => {
  const home = freshHome();
  const root = grantedRepo(home);
  storeListeningObject(root, Buffer.from("alpha"), home);
  const out = await captureStderr(() => setup(["--repo", root, "--purge-capture"], deps(home, false)));
  assert.equal(out.code, 1);
  assert.equal(isRepoCaptureAllowed(root, home), true);
  assert.equal(existsSync(repoDir(root, home)), true);
});
