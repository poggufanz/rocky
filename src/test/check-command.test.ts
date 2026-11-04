import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanLine } from "../commands/check.js";
import { validateRockyPhrase } from "../ui/phrases.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
// Harness backstop only: the product's own git deadline is 5 s, and a loaded
// CI runner can add several seconds of CLI startup before it. This bound must
// never race the deadline-kill path it exists to observe.
const PROCESS_TIMEOUT_MS = 30_000;
const NEVER_PACKAGE = "this-package-should-never-exist-rocky-0405060708";
const NO_SHARED_HISTORY = /no upstream and no remote branch shares history: checking all of HEAD/;

interface Sandbox {
  root: string;
  repo: string;
  rockyHome: string;
  env: NodeJS.ProcessEnv;
}

function sandbox(t: TestContext): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-check-command-"));
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

function writeRepoFile(repo: string, path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents, "utf8");
}

function initRepo(
  box: Sandbox,
  initial: Record<string, string | Uint8Array>,
  second?: Record<string, string | Uint8Array>,
): {
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
): Promise<{ error?: Error; signal: NodeJS.Signals | null; status: number | null; stdout: string; stderr: string; pid: number }> {
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
        stdout: readFileSync(stdoutPath, "utf8"),
        stderr: readFileSync(stderrPath, "utf8"),
        pid: child.pid ?? 0,
      });
    });
  });
}

function assertCompleted(
  result: { error?: Error; signal: NodeJS.Signals | null; status: number | null; stderr: string },
  status: number,
  message?: string,
): void {
  if (result.error !== undefined) {
    assert.equal((result.error as NodeJS.ErrnoException).code, "EPERM");
    assert.notEqual(result.status, null);
  }
  assert.equal(result.signal, null);
  assert.equal(result.status, status, message === undefined ? result.stderr : `${message}: ${result.stderr}`);
}

