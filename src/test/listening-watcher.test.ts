import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRepoCapture } from "../listening/consent.js";
import { loadEventsForProjection } from "../listening/event-log-read.js";
import { consentsPath } from "../listening/store-paths.js";
import { ensureBaseline, reconcileRepo } from "../listening/watcher.js";

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-watch-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

function consentedRepo(home: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-watch-repo-")));
  mkdirSync(join(root, ".git"));
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli" }, home).ok, true);
  return root;
}

test("reconcile without consent reports unknown and writes nothing", () => {
  const home = freshHome();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-watch-noconsent-")));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "a.txt"), "hi\n");
  const out = reconcileRepo(root, {}, home);
  assert.equal(out.coverage, "unknown");
  assert.deepEqual(out.versions, []);
  assert.equal(loadEventsForProjection(root, home).events.length, 0);
});

test("baseline then change emits version plus generated_hunk", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  const again = ensureBaseline(root, home);
  assert.equal(again.ok, true);
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  const out = reconcileRepo(root, {}, home);
  assert.equal(out.coverage, "complete");
  assert.equal(out.hunks, 1);
  const { events } = loadEventsForProjection(root, home);
  assert.ok(events.some((e) => e.edge?.kind === "generated_hunk" && e.edge.basis === "filesystem_observed"));
  assert.ok(events.every((e) => (e.edge?.basis as string | undefined) !== "runtime_observed"));
});

test("binary, oversized, and symlink files become gaps, never versions", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "ok.txt"), "text\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  writeFileSync(join(root, "big.txt"), "x".repeat(1 * 1024 * 1024 + 8));
  writeFileSync(join(root, "real.txt"), "real\n");
  try {
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
  } catch {
    // Windows without privilege: gap coverage still asserted via binary+big.
  }
  const out = reconcileRepo(root, {}, home);
  assert.equal(out.coverage, "partial");
  const { events } = loadEventsForProjection(root, home);
  const versioned = events.filter((e) => e.node === "file_version").map((e) => e.refs.fileRel);
  assert.ok(versioned.includes("ok.txt"));
  assert.ok(!versioned.includes("bin.dat"));
  assert.ok(!versioned.includes("big.txt"));
  assert.ok(!versioned.includes("link.txt"));
});

test("path cap truncates with partial coverage", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  for (let i = 0; i < 4; i += 1) writeFileSync(join(root, `f${i}.txt`), `v${i}\n`);
  const out = reconcileRepo(root, { pathCap: 2 }, home);
  assert.equal(out.coverage, "partial");
  assert.ok(out.gaps.some((g) => g.startsWith("path-cap-reached")));
});
