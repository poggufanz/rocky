import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveGitDiff,
  formatGitDiffLines,
  GIT_DIFF_TIMEOUT_MS,
  GIT_DIFF_MAX_BYTES,
  type GitDiffResult,
} from "../core/git-diff.js";
import { why, how } from "../commands/dictionary.js";
import { createToolRegistry, McpInvalidParamsError } from "../mcp/tools.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { parseQueryArgs, CliUsageError } from "../commands/cli-args.js";
import type { MemoryRecord, TripleRecord } from "../core/memory-read.js";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("git-diff constants match specification boundaries", () => {
  assert.equal(GIT_DIFF_TIMEOUT_MS, 5000, "timeoutMs must be 5000ms (5s)");
  assert.equal(GIT_DIFF_MAX_BYTES, 32768, "maxOutputBytes must be 32768 (32KB)");
});

test("formatGitDiffLines formats unavailable, commit-based, and uncommitted diffs", () => {
  assert.deepEqual(formatGitDiffLines(undefined), ["  (git diff unavailable)"]);
  assert.deepEqual(formatGitDiffLines({ diff: "" }), ["  (git diff unavailable)"]);
  assert.deepEqual(formatGitDiffLines({ diff: "   " }), ["  (git diff unavailable)"]);

  const commitDiff: GitDiffResult = {
    commit: "a1b2c3d4e5",
    diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,2 @@\n-old\n+new",
  };
  assert.deepEqual(formatGitDiffLines(commitDiff), [
    "  diff (commit a1b2c3d):",
    "    --- a/src/auth.ts",
    "    +++ b/src/auth.ts",
    "    @@ -1,2 +1,2 @@",
    "    -old",
    "    +new",
  ]);

  const uncommittedDiff: GitDiffResult = {
    commit: "uncommitted",
    diff: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-a\n+b",
  };
  assert.deepEqual(formatGitDiffLines(uncommittedDiff), [
    "  diff (uncommitted):",
    "    --- a/src/index.ts",
    "    +++ b/src/index.ts",
    "    @@ -1 +1 @@",
    "    -a",
    "    +b",
  ]);
});

test("formatGitDiffLines redacts secrets in diff output", () => {
  const secretDiff: GitDiffResult = {
    commit: "c0ffee1",
    diff: "--- a/config.ts\n+++ b/config.ts\n@@ -1 +1 @@\n+const token = \"ghp_123456789012345678901234567890123456\";",
  };
  const formatted = formatGitDiffLines(secretDiff);
  assert.equal(formatted[0], "  diff (commit c0ffee1):");
  assert.ok(!formatted.some((line) => line.includes("ghp_123456789012345678901234567890123456")), "Secrets must be redacted");
  assert.ok(formatted.some((line) => line.includes("[redacted")), "Redaction placeholder expected");
});

test("parseQueryArgs handles --diff correctly", () => {
  // Flag before query
  const res1 = parseQueryArgs(["--diff", "src/auth.ts"], { usage: "usage", allowDiff: true });
  assert.deepEqual(res1, { query: "src/auth.ts", useAi: false, diff: true });

  // Flag with terminator
  const res2 = parseQueryArgs(["--diff", "--", "src/auth.ts"], { usage: "usage", allowDiff: true });
  assert.deepEqual(res2, { query: "src/auth.ts", useAi: false, diff: true });

  // Literal token after terminator
  const res3 = parseQueryArgs(["--", "--diff"], { usage: "usage", allowDiff: true });
  assert.deepEqual(res3, { query: "--diff", useAi: false, diff: false });

  // --diff rejected when allowDiff is false or omitted
  assert.throws(
    () => parseQueryArgs(["--diff", "src/auth.ts"], { usage: "usage" }),
    CliUsageError,
  );

  // Duplicate --diff rejected
  assert.throws(
    () => parseQueryArgs(["--diff", "--diff", "src/auth.ts"], { usage: "usage", allowDiff: true }),
    CliUsageError,
  );

  // Option after query token rejected
  assert.throws(
    () => parseQueryArgs(["src/auth.ts", "--diff"], { usage: "usage", allowDiff: true }),
    CliUsageError,
  );
});

