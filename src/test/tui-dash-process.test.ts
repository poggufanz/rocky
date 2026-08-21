import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
const PROCESS_TIMEOUT_MS = 30_000;

interface ProcessSandbox {
  root: string;
  rockyHome: string;
  env: NodeJS.ProcessEnv;
}

function processSandbox(t: TestContext): ProcessSandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-tui-dash-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  writeFileSync(join(rockyHome, "memory.jsonl"), "");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    ROCKY_HOME: rockyHome,
    NO_COLOR: "1",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;

  return { root, rockyHome, env };
}

test("rocky dash without TTY prints stats fallback and speaks winpty hint on stderr, exiting 0", (t) => {
  const sandbox = processSandbox(t);

  const result = spawnSync(process.execPath, [entry, "dash"], {
    cwd: packageRoot,
    env: sandbox.env,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });

  assert.equal(result.status, 0);
  assert.match(
    result.stderr,
    /dash need real terminal, this one pipe\. I give stats instead\. on git bash, try winpty rocky dash\./,
  );
  assert.match(result.stderr, /I remember 0 errors/);
  assert.match(result.stderr, /memory holds 0 remembered items/);
  assert.match(result.stdout, /═╦═══════╦═/);
});

test("bare rocky in a pipe prints usage text and never dash fallback", (t) => {
  const sandbox = processSandbox(t);

  const result = spawnSync(process.execPath, [entry], {
    cwd: packageRoot,
    env: sandbox.env,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage:/);
  assert.match(result.stdout, /rocky run/);
  assert.match(result.stdout, /rocky dash/);
  assert.doesNotMatch(result.stderr, /dash need real terminal/);
});
