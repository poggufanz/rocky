import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
const PROCESS_TIMEOUT_MS = 10_000;
const NEVER_PACKAGE = "this-package-should-never-exist-rocky-0405060708";

interface Sandbox {
  root: string;
  repo: string;
  rockyHome: string;
  env: NodeJS.ProcessEnv;
}

function sandbox(t: TestContext): Sandbox {
  const root = mkdtempSync(join(packageRoot, ".rocky-check-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const rockyHome = join(root, "rocky-home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(rockyHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ROCKY_HOME: rockyHome,
    ROCKY_NO_QUIZ: "1",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return { root, repo, rockyHome, env };
}

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    // The managed test sandbox can attach EPERM to a completed nested process;
    // its status/stdout still describe the real git result.
    const completed = error as Error & { status?: number; stdout?: string };
    if (completed.status === 0 && typeof completed.stdout === "string") return completed.stdout.trim();
    throw error;
  }
}

function writeRepoFile(repo: string, path: string, contents: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents, "utf8");
}

function initRepo(box: Sandbox, initial: Record<string, string>, second?: Record<string, string>): {
  first: string;
  second?: string;
} {
  git(box.repo, ["init"]);
  git(box.repo, ["config", "user.email", "rocky@example.test"]);
  git(box.repo, ["config", "user.name", "Rocky Test"]);
  for (const [path, contents] of Object.entries(initial)) writeRepoFile(box.repo, path, contents);
  git(box.repo, ["add", "."]);
  git(box.repo, ["commit", "-m", "initial"]);
  const first = git(box.repo, ["rev-parse", "HEAD"]);
  if (second === undefined) return { first };
  for (const [path, contents] of Object.entries(second)) writeRepoFile(box.repo, path, contents);
  git(box.repo, ["add", "."]);
  git(box.repo, ["commit", "-m", "second"]);
  return { first, second: git(box.repo, ["rev-parse", "HEAD"]) };
}

function prePushLine(head: string, base: string): string {
  return `refs/heads/x ${head} refs/heads/x ${base}\n`;
}

function runCheck(
  box: Sandbox,
  args: readonly string[],
  input?: string,
  preload?: string,
): Promise<{ error?: Error; signal: NodeJS.Signals | null; status: number | null; stderr: string; pid: number }> {
  const nodeArgs = preload === undefined
    ? [entry, "check", ...args]
    : ["--require", preload, entry, "check", ...args];
  return new Promise((resolveResult) => {
    const nonce = `${Date.now()}-${Math.random()}`;
    const stdinPath = join(box.root, `stdin-${nonce}`);
    const stdoutPath = join(box.root, `stdout-${nonce}`);
    const stderrPath = join(box.root, `stderr-${nonce}`);
    writeFileSync(stdinPath, input ?? "", "utf8");
    const stdin = openSync(stdinPath, "r");
    const stdout = openSync(stdoutPath, "w");
    const stderr = openSync(stderrPath, "w");
    const child = spawn(process.execPath, nodeArgs, {
      cwd: box.repo,
      env: box.env,
      stdio: [stdin, stdout, stderr],
      windowsHide: true,
    });
    let spawnError: Error | undefined;
    const timer = setTimeout(() => child.kill(), PROCESS_TIMEOUT_MS);
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      closeSync(stdin);
      closeSync(stdout);
      closeSync(stderr);
      resolveResult({
        ...(spawnError === undefined ? {} : { error: spawnError }),
        status,
        signal,
        stderr: readFileSync(stderrPath, "utf8"),
        pid: child.pid ?? 0,
      });
    });
  });
}

function assertCompleted(
  result: { error?: Error; signal: NodeJS.Signals | null; status: number | null; stderr: string },
  status: number,
): void {
  if (result.error !== undefined) {
    assert.equal((result.error as NodeJS.ErrnoException).code, "EPERM");
    assert.notEqual(result.status, null);
  }
  assert.equal(result.signal, null);
  assert.equal(result.status, status, result.stderr);
}