/** A quiet manual run in a repo with no remote still states its scope, and says nothing else. */
function assertOnlyScopeNote(stderr: string): void {
  assert.match(stderr, NO_SHARED_HISTORY);
  assert.equal(stderr.trim().split(/\r?\n/).length, 1, stderr);
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

function registryMissingOnlyPreload(box: Sandbox, missingName: string): string {
  const path = join(box.root, "registry-one-404.cjs");
  writeFileSync(path, [
    `const missing = ${JSON.stringify(encodeURIComponent(missingName))};`,
    "global.fetch = async (url) => ({ status: String(url).endsWith('/' + missing) ? 404 : 200 });",
    "",
  ].join("\n"), "utf8");
  return path;
}

function registryStatusPreload(box: Sandbox, statuses: Record<string, number>, fallbackStatus = 200): string {
  const path = join(box.root, "registry-statuses.cjs");
  writeFileSync(path, [
    `const statuses = ${JSON.stringify(statuses)};`,
    `const fallbackStatus = ${fallbackStatus};`,
    "global.fetch = async (url) => {",
    "  const name = decodeURIComponent(String(url).slice(String(url).lastIndexOf('/') + 1));",
    "  return { status: statuses[name] ?? fallbackStatus };",
    "};",
    "",
  ].join("\n"), "utf8");
  return path;
}

function throwingStderrPreload(box: Sandbox, target: string, registry404 = false, firedMarker?: string): string {
  const path = join(box.root, `stderr-throw-${registry404 ? "registry" : "plain"}.cjs`);
  // A guard test is only meaningful when the injected failure really fired, so
  // the optional marker file lets the test prove the throw happened.
  const markFired = firedMarker === undefined
    ? ""
    : `require('node:fs').writeFileSync(${JSON.stringify(firedMarker)}, 'fired'); `;
  writeFileSync(path, [
    "const originalWrite = process.stderr.write.bind(process.stderr);",
    "let thrown = false;",
    "process.stderr.write = function (chunk, ...args) {",
    `  if (!thrown && String(chunk).includes(${JSON.stringify(target)})) { thrown = true; ${markFired}throw new Error('injected stderr failure'); }`,
    "  return originalWrite(chunk, ...args);",
    "};",
    ...(registry404 ? ["global.fetch = async () => ({ status: 404 });"] : []),
    "",
  ].join("\n"), "utf8");
  return path;
}

function installGitShim(
  box: Sandbox,
  mode: "merge-base-128" | "diff-hang-once" | "diff-flood" | "diff-stderr-flood" | "diff-malformed" | "diff-ambiguous" | "diff-index-only" | "diff-old-mode" | "diff-rename-from" | "diff-marker-only" | "diff-hunk-empty" | "diff-binary-patch" | "diff-invalid-later" | "diff-name-only-missing" | "diff-name-only-leading" | "diff-name-only-double" | "diff-name-only-bare" | "ls-tree-name-only-bare" | "apply-numstat-orphan" | "apply-numstat-bad-number" | "apply-numstat-mixed-binary" | "apply-numstat-count-mismatch" | "rev-parse-flood" | "show-flood" | "show-128" | "rev-list-flood",
): void {
  let realGit = (box.env.PATH ?? "")
    .split(delimiter)
    .flatMap((directory) => [join(directory, "git"), join(directory, "git.exe"), join(directory, "git.cmd")])
    .find(existsSync);
  if (realGit === undefined && process.platform === "win32") {
    try {
      realGit = execFileSync("where.exe", ["git"], { encoding: "utf8" })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && existsSync(line));
    } catch {
      /* the assertion below reports a missing test prerequisite */
    }
  }
  assert.ok(realGit, "git executable must be present on PATH");
  const bin = join(box.root, "git shim bin");
  const script = join(bin, "git shim.cjs");
  mkdirSync(bin, { recursive: true });
  writeFileSync(script, [
    "#!/usr/bin/env node",
    "const { appendFileSync, existsSync, writeFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const args = process.argv.slice(2);",
    "const mode = process.env.ROCKY_GIT_SHIM_MODE;",
    "appendFileSync(process.env.ROCKY_GIT_SHIM_CALL_LOG, JSON.stringify({ marker: 'rocky-git-shim', args }) + '\\n');",
    "if (mode === 'merge-base-128' && args.includes('merge-base')) process.exit(128);",
    "if (mode === 'diff-flood' && args.includes('--unified=0')) { require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'diff-stderr-flood' && args.includes('--unified=0')) { require('node:fs').writeSync(2, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'diff-malformed' && args.includes('--unified=0')) { require('node:fs').writeSync(1, 'not a unified diff\\n'); process.exit(0); }",
    "if (mode === 'diff-ambiguous' && args.includes('--unified=0')) { require('node:fs').writeSync(1, 'diff --git a/file.ts b/file.ts\\n'); process.exit(0); }",
    "if (mode === 'diff-index-only' && args.includes('--unified=0')) { require('node:fs').writeSync(1, 'diff --git a/file.ts b/file.ts\\nindex 1234567..89abcde 100644\\n'); process.exit(0); }",
    "if (mode === 'diff-old-mode' && args.includes('--unified=0')) { require('node:fs').writeSync(1, 'diff --git a/file.ts b/file.ts\\nold mode 100644\\n'); process.exit(0); }",
    "if (mode === 'diff-rename-from' && args.includes('--unified=0')) { require('node:fs').writeSync(1, 'diff --git a/file.ts b/renamed.ts\\nsimilarity index 100%\\nrename from file.ts\\n'); process.exit(0); }",
    "if (mode === 'diff-marker-only' && args.includes('--unified=0')) { require('node:fs').writeSync(1, 'diff --git a/file.ts b/file.ts\\n--- a/file.ts\\n'); process.exit(0); }",
    "if (mode === 'diff-hunk-empty' && args.includes('--unified=0')) { require('node:fs').writeSync(1, 'diff --git a/file.ts b/file.ts\\n--- a/file.ts\\n+++ b/file.ts\\n@@ -1 +1 @@\\n'); process.exit(0); }",
    "if (mode === 'diff-binary-patch' && args.includes('--unified=0')) { require('node:fs').writeSync(1, 'diff --git a/file.bin b/file.bin\\nGIT binary patch\\nliteral 42\\n'); process.exit(0); }",
    "if (mode === 'diff-invalid-later' && args.includes('--unified=0') && args.some((arg) => /^c{40}$/.test(arg))) { require('node:fs').writeSync(1, 'not a unified diff\\n'); process.exit(0); }",
    "if (mode === 'diff-name-only-missing' && args.includes('--name-only')) { require('node:fs').writeSync(1, 'package.json'); process.exit(0); }",
    "if (mode === 'diff-name-only-leading' && args.includes('--name-only')) { require('node:fs').writeSync(1, '\\0package.json\\0'); process.exit(0); }",
    "if (mode === 'diff-name-only-double' && args.includes('--name-only')) { require('node:fs').writeSync(1, 'package.json\\0\\0'); process.exit(0); }",
    "if (mode === 'diff-name-only-bare' && args.includes('--name-only')) { require('node:fs').writeSync(1, '\\0'); process.exit(0); }",
    "if (mode === 'ls-tree-name-only-bare' && args.includes('ls-tree')) { require('node:fs').writeSync(1, '\\0'); process.exit(0); }",
    "if (mode === 'apply-numstat-orphan' && args.includes('apply')) { require('node:fs').writeSync(1, '0\\t0\\tfile.ts\\0orphan\\0'); process.exit(0); }",
    "if (mode === 'apply-numstat-bad-number' && args.includes('apply')) { require('node:fs').writeSync(1, '1x\\t0\\tfile.ts\\0'); process.exit(0); }",
    "if (mode === 'apply-numstat-mixed-binary' && args.includes('apply')) { require('node:fs').writeSync(1, '-\\t0\\tfile.ts\\0'); process.exit(0); }",
    "if (mode === 'apply-numstat-count-mismatch' && args.includes('apply')) { require('node:fs').writeSync(1, '0\\t0\\tfile.ts\\0'); process.exit(0); }",
    "if (mode === 'rev-parse-flood' && args.includes('--git-dir')) { require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'show-flood' && args.includes('show')) { require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'show-128' && args.includes('show')) process.exit(128);",
    "if (mode === 'rev-list-flood' && args.includes('rev-list')) { require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024 + 1, 120)); process.exit(0); }",
    "if (mode === 'diff-hang-once' && args.includes('--unified=0') && !existsSync(process.env.ROCKY_GIT_SHIM_MARKER)) {",
    "  writeFileSync(process.env.ROCKY_GIT_SHIM_MARKER, 'started');",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);",
    "  process.exit(0);",
    "}",
    "const result = spawnSync(process.env.ROCKY_REAL_GIT, args, { stdio: 'inherit' });",
    "process.exit(result.status === null ? 1 : result.status);",
    "",
  ].join("\n"), "utf8");
  box.env.ROCKY_REAL_GIT = realGit;
  box.env.ROCKY_GIT_SHIM_MODE = mode;
  box.env.ROCKY_GIT_SHIM_MARKER = join(box.root, "git-shim.marker");
  box.env.ROCKY_GIT_SHIM_CALL_LOG = join(box.root, "git-shim-calls.jsonl");
  box.env.ROCKY_GIT_TEST_MODE = "1";
  box.env.ROCKY_GIT_TEST_SHIM = JSON.stringify({ executable: process.execPath, script });
}

