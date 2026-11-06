import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariantsCommand } from "../commands/invariants.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rocky-inv-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  git("init");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src", "payment"), { recursive: true });
  writeFileSync(join(dir, "src", "payment", "retry.ts"), "export {};\n");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const originalStderr = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stderr };
  } finally {
    process.stderr.write = originalStderr;
  }
}

test("invariantsCommand lists parsed blocks and flags globs matching nothing", async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".rocky"), { recursive: true });
  writeFileSync(join(dir, ".rocky", "invariants.md"), [
    "Invariant: payment may commit at most once",
    "Guarded by: src/payment/**, src/nonexistent/**",
    "Why: duplicate settlement",
    "",
  ].join("\n"));
  const { code, stderr } = await captureStderr(() => invariantsCommand([], dir));
  assert.equal(code, 0);
  assert.match(stderr, /rocky: Parsed 1 invariant from \.rocky\/invariants\.md\./);
  assert.match(stderr, /rocky: Glob "src\/nonexistent\/\*\*" matches no tracked file\. Possible typo\./);
  assert.match(stderr, /src\/nonexistent\/\*\*.*matches no tracked file/);
  assert.doesNotMatch(stderr, /src\/payment\/\*\*.*matches no tracked file/);
});

test("invariantsCommand flags dead globs correctly when run from a repo subdirectory", async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".rocky"), { recursive: true });
  writeFileSync(join(dir, ".rocky", "invariants.md"), [
    "Invariant: payment may commit at most once",
    "Guarded by: src/payment/**, src/nonexistent/**",
    "Why: duplicate settlement",
    "",
  ].join("\n"));
  const { code, stderr } = await captureStderr(() => invariantsCommand([], join(dir, "src")));
  assert.equal(code, 0);
  assert.match(stderr, /src\/nonexistent\/\*\*.*matches no tracked file/);
  assert.doesNotMatch(stderr, /src\/payment\/\*\*.*matches no tracked file/);
});

test("invariantsCommand exits 0 with hint when file is missing", async () => {
  const dir = makeRepo();
  const { code, stderr } = await captureStderr(() => invariantsCommand([], dir));
  assert.equal(code, 0);
  assert.match(stderr, /rocky: No invariant file yet\. Create \.rocky\/invariants\.md to declare what each invariant guards\./);
});

test("invariantsCommand exits 1 outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-nogit-"));
  const { code, stderr } = await captureStderr(() => invariantsCommand([], dir));
  assert.equal(code, 1);
  assert.match(stderr, /rocky: No git repository here\. Invariants live in the repository root\./);
});
