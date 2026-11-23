import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
import { renderClaudeMd } from "../history.mjs";
import {
  ARMS,
  DEFAULT_K,
  DEFAULT_SEED,
  classifyOutcome,
  mulberry32,
  runBatch,
  schedule,
  selectTasks,
  spawnProcess,
} from "../runner.mjs";
import { CLAUDE_FLAGS, MODEL } from "../sandbox.mjs";

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(evalDir, "..", "..");
const runnerScript = join(evalDir, "runner.mjs");
const manifestPath = join(evalDir, "tasks", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function listAllFiles(dir, prefix = "") {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...listAllFiles(full, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

describe("schedule and mulberry32", () => {
  test("mulberry32 produces deterministic numbers in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    assert.deepEqual(seqA, seqB);
    for (const value of seqA) {
      assert.equal(typeof value, "number");
      assert.ok(value >= 0 && value < 1, `expected value in [0,1), got ${value}`);
    }
  });

  test("schedule interleaves arms within each block", () => {
    const tasks = ["T01", "T02", "T03"];
    const first = schedule(tasks, ARMS, 2, 7);
    const second = schedule(tasks, ARMS, 2, 7);

    assert.equal(first.length, 18);
    assert.deepEqual(first, second);

    const armOrders = [];
    for (let block = 1; block <= 2; block += 1) {
      const inBlock = first.filter((entry) => entry.block === block);
      assert.equal(inBlock.length, 9);
      for (const taskId of tasks) {
        const pair = inBlock.filter((entry) => entry.taskId === taskId);
        assert.equal(pair.length, 3);
        const armsSeen = pair.map((entry) => entry.arm);
        assert.deepEqual([...armsSeen].sort(), ["after", "before", "none"]);
        for (const entry of pair) {
          assert.equal(entry.runId, `${taskId}-${entry.arm}-b${block}`);
        }
        armOrders.push(armsSeen.join(","));
      }
    }

    assert.ok(
      new Set(armOrders).size > 1,
      `expected arm order to vary across (task, block) pairs, got ${JSON.stringify(armOrders)}`,
    );
  });

  test("schedule is stable for a fixed seed", () => {
    const defaultTaskIds = selectTasks(manifest.tasks, null).map((task) => task.id);
    const planned = schedule(defaultTaskIds, ARMS, DEFAULT_K, DEFAULT_SEED);
    assert.equal(planned.length, defaultTaskIds.length * ARMS.length * DEFAULT_K);
    assert.deepEqual(
      planned.slice(0, 6).map((entry) => entry.runId),
      [
        "C01-before-b1",
        "C01-none-b1",
        "C01-after-b1",
        "C04-before-b1",
        "C04-after-b1",
        "C04-none-b1",
      ],
    );
  });
});

describe("task selection and outcome classification", () => {
  test("selectTasks excludes SMOKE by default and honors --only", () => {
    const defaults = selectTasks(manifest.tasks, null);
    assert.equal(defaults.length, 20);
    assert.equal(defaults.some((task) => task.id === "SMOKE"), false);

    const smokeOnly = selectTasks(manifest.tasks, ["SMOKE"]);
    assert.deepEqual(smokeOnly.map((task) => task.id), ["SMOKE"]);
    assert.equal(schedule(smokeOnly.map((t) => t.id), ARMS, DEFAULT_K, DEFAULT_SEED).length, 15);

    const subset = selectTasks(manifest.tasks, ["T01", "C01"]);
    assert.deepEqual(subset.map((task) => task.id), ["T01", "C01"]);

    assert.throws(() => selectTasks(manifest.tasks, ["DOES_NOT_EXIST"]), /Unknown task/i);
  });

  test("classifyOutcome distinguishes valid, api_error, timeout, transcript_broken, and token_leak", () => {
    const okLine = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    assert.equal(
      classifyOutcome({ rawStdout: `${okLine}\n`, rawStderr: "", exitCode: 0, timedOut: false, secrets: ["tok-1"] }),
      null,
    );

    const maxTurnsLine = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false });
    assert.equal(
      classifyOutcome({ rawStdout: `${maxTurnsLine}\n`, rawStderr: "", exitCode: 1, timedOut: false, secrets: [] }),
      null,
    );

    const isErrorLine = JSON.stringify({ type: "result", subtype: "success", is_error: true });
    assert.equal(
      classifyOutcome({ rawStdout: `${isErrorLine}\n`, rawStderr: "", exitCode: 1, timedOut: false, secrets: [] }),
      "api_error",
    );

    const badSubtypeLine = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: false });
    assert.equal(
      classifyOutcome({ rawStdout: `${badSubtypeLine}\n`, rawStderr: "", exitCode: 1, timedOut: false, secrets: [] }),
      "api_error",
    );

    assert.equal(
      classifyOutcome({ rawStdout: `${okLine}\n`, rawStderr: "", exitCode: null, timedOut: true, secrets: [] }),
      "timeout",
    );

    assert.equal(
      classifyOutcome({ rawStdout: "", rawStderr: "", exitCode: 1, timedOut: false, secrets: [] }),
      "transcript_broken",
    );
    assert.equal(
      classifyOutcome({ rawStdout: "{not-json\n", rawStderr: "", exitCode: 0, timedOut: false, secrets: [] }),
      "transcript_broken",
    );
    assert.equal(
      classifyOutcome({
        rawStdout: `${JSON.stringify({ type: "system", subtype: "init" })}\n`,
        rawStderr: "",
        exitCode: 0,
        timedOut: false,
        secrets: [],
      }),
      "transcript_broken",
    );

    assert.equal(
      classifyOutcome({
        rawStdout: `${okLine}\n`,
        rawStderr: "leaked secret-xyz here",
        exitCode: 0,
        timedOut: false,
        secrets: ["secret-xyz"],
      }),
      "token_leak",
    );
  });
});