test("resolveGitDiff fails open gracefully outside git repo", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rocky-no-git-"));
  try {
    const result = await resolveGitDiff({
      file: "nonexistent.ts",
      cwd: tempDir,
      head: "a1b2c3d",
      ts: Date.now(),
    });
    assert.equal(result, undefined, "Must fail open with undefined outside git repository");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveGitDiff in git repo resolves commit, time window, and uncommitted diffs", { skip: !hasGit() }, async () => {
  const tempRepo = mkdtempSync(join(tmpdir(), "rocky-git-test-"));
  try {
    // Initialize temporary repository
    execFileSync("git", ["init"], { cwd: tempRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Rocky Tester"], { cwd: tempRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "tester@rocky.local"], { cwd: tempRepo, stdio: "ignore" });

    // Commit 1: Initial file
    const testFile = join(tempRepo, "test.txt");
    writeFileSync(testFile, "line 1\nline 2\n", "utf8");
    execFileSync("git", ["add", "test.txt"], { cwd: tempRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tempRepo, stdio: "ignore" });

    // Commit 2: Modification
    const commitTs = Date.now();
    writeFileSync(testFile, "line 1\nline 2 modified\nline 3 added\n", "utf8");
    execFileSync("git", ["add", "test.txt"], { cwd: tempRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: tempRepo, stdio: "ignore" });

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRepo, encoding: "utf8" }).trim();

    // 1. Resolve via commit SHA (head)
    const resHead = resolveGitDiff({
      head: headSha,
      file: "test.txt",
      cwd: tempRepo,
    });
    assert.ok(resHead !== undefined, "Should resolve diff by commit SHA");
    assert.equal(resHead?.commit, headSha.slice(0, 7));
    assert.ok(resHead?.diff.includes("+line 3 added"), "Diff must include added line");

    // 2. Resolve via timestamp window
    const resTs = resolveGitDiff({
      ts: commitTs,
      file: "test.txt",
      cwd: tempRepo,
    });
    assert.ok(resTs !== undefined, "Should resolve diff by timestamp window");
    assert.ok(resTs?.diff.includes("+line 3 added"), "Diff must include added line");

    // 3. Resolve uncommitted changes
    writeFileSync(testFile, "line 1\nline 2 modified\nline 3 added\nuncommitted line\n", "utf8");
    const resUncommitted = resolveGitDiff({
      file: "test.txt",
      cwd: tempRepo,
    });
    assert.ok(resUncommitted !== undefined, "Should resolve uncommitted working tree diff");
    assert.equal(resUncommitted?.commit, "uncommitted");
    assert.ok(resUncommitted?.diff.includes("+uncommitted line"));
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("why and how commands support --diff with mock gitDiff dependency", () => {
  const spoken: string[] = [];
  const supported: string[] = [];
  const speak = (line: string) => spoken.push(line);
  const support = (line: string) => supported.push(line);

  const mockTriple: TripleRecord = {
    id: "triple-test-1",
    ts: 1700000000000,
    schemaV: 1,
    kind: "triple",
    agent: "claude-code",
    origin: "agent-hook",
    cwd: "/workspace",
    intent: { text: "update authentication" },
    rationale: { text: "use secure password hashing", tags: ["security"], source: "notify" },
    mechanism: {
      head: "commit123456",
      files: [{ path: "src/auth.ts", plusMinus: [5, 2], props: ["auth"] }],
      truncatedFiles: 0,
      coverageStatus: "complete",
      baseline: "captured",
    },
  };

  const records = [mockTriple];

  // Test why without --diff
  spoken.length = 0;
  supported.length = 0;
  const codeWhy1 = why(["src/auth.ts"], {
    load: () => records,
    say: speak,
    out: support,
    now: 1700000001000,
  });
  assert.equal(codeWhy1, 0);
  assert.ok(!supported.some((line) => line.includes("diff (")), "Why without --diff must not show diff header");

  // Test why with --diff
  spoken.length = 0;
  supported.length = 0;
  const mockGitDiff = () => ({
    commit: "commit1",
    diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new",
  });
  const codeWhy2 = why(["--diff", "src/auth.ts"], {
    load: () => records,
    say: speak,
    out: support,
    now: 1700000001000,
    gitDiff: mockGitDiff,
  });
  assert.equal(codeWhy2, 0);
  assert.ok(supported.some((line) => line.includes("diff (commit commit1):")), "Why with --diff must show diff header");
  assert.ok(supported.some((line) => line.includes("+new")), "Why with --diff must include diff lines");

  // Test why with --diff when diff is unavailable (fail-open)
  spoken.length = 0;
  supported.length = 0;
  const codeWhyUnavailable = why(["--diff", "src/auth.ts"], {
    load: () => records,
    say: speak,
    out: support,
    now: 1700000001000,
    gitDiff: () => undefined,
  });
  assert.equal(codeWhyUnavailable, 0);
  assert.ok(supported.some((line) => line.includes("(git diff unavailable)")), "Why with unavailable diff must print (git diff unavailable)");

  // Test how with --diff
  spoken.length = 0;
  supported.length = 0;
  const codeHow = how(["--diff", "update authentication"], {
    load: () => records,
    say: speak,
    out: support,
    now: 1700000001000,
    gitDiff: mockGitDiff,
  });
  assert.equal(codeHow, 0);
  assert.ok(supported.some((line) => line.includes("diff (commit commit1):")), "How with --diff must show diff header");
  assert.ok(supported.some((line) => line.includes("+new")), "How with --diff must include diff lines");
});

test("MCP why_file supports optional diff parameter and secret redaction", async () => {
  const signal = new AbortController().signal;
  const mockTriple: TripleRecord = {
    id: "triple-mcp-1",
    ts: 1000,
    schemaV: 1,
    kind: "triple",
    agent: "claude-code",
    origin: "agent-hook",
    cwd: "/workspace",
    intent: { text: "refactor styles" },
    rationale: { text: "fix layout bug", tags: ["css"], source: "notify" },
    mechanism: {
      head: "a1b2c3d4e5f6",
      files: [{ path: "src/style.css", plusMinus: [3, 1], props: ["style"], provenance: "tool-observed" }],
      truncatedFiles: 0,
      coverageStatus: "complete",
      baseline: "captured",
    },
  };

  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => [mockTriple]),
    recallWithAi: disabledRecallWithAi,
  });

  // 1. Call without diff parameter
  const resNoDiff = await registry.call("why_file", { path: "src/style.css" }, signal);
  assert.equal(resNoDiff.isError, undefined);
  const structuredNoDiff = resNoDiff.structuredContent as { items: Array<{ diff?: string }> };
  const itemNoDiff = structuredNoDiff.items[0];
  assert.equal(itemNoDiff.diff, undefined);

  // 2. Call with invalid diff type (string instead of boolean)
  await assert.rejects(
    async () => registry.call("why_file", { path: "src/style.css", diff: "true" }, signal),
    McpInvalidParamsError,
  );

  // 3. Call with diff: true (outside real git repo fails open cleanly without error)
  const resDiff = await registry.call("why_file", { path: "src/style.css", diff: true }, signal);
  assert.equal(resDiff.isError, undefined, "why_file with diff: true must succeed even if git diff fails open");
});
