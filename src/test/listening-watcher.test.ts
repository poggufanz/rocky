import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRepoCapture } from "../listening/consent.js";
import { appendListeningEvent } from "../listening/event-log.js";
import { loadEventsForProjection } from "../listening/event-log-read.js";
import { projectGraph } from "../listening/graph-store.js";
import { consentsPath, eventsPath } from "../listening/store-paths.js";
import type { EventEnvelope } from "../listening/types.js";
import { ensureBaseline, reconcileRepo } from "../listening/watcher.js";

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-watch-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

function consentedRepo(home: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-watch-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli", onRevoke: "delete" }, home).ok, true);
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

// Listening reads the text files Git lists, nothing else. A root whose .git
// Git can no longer read (consent kept from before, a stub left behind) is
// never walked wholesale: a workspace like that used to snapshot a nested
// clone's ignored test build and git internals on every tick.
test("a consented root Git cannot list is captured as nothing, never walked", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "kept.txt"), "kept\n");
  rmSync(join(root, ".git"), { recursive: true, force: true });
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  mkdirSync(join(root, ".test-dist"));
  writeFileSync(join(root, ".test-dist", "built.js"), "built\n");

  const out = reconcileRepo(root, {}, home);
  assert.equal(out.coverage, "unknown");
  assert.deepEqual(out.gaps, ["git-unreadable"]);
  assert.deepEqual(out.versions, []);
  assert.equal(loadEventsForProjection(root, home).events.length, 0);
  assert.equal(ensureBaseline(root, home).reason, "git-unreadable");
});

// Git's own ignore rules decide what is captured in a readable repo.
test("gitignored build output is never captured", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, ".gitignore"), ".test-dist/\n");
  writeFileSync(join(root, "kept.txt"), "kept\n");
  mkdirSync(join(root, ".test-dist"));
  writeFileSync(join(root, ".test-dist", "built.js"), "built\n");
  reconcileRepo(root, {}, home);
  const versioned = loadEventsForProjection(root, home).events
    .filter((e) => e.node === "file_version")
    .map((e) => e.refs.fileRel);
  assert.ok(versioned.includes("kept.txt"));
  assert.ok(!versioned.some((rel) => rel?.includes(".test-dist/")));
  assert.ok(!versioned.some((rel) => rel?.split("/").includes(".git")));
});

test("path cap truncates with partial coverage", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  for (let i = 0; i < 4; i += 1) writeFileSync(join(root, `f${i}.txt`), `v${i}\n`);
  const out = reconcileRepo(root, { pathCap: 2 }, home);
  assert.equal(out.coverage, "partial");
  assert.ok(out.gaps.some((g) => g.startsWith("path-cap-reached")));
});

function fileVersionEvents(root: string, home: string, rel?: string): EventEnvelope[] {
  return loadEventsForProjection(root, home).events.filter(
    (e) => e.node === "file_version" && (rel === undefined || e.refs.fileRel === rel),
  );
}

test("a changed file's version carries refs.prev with the previous sha", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  writeFileSync(join(root, "a.txt"), "two\n");
  reconcileRepo(root, {}, home);
  writeFileSync(join(root, "a.txt"), "three\n");
  reconcileRepo(root, {}, home);

  const events = fileVersionEvents(root, home, "a.txt");
  assert.equal(events.length, 3);
  assert.equal(events[1].refs.prev, events[0].refs.version);
  assert.equal(events[2].refs.prev, events[1].refs.version);
  assert.equal(events[1].refs.created, undefined);
  assert.equal(events[2].refs.created, undefined);
});

test("the baseline version has neither refs.prev nor refs.created", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);

  const events = fileVersionEvents(root, home, "a.txt");
  assert.equal(events.length, 1);
  assert.equal(events[0].refs.baseline, true);
  assert.equal(events[0].refs.prev, undefined);
  assert.equal(events[0].refs.created, undefined);
  assert.equal("prev" in events[0].refs, false);
  assert.equal("created" in events[0].refs, false);
});