function shimCalls(box: Sandbox): Array<{ marker: string; args: string[] }> {
  assert.equal(existsSync(join(box.root, "git-shim-calls.jsonl")), true, "explicit Git seam was not invoked");
  return readFileSync(join(box.root, "git-shim-calls.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { marker: string; args: string[] });
}

function rockyHomeSnapshot(home: string): string {
  return JSON.stringify(readdirSync(home).sort().map((name) => [name, readFileSync(join(home, name), "utf8")]));
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

test("pre-push check finds a planted secret when the last diff section is a binary file", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAABCDEFGHIJKLMNOP";
  // Git sorts paths, so x.png closes the diff with a section that opens no hunk.
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "a-key.ts": `const key = "${secret}";\n`,
    "x.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
  });

  const result = await runCheck(box, ["--offline", "--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 3);
  assert.match(result.stderr, /a-key\.ts:1/);
  assert.match(result.stderr, /secret sits in outgoing code/);
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
  // Windows path names cannot contain a tab, so the fixture itself is
  // unbuildable there. The parsing this covers matters on POSIX, where such
  // a path is legal and git quotes it.
  if (process.platform === "win32") return;
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

test("manual registry outages are incomplete rather than clean", async (t) => {
  const box = sandbox(t);
  initRepo(box, { "package.json": JSON.stringify({ dependencies: { "rocky-registry-unreachable": "1.0.0" } }) });
  enableRegistry(box);

  const result = await runCheck(box, [], undefined, registryStatusPreload(box, {}, 503));

  assertCompleted(result, 2);
  assert.match(result.stderr, /registry unreachable.*rocky-registry-unreachable/i);
  assert.match(result.stderr, /incomplete/i);
});

test("mixed missing and unreachable packages retain both finding and incomplete evidence", async (t) => {
  const box = sandbox(t);
  const missing = "rocky-registry-missing";
  const unreachable = "rocky-registry-unreachable";
  initRepo(box, { "package.json": JSON.stringify({ dependencies: {
    [missing]: "1.0.0",
    [unreachable]: "1.0.0",
  } }) });
  enableRegistry(box);

  const result = await runCheck(
    box,
    [],
    undefined,
    registryStatusPreload(box, { [missing]: 404, [unreachable]: 503 }),
  );

  assertCompleted(result, 1);
  assert.match(result.stderr, new RegExp(missing));
  assert.match(result.stderr, new RegExp(`registry unreachable.*${unreachable}`));
  assert.match(result.stderr, /incomplete/i);
});

test("pre-push registry outages stay fail-open but announce incompleteness", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { "rocky-registry-unreachable": "1.0.0" } }),
  });
  enableRegistry(box);

  const result = await runCheck(
    box,
    ["--pre-push"],
    prePushLine(commits.second!, commits.first),
    registryStatusPreload(box, {}, 503),
  );

  assertCompleted(result, 0);
  assert.match(result.stderr, /registry unreachable/i);
  assert.match(result.stderr, /incomplete/i);
  assert.doesNotMatch(result.stderr, /checked.clean/i);
});

test("not a git repository is incomplete, exits 2 manually, and does not mutate quiet state", async (t) => {
  // Keep this case in a separately-created directory so it cannot inherit a
  // repository from the package checkout.
  const outside = mkdtempSync(join(tmpdir(), "rocky-no-repo-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const box = sandbox(t);
  const before = rockyHomeSnapshot(box.rockyHome);

  const result = await runCheck({ ...box, repo: outside }, ["--offline", "--quiet"]);

  assertCompleted(result, 2);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /INCOMPLETE/i);
  assert.match(result.stderr, /no workspace inspected/i);
  assert.equal(result.stdout, "");
  assert.equal(rockyHomeSnapshot(box.rockyHome), before, "manual offline quiet check must not write config or memory");
});

test("pre-push outside a git repository fails open but reports no inspection", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "rocky-no-repo-pre-push-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const box = sandbox(t);
  const before = rockyHomeSnapshot(box.rockyHome);
  const line = prePushLine("a".repeat(40), "b".repeat(40));

  const result = await runCheck({ ...box, repo: outside }, ["--offline", "--quiet", "--pre-push"], line);

  assertCompleted(result, 0);
  assert.match(result.stderr, /INCOMPLETE/i);
  assert.match(result.stderr, /no workspace inspected/i);
  assert.equal(result.stdout, "");
  assert.equal(rockyHomeSnapshot(box.rockyHome), before, "pre-push no-repo check must not write config or memory");
});

test("a valid git repository with an empty pushed diff is checked-clean", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" });

  const result = await runCheck(box, ["--offline", "--quiet", "--pre-push"], prePushLine(commits.first, commits.first));

  assertCompleted(result, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
});

test("git executable spawn failure is incomplete manually and fail-open in pre-push mode", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 1;\n" });
  const missingGit = join(box.root, "no-git-bin");
  mkdirSync(missingGit);
  box.env.PATH = missingGit;

  const manual = await runCheck(box, ["--offline", "--quiet"]);
  assertCompleted(manual, 2);
  assert.match(manual.stderr, /INCOMPLETE/i);
  assert.match(manual.stderr, /git.*(scope|executable)|no workspace inspected/i);
  assert.equal(manual.stdout, "");

  const hook = await runCheck(box, ["--offline", "--quiet", "--pre-push"], prePushLine(commits.second!, commits.first));
  assertCompleted(hook, 0);
  assert.match(hook.stderr, /INCOMPLETE/i);
  assert.match(hook.stderr, /git.*(scope|executable)|no workspace inspected/i);
  assert.equal(hook.stdout, "");
});

test("malformed or ambiguous git diff output is incomplete, not clean", async (t) => {
  for (const mode of [
    "diff-malformed",
    "diff-ambiguous",
    "diff-index-only",
    "diff-old-mode",
    "diff-rename-from",
    "diff-marker-only",
    "diff-hunk-empty",
    "diff-binary-patch",
  ] as const) {
    const box = sandbox(t);
    const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 1;\n" });
    installGitShim(box, mode);

    const manual = await runCheck(box, ["--offline", "--quiet"]);
    assertCompleted(manual, 2, mode);
    assert.match(manual.stderr, /INCOMPLETE|malformed|ambiguous/i, mode);
    assert.equal(manual.stdout, "", mode);

    const hook = await runCheck(box, ["--offline", "--quiet", "--pre-push"], prePushLine(commits.second!, commits.first));
    assertCompleted(hook, 0, mode);
    assert.match(hook.stderr, /INCOMPLETE|malformed|ambiguous/i, mode);
    assert.equal(hook.stdout, "", mode);
  }
});