function enableRegistry(box: Sandbox): void {
  writeFileSync(join(box.rockyHome, "config.json"), JSON.stringify({
    version: 1,
    ai: { enabled: false },
    check: { registry: true },
  }), "utf8");
}

function registry404Preload(box: Sandbox): { path: string; marker: string } {
  const path = join(box.root, "registry-404.cjs");
  const marker = join(box.root, "registry-fetches.txt");
  writeFileSync(path, [
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "global.fetch = async (url) => {",
    "  fs.appendFileSync(marker, String(url) + '\\n');",
    "  return { status: 404 };",
    "};",
    "",
  ].join("\n"), "utf8");
  return { path, marker };
}

function throwingStderrPreload(box: Sandbox, target: string, registry404 = false): string {
  const path = join(box.root, `stderr-throw-${registry404 ? "registry" : "plain"}.cjs`);
  writeFileSync(path, [
    "const originalWrite = process.stderr.write.bind(process.stderr);",
    "let thrown = false;",
    "process.stderr.write = function (chunk, ...args) {",
    `  if (!thrown && String(chunk).includes(${JSON.stringify(target)})) { thrown = true; throw new Error('injected stderr failure'); }`,
    "  return originalWrite(chunk, ...args);",
    "};",
    ...(registry404 ? ["global.fetch = async () => ({ status: 404 });"] : []),
    "",
  ].join("\n"), "utf8");
  return path;
}

function installGitShim(
  box: Sandbox,
  mode: "merge-base-128" | "diff-hang-once" | "diff-flood" | "diff-stderr-flood" | "rev-parse-flood" | "show-flood" | "show-128",
): void {
  const realGit = (box.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory, "git"))
    .find(existsSync);
  assert.ok(realGit, "git executable must be present on PATH");
  const bin = join(box.root, "git-shim-bin");
  const script = join(bin, "git-shim.cjs");
  mkdirSync(bin, { recursive: true });
  writeFileSync(script, [
    "#!/usr/bin/env node",
    "const { existsSync, writeFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const args = process.argv.slice(2);",
    "const mode = process.env.ROCKY_GIT_SHIM_MODE;",
    "if (mode === 'merge-base-128' && args.includes('merge-base')) process.exit(128);",
    "if (mode === 'diff-flood' && args.includes('--unified=0')) { require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'diff-stderr-flood' && args.includes('--unified=0')) { require('node:fs').writeSync(2, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'rev-parse-flood' && args.includes('--git-dir')) { require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'show-flood' && args.includes('show')) { require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'show-128' && args.includes('show')) process.exit(128);",
    "if (mode === 'diff-hang-once' && args.includes('--unified=0') && !existsSync(process.env.ROCKY_GIT_SHIM_MARKER)) {",
    "  writeFileSync(process.env.ROCKY_GIT_SHIM_MARKER, 'started');",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);",
    "  process.exit(0);",
    "}",
    "const result = spawnSync(process.env.ROCKY_REAL_GIT, args, { stdio: 'inherit' });",
    "process.exit(result.status === null ? 1 : result.status);",
    "",
  ].join("\n"), "utf8");
  chmodSync(script, 0o755);
  symlinkSync("git-shim.cjs", join(bin, "git"));
  box.env.PATH = `${bin}:${box.env.PATH ?? ""}`;
  box.env.ROCKY_REAL_GIT = realGit;
  box.env.ROCKY_GIT_SHIM_MODE = mode;
  box.env.ROCKY_GIT_SHIM_MARKER = join(box.root, "git-shim.marker");
}