test("a file created after the baseline has refs.created and no refs.prev", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  writeFileSync(join(root, "b.txt"), "two\n");
  const out = reconcileRepo(root, {}, home);
  assert.equal(out.coverage, "complete");

  const events = fileVersionEvents(root, home, "b.txt");
  assert.equal(events.length, 1);
  assert.equal(events[0].refs.created, true);
  assert.equal(events[0].refs.prev, undefined);
  assert.equal("prev" in events[0].refs, false);
  assert.equal(events[0].refs.baseline, true);
});

test("a re-created file after a deletion has refs.created and no refs.prev", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  rmSync(join(root, "a.txt"));
  reconcileRepo(root, {}, home);
  writeFileSync(join(root, "a.txt"), "two\n");
  reconcileRepo(root, {}, home);

  const events = fileVersionEvents(root, home, "a.txt");
  assert.equal(events.length, 3);
  assert.equal(events[1].refs.deleted, true);
  assert.equal(events[2].refs.created, true);
  assert.equal(events[2].refs.prev, undefined);
  assert.equal("prev" in events[2].refs, false);
  assert.equal(events[2].refs.deleted, undefined);

  rmSync(join(root, "a.txt"));
  reconcileRepo(root, {}, home);
  writeFileSync(join(root, "a.txt"), "two\n");
  reconcileRepo(root, {}, home);
  const recreatedSame = fileVersionEvents(root, home, "a.txt");
  assert.equal(recreatedSame.length, 5);
  assert.equal(recreatedSame[4].refs.created, true);
  assert.equal(recreatedSame[4].refs.prev, undefined);
});

test("a deletion event carries refs.prev of the last live version", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  writeFileSync(join(root, "a.txt"), "two\n");
  reconcileRepo(root, {}, home);
  rmSync(join(root, "a.txt"));
  reconcileRepo(root, {}, home);

  const events = fileVersionEvents(root, home, "a.txt");
  assert.equal(events.length, 3);
  const del = events[2];
  assert.equal(del.refs.deleted, true);
  assert.equal(del.refs.prev, events[1].refs.version);
  assert.equal(del.refs.created, undefined);
  assert.equal(del.refs.version, del.nodeId);
  assert.notEqual(del.refs.version, events[1].refs.version);
});

test("a file still missing after repeated reconciles has exactly one deletion event", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  rmSync(join(root, "a.txt"));
  reconcileRepo(root, {}, home);
  reconcileRepo(root, {}, home);
  reconcileRepo(root, {}, home);

  const deletions = fileVersionEvents(root, home, "a.txt").filter((e) => e.refs.deleted === true);
  assert.equal(deletions.length, 1);
});

test("a file re-created after a single deletion has refs.created and no refs.prev", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  rmSync(join(root, "a.txt"));
  reconcileRepo(root, {}, home);
  reconcileRepo(root, {}, home);
  writeFileSync(join(root, "a.txt"), "two\n");
  reconcileRepo(root, {}, home);

  const events = fileVersionEvents(root, home, "a.txt");
  assert.equal(events.length, 3);
  assert.equal(events[2].refs.created, true);
  assert.equal("prev" in events[2].refs, false);
});

test("deleting a re-created file again appends a second deletion carrying the re-created sha as refs.prev", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  rmSync(join(root, "a.txt"));
  reconcileRepo(root, {}, home);
  writeFileSync(join(root, "a.txt"), "two\n");
  reconcileRepo(root, {}, home);
  rmSync(join(root, "a.txt"));
  reconcileRepo(root, {}, home);
  reconcileRepo(root, {}, home);

  const events = fileVersionEvents(root, home, "a.txt");
  const deletions = events.filter((e) => e.refs.deleted === true);
  assert.equal(deletions.length, 2);
  const recreated = events[2];
  assert.equal(recreated.refs.created, true);
  assert.equal(deletions[1].refs.prev, recreated.refs.version);
});