test("the bounded Git process seam intercepts argv and preserves a finding before a later invalid range", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAABCDEFGHIJKLMNOP";
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "src/key.ts": `export const key = "${secret}";\n`,
  });
  installGitShim(box, "diff-invalid-later");
  const invalid = "c".repeat(40);
  const input = prePushLine(commits.second!, commits.first) + prePushLine(invalid, commits.first);

  const result = await runCheck(box, ["--offline", "--pre-push"], input);

  assertCompleted(result, 3);
  assert.match(result.stderr, /src\/key\.ts:1/);
  assert.match(result.stderr, /INCOMPLETE/i);
  const calls = shimCalls(box);
  assert.ok(calls.every(({ marker }) => marker === "rocky-git-shim"));
  assert.deepEqual(calls.map(({ args }) => args), [
    ["-c", "core.quotePath=false", "rev-parse", "--git-dir"],
    ["-c", "core.quotePath=false", "diff", "--unified=0", "--no-color", "--no-ext-diff", commits.first, commits.second!, "--"],
    ["apply", "--numstat", "-z"],
    ["-c", "core.quotePath=false", "diff", "--unified=0", "--no-color", "--no-ext-diff", commits.first, invalid, "--"],
    ["-c", "core.quotePath=false", "diff", "--name-only", "-z", commits.first, commits.second!, "--"],
    ["-c", "core.quotePath=false", "diff", "--name-only", "-z", commits.first, invalid, "--"],
  ]);
});

test("the process-test seam needs explicit mode and never falls through when invalid", async (t) => {
  const box = sandbox(t);
  initRepo(box, { "src/key.ts": "export const key = \"AKIAABCDEFGHIJKLMNOP\";\n" });
  box.env.ROCKY_GIT_TEST_SHIM = "{}";

  const ambient = await runCheck(box, ["--offline", "--quiet"]);
  assertCompleted(ambient, 1);
  assert.match(ambient.stderr, /src\/key\.ts:1/);

  box.env.ROCKY_GIT_TEST_MODE = "1";
  const explicit = await runCheck(box, ["--offline", "--quiet"]);
  assertCompleted(explicit, 2);
  assert.match(explicit.stderr, /invalid ROCKY_GIT_TEST_SHIM|INCOMPLETE/i);
  assert.doesNotMatch(explicit.stderr, /src\/key\.ts:1/);
});

test("a package finding from an earlier range survives a later invalid range", async (t) => {
  const box = sandbox(t);
  const missing = NEVER_PACKAGE;
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [missing]: "1.0.0" } }),
  });
  enableRegistry(box);
  const preload = registryMissingOnlyPreload(box, missing);
  const invalid = "d".repeat(40);
  const input = prePushLine(commits.second!, commits.first) + prePushLine(invalid, commits.first);

  const result = await runCheck(box, ["--pre-push"], input, preload);

  assertCompleted(result, 3);
  assert.match(result.stderr, new RegExp(missing));
  assert.match(result.stderr, /INCOMPLETE/i);
});

test("malformed name-only NUL framing is incomplete and never clean", async (t) => {
  for (const mode of [
    "diff-name-only-missing",
    "diff-name-only-leading",
    "diff-name-only-double",
    "diff-name-only-bare",
  ] as const) {
    const box = sandbox(t);
    const commits = initRepo(box, { "package.json": "{}\n" }, {
      "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
    });
    enableRegistry(box);
    installGitShim(box, mode);
    const manual = await runCheck(box, ["--quiet"]);
    assertCompleted(manual, 2, mode);
    assert.match(manual.stderr, /INCOMPLETE|malformed|ambiguous/i, mode);
    const hook = await runCheck(box, ["--quiet", "--pre-push"], prePushLine(commits.second!, commits.first));
    assertCompleted(hook, 0, mode);
    assert.match(hook.stderr, /INCOMPLETE|malformed|ambiguous/i, mode);
  }
});

test("malformed ls-tree NUL framing is incomplete and never clean", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, {
    "package.json": "{}\n",
    ".npmrc": "registry=https://registry.npmjs.org/\n",
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
  }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  installGitShim(box, "ls-tree-name-only-bare");

  const result = await runCheck(box, ["--offline", "--quiet", "--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.match(result.stderr, /INCOMPLETE|malformed|ambiguous/i);
});

test("malformed or inconsistent Git apply numstat framing is incomplete and intercepted", async (t) => {
  for (const mode of [
    "apply-numstat-orphan",
    "apply-numstat-bad-number",
    "apply-numstat-mixed-binary",
    "apply-numstat-count-mismatch",
  ] as const) {
    const box = sandbox(t);
    initRepo(box, { "README.md": "clean\n" });
    installGitShim(box, mode);

    const result = await runCheck(box, ["--offline", "--quiet"]);

    assertCompleted(result, 2, mode);
    assert.match(result.stderr, /INCOMPLETE|malformed|ambiguous/i, mode);
    assert.ok(shimCalls(box).some(({ args }) => args.includes("apply")), `${mode}: apply validator was not intercepted`);
  }
});

test("behavior reference and pre-push hook document the same clean/incomplete mapping", () => {
  const readme = readFileSync(join(packageRoot, "docs", "reference.md"), "utf8");
  const hook = readFileSync(join(packageRoot, "src", "check", "pre-push.ts"), "utf8");
  assert.match(readme, /no git repository.*exits? 2|exits? 2.*no git repository/is);
  assert.match(readme, /pre-push.*incomplete.*exit 0/is);
  assert.match(readme, /empty diff.*exit 0/is);
  assert.match(hook, /only.*exit 3.*blocks|exit 3.*only.*finding/is);
});

test("ROCKY_NO_QUIZ and missing TTY never block comprehension", async (t) => {
  const box = sandbox(t);
  // sandbox() sets ROCKY_NO_QUIZ=1, which would make this test vacuous: the
  // question must be reachable for the missing terminal to be what skips it.
  delete box.env.ROCKY_NO_QUIZ;
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
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 1;\n" });
  installGitShim(box, "diff-hang-once");
  const start = Date.now();

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  // Wall time includes CLI startup on a loaded runner; the bound proves the
  // 5 s git deadline killed the hang instead of holding indefinitely.
  assert.ok(Date.now() - start < 20_000, `hung git held check for ${Date.now() - start}ms`);
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
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 1;\n" });
  installGitShim(box, "diff-flood");

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git diff output exceeded 1 MB.*secret lines not inspected/i);
});