test("pre-push check finds a planted secret and uses finding exit 3", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAABCDEFGHIJKLMNOP";
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/key.ts": `export const key = "${secret}";\n` });

  const result = await runCheck(box, ["--offline", "--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 3);
  assert.match(result.stderr, /src\/key\.ts:1/);
  assert.match(result.stderr, /aws access key/);
});

test("manual check finds committed content without an upstream and exits 1", async (t) => {
  const box = sandbox(t);
  const secret = "AKIABADCFEHGJILKNMOP";
  initRepo(box, { "src/key.ts": `export const key = "${secret}";\n` });

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 1);
  assert.match(result.stderr, /src\/key\.ts:1/);
});

test("pre-push check passes a clean endpoint range", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 42;\n" });

  const result = await runCheck(box, ["--pre-push", "--offline"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
});

test("pre-push ignores a remote named --install-hook and runs the scan", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAZXCVBNMASDFGHJKL";
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "src/key.ts": `export const key = "${secret}";\n`,
  });

  const result = await runCheck(
    box,
    ["--pre-push", "--install-hook", "https://evil.example/repo.git"],
    prePushLine(commits.second!, commits.first),
  );

  assertCompleted(result, 3);
  assert.match(result.stderr, /src\/key\.ts:1/);
  assert.equal(existsSync(join(box.repo, ".git", "hooks", "pre-push")), false);
});

test("pre-push ignores a remote named --offline and still runs the package stage", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(box);
  const preload = registry404Preload(box);

  const result = await runCheck(
    box,
    ["--pre-push", "--offline", "https://evil.example/repo.git"],
    prePushLine(commits.second!, commits.first),
    preload.path,
  );

  assertCompleted(result, 3);
  assert.match(result.stderr, new RegExp(NEVER_PACKAGE));
  assert.match(readFileSync(preload.marker, "utf8"), /registry\.npmjs\.org/);
});

test("new-ref range uses an existing remote-tracking merge base", async (t) => {
  const box = sandbox(t);
  const oldSecret = "AKIAAZBYCXDWEVFUGTHS";
  const commits = initRepo(
    box,
    { "src/old.ts": `export const old = "${oldSecret}";\n` },
    { "src/new.ts": "export const newValue = 42;\n" },
  );
  git(box.repo, ["update-ref", "refs/remotes/origin/main", commits.first]);
  const zero = "0".repeat(40);

  const result = await runCheck(box, ["--pre-push", "--offline"], prePushLine(commits.second!, zero));

  assertCompleted(result, 0);
  assert.doesNotMatch(result.stderr, /src\/old\.ts/);
});

test("new-ref range falls back to the empty tree when no remote-tracking base exists", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAMNBVCXZLKJHGFDSA";
  const commits = initRepo(box, { "src/root.ts": `export const root = "${secret}";\n` });
  const zero = "0".repeat(40);

  const result = await runCheck(box, ["--pre-push", "--offline"], prePushLine(commits.first, zero));

  assertCompleted(result, 3);
  assert.match(result.stderr, /src\/root\.ts:1/);
});

test("new-ref merge-base exit 128 skips both scans for that ref instead of using the empty tree", async (t) => {
  if (process.platform === "win32") return;
  const box = sandbox(t);
  const secret = "AKIAHGFDSAPOIUYTREWQ";
  const commits = initRepo(box, { "src/root.ts": `export const root = "${secret}";\n` });
  git(box.repo, ["update-ref", "refs/remotes/origin/main", commits.first]);
  installGitShim(box, "merge-base-128");
  const zero = "0".repeat(40);

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.first, zero));

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /ref refs\/heads\/x.*not inspected.*merge-base/i);
  assert.doesNotMatch(result.stderr, /src\/root\.ts/);
});

test("a later package-stage failure cannot erase an earlier secret finding", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAQWERTYUIOPASDFGH";
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "src/key.ts": `export const key = "${secret}";\n`,
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  writeFileSync(join(box.rockyHome, "config.json"), "{}\n", "utf8");

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 3);
  assert.match(result.stderr, /src\/key\.ts:1/);
  assert.match(result.stderr, /could not run/);
});