test("an eviction gap blocks refs.created", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  const gapResult = appendListeningEvent(root, {
    v: 1,
    eventId: "gap-1",
    source: "watcher",
    repoRoot: root,
    ts: Date.now(),
    adapterVersion: "listening-store/1",
    consent: { host: false, repo: true, rawTrace: false },
    redaction: { applied: false, truncated: false },
    coverage: "partial",
    refs: {},
    gapEvicted: 3,
  }, undefined, home);
  assert.equal(gapResult.ok, true);

  writeFileSync(join(root, "b.txt"), "two\n");
  reconcileRepo(root, {}, home);

  const events = fileVersionEvents(root, home, "b.txt");
  assert.equal(events.length, 1);
  assert.equal(events[0].refs.created, undefined);
  assert.equal(events[0].refs.prev, undefined);
  assert.equal("created" in events[0].refs, false);
  assert.equal("prev" in events[0].refs, false);
});

test("malformed log lines block refs.created", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(ensureBaseline(root, home).ok, true);
  appendFileSync(eventsPath(root, home), "{not-valid-json\n");

  writeFileSync(join(root, "b.txt"), "two\n");
  reconcileRepo(root, {}, home);

  const events = fileVersionEvents(root, home, "b.txt");
  assert.equal(events.length, 1);
  assert.equal(events[0].refs.created, undefined);
  assert.equal(events[0].refs.prev, undefined);
});

test("events without the new refs still load", () => {
  const home = freshHome();
  const root = consentedRepo(home);
  const oneSha = createHash("sha256").update("one\n", "utf8").digest("hex");
  writeFileSync(join(root, "a.txt"), "one\n");
  assert.equal(appendListeningEvent(root, {
    v: 1,
    eventId: "old-1",
    source: "watcher",
    repoRoot: root,
    ts: Date.now() - 2000,
    adapterVersion: "listening-watcher/1",
    node: "file_version",
    nodeId: "old-ver-1",
    consent: { host: false, repo: true, rawTrace: false },
    redaction: { applied: true, truncated: false },
    coverage: "complete",
    refs: { version: oneSha, fileRel: "a.txt", baseline: true },
  }, undefined, home).ok, true);
  assert.equal(appendListeningEvent(root, {
    v: 1,
    eventId: "old-2",
    source: "watcher",
    repoRoot: root,
    ts: Date.now() - 1000,
    adapterVersion: "listening-watcher/1",
    node: "file_version",
    nodeId: "old-del-1",
    consent: { host: false, repo: true, rawTrace: false },
    redaction: { applied: true, truncated: false },
    coverage: "complete",
    refs: { version: "old-del-1", fileRel: "b.txt", deleted: true },
  }, undefined, home).ok, true);

  const loaded = loadEventsForProjection(root, home);
  assert.equal(loaded.malformed, 0);
  assert.equal(loaded.truncated, false);
  assert.equal(loaded.events.length, 2);

  const graph = projectGraph(root, { limit: 50 }, home);
  assert.equal(graph.coverage.status, "complete");
  assert.equal(graph.nodes.length, 2);

  writeFileSync(join(root, "b.txt"), "reborn\n");
  const unchangedA = reconcileRepo(root, {}, home);
  assert.equal(unchangedA.coverage, "complete");
  assert.equal(fileVersionEvents(root, home, "a.txt").length, 1);

  const bEvents = fileVersionEvents(root, home, "b.txt");
  assert.equal(bEvents.length, 2);
  assert.equal(bEvents[1].refs.created, true);
  assert.equal(bEvents[1].refs.prev, undefined);

  writeFileSync(join(root, "a.txt"), "two\n");
  reconcileRepo(root, {}, home);
  const aEvents = fileVersionEvents(root, home, "a.txt");
  assert.equal(aEvents.length, 2);
  assert.equal(aEvents[1].refs.prev, oneSha);
  assert.equal(aEvents[1].refs.created, undefined);
});