test("git output is capped by default on the check path", async (t) => {
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
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/value.ts": "export const value = 1;\n" });
  installGitShim(box, "diff-stderr-flood");

  const result = await runCheck(box, ["--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git diff output exceeded 1 MB.*secret lines not inspected/i);
});

test("git show failure skips the package stage instead of treating manifests as absent", async (t) => {
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

test("a secret beyond the added-line cap makes a manual check incomplete", async (t) => {
  const box = sandbox(t);
  const secret = "AKIACAPPEDLINESECRET12";
  const source = Array.from({ length: 20_000 }, (_, index) => `export const value${index} = ${index};`)
    .concat(`export const key = "${secret}";`)
    .join("\n") + "\n";
  initRepo(box, { "src/large.ts": source });

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 2);
  assert.match(result.stderr, /added-line limit: 20001 found; first 20000 checked, 1 skipped/);
  assert.match(result.stderr, /incomplete/i);
  assert.doesNotMatch(result.stderr, /src\/large\.ts:20001/);
});

test("a missing package beyond the package cap makes a manual check incomplete", async (t) => {
  const box = sandbox(t);
  const dependencies: Record<string, string> = {};
  for (let index = 0; index < 51; index++) dependencies[`rocky-limit-package-${index}`] = "1.0.0";
  initRepo(box, { "package.json": JSON.stringify({ dependencies }) });
  enableRegistry(box);

  const result = await runCheck(box, [], undefined, registryMissingOnlyPreload(box, "rocky-limit-package-50"));

  assertCompleted(result, 2);
  assert.match(result.stderr, /package limit: 51 found; first 50 checked, 1 skipped/);
  assert.match(result.stderr, /incomplete/i);
  assert.doesNotMatch(result.stderr, /rocky-limit-package-50/);
});

test("added-line limit announces incomplete coverage but remains fail-open for pre-push", async (t) => {
  const box = sandbox(t);
  const source = Array.from({ length: 20_001 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n";
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/large.ts": source });

  const result = await runCheck(box, ["--pre-push", "--offline"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.match(result.stderr, /added-line limit: 20001 found; first 20000 checked, 1 skipped/);
  assert.match(result.stderr, /incomplete/i);
  assert.doesNotMatch(result.stderr, /checked.clean/i);
});

test("package limit preserves a finding while reporting incomplete coverage", async (t) => {
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
  assert.match(result.stderr, /package limit: 51 found; first 50 checked, 1 skipped/);
  assert.match(result.stderr, /incomplete/i);
});

test("a missing package beyond the cap stays fail-open but reports incomplete pre-push coverage", async (t) => {
  const box = sandbox(t);
  const dependencies: Record<string, string> = {};
  for (let index = 0; index < 51; index++) dependencies[`rocky-tail-package-${index}`] = "1.0.0";
  const missing = "rocky-tail-package-50";
  const commits = initRepo(box, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies }),
  });
  enableRegistry(box);

  const result = await runCheck(
    box,
    ["--pre-push"],
    prePushLine(commits.second!, commits.first),
    registryMissingOnlyPreload(box, missing),
  );

  assertCompleted(result, 0);
  assert.match(result.stderr, /package limit: 51 found; first 50 checked, 1 skipped/);
  assert.match(result.stderr, /incomplete/i);
  assert.doesNotMatch(result.stderr, new RegExp(missing));
  assert.doesNotMatch(result.stderr, /checked.clean/i);
});

test("exact line and package caps remain complete", async (t) => {
  const box = sandbox(t);
  const source = Array.from({ length: 19_999 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n";
  const dependencies: Record<string, string> = {};
  for (let index = 0; index < 50; index++) dependencies[`rocky-exact-package-${index}`] = "1.0.0";
  const commits = initRepo(box, { "README.md": "clean\n", "package.json": "{}\n" }, {
    "src/large.ts": source,
    "package.json": JSON.stringify({ dependencies }),
  });
  enableRegistry(box);
  const result = await runCheck(
    box,
    ["--pre-push"],
    prePushLine(commits.second!, commits.first),
    registryMissingOnlyPreload(box, "never-missing"),
  );

  assertCompleted(result, 0);
  assert.doesNotMatch(result.stderr, /incomplete/i);
  assert.doesNotMatch(result.stderr, /limit:/i);
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

test("a manual run whose secret stage cannot read the diff exits 2, not a clean 0", async (t) => {
  // installGitShim uses the explicit validated process seam on every platform.
  // Fail-open protects pushes, not exit codes. A stress audit found a manual
  // run reporting 0 — "checked, clean" to any script reading it — when the
  // range had in fact never been inspected.
  const box = sandbox(t);
  initRepo(box, { "README.md": "clean\n" }, { "src/a.ts": "const a = 1;\n" });
  installGitShim(box, "diff-flood");

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 2);
  assert.match(result.stderr, /secret lines not inspected/i);
});

test("the same unreadable diff still lets a push through in hook mode", async (t) => {
  // installGitShim uses the explicit validated process seam on every platform.
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, { "src/a.ts": "const a = 1;\n" });
  const line = prePushLine(commits.second!, commits.first);
  installGitShim(box, "diff-flood");

  const result = await runCheck(box, ["--pre-push", "--offline"], line);

  // Exit 0: a Rocky that cannot inspect must never be the reason a push is held.
  assertCompleted(result, 0);
});

function cleanLineCount(stderr: string): number {
  return (stderr.match(/checked net change|net change has no new text lines/g) ?? []).length;
}

test("cleanLine states only the net change it checked, with exact plurals", () => {
  const lines = [
    [cleanLine(3, 2, 0), "checked net change: 3 new text lines, 2 files. no secret hit."],
    [cleanLine(1, 1, 1), "checked net change: 1 new text line, 1 file. no secret hit. 1 new package not looked up."],
    [cleanLine(0, 0, 0), "net change has no new text lines."],
    [cleanLine(5, 2, 3), "checked net change: 5 new text lines, 2 files. no secret hit. 3 new packages not looked up."],
    [cleanLine(0, 0, 2), "net change has no new text lines. 2 new packages not looked up."],
  ] as const;
  for (const [actual, expected] of lines) {
    assert.equal(actual, expected);
    assert.deepEqual(validateRockyPhrase(actual), [], actual);
  }
});

test("a clean pre-push check states its scope in one line", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "src/a.ts": "export const a = 1;\nexport const b = 2;\n",
    "src/b.ts": "export const c = 3;\n",
  });

  const result = await runCheck(box, ["--offline", "--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.match(result.stderr, /\[Rocky\] checked net change: 3 new text lines, 2 files\. no secret hit\.\r?\n/);
  assert.equal(cleanLineCount(result.stderr), 1, result.stderr);
});

test("a clean manual check states its scope and --quiet stays silent", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" });

  const loud = await runCheck(box, ["--offline"]);
  assertCompleted(loud, 0);
  assert.match(loud.stderr, /checked net change: /);
  assert.equal(cleanLineCount(loud.stderr), 1, loud.stderr);

  // --quiet drops the clean line. This repo has no remote, so the manual scope
  // note is a plain fact and survives it: it is the only line left.
  const quiet = await runCheck(box, ["--offline", "--quiet"]);
  assertCompleted(quiet, 0);
  assertOnlyScopeNote(quiet.stderr);

  const quietPush = await runCheck(
    box,
    ["--offline", "--quiet", "--pre-push"],
    prePushLine(commits.first, "0".repeat(40)),
  );
  assertCompleted(quietPush, 0);
  assert.equal(quietPush.stderr, "");
});

test("a secret added then removed inside the pushed range never reads as nothing to check", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAREMOVEDINRANGE12";
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "src/key.ts": `export const key = "${secret}";\n`,
    "src/keep.ts": "export const keep = 1;\n",
  });
  git(box.repo, ["rm", "-q", "src/key.ts"]);
  git(box.repo, ["commit", "-q", "-m", "remove key"]);
  const head = git(box.repo, ["rev-parse", "HEAD"]);

  const result = await runCheck(box, ["--offline", "--pre-push"], prePushLine(head, commits.first));

  assertCompleted(result, 0);
  assert.match(result.stderr, /checked net change: 1 new text line, 1 file\. no secret hit\./);
  assert.doesNotMatch(result.stderr, /nothing to check/i);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test("a push whose net change cancels out says it has no new text lines", async (t) => {
  const box = sandbox(t);
  const secret = "AKIACANCELLEDOUT1234";
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "src/key.ts": `export const key = "${secret}";\n`,
  });
  git(box.repo, ["rm", "-q", "src/key.ts"]);
  git(box.repo, ["commit", "-q", "-m", "remove key"]);
  const head = git(box.repo, ["rev-parse", "HEAD"]);

  const result = await runCheck(box, ["--offline", "--pre-push"], prePushLine(head, commits.first));

  assertCompleted(result, 0);
  assert.match(result.stderr, /\[Rocky\] net change has no new text lines\.\r?\n/);
  assert.doesNotMatch(result.stderr, /no secret hit|nothing to check/i);
  assert.equal(cleanLineCount(result.stderr), 1, result.stderr);
});

test("a binary-only push says its net change has no new text lines", async (t) => {
  const box = sandbox(t);
  const commits = initRepo(box, { "README.md": "clean\n" }, {
    "x.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
  });

  const result = await runCheck(box, ["--offline", "--pre-push"], prePushLine(commits.second!, commits.first));

  assertCompleted(result, 0);
  assert.match(result.stderr, /net change has no new text lines\./);
  assert.doesNotMatch(result.stderr, /no secret hit/);
});

test("junk pre-push input, a finding, and an incomplete scan never print the clean line", async (t) => {
  const junkBox = sandbox(t);
  initRepo(junkBox, { "README.md": "clean\n" });
  // One token is not a ref update, so no range exists: the early return stays silent.
  const junk = await runCheck(junkBox, ["--offline", "--pre-push"], "junk\n");
  assertCompleted(junk, 0);
  assert.equal(cleanLineCount(junk.stderr), 0, junk.stderr);

  const findingBox = sandbox(t);
  const commits = initRepo(findingBox, { "README.md": "clean\n" }, {
    "src/key.ts": 'export const key = "AKIAFINDINGNOCLEAN12";\n',
  });
  const finding = await runCheck(findingBox, ["--offline", "--pre-push"], prePushLine(commits.second!, commits.first));
  assertCompleted(finding, 3);
  assert.match(finding.stderr, /src\/key\.ts:1/);
  assert.equal(cleanLineCount(finding.stderr), 0, finding.stderr);

  const incompleteBox = sandbox(t);
  initRepo(incompleteBox, { "README.md": "clean\n" }, { "src/a.ts": "const a = 1;\n" });
  installGitShim(incompleteBox, "diff-flood");
  const incomplete = await runCheck(incompleteBox, ["--offline"]);
  assertCompleted(incomplete, 2);
  assert.match(incomplete.stderr, /secret lines not inspected/i);
  assert.equal(cleanLineCount(incomplete.stderr), 0, incomplete.stderr);
});

test("a clean check discloses new packages it did not look up", async (t) => {
  const offline = sandbox(t);
  const offlineCommits = initRepo(offline, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(offline);
  const skippedOffline = await runCheck(
    offline,
    ["--offline", "--pre-push"],
    prePushLine(offlineCommits.second!, offlineCommits.first),
  );
  assertCompleted(skippedOffline, 0);
  assert.match(
    skippedOffline.stderr,
    /checked net change: 1 new text line, 1 file\. no secret hit\. 1 new package not looked up\./,
  );

  // No stored consent and no terminal to ask on: the lookup is skipped, and the
  // clean line says how many names that left unchecked.
  const unconsented = sandbox(t);
  const unconsentedCommits = initRepo(unconsented, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({
      dependencies: { [NEVER_PACKAGE]: "1.0.0", [`${NEVER_PACKAGE}-two`]: "1.0.0" },
    }),
  });
  const skippedWithoutConsent = await runCheck(
    unconsented,
    ["--pre-push"],
    prePushLine(unconsentedCommits.second!, unconsentedCommits.first),
  );
  assertCompleted(skippedWithoutConsent, 0);
  assert.match(skippedWithoutConsent.stderr, /no secret hit\. 2 new packages not looked up\./);

  // A lookup that really ran leaves nothing to disclose.
  const looked = sandbox(t);
  const lookedCommits = initRepo(looked, { "package.json": "{}\n" }, {
    "package.json": JSON.stringify({ dependencies: { [NEVER_PACKAGE]: "1.0.0" } }),
  });
  enableRegistry(looked);
  const lookedUp = await runCheck(
    looked,
    ["--pre-push"],
    prePushLine(lookedCommits.second!, lookedCommits.first),
    registryStatusPreload(looked, {}, 200),
  );
  assertCompleted(lookedUp, 0);
  assert.match(lookedUp.stderr, /checked net change: 1 new text line, 1 file\. no secret hit\./);
  assert.doesNotMatch(lookedUp.stderr, /not looked up/);
});

test("a risky line with no terminal says the comprehension question was skipped", async (t) => {
  const box = sandbox(t);
  // sandbox() sets ROCKY_NO_QUIZ=1; the skip line is only reachable without it.
  delete box.env.ROCKY_NO_QUIZ;
  // An inert fixture line: it is written into a throwaway repo and never run.
  initRepo(box, { "src/risky.ts": "eval(x)\n" });

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 0);
  assert.match(result.stderr, /comprehension question skipped: no terminal/);
  // The question header never prints without a way to answer it.
  assert.doesNotMatch(result.stderr, /what .*doing/);
  // A skipped question is not an incomplete scan.
  assert.doesNotMatch(result.stderr, /INCOMPLETE/i);
  assert.match(result.stderr, /checked net change: 1 new text line, 1 file\. no secret hit\./);
  // The skip line is a plain fact through detail(), so it carries no persona
  // prefix and sits outside the persona lint ("question" is a noun there).
  assert.doesNotMatch(result.stderr, /\[Rocky\] comprehension question skipped/);
});

