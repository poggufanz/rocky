import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cardsFilePath } from "../desk/cards-path.js";
import { purgeRepoCapture, setRepoCapture } from "../listening/consent.js";
import {
  getRepoConsentDetail,
  isRepoCaptureAllowed,
  mainRepoRootOf,
  normalizeRepoRoot,
  readRepoDecision,
} from "../listening/repo-consent-read.js";
import { storeListeningObject } from "../listening/event-log.js";
import { consentsPath, repoSlug } from "../listening/store-paths.js";
import { skipIfSymlinkUnavailable } from "./symlink-capability.js";

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-consent-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

function gitRepo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-consent-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function worktree(): { main: string; wt: string } {
  const main = gitRepo();
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "x"],
    { cwd: main, stdio: "pipe" },
  );
  const wt = join(realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-consent-wt-"))), "wt");
  execFileSync("git", ["worktree", "add", wt], { cwd: main, stdio: "pipe" });
  return { main, wt };
}

// A .git that Git cannot read (a stub left in a workspace) used to pass the
// existence check; capture then fell back to walking the folder wholesale.
test("a .git that Git cannot read is refused as not-a-git-root", () => {
  const home = freshHome();
  const stub = realpathSync(mkdtempSync(join(tmpdir(), "rocky-consent-stub-")));
  mkdirSync(join(stub, ".git", "info"), { recursive: true });
  const refused = setRepoCapture(stub, true, { yes: true, actor: "cli", onRevoke: "delete" }, home);
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
  assert.equal(setRepoCapture(sub, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, false);
});

test("grant requires explicit yes and writes nothing without it", () => {
  const home = freshHome();
  const root = gitRepo();
  const denied = setRepoCapture(root, true, { yes: false, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.reason, "requires-confirmation");
  assert.equal(isRepoCaptureAllowed(root, home), false);
  const granted = setRepoCapture(root, true, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(granted.ok, true);
  assert.equal(isRepoCaptureAllowed(root, home), true);
  assert.equal(getRepoConsentDetail(root, home).allowed, true);
});

test("non-git, relative, and unresolvable paths are refused", () => {
  const home = freshHome();
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "rocky-consent-plain-")));
  assert.equal(setRepoCapture(plain, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, false);
  assert.equal(setRepoCapture("relative/path", true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, false);
  assert.equal(setRepoCapture(join(plain, "missing"), true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, false);
});

test("revoke stops future capture but keeps history", () => {
  const home = freshHome();
  const root = gitRepo();
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  const revoked = setRepoCapture(root, false, { yes: true, actor: "gui", onRevoke: "delete" }, home);
  assert.equal(revoked.ok, true);
  assert.equal(isRepoCaptureAllowed(root, home), false);
  const raw = readFileSync(consentsPath(home), "utf8");
  assert.ok(!raw.includes(root));
});

// A consent made before a root went stale (its .git removed, or the folder
// gone) must stay revocable: only a grant needs a live Git root.
test("revoke works for a root that is no longer a git root or no longer exists", () => {
  const home = freshHome();
  const stale = gitRepo();
  const gone = gitRepo();
  assert.equal(setRepoCapture(stale, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  assert.equal(setRepoCapture(gone, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  rmSync(join(stale, ".git"), { recursive: true, force: true });
  rmSync(gone, { recursive: true, force: true });
  assert.equal(setRepoCapture(stale, false, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  assert.equal(setRepoCapture(gone, false, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  assert.equal(isRepoCaptureAllowed(stale, home), false);
  assert.equal(isRepoCaptureAllowed(gone, home), false);
  assert.equal(setRepoCapture(stale, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, false, "a grant still needs a live root");
});

test("repo consent: decline stores false and old readers see no consent", () => {
  const home = freshHome();
  const root = gitRepo();
  setRepoCapture(root, false, { yes: true, actor: "desk", onRevoke: "decline" }, home);
  const stored = JSON.parse(readFileSync(consentsPath(home), "utf8")) as Record<string, unknown>;
  assert.equal(stored[normalizeRepoRoot(root)], false);
  assert.equal(isRepoCaptureAllowed(root, home), false);
  assert.equal(readRepoDecision(root, home).decision, "declined");
});

test("repo consent: false survives a later allow of another repo", () => {
  const home = freshHome();
  const rootA = gitRepo();
  const rootB = gitRepo();
  setRepoCapture(rootA, false, { yes: true, actor: "desk", onRevoke: "decline" }, home);
  setRepoCapture(rootB, true, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(readRepoDecision(rootA, home).decision, "declined");
  assert.equal(readRepoDecision(rootB, home).decision, "allowed");
});

test("repo consent: cli revoke still deletes the key", () => {
  const home = freshHome();
  const root = gitRepo();
  setRepoCapture(root, true, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  setRepoCapture(root, false, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(readRepoDecision(root, home).decision, "undecided");
});

test("repo consent: a worktree inherits its main repo decision", () => {
  const home = freshHome();
  const { main, wt } = worktree();
  setRepoCapture(main, true, { yes: true, actor: "desk", onRevoke: "decline" }, home);
  assert.equal(isRepoCaptureAllowed(wt, home), true);
  assert.equal(getRepoConsentDetail(wt, home).allowed, true);
  assert.equal(readRepoDecision(wt, home).main, main);
});

test("repo consent: a worktree's own grant reads as allowed", () => {
  const home = freshHome();
  const { main, wt } = worktree();
  writeFileSync(consentsPath(home), JSON.stringify({ [normalizeRepoRoot(wt)]: true }));
  assert.equal(isRepoCaptureAllowed(wt, home), true);
  assert.equal(readRepoDecision(wt, home).decision, "allowed");
  assert.equal(readRepoDecision(wt, home).main, main);
});

test("repo consent: revoke at a worktree clears the main repo decision", () => {
  const home = freshHome();
  const { main, wt } = worktree();
  setRepoCapture(main, true, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  const revoked = setRepoCapture(wt, false, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(revoked.ok, true);
  assert.equal(revoked.root, normalizeRepoRoot(main));
  assert.equal(isRepoCaptureAllowed(wt, home), false);
  assert.equal(readRepoDecision(main, home).decision, "undecided");
  assert.equal(readRepoDecision(wt, home).decision, "undecided");
});

test("repo consent: purge at a worktree clears the inherited decision and its history", () => {
  const home = freshHome();
  const { main, wt } = worktree();
  setRepoCapture(main, true, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(storeListeningObject(wt, Buffer.from("alpha"), home).ok, true);
  const purged = purgeRepoCapture(wt, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(purged.ok, true);
  assert.equal(purged.freedBytes, 5);
  assert.equal(isRepoCaptureAllowed(wt, home), false);
  assert.equal(readRepoDecision(main, home).decision, "undecided");
});

test("repo consent: submodule and malformed .git files inherit nothing", () => {
  const sub = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-consent-sub-")));
  const junk = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-consent-junk-")));
  writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
  writeFileSync(join(junk, ".git"), "not a gitdir line");
  assert.equal(mainRepoRootOf(sub), undefined);
  assert.equal(mainRepoRootOf(junk), undefined);
});

test("read side carries no writer imports", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "listening", "repo-consent-read.ts"), "utf8");
  assert.ok(!source.includes("writeFileSync"));
  assert.ok(!source.includes("mkdirSync"));
  assert.ok(!source.includes("renameSync"));
});

test("purge deletes the repo's change card file and adds its size to freedBytes", (t) => {
  const home = freshHome();
  const root = gitRepo();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  assert.equal(storeListeningObject(root, Buffer.from("alpha"), home).ok, true);
  const cardsPath = cardsFilePath(root, home);
  assert.equal(cardsPath, join(home, "desk", "cards", `${repoSlug(root)}.jsonl`));
  mkdirSync(dirname(cardsPath), { recursive: true });
  const payload = '{"card":1}\n';
  writeFileSync(cardsPath, payload, "utf8");
  const purged = purgeRepoCapture(root, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(purged.ok, true);
  assert.equal(purged.freedBytes, 5 + Buffer.byteLength(payload, "utf8"));
  assert.equal(existsSync(cardsPath), false);
  assert.equal(isRepoCaptureAllowed(root, home), false);
});

test("purge deletes the change card file for both root spellings", (t) => {
  if (skipIfSymlinkUnavailable(t, "dir")) return;
  const home = freshHome();
  const real = gitRepo();
  const linkParent = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-consent-link-")));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  });
  const link = join(linkParent, "alias");
  symlinkSync(real, link, "dir");
  const typed = normalizeRepoRoot(link);
  const own = normalizeRepoRoot(realpathSync(link));
  assert.notEqual(typed, own);
  const typedCards = cardsFilePath(typed, home);
  const ownCards = cardsFilePath(own, home);
  assert.notEqual(typedCards, ownCards);
  mkdirSync(dirname(typedCards), { recursive: true });
  const typedPayload = "typed-card\n";
  const ownPayload = "own-card-two\n";
  writeFileSync(typedCards, typedPayload, "utf8");
  writeFileSync(ownCards, ownPayload, "utf8");
  const purged = purgeRepoCapture(link, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(purged.ok, true);
  assert.equal(
    purged.freedBytes,
    Buffer.byteLength(typedPayload, "utf8") + Buffer.byteLength(ownPayload, "utf8"),
  );
  assert.equal(existsSync(typedCards), false);
  assert.equal(existsSync(ownCards), false);
});

test("purge succeeds when no card file exists", (t) => {
  const home = freshHome();
  const root = gitRepo();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  const purged = purgeRepoCapture(root, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(purged.ok, true);
  assert.equal(purged.freedBytes, 0);
});

test("purge leaves a linked worktree's card file alone", (t) => {
  const home = freshHome();
  const { main, wt } = worktree();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
    rmSync(dirname(wt), { recursive: true, force: true });
  });
  assert.equal(setRepoCapture(main, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  const mainCards = cardsFilePath(main, home);
  const wtCards = cardsFilePath(wt, home);
  mkdirSync(dirname(mainCards), { recursive: true });
  writeFileSync(mainCards, "main\n", "utf8");
  writeFileSync(wtCards, "worktree\n", "utf8");
  const purged = purgeRepoCapture(main, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(purged.ok, true);
  assert.equal(purged.freedBytes, Buffer.byteLength("main\n", "utf8"));
  assert.equal(existsSync(mainCards), false);
  assert.equal(existsSync(wtCards), true);
  assert.equal(readFileSync(wtCards, "utf8"), "worktree\n");
});

test("purge reports cards-delete-failed when the card file cannot be removed", (t) => {
  const home = freshHome();
  const root = gitRepo();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
  assert.equal(storeListeningObject(root, Buffer.from("alpha"), home).ok, true);
  const cardPath = cardsFilePath(root, home);
  mkdirSync(cardPath, { recursive: true });
  writeFileSync(join(cardPath, "keep.txt"), "non-empty", "utf8");
  const purged = purgeRepoCapture(root, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  assert.equal(purged.ok, false);
  assert.equal(purged.reason, "cards-delete-failed");
  assert.equal(purged.freedBytes, 5);
  assert.equal(existsSync(cardPath), true);
});
