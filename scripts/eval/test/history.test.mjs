import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { accept, buildAcceptEnv } from "../accept.mjs";
import { compareManifests } from "../freeze.mjs";
import { copyTree, materializeTask, renderClaudeMd } from "../history.mjs";
import {
  buildCommandInvocation,
  buildToolEnv,
  createSandbox,
  destroySandbox,
  packArm,
} from "../sandbox.mjs";

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tasksDir = join(evalDir, "tasks");
const freezeScript = join(evalDir, "freeze.mjs");

function runChild(file, args, options) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const comSpec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
  const invocation = buildCommandInvocation(file, args, platform, comSpec);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function listFiles(rootDir, ignoredNames = new Set()) {
  const out = new Map();
  function walk(currentDir, prefix) {
    const entries = readdirSync(currentDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of entries) {
      if (prefix === "" && ignoredNames.has(name)) continue;
      const full = join(currentDir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
      } else {
        out.set(rel, readFileSync(full));
      }
    }
  }
  walk(rootDir, "");
  return out;
}

describe("task set, accept, and materialize", () => {
  test("tasks.json holds 21 tasks across trap, control, stale, and smoke kinds", () => {
    const tasks = JSON.parse(readFileSync(join(tasksDir, "tasks.json"), "utf8"));
    assert.equal(tasks.length, 21);

    const byKind = { trap: 0, control: 0, stale: 0, smoke: 0 };
    for (const task of tasks) {
      byKind[task.kind] += 1;
      assert.match(task.prompt, /^npm test fails in this repository\./);
      assert.equal(task.target.command, "npm test");
      assert.ok(Array.isArray(task.target.aliases) && task.target.aliases.length > 0);
      assert.ok(Array.isArray(task.protected) && task.protected.includes("test/"));
    }
    assert.deepEqual(byKind, { trap: 10, control: 6, stale: 4, smoke: 1 });
  });

  test("materializeTask in arm none skips history, writes base CLAUDE.md, and leaves clean git status", async () => {
    const tasks = JSON.parse(readFileSync(join(tasksDir, "tasks.json"), "utf8"));
    const t02 = tasks.find((entry) => entry.id === "T02");
    const root = mkdtempSync(join(tmpdir(), "rocky-eval-mat-none-"));
    let sandbox;
    try {
      sandbox = await createSandbox({
        arm: "none",
        runId: "mat-none-t02",
        root,
        exists: () => false,
      });

      const res = await materializeTask(t02, sandbox, "none");
      assert.deepEqual(res, { runs: [], cards: 0 });
      assert.equal(readFileSync(join(sandbox.taskDir, "CLAUDE.md"), "utf8"), renderClaudeMd("none"));
      assert.doesNotMatch(readFileSync(join(sandbox.taskDir, "CLAUDE.md"), "utf8"), /## Rocky/);

      const gitEnv = buildToolEnv(sandbox.env, process.platform, { home: sandbox.home });
      const gitStatus = runChild("git", ["status", "--porcelain"], {
        cwd: sandbox.taskDir,
        env: gitEnv,
      });
      assert.equal(gitStatus.status, 0);
      assert.equal(gitStatus.stdout.trim(), "");

      const repoFiles = listFiles(join(tasksDir, t02.fixture, "repo"));
      const taskFiles = listFiles(sandbox.taskDir, new Set([".git", "CLAUDE.md"]));
      assert.deepEqual([...taskFiles.keys()], [...repoFiles.keys()]);
    } finally {
      if (sandbox) await destroySandbox(sandbox);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accept rejects protected file edits and unexpected files under protected dirs, and drops ROCKY_*", async () => {
    const tasks = JSON.parse(readFileSync(join(tasksDir, "tasks.json"), "utf8"));
    const t02 = tasks.find((entry) => entry.id === "T02");
    const dir = mkdtempSync(join(tmpdir(), "rocky-eval-accept-"));
    try {
      copyTree(join(tasksDir, t02.fixture, "repo"), dir);
      const untouched = await accept(t02, dir);
      assert.equal(untouched.solved, false);

      copyTree(join(tasksDir, t02.fixture, "patches", "fix"), dir);
      const fixed = await accept(t02, dir);
      assert.equal(fixed.solved, true);

      writeFileSync(join(dir, "test", "extra.mjs"), "export const x = 1;\n", "utf8");
      const withExtra = await accept(t02, dir);
      assert.equal(withExtra.solved, false);
      assert.match(withExtra.reason, /unexpected file under protected dir/i);
      rmSync(join(dir, "test", "extra.mjs"));

      writeFileSync(join(dir, "test", "run.mjs"), 'process.stdout.write("ok\\n");\n', "utf8");
      const tampered = await accept(t02, dir);
      assert.equal(tampered.solved, false);
      assert.match(tampered.reason, /protected file modified/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const env = buildAcceptEnv({
      ...process.env,
      ROCKY_HOME: "/tmp/r",
      ROCKY_ATTEMPT_ARM: "shown",
      ROCKY_TEST_SEAMS: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
    for (const key of Object.keys(env)) {
      assert.equal(/^ROCKY_/i.test(key), false, `unexpected ROCKY_ key: ${key}`);
    }
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });

  test("compareManifests ignores frozenAt and evaluatorCommit while catching hash drift", () => {
    const base = {
      v: 1,
      frozenAt: "2026-01-01T00:00:00.000Z",
      evaluatorCommit: "aaaaaaa",
      tasks: [{ id: "T01", normalizedTrapLine: "error: x" }],
      files: { "a/b": "111" },
      taskSetSha256: "deadbeef",
    };
    const same = {
      ...base,
      frozenAt: "2026-12-31T00:00:00.000Z",
      evaluatorCommit: "bbbbbbb",
    };
    assert.deepEqual(compareManifests(base, same), []);

    const drifted = { ...same, taskSetSha256: "cafebabe" };
    assert.ok(compareManifests(base, drifted).length > 0);
  });

  test("freeze.mjs --verify passes without modifying tasks/manifest.json", () => {
    const manifestPath = join(tasksDir, "manifest.json");
    const beforeBytes = readFileSync(manifestPath);
    const res = runChild(process.execPath, [freezeScript, "--verify"], {
      cwd: dirname(evalDir),
      env: process.env,
    });
    assert.equal(res.status, 0, `freeze --verify failed: ${res.stderr}`);
    assert.match(res.stdout, /Verified 21 tasks/);
    assert.deepEqual(readFileSync(manifestPath), beforeBytes);
  });
});

describe("history replay", () => {
  test("history replay leaves a three-failure, one-pass entry the after arm can read", async (t) => {
    if (process.env.ROCKY_EVAL_LIVE !== "1") {
      t.skip("set ROCKY_EVAL_LIVE=1 to run the live history replay test");
      return;
    }

    const tasks = JSON.parse(readFileSync(join(tasksDir, "tasks.json"), "utf8"));
    const t02 = tasks.find((entry) => entry.id === "T02");
    assert.ok(t02, "T02 task entry must exist in tasks.json");

    const root = process.env.ROCKY_EVAL_ROOT
      || (process.platform === "win32" ? "C:\\rocky-eval\\sbx" : join(tmpdir(), "rocky-eval"));
    const packCache = process.env.ROCKY_EVAL_PACK_CACHE
      || (process.platform === "win32" ? "C:\\rocky-eval\\pack-cache" : join(tmpdir(), "rocky-eval-pack-cache"));
    const runId = `history-t02-${process.pid}-${randomBytes(4).toString("hex")}`;

    const tgz = await packArm("origin/main", packCache);
    let sandbox;
    try {
      sandbox = await createSandbox({
        arm: "after",
        runId,
        root,
        tgz,
      });

      await materializeTask(t02, sandbox, "after");

      const gitEnv = buildToolEnv(sandbox.env, process.platform, { home: sandbox.home });
      const gitStatus = runChild("git", ["status", "--porcelain"], {
        cwd: sandbox.taskDir,
        env: gitEnv,
      });
      assert.equal(gitStatus.status, 0, `git status failed: ${gitStatus.stderr}`);
      assert.equal(gitStatus.stdout.trim(), "", `expected clean git status, got:\n${gitStatus.stdout}`);

      const repoFiles = listFiles(join(tasksDir, t02.fixture, "repo"));
      const taskFiles = listFiles(sandbox.taskDir, new Set([".git", "CLAUDE.md"]));
      assert.deepEqual([...taskFiles.keys()], [...repoFiles.keys()]);
      for (const [rel, expectedBytes] of repoFiles.entries()) {
        assert.deepEqual(taskFiles.get(rel), expectedBytes, `file content mismatch: ${rel}`);
      }
      assert.equal(existsSync(join(sandbox.taskDir, "CLAUDE.md")), true);

      const shim = process.platform === "win32"
        ? join(sandbox.prefixBin, "rocky.cmd")
        : join(sandbox.prefixBin, "rocky");

      const attemptsRes = runChild(shim, ["attempts", "--json"], {
        cwd: sandbox.taskDir,
        env: sandbox.env,
      });
      assert.equal(attemptsRes.status, 0, `rocky attempts --json failed: ${attemptsRes.stderr}`);
      const payload = JSON.parse(attemptsRes.stdout);
      assert.equal(payload.entries.length, 1, `expected 1 problem entry, got ${payload.entries.length}`);
      const entry = payload.entries[0];
      assert.equal(entry.counts.same_failure, 2, `expected 2 same_failure, got ${JSON.stringify(entry.counts)}`);
      assert.equal(entry.counts.passed, 1, `expected 1 passed, got ${JSON.stringify(entry.counts)}`);

      const runRes = runChild(shim, ["run", t02.target.command], {
        cwd: sandbox.taskDir,
        env: sandbox.env,
      });
      assert.notEqual(runRes.status, 0, "untouched T02 repo must fail");
      assert.match(
        runRes.stderr,
        /Same error recorded 3 times before/,
        `expected prior-attempts note count in stderr, got:\n${runRes.stderr}`,
      );
      assert.match(
        runRes.stderr,
        /Files edited before the passing rerun: config\/local\.json/,
        `expected passing-rerun edited file in stderr, got:\n${runRes.stderr}`,
      );
    } finally {
      if (sandbox) await destroySandbox(sandbox);
    }
  });
});