test("the skipped-question line stays silent under ROCKY_NO_QUIZ, --quiet, and a calm diff", async (t) => {
  const optedOut = sandbox(t);
  initRepo(optedOut, { "src/risky.ts": "eval(x)\n" });
  assert.equal(optedOut.env.ROCKY_NO_QUIZ, "1");
  const noQuiz = await runCheck(optedOut, ["--offline"]);
  assertCompleted(noQuiz, 0);
  assert.doesNotMatch(noQuiz.stderr, /comprehension question skipped/);

  const quiet = sandbox(t);
  delete quiet.env.ROCKY_NO_QUIZ;
  initRepo(quiet, { "src/risky.ts": "eval(x)\n" });
  const quietRun = await runCheck(quiet, ["--offline", "--quiet"]);
  assertCompleted(quietRun, 0);
  // The scope note is the one line --quiet keeps: no skip line, no question.
  assertOnlyScopeNote(quietRun.stderr);

  const calm = sandbox(t);
  delete calm.env.ROCKY_NO_QUIZ;
  initRepo(calm, { "src/calm.ts": "export const calm = 1;\n" });
  const calmRun = await runCheck(calm, ["--offline"]);
  assertCompleted(calmRun, 0);
  assert.doesNotMatch(calmRun.stderr, /comprehension question skipped/);
});