test("secret finding latches before its announcement can fail", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAQAZWSXEDCRFVTGBY";
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "src/key.ts": `export const key = "${secret}";\n`,
  });
  const preload = throwingStderrPreload(box, "secret sits in outgoing code");

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first), preload);

  assertCompleted(result, 3);
  assert.match(result.stderr, /secret scan could not run.*injected stderr failure/);
});

test("missing-package finding latches before its announcement can fail", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(box);
  const preload = throwingStderrPreload(box, "package does not exist", true);

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first), preload);

  assertCompleted(result, 3);
  assert.match(result.stderr, /package scan could not run.*injected stderr failure/);
});

test("an uncommitted working-tree lockfile cannot suppress committed package evidence", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  writeRepoFile(box.repo, "package-lock.json", JSON.stringify({
    lockfileVersion: 3,
    packages: { [`node_modules/${NEVER_PACKAGE}`]: { version: "1.0.0" } },
  }));
  enableRegistry(box);
  const preload = registry404Preload(box);

  const result = await runCheck(
    box,
    ["--pre-push"],
    prePushLine(commits.second!, commits.first),
    preload.path,
  );

  assertCompleted(result, 3);
  assert.match(result.stderr, new RegExp(NEVER_PACKAGE));
  assert.match(readFileSync(preload.marker, "utf8"), /registry\.npmjs\.org/);
});

test("repairing a malformed old package manifest skips that file and never calls the registry", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{not json\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(box);
  const preload = registry404Preload(box);

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first), preload.path);

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /package check skipped for package\.json.*old manifest.*malformed/i);
  assert.equal(existsSync(preload.marker), false, "registry must not be called for a repaired malformed manifest");
});

test("NUL-delimited name-only output finds a nested package manifest with a tab in its path", async (t) => {
  const box = sandbox(t);
  const path = "packages/tab\tname/package.json";
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    [path]: JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(box);
  const preload = registry404Preload(box);

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first), preload.path);

  assertCompleted(result, 3);
  assert.match(result.stderr, new RegExp(NEVER_PACKAGE));
  assert.match(readFileSync(preload.marker, "utf8"), /registry\.npmjs\.org/);
});

test("hallucinated package blocks when stored registry consent is on and registry returns 404", {
  skip: process.env.ROCKY_TEST_OFFLINE === "1" ? "ROCKY_TEST_OFFLINE=1" : false,
}, async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(box);

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 3);
  assert.match(result.stderr, new RegExp(NEVER_PACKAGE));
});

test("--offline skips registry even when consent is stored", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(box);
  const preload = registry404Preload(box);

  const result = await runCheck(
    box,
    ["--offline", "--pre-push"],
    prePushLine(commits.second!, commits.first),
    preload.path,
  );

  assertCompleted(result, 0);
  assert.throws(() => readFileSync(preload.marker, "utf8"), { code: "ENOENT" });
});

test("not a git repository reports one line and exits 0", async (t) => {
  // The shared sandbox lives inside the package worktree, so a run there finds
  // the enclosing repository and tests something else entirely. A genuine
  // "no repository" case has to sit outside any repo.
  const outside = mkdtempSync(join(tmpdir(), "rocky-no-repo-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const box = sandbox(t);

  const result = await runCheck({ ...box, repo: outside }, ["--offline"]);

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /nothing to check/);
});

test("ROCKY_NO_QUIZ and missing TTY never block comprehension", async (t) => {
  const box = sandbox(t);
  initRepo(box, { "src/risky.ts": "export const risky = eval('1 + 1');\n" });

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 0);
  assert.doesNotMatch(result.stderr, /what .*doing/);
});

test("hook install refusal remains exit 1 when later consent loading fails", async (t) => {
  const box = sandbox(t);
  initRepo(box, { "README.md": "clean\n" });
  writeRepoFile(box.repo, ".git/hooks/pre-push", "#!/bin/sh\nexit 0\n");
  writeFileSync(join(box.rockyHome, "config.json"), "{}\n", "utf8");

  const result = await runCheck(box, ["--install-hook"]);

  assertCompleted(result, 1);
  assert.match(result.stderr, /belongs to another tool/);
  assert.match(result.stderr, /invalid config/);
});

