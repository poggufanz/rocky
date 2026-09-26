import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { committedBytes, headCommit, mapHunkToCommit, mapVersionToCommit } from "../listening/git-map.js";
import type { FileVersionObject } from "../listening/types.js";

function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureRepo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-git-map-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
  return dir;
}

function versionFor(dir: string, rel: string, redacted = false): FileVersionObject {
  const bytes = readFileSync(join(dir, rel));
  return {
    versionId: "v1",
    repoRoot: dir,
    rel,
    sha256: sha256hex(bytes),
    bytes: bytes.length,
    snapshotRef: "ref",
    redacted,
  };
}

test("exact committed version maps to HEAD", () => {
  const dir = fixtureRepo({ "a.txt": "hello\n" });
  const out = mapVersionToCommit(versionFor(dir, "a.txt"), { root: dir });
  assert.equal(out.basis, "content_mapped");
  assert.equal(out.commit, headCommit(dir));
  assert.equal(out.reason, "exact");
});

test("modified working file and traversal rel are unknown", () => {
  const dir = fixtureRepo({ "a.txt": "hello\n" });
  writeFileSync(join(dir, "a.txt"), "hello\nmore\n");
  assert.equal(mapVersionToCommit(versionFor(dir, "a.txt"), { root: dir }).basis, "unknown");
  const bad = { ...versionFor(dir, "a.txt"), rel: "../escape.txt" };
  assert.deepEqual(mapVersionToCommit(bad, { root: dir }), { basis: "unknown", reason: "bad-rel" });
});

test("redaction mismatch never maps exact", () => {
  const dir = fixtureRepo({ "a.txt": "token sk-ant-abcdefghij1234567890\n" });
  const committed = committedBytes(dir, "a.txt");
  assert.ok(committed !== undefined && committed.length > 0);
  const redacted = { ...versionFor(dir, "a.txt"), sha256: sha256hex(Buffer.from("token [redacted]\n")), redacted: true };
  assert.equal(mapVersionToCommit(redacted, { root: dir }).basis, "unknown");
});

test("hunk maps exact lines, unknown otherwise", () => {
  const dir = fixtureRepo({ "a.txt": "one\ntwo\n" });
  const head = headCommit(dir);
  assert.ok(head !== undefined);
  const hit = mapHunkToCommit("h1", { root: dir, rel: "a.txt", addedLines: ["two"], versionCommit: head });
  assert.equal(hit.basis, "content_mapped");
  const miss = mapHunkToCommit("h2", { root: dir, rel: "a.txt", addedLines: ["never-present-xyz"] });
  assert.equal(miss.basis, "unknown");
  const empty = mapHunkToCommit("h3", { root: dir, rel: "a.txt", addedLines: [] });
  assert.equal(empty.basis, "unknown");
});

test("outside a repo the lane fails open to unknown", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-norepo-")));
  const v: FileVersionObject = {
    versionId: "v", repoRoot: dir, rel: "a.txt", sha256: "0".repeat(64), bytes: 1, snapshotRef: "r", redacted: false,
  };
  assert.equal(mapVersionToCommit(v, { root: dir }).basis, "unknown");
  assert.equal(headCommit(dir), undefined);
});