test("a stderr failure while stating a result never changes the exit code", async (t) => {
  const cleanBox = sandbox(t);
  initRepo(cleanBox, { "README.md": "clean\n" });
  const cleanMarker = join(cleanBox.root, "clean-line-fired.txt");
  const cleanPreload = throwingStderrPreload(cleanBox, "checked net change", false, cleanMarker);

  const clean = await runCheck(cleanBox, ["--offline"], undefined, cleanPreload);

  assert.equal(existsSync(cleanMarker), true, "the injected stderr failure never fired");
  // Exit 2 would mean the lost line was reported as an infrastructure failure.
  assertCompleted(clean, 0);
  assert.doesNotMatch(clean.stderr, /could not run|INCOMPLETE/i);

  const skipBox = sandbox(t);
  delete skipBox.env.ROCKY_NO_QUIZ;
  initRepo(skipBox, { "src/risky.ts": "eval(x)\n" });
  const skipMarker = join(skipBox.root, "skip-line-fired.txt");
  const skipPreload = throwingStderrPreload(skipBox, "comprehension question skipped", false, skipMarker);

  const skipped = await runCheck(skipBox, ["--offline"], undefined, skipPreload);

  assert.equal(existsSync(skipMarker), true, "the injected stderr failure never fired");
  assertCompleted(skipped, 0);
  assert.doesNotMatch(skipped.stderr, /could not run|INCOMPLETE/i);
});

function currentBranch(box: Sandbox): string {
  return git(box.repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function commitFile(box: Sandbox, path: string, contents: string, message: string): void {
  writeRepoFile(box.repo, path, contents);
  git(box.repo, ["add", "."]);
  git(box.repo, ["commit", "-q", "-m", message]);
}

/** A bare `origin` inside the sandbox; the current branch is pushed to it and tracks it. */
function addBareOrigin(box: Sandbox): void {
  const remote = join(box.root, "origin.git");
  git(box.root, ["init", "-q", "--bare", remote]);
  git(box.repo, ["remote", "add", "origin", remote]);
  git(box.repo, ["push", "-q", "-u", "origin", "HEAD"]);
}

test("a branch with no upstream is checked only from where it leaves the remote", async (t) => {
  const box = sandbox(t);
  const oldSecret = "AKIAOLDONTHEREMOTE12";
  initRepo(box, { "src/old.ts": `export const old = "${oldSecret}";\n` });
  addBareOrigin(box);
  git(box.repo, ["checkout", "-q", "-b", "feat"]);
  commitFile(box, "src/feat.ts", "export const feat = 1;\n", "feat");

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 0);
  assert.match(result.stderr, /checked net change: 1 new text line, 1 file\. no secret hit\./);
  assert.doesNotMatch(result.stderr, new RegExp(oldSecret));
  assert.doesNotMatch(result.stderr, NO_SHARED_HISTORY);
});

test("a diverged branch does not answer for commits only its upstream has", async (t) => {
  const box = sandbox(t);
  const oldSecret = "AKIAOLDONTHEREMOTE12";
  const upstreamSecret = "AKIAUPSTREAMONLY1234";
  initRepo(box, { "src/old.ts": `export const old = "${oldSecret}";\n` });
  addBareOrigin(box);
  // The upstream's own commit drops the old secret and adds another. The local
  // branch then steps back to the shared base and adds one clean commit, so it
  // is both behind and ahead. Diffing against the upstream tip would read the
  // old secret as an added line, because the local tree still has it.
  git(box.repo, ["rm", "-q", "src/old.ts"]);
  commitFile(box, "src/up.ts", `export const up = "${upstreamSecret}";\n`, "upstream only");
  git(box.repo, ["push", "-q", "origin", "HEAD"]);
  git(box.repo, ["reset", "-q", "--hard", "HEAD~1"]);
  commitFile(box, "src/local.ts", "export const local = 1;\n", "local only");
  assert.equal(git(box.repo, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]), "1\t1");

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 0);
  assert.match(result.stderr, /checked net change: 1 new text line, 1 file\. no secret hit\./);
  assert.doesNotMatch(result.stderr, new RegExp(`${oldSecret}|${upstreamSecret}`));
});

