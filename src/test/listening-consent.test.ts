import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setRepoCapture } from "../listening/consent.js";
import { getRepoConsentDetail, isRepoCaptureAllowed } from "../listening/repo-consent-read.js";
import { consentsPath } from "../listening/store-paths.js";

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-consent-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

function gitRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-consent-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

// A .git that Git cannot read (a stub left in a workspace) used to pass the
// existence check; capture then fell back to walking the folder wholesale.
test("a .git that Git cannot read is refused as not-a-git-root", () => {
  const home = freshHome();
  const stub = realpathSync(mkdtempSync(join(tmpdir(), "rocky-consent-stub-")));
  mkdirSync(join(stub, ".git", "info"), { recursive: true });
  const refused = setRepoCapture(stub, true, { yes: true, actor: "cli" }, home);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "not-a-git-root");
  assert.equal(isRepoCaptureAllowed(stub, home), false);
});

// A subfolder of a repo is not a root: consent names whole repos only.
test("a subfolder inside a repo is refused even with a stray .git", () => {
  const home = freshHome();
  const root = gitRepo();
  const sub = join(root, "pkg");
  mkdirSync(join(sub, ".git"), { recursive: true });
  assert.equal(setRepoCapture(sub, true, { yes: true, actor: "cli" }, home).ok, false);
});

test("grant requires explicit yes and writes nothing without it", () => {
  const home = freshHome();
  const root = gitRepo();
  const denied = setRepoCapture(root, true, { yes: false, actor: "cli" }, home);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.reason, "requires-confirmation");
  assert.equal(isRepoCaptureAllowed(root, home), false);
  const granted = setRepoCapture(root, true, { yes: true, actor: "cli" }, home);
  assert.equal(granted.ok, true);
  assert.equal(isRepoCaptureAllowed(root, home), true);
  assert.equal(getRepoConsentDetail(root, home).allowed, true);
});

test("non-git, relative, and unresolvable paths are refused", () => {
  const home = freshHome();
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "rocky-consent-plain-")));
  assert.equal(setRepoCapture(plain, true, { yes: true, actor: "cli" }, home).ok, false);
  assert.equal(setRepoCapture("relative/path", true, { yes: true, actor: "cli" }, home).ok, false);
  assert.equal(setRepoCapture(join(plain, "missing"), true, { yes: true, actor: "cli" }, home).ok, false);
});

test("revoke stops future capture but keeps history", () => {
  const home = freshHome();
  const root = gitRepo();
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli" }, home).ok, true);
  const revoked = setRepoCapture(root, false, { yes: true, actor: "gui" }, home);
  assert.equal(revoked.ok, true);
  assert.equal(isRepoCaptureAllowed(root, home), false);
  const raw = readFileSync(consentsPath(home), "utf8");
  assert.ok(!raw.includes(root));
});

test("read side carries no writer imports", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "listening", "repo-consent-read.ts"), "utf8");
  assert.ok(!source.includes("writeFileSync"));
  assert.ok(!source.includes("mkdirSync"));
  assert.ok(!source.includes("renameSync"));
});
