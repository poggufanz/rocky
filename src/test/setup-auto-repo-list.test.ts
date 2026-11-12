import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRepoRoot } from "../listening/repo-consent-read.js";
import { consentsPath, repoDir } from "../listening/store-paths.js";
import { runAutoCommand } from "../setup/auto/command.js";
import type { AutoContext } from "../setup/auto/engine.js";
import { listRepos } from "../setup/auto/repo-list.js";

function git(cwd: string, args: string[]): number {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status ?? 1;
}

const noGit: string | false = git(tmpdir(), ["--version"]) === 0 ? false : "git unavailable";

function tmp(t: test.TestContext): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-repo-list-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("repo list reports decisions, store sizes and worktrees", { skip: noGit }, (t) => {
  const root = tmp(t);
  const rh = join(root, "rocky-home");
  mkdirSync(join(rh, "listening"), { recursive: true });
  const main = join(root, "alpha");
  mkdirSync(main);
  assert.equal(git(main, ["init", "-q"]), 0);
  assert.equal(git(main, ["commit", "--allow-empty", "-q", "-m", "init"]), 0);
  const linked = join(root, "alpha-wt");
  const gone = join(root, "alpha-gone");
  assert.equal(git(main, ["worktree", "add", "-q", linked, "-b", "wt1"]), 0);
  assert.equal(git(main, ["worktree", "add", "-q", gone, "-b", "wt2"]), 0);
  rmSync(gone, { recursive: true, force: true });
  const declined = join(root, "beta");
  mkdirSync(declined);

  const mainKey = normalizeRepoRoot(main);
  const declinedKey = normalizeRepoRoot(declined);
  writeFileSync(consentsPath(rh), JSON.stringify({ [mainKey]: true, [declinedKey]: false }));
  mkdirSync(repoDir(main, rh), { recursive: true });
  writeFileSync(join(repoDir(main, rh), "events.jsonl"), "0123456789");

  const repos = listRepos(rh);
  assert.equal(repos.length, 2);
  const [first, second] = repos;
  assert.equal(first?.key, mainKey);
  assert.equal(first?.name, "alpha");
  assert.equal(first?.decision, "allowed");
  assert.equal(first?.bytes, 10);
  assert.equal(first?.worktrees.length, 2);
  const byExists = new Map(first?.worktrees.map((entry) => [normalizeRepoRoot(entry.root), entry]));
  assert.equal(byExists.get(normalizeRepoRoot(linked))?.exists, true);
  assert.equal(byExists.get(normalizeRepoRoot(gone))?.exists, false);
  assert.equal(byExists.get(normalizeRepoRoot(linked))?.bytes, 0);
  assert.equal(second?.key, declinedKey);
  assert.equal(second?.decision, "declined");
  assert.equal(second?.bytes, 0);
  assert.deepEqual(second?.worktrees, []);
});

test("repo list survives a missing consent store", async (t) => {
  const root = tmp(t);
  const rh = join(root, "rocky-home");
  mkdirSync(rh);
  assert.deepEqual(listRepos(rh), []);
  const ctx = { rockyHome: rh, detect: { home: root, env: {}, platform: process.platform } } as unknown as AutoContext;
  const chunks: string[] = [];
  const code = await runAutoCommand(["repo", "list", "--json"], ctx, (value) => chunks.push(value));
  assert.equal(code, 0);
  const json = JSON.parse(chunks[0] ?? "") as { repos?: unknown[]; harness_off?: unknown[]; shell_hook?: boolean };
  assert.deepEqual(json.repos, []);
  assert.deepEqual(json.harness_off, []);
  assert.equal(json.shell_hook, true);
});