test("an upstream that shares no history is diffed from its own tip", async (t) => {
  const box = sandbox(t);
  const secret = "AKIAUNRELATEDTIP1234";
  initRepo(box, { "src/local.ts": `export const local = "${secret}";\n` });
  const branch = currentBranch(box);
  const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], {
    cwd: box.repo,
    input: "",
    encoding: "utf8",
  }).trim();
  const unrelated = git(box.repo, ["commit-tree", emptyTree, "-m", "unrelated"]);
  git(box.repo, ["remote", "add", "origin", join(box.root, "never-contacted.git")]);
  git(box.repo, ["update-ref", `refs/remotes/origin/${branch}`, unrelated]);
  git(box.repo, ["branch", "--set-upstream-to", `origin/${branch}`]);

  const result = await runCheck(box, ["--offline"]);

  // No merge base exists, so the upstream tip itself is the base and all of
  // HEAD reads as new to it.
  assertCompleted(result, 1);
  assert.match(result.stderr, /src\/local\.ts:1/);
});

test("a repository with no remote says it is checking all of HEAD", async (t) => {
  const box = sandbox(t);
  initRepo(box, { "README.md": "clean\n" });

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 0);
  assert.equal(result.stderr.match(new RegExp(NO_SHARED_HISTORY.source, "g"))?.length, 1, result.stderr);
  assert.match(result.stderr, /checked net change: 1 new text line, 1 file\. no secret hit\./);
});

test("a file named HEAD in the working tree does not make the revision ambiguous", async (t) => {
  const box = sandbox(t);
  initRepo(box, { HEAD: "just a file\n" });

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 0);
  assert.match(result.stderr, /checked net change: 1 new text line, 1 file\. no secret hit\./);
});

test("a manual run that cannot list its unpushed commits exits 2, not a clean 0", async (t) => {
  const flooded = sandbox(t);
  initRepo(flooded, { "README.md": "clean\n" });
  installGitShim(flooded, "rev-list-flood");
  const tooMany = await runCheck(flooded, ["--offline"]);
  assertCompleted(tooMany, 2);
  assert.match(tooMany.stderr, /git rev-list output exceeded 1 MB; unpushed commits not inspected/);
  assert.match(tooMany.stderr, /INCOMPLETE: no clean result/);
  assert.doesNotMatch(tooMany.stderr, /checked net change|net change has no new text lines/);

  // No commit yet, so rev-list has nothing to name HEAD with and git exits 128.
  const unborn = sandbox(t);
  git(unborn.repo, ["init", "-q"]);
  const noCommits = await runCheck(unborn, ["--offline"]);
  assertCompleted(noCommits, 2);
  assert.match(noCommits.stderr, /INCOMPLETE: no clean result/);
  assert.doesNotMatch(noCommits.stderr, /checked net change|net change has no new text lines/);
});

test("a branch already on a remote has no new text lines and no scope note", async (t) => {
  const box = sandbox(t);
  initRepo(box, { "src/old.ts": 'export const old = "AKIAOLDONTHEREMOTE12";\n' });
  addBareOrigin(box);
  // Same commit as the pushed branch, but with no upstream of its own.
  git(box.repo, ["checkout", "-q", "-b", "feat"]);

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 0);
  assert.match(result.stderr, /\[Rocky\] net change has no new text lines\.\r?\n/);
  assert.doesNotMatch(result.stderr, NO_SHARED_HISTORY);
});

test("a branch that leaves the remote at several tips starts from the nearest one", async (t) => {
  const box = sandbox(t);
  initRepo(box, { "README.md": "clean\n" });
  addBareOrigin(box);
  const base = currentBranch(box);
  for (const [name, files] of [["a", ["a1", "a2"]], ["b", ["b1"]]] as const) {
    git(box.repo, ["checkout", "-q", "-b", name, base]);
    for (const file of files) commitFile(box, `src/${file}.ts`, `export const ${file} = 1;\n`, file);
    git(box.repo, ["push", "-q", "origin", name]);
  }
  git(box.repo, ["checkout", "-q", "-b", "feat", "a"]);
  git(box.repo, ["merge", "-q", "--no-ff", "-m", "merge b", "b"]);
  commitFile(box, "src/local.ts", "export const local = 1;\n", "local");
  const boundaries = git(box.repo, ["rev-list", "--boundary", "HEAD", "--not", "--remotes"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("-"));
  assert.equal(boundaries.length, 2, "the fixture must leave the remote at two tips");

  const result = await runCheck(box, ["--offline"]);

  assertCompleted(result, 0);
  // origin/a is nearest, so what b added and the local commit both count.
  assert.match(result.stderr, /checked net change: 2 new text lines, 2 files\. no secret hit\./);
  assert.doesNotMatch(result.stderr, NO_SHARED_HISTORY);
});