describe("runner CLI guards", () => {
  test("runner prints usage and exits 0 on --help", () => {
    const res = spawnSync(process.execPath, [runnerScript, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /--out/);
    assert.match(res.stdout, /--before/);
    assert.match(res.stdout, /--after/);
    assert.match(res.stdout, /--auth/);
    assert.match(res.stdout, /--root/);
    assert.match(res.stdout, /--cache/);
    assert.match(res.stdout, /--only/);
    assert.match(res.stdout, /--retry-invalid/);
  });

  test("runner refuses an out dir inside the repo", () => {
    const res = spawnSync(process.execPath, [runnerScript, "--out", "."], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /outside the repo/i);
  });

  test("runner refuses an out dir in the enclosing workspace", () => {
    const sibling = join(dirname(repoRoot), "tmp-runner-out");
    const res = spawnSync(process.execPath, [runnerScript, "--out", sibling], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /outside the repo/i);
  });

  test("runner refuses a cache dir inside the repo or workspace", () => {
    const outDir = mkdtempSync(join(tmpdir(), "rocky-runner-out-"));
    try {
      const insideCache = join(repoRoot, "tmp-cache");
      const res = spawnSync(
        process.execPath,
        [
          runnerScript,
          "--out",
          outDir,
          "--cache",
          insideCache,
          "--before",
          "31128bc",
          "--after",
          "HEAD",
          "--auth",
          "token",
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, ROCKY_EVAL_OAUTH_TOKEN: "dummy-token" },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.equal(res.status, 2);
      assert.match(res.stderr, /outside the repo/i);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("runner exits 2 when ROCKY_EVAL_OAUTH_TOKEN is missing in token mode", () => {
    const outDir = mkdtempSync(join(tmpdir(), "rocky-runner-tok-"));
    try {
      const env = { ...process.env };
      delete env.ROCKY_EVAL_OAUTH_TOKEN;
      const res = spawnSync(
        process.execPath,
        [
          runnerScript,
          "--out",
          outDir,
          "--before",
          "31128bc",
          "--after",
          "HEAD",
          "--auth",
          "token",
        ],
        { cwd: repoRoot, env, encoding: "utf8", windowsHide: true },
      );
      assert.equal(res.status, 2);
      assert.match(res.stderr, /ROCKY_EVAL_OAUTH_TOKEN/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("runner exits 2 when --only specifies an unknown task ID", () => {
    const outDir = mkdtempSync(join(tmpdir(), "rocky-runner-only-"));
    const rootDir = mkdtempSync(join(tmpdir(), "rocky-runner-root-"));
    try {
      const res = spawnSync(
        process.execPath,
        [
          runnerScript,
          "--out",
          outDir,
          "--root",
          rootDir,
          "--before",
          "31128bc",
          "--after",
          "HEAD",
          "--auth",
          "token",
          "--only",
          "NO_SUCH_TASK",
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, ROCKY_EVAL_OAUTH_TOKEN: "dummy-token" },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.equal(res.status, 2);
      assert.match(res.stderr, /Unknown task/i);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("spawnProcess timeout and capture", () => {
  test("captures stdout/stderr and hard-kills runaway processes on timeout", async () => {
    const fast = await spawnProcess({
      file: process.execPath,
      args: ["-e", 'process.stdout.write("hello\\n"); process.stderr.write("warn\\n");'],
      cwd: repoRoot,
      env: process.env,
      timeoutMs: 10_000,
    });
    assert.equal(fast.timedOut, false);
    assert.equal(fast.exitCode, 0);
    assert.equal(fast.stdout, "hello\n");
    assert.equal(fast.stderr, "warn\n");

    const slow = await spawnProcess({
      file: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000);"],
      cwd: repoRoot,
      env: process.env,
      timeoutMs: 200,
    });
    assert.equal(slow.timedOut, true);
  });
});

describe("runBatch orchestration, artifacts, redaction, crashes, and resume", () => {
  test("packs arms sequentially once before runs, writes provenance, filters copies, redacts secrets, isolates crashes, and supports resume/--retry-invalid", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-runner-batch-"));
    const outDir = join(baseTmp, "batch-out");
    const rootDir = join(baseTmp, "sbx-root");
    const cacheDir = join(baseTmp, "pack-cache");
    const secretToken = "sk-ant-oat01-super-secret-eval-token";

    try {
      const events = [];
      let activePacks = 0;
      let maxConcurrentPacks = 0;
      let activeRuns = 0;
      let maxConcurrentRuns = 0;
      const destroyedSandboxes = [];
      const callCounts = new Map();

      const fakeDeps = {
        resolveCommit: (ref) => (ref === "31128bc" ? "31128bc000000000000000000000000000000001" : "aaaaaaa000000000000000000000000000000002"),
        getHeadCommit: () => "bbbbbbb000000000000000000000000000000003",
        getClaudeVersion: () => `2.1.330 (Claude Code) ${secretToken}`,
        packArm: async (sha, dir) => {
          assert.equal(dir, cacheDir);
          activePacks += 1;
          maxConcurrentPacks = Math.max(maxConcurrentPacks, activePacks);
          events.push(`pack:start:${sha}`);
          await new Promise((r) => setTimeout(r, 15));
          events.push(`pack:end:${sha}`);
          activePacks -= 1;
          return join(dir, `rocky-${sha}.tgz`);
        },
        createSandbox: async ({ arm, runId, root, tgz }) => {
          events.push(`run:start:${runId}`);
          if (arm === "before") assert.match(tgz, /rocky-31128bc/);
          if (arm === "after") assert.match(tgz, /rocky-aaaaaaa/);
          if (arm === "none") assert.equal(tgz, undefined);
          const dir = join(root, runId);
          const home = join(dir, "home");
          const configDir = join(home, ".claude");
          const rockyHome = join(dir, "rocky-home");
          const taskDir = join(dir, "task");
          mkdirSync(configDir, { recursive: true });
          mkdirSync(rockyHome, { recursive: true });
          mkdirSync(taskDir, { recursive: true });
          writeFileSync(join(configDir, ".credentials.json"), '{"secret":"never-copy"}\n', "utf8");
          writeFileSync(join(home, "host-leak.txt"), "do-not-copy\n", "utf8");
          return { dir, home, configDir, rockyHome, taskDir, prefixBin: null, env: {} };
        },
        materializeTask: async (task, sandbox, arm) => {
          mkdirSync(join(sandbox.taskDir, ".git"), { recursive: true });
          writeFileSync(join(sandbox.taskDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
          writeFileSync(join(sandbox.taskDir, "solution.txt"), `arm=${arm} task=${task.id}\n`, "utf8");
          if (arm === "before") {
            writeFileSync(join(sandbox.rockyHome, "memory.jsonl"), '{"kind":"failure"}\n', "utf8");
            writeFileSync(join(sandbox.rockyHome, "extra-ignored.json"), '{"ignore":true}\n', "utf8");
          } else if (arm === "after") {
            writeFileSync(join(sandbox.rockyHome, "memory.jsonl"), '{"kind":"failure"}\n', "utf8");
            writeFileSync(join(sandbox.rockyHome, "advisories.jsonl"), '{"lane":"run","delivered":true}\n', "utf8");
            writeFileSync(join(sandbox.rockyHome, "cards.jsonl"), '{"ignore":true}\n', "utf8");
          } else {
            writeFileSync(join(sandbox.rockyHome, "memory.jsonl"), "should-not-copy-for-none\n", "utf8");
          }
          return { runs: [], cards: 0 };
        },
        runClaude: async ({ runId }) => {
          activeRuns += 1;
          maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
          const count = (callCounts.get(runId) ?? 0) + 1;
          callCounts.set(runId, count);
          await new Promise((r) => setTimeout(r, 25));
          activeRuns -= 1;

          if (runId === "SMOKE-before-b1" && count === 1) {
            throw new Error(`simulated crash with token ${secretToken}`);
          }
          if (runId === "SMOKE-after-b1") {
            return {
              stdout: `${JSON.stringify({ type: "result", subtype: "error_api", is_error: true })}\n`,
              stderr: "upstream 500 error\n",
              exitCode: 1,
              timedOut: false,
            };
          }
          if (runId === "SMOKE-none-b1") {
            return {
              stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false, note: secretToken })}\n`,
              stderr: `leaked ${secretToken}\n`,
              exitCode: 0,
              timedOut: false,
            };
          }
          if (runId === "SMOKE-none-b2") {
            return {
              stdout: "",
              stderr: "timed out\n",
              exitCode: null,
              timedOut: true,
            };
          }
          return {
            stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            stderr: "clean stderr\n",
            exitCode: 0,
            timedOut: false,
          };
        },
        accept: async () => ({ solved: true, reason: "ok" }),
        destroySandbox: async (sandbox) => {
          destroyedSandboxes.push(sandbox.dir);
          rmSync(sandbox.dir, { recursive: true, force: true });
        },
        assertRootClean: () => {},
        log: () => {},
      };

      const baseOpts = {
        outDir,
        rootDir,
        cacheDir,
        beforeRef: "31128bc",
        afterRef: "origin/main",
        auth: { kind: "token" },
        secrets: [secretToken],
        concurrency: 2,
        k: 2,
        seed: 7,
        only: ["SMOKE"],
        retryInvalid: false,
      };

      await runBatch(baseOpts, fakeDeps);

      // 1. Packing happened once per arm, sequentially, strictly before any run started.
      assert.equal(maxConcurrentPacks, 1);
      const packIndices = events
        .map((ev, idx) => (ev.startsWith("pack:") ? idx : -1))
        .filter((idx) => idx >= 0);
      const firstRunIdx = events.findIndex((ev) => ev.startsWith("run:start:"));
      assert.equal(packIndices.length, 4);
      assert.ok(Math.max(...packIndices) < firstRunIdx, `packs must finish before first run: ${events.join(", ")}`);
      assert.ok(maxConcurrentRuns >= 2, `expected concurrent runs with concurrency=2, saw max=${maxConcurrentRuns}`);

      // 2. Every sandbox was destroyed in finally, even the crashed run.
      assert.equal(destroyedSandboxes.length, 6);

      // 3. batch.json provenance check (no owner leak baseline yet, secret redacted).
      const batchJson = JSON.parse(readFileSync(join(outDir, "batch.json"), "utf8"));
      assert.equal(batchJson.model, MODEL);
      assert.deepEqual(batchJson.claudeFlags, CLAUDE_FLAGS);
      assert.equal(batchJson.beforeSha, "31128bc000000000000000000000000000000001");
      assert.equal(batchJson.afterSha, "aaaaaaa000000000000000000000000000000002");
      assert.equal(batchJson.evaluatorCommit, "bbbbbbb000000000000000000000000000000003");
      assert.equal(batchJson.taskSetSha256, manifest.taskSetSha256);
      assert.equal(batchJson.claudeVersion, "2.1.330 (Claude Code) <redacted>");
      assert.deepEqual(batchJson.claudeMdSha256, {
        none: sha256Text(renderClaudeMd("none")),
        before: sha256Text(renderClaudeMd("before")),
        after: sha256Text(renderClaudeMd("after")),
      });
      assert.equal(batchJson.seed, 7);
      assert.equal(batchJson.k, 2);
      assert.equal(batchJson.concurrency, 2);
      assert.equal("ownerLeakBaseline" in batchJson, false);

      // 4. Artifact filtering checks: final/ without .git; rocky-home/ filtered; no home/.claude.
      const noneDir = join(outDir, "runs", "SMOKE-none-b1");
      assert.equal(existsSync(join(noneDir, "final", "solution.txt")), true);
      assert.equal(existsSync(join(noneDir, "final", ".git")), false);
      assert.equal(existsSync(join(noneDir, "rocky-home")), false);
      assert.equal(existsSync(join(noneDir, "home")), false);
      assert.equal(existsSync(join(noneDir, ".claude")), false);

      const beforeB2Dir = join(outDir, "runs", "SMOKE-before-b2");
      assert.deepEqual(listAllFiles(join(beforeB2Dir, "rocky-home")), ["memory.jsonl"]);
      assert.equal(existsSync(join(beforeB2Dir, "final", ".git")), false);

      const afterB2Dir = join(outDir, "runs", "SMOKE-after-b2");
      assert.deepEqual(listAllFiles(join(afterB2Dir, "rocky-home")), ["advisories.jsonl", "memory.jsonl"]);

      // 5. Crash run wrote run.json with harness_crash and redacted error; batch continued.
      const crashedRun = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-before-b1", "run.json"), "utf8"));
      assert.equal(crashedRun.invalid, "harness_crash");
      assert.equal(crashedRun.retries, 0);
      assert.match(crashedRun.error, /<redacted>/);
      assert.doesNotMatch(crashedRun.error, new RegExp(secretToken));

      const apiErrRun = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-after-b1", "run.json"), "utf8"));
      assert.equal(apiErrRun.invalid, "api_error");
      assert.equal(apiErrRun.retries, 0);

      const leakedRun = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-none-b1", "run.json"), "utf8"));
      assert.equal(leakedRun.invalid, "token_leak");
      assert.match(readFileSync(join(noneDir, "transcript.jsonl"), "utf8"), /<redacted>/);
      assert.match(readFileSync(join(noneDir, "stderr.txt"), "utf8"), /<redacted>/);

      const timedOutRun = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-none-b2", "run.json"), "utf8"));
      assert.equal(timedOutRun.invalid, "timeout");
      assert.equal(timedOutRun.timedOut, true);

      // 6. Token secret NEVER appears in any file under outDir.
      for (const rel of listAllFiles(outDir)) {
        const text = readFileSync(join(outDir, rel), "utf8");
        assert.equal(text.includes(secretToken), false, `secret leaked in ${rel}`);
      }

      // 7. Plain resume skips every existing run.json.
      const beforeResumeCounts = new Map(callCounts);
      await runBatch(baseOpts, fakeDeps);
      assert.deepEqual(callCounts, beforeResumeCounts);

      // 8. --retry-invalid re-runs ONLY harness_crash and api_error (not timeout, token_leak, or valid),
      //    increments retries, and stops after 2 retries.
      await runBatch({ ...baseOpts, retryInvalid: true }, fakeDeps);
      assert.equal(callCounts.get("SMOKE-before-b1"), 2);
      assert.equal(callCounts.get("SMOKE-after-b1"), 2);
      assert.equal(callCounts.get("SMOKE-none-b1"), 1);
      assert.equal(callCounts.get("SMOKE-none-b2"), 1);
      const retriedCrash = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-before-b1", "run.json"), "utf8"));
      assert.equal(retriedCrash.invalid, null);
      assert.equal(retriedCrash.retries, 1);
      const retriedApi1 = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-after-b1", "run.json"), "utf8"));
      assert.equal(retriedApi1.invalid, "api_error");
      assert.equal(retriedApi1.retries, 1);

      // Retry 2: only SMOKE-after-b1 runs (retries=2).
      await runBatch({ ...baseOpts, retryInvalid: true }, fakeDeps);
      assert.equal(callCounts.get("SMOKE-before-b1"), 2);
      assert.equal(callCounts.get("SMOKE-after-b1"), 3);
      const retriedApi2 = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-after-b1", "run.json"), "utf8"));
      assert.equal(retriedApi2.invalid, "api_error");
      assert.equal(retriedApi2.retries, 2);

      // Retry 3: capped at 2 retries, so nothing runs.
      await runBatch({ ...baseOpts, retryInvalid: true }, fakeDeps);
      assert.equal(callCounts.get("SMOKE-after-b1"), 3);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });
});
