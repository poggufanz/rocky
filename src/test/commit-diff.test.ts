import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveCommitDiff } from "../core/git-diff.js";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("resolveCommitDiff refuses an unsafe ref without touching git", () => {
  assert.equal(resolveCommitDiff({ sha: "--help" }), undefined);
  assert.equal(resolveCommitDiff({ sha: "" }), undefined);
  assert.equal(resolveCommitDiff({ sha: "zzzz" }), undefined);
});

test("resolveCommitDiff returns one multi-file diff for a commit", { skip: !hasGit() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-bundle-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, "b.txt"), "two\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "both"], { cwd: dir, stdio: "ignore" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const got = resolveCommitDiff({ sha, cwd: dir });
    assert.ok(got !== undefined);
    assert.equal(got.commit, sha.slice(0, 7));
    assert.match(got.diff, /a\.txt/);
    assert.match(got.diff, /b\.txt/);
    assert.equal(got.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCommitDiff fails open on non-existent commit sha", { skip: !hasGit() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-bundle-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const got = resolveCommitDiff({ sha: "0123456789abcdef", cwd: dir });
    assert.equal(got, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCommitDiff redacts secrets and sets truncated flag when bounded", { skip: !hasGit() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-bundle-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "secret.txt"), "const token = \"ghp_123456789012345678901234567890123456\";\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "secret"], { cwd: dir, stdio: "ignore" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    
    // Normal resolution with secret redaction
    const got = resolveCommitDiff({ sha, cwd: dir });
    assert.ok(got !== undefined);
    assert.ok(!got.diff.includes("ghp_123456789012345678901234567890123456"));
    assert.ok(got.diff.includes("[redacted"));
    assert.equal(got.truncated, false);

    // Truncated resolution with tiny maxOutputBytes
    const truncated = resolveCommitDiff({ sha, cwd: dir, maxOutputBytes: 64 });
    if (truncated !== undefined) {
      assert.equal(truncated.truncated, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