test("hook install writes the path reported by git in a linked worktree", async (t) => {
  const box = sandbox(t);
  const main = join(box.root, "main");
  const linked = join(box.root, "linked");
  mkdirSync(main);
  git(main, ["init"]);
  git(main, ["config", "user.email", "rocky@example.test"]);
  git(main, ["config", "user.name", "Rocky Test"]);
  writeRepoFile(main, "README.md", "clean\n");
  git(main, ["add", "."]);
  git(main, ["commit", "-m", "initial"]);
  git(main, ["worktree", "add", "-b", "linked", linked]);
  const reported = git(linked, ["rev-parse", "--git-path", "hooks/pre-push"]);
  const expected = isAbsolute(reported) ? reported : resolve(linked, reported);

  const result = await new Promise<{ status: number | null; stderr: string }>((resolveResult) => {
    const child = spawn(process.execPath, [entry, "check", "--install-hook"], {
      cwd: linked,
      env: box.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (status) => resolveResult({ status, stderr: Buffer.concat(chunks).toString("utf8") }));
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(expected), true, `expected hook at ${expected}`);
  assert.ok(readFileSync(expected, "utf8").includes("rocky check --pre-push"));
});

test("a hung git diff is killed after the check-path deadline and fails open with one line", async (t) => {
  if (process.platform === "win32") return;
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 1;\n" });
  installGitShim(box, "diff-hang-once");
  const start = Date.now();

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.ok(Date.now() - start < 8_000, `hung git held check for ${Date.now() - start}ms`);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git diff timed out.*not inspected/i);
});

test("pre-push stdin over one megabyte is bounded and announces uninspected refs", async (t) => {
  const box = sandbox(t);
  initRepo(box, { "README.md": "clean\n" });

  const result = await runCheck(box, ["--pre-push"], "x".repeat(1024 * 1024 + 1));

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /pre-push input exceeded 1 MB.*not inspected/i);
});

test("git diff output over one megabyte is bounded and announces uninspected secret lines", async (t) => {
  if (process.platform === "win32") return;
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 1;\n" });
  installGitShim(box, "diff-flood");

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git diff output exceeded 1 MB.*secret lines not inspected/i);
});

test("git output is capped by default on the check path", async (t) => {
  if (process.platform === "win32") return;
  const box = sandbox(t);
  initRepo(box, { "README.md": "clean\n" });
  installGitShim(box, "rev-parse-flood");

  const result = await runCheck(box, ["--offline"]);

  // Exit 2, not 0: the cap tripped, so this range was never inspected, and a
  // manual run must not report that as clean.
  assertCompleted(result, 2);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git rev-parse output exceeded 1 MB.*check data not inspected/i);
});

test("git show output over one megabyte is bounded and announces the skipped package stage", async (t) => {
  if (process.platform === "win32") return;
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(box);
  const preload = registry404Preload(box);
  installGitShim(box, "show-flood");

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first), preload.path);

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git show output exceeded 1 MB.*package files not inspected/i);
});

test("git diff stderr over one megabyte is bounded and announced", async (t) => {
  if (process.platform === "win32") return;
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 1;\n" });
  installGitShim(box, "diff-stderr-flood");

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git diff output exceeded 1 MB.*secret lines not inspected/i);
});

test("git show failure skips the package stage instead of treating manifests as absent", async (t) => {
  if (process.platform === "win32") return;
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(box);
  const preload = registry404Preload(box);
  installGitShim(box, "show-128");

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first), preload.path);

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git show failed.*package files not inspected/i);
  assert.equal(existsSync(preload.marker), false);
});

test("added-line limit announces exactly how much was not checked", async (t) => {
  const box = sandbox(t);
  const source = Array.from({ length: 20_001 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n";
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/large.ts": source });

  const result = await runCheck(box, ["--pre-push", "--offline"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.match(result.stderr, /added-line limit: 20001 found; first 20000 checked, 1 not checked/);
});

test("package limit announces exactly how many names were not checked", async (t) => {
  const box = sandbox(t);
  const dependencies: Record<string, string> = {};
  for (let index = 0; index < 51; index++) dependencies[`rocky-limit-package-${index}`] = "1.0.0";
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies }),
  });
  enableRegistry(box);
  const preload = registry404Preload(box);

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first), preload.path);

  assertCompleted(result, 3);
  assert.match(result.stderr, /package limit: 51 found; first 50 checked, 1 not checked/);
});

test("offline package lookup never claims that capped package names were checked", async (t) => {
  const box = sandbox(t);
  const dependencies: Record<string, string> = {};
  for (let index = 0; index < 51; index++) dependencies[`rocky-offline-package-${index}`] = "1.0.0";
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies }),
  });

  const result = await runCheck(box, ["--pre-push", "--offline"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.doesNotMatch(result.stderr, /package limit:.*checked/i);
});

test("--help prints usage and checks nothing", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAZXCVBNMASDFGHJKL";
  initRepo(box, { "README.md": "clean\n" }, { "src/key.ts": `export const key = "${secret}";\n` });

  const result = await runCheck(box, ["--help"]);

  assertCompleted(result, 0);
  assert.match(result.stderr, /usage: rocky check/);
  // A usage print must not double as a scan: the planted secret stays unreported.
  assert.doesNotMatch(result.stderr, /src\/key\.ts/);
});

test("an unrecognised flag refuses instead of silently running a full check", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAZXCVBNMASDFGHJKL";
  initRepo(box, { "README.md": "clean\n" }, { "src/key.ts": `export const key = "${secret}";\n` });

  const result = await runCheck(box, ["--offlien"]);

  // Exit 2 is usage-error, deliberately neither 0 (clean) nor a finding code:
  // a typo'd --offline must never read as "checked, nothing found".
  assertCompleted(result, 2);
  assert.match(result.stderr, /unknown: --offlien/);
  assert.match(result.stderr, /usage: rocky check/);
  assert.doesNotMatch(result.stderr, /src\/key\.ts/);
});

test("pre-push mode never reads git's positional arguments as --help", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAZXCVBNMASDFGHJKL";
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "src/key.ts": `export const key = "${secret}";\n`,
  });

  const result = await runCheck(
    box,
    ["--pre-push", "--help", "https://example.com/repo.git"],
    prePushLine(commits.second!, commits.first),
  );

  assertCompleted(result, 3);
  assert.doesNotMatch(result.stderr, /usage: rocky check/);
  assert.match(result.stderr, /src\/key\.ts:1/);
});

test("a manual run whose git calls fail exits 2, not a clean 0", async (t) => {
  // Fail-open protects pushes, not exit codes. A stress audit found a manual
  // run reporting 0 — "checked, clean" to any script reading it — after git
  // failed so early that nothing was inspected at all.
  const box = sandbox(t);
  initRepo(box, { "README.md": "clean\n" }, { "src/a.ts": "const a = 1;\n" });
  rmSync(join(box.repo, ".git", "objects"), { recursive: true, force: true });

  const result = await runCheck(box, []);

  assertCompleted(result, 2);
  assert.match(result.stderr, /could not run/);
});

test("the same broken repository still lets a push through in hook mode", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/a.ts": "const a = 1;\n" });
  const line = prePushLine(commits.second!, commits.first);
  rmSync(join(box.repo, ".git", "objects"), { recursive: true, force: true });

  const result = await runCheck(box, ["--pre-push"], line);

  // Exit 0: a Rocky that cannot run must never be the reason a push is held.
  assertCompleted(result, 0);
});
