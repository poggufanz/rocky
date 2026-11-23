import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTargetCommand } from "../accept.mjs";
import { renderClaudeMd } from "../history.mjs";
import {
  ARMS,
  DEFAULT_K,
  DEFAULT_SEED,
  ProvenanceMismatchError,
  classifyOutcome,
  createRedactingFileWriter,
  createTranscriptParser,
  diffBatchProvenance,
  extractCredentialSecrets,
  mulberry32,
  runBatch,
  schedule,
  selectTasks,
  spawnProcess,
  sweepWin32Strays,
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
    if (lstatSync(full).isDirectory()) {
      out.push(...listAllFiles(full, rel));
    } else if (lstatSync(full).isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function makeFakeDeps(overrides = {}) {
  return {
    resolveCommit: (ref) => (
      ref === "31128bc"
        ? "31128bc000000000000000000000000000000001"
        : "aaaaaaa000000000000000000000000000000002"
    ),
    getHeadCommit: () => "bbbbbbb000000000000000000000000000000003",
    getClaudeVersion: () => "2.1.330 (Claude Code)",
    packArm: async (sha, dir) => join(dir, `rocky-${sha}.tgz`),
    createSandbox: async ({ runId, root }) => {
      const dir = join(root, runId);
      const home = join(dir, "home");
      const configDir = join(home, ".claude");
      const rockyHome = join(dir, "rocky-home");
      const taskDir = join(dir, "task");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(rockyHome, { recursive: true });
      mkdirSync(taskDir, { recursive: true });
      return { dir, home, configDir, rockyHome, taskDir, prefixBin: null, env: {} };
    },
    materializeTask: async (task, sandbox, arm) => {
      mkdirSync(join(sandbox.taskDir, ".git"), { recursive: true });
      writeFileSync(join(sandbox.taskDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
      writeFileSync(join(sandbox.taskDir, "solution.txt"), `arm=${arm} task=${task.id}\n`, "utf8");
      return { runs: [], cards: 0 };
    },
    runClaude: async () => ({
      stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
      stderr: "clean stderr\n",
      exitCode: 0,
      timedOut: false,
    }),
    accept: async () => ({ solved: true, reason: "ok" }),
    destroySandbox: async (sandbox) => {
      rmSync(sandbox.dir, { recursive: true, force: true });
    },
    sweepStrays: async () => 0,
    assertRootClean: () => {},
    log: () => {},
    ...overrides,
  };
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

describe("task selection, credential extraction, provenance diff, and outcome classification", () => {
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

  test("extractCredentialSecrets collects every string value >= 20 chars recursively", () => {
    const secrets = extractCredentialSecrets({
      short: "too-short-19-chars!",
      exact20: "12345678901234567890",
      nested: {
        accessToken: "sk-ant-oat01-very-long-credential-value",
        items: ["ok", "refresh-token-value-at-least-20-chars"],
      },
      count: 42,
    });
    assert.deepEqual(secrets, [
      "sk-ant-oat01-very-long-credential-value",
      "refresh-token-value-at-least-20-chars",
      "12345678901234567890",
    ]);
  });

  test("diffBatchProvenance checks provenance fields while allowing concurrency changes", () => {
    const base = {
      beforeSha: "111",
      afterSha: "222",
      model: MODEL,
      claudeFlags: [...CLAUDE_FLAGS],
      claudeVersion: "2.1.330",
      evaluatorCommit: "333",
      taskSetSha256: "444",
      seed: 7,
      k: 2,
      concurrency: 2,
      taskIds: ["SMOKE"],
    };
    assert.deepEqual(diffBatchProvenance({ ...base, concurrency: 4 }, base), []);
    assert.deepEqual(
      diffBatchProvenance({ ...base, seed: 99, k: 3, taskIds: ["T01"] }, base),
      ["seed", "k", "taskIds"],
    );
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

describe("bounded streaming capture and async accept", () => {
  test("createRedactingFileWriter redacts secrets split across arbitrary chunk boundaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rocky-redact-stream-"));
    try {
      const outPath = join(dir, "out.txt");
      const secret = "sk-ant-oat01-chunk-boundary-secret-9999";
      const writer = createRedactingFileWriter(outPath, [secret]);
      const payload = `prefix-${secret}-middle-${secret}-suffix\n`;
      // Feed 3-character chunks so every secret spans many chunks.
      for (let i = 0; i < payload.length; i += 3) {
        writer.write(Buffer.from(payload.slice(i, i + 3), "utf8"));
      }
      const res = await writer.end();
      assert.equal(res.leaked, true);
      const written = readFileSync(outPath, "utf8");
      assert.equal(written, "prefix-<redacted>-middle-<redacted>-suffix\n");
      assert.equal(written.includes(secret), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("createTranscriptParser skips oversized lines while preserving last result event", () => {
    const parser = createTranscriptParser(256);
    const bigLine = JSON.stringify({ type: "assistant", blob: "x".repeat(400) });
    const resultLine = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    parser.write(`${bigLine}\n${resultLine}\n`);
    const summary = parser.end();
    assert.equal(summary.oversizedLineCount, 1);
    assert.equal(summary.malformedLineCount, 0);
    assert.deepEqual(summary.lastResult, { subtype: "success", is_error: false });
    assert.equal(classifyOutcome({ transcript: summary, tokenLeaked: false, timedOut: false }), null);
  });

  test("spawnProcess streams redacted output to disk and skips parsing lines > 1 MiB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rocky-spawn-stream-"));
    try {
      const stdoutPath = join(dir, "transcript.jsonl");
      const stderrPath = join(dir, "stderr.txt");
      const secret = "sk-ant-oat01-streamed-secret-token-value";
      const script = [
        'const big = JSON.stringify({ type: "assistant", data: "a".repeat(1100000) });',
        'process.stdout.write(big + "\\n");',
        `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\\n");`,
        `const s = ${JSON.stringify(secret)};`,
        'process.stderr.write("err-part1-" + s.slice(0, 12));',
        'setTimeout(() => { process.stderr.write(s.slice(12) + "-end\\n"); }, 15);',
      ].join("\n");

      const res = await spawnProcess({
        file: process.execPath,
        args: ["-e", script],
        cwd: repoRoot,
        env: process.env,
        timeoutMs: 15_000,
        stdoutPath,
        stderrPath,
        secrets: [secret],
      });

      assert.equal(res.streamed, true);
      assert.equal(res.exitCode, 0);
      assert.equal(res.timedOut, false);
      assert.equal(res.tokenLeaked, true);
      assert.equal(res.transcript.oversizedLineCount, 1);
      assert.equal(res.transcript.malformedLineCount, 0);
      assert.deepEqual(res.transcript.lastResult, { subtype: "success", is_error: false });

      const writtenStdout = readFileSync(stdoutPath, "utf8");
      assert.ok(writtenStdout.length > 1_100_000, "oversized line must still be written to transcript.jsonl");
      const writtenStderr = readFileSync(stderrPath, "utf8");
      assert.equal(writtenStderr, "err-part1-<redacted>-end\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runTargetCommand runs asynchronously without blocking concurrent event-loop timers", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 25);
    try {
      const res = await runTargetCommand(
        'node -e setTimeout(()=>console.log("ok"),220)',
        repoRoot,
        process.env,
        10_000,
      );
      assert.equal(res.status, 0);
      assert.equal(res.timedOut, false);
      assert.equal(res.stdout.trim(), "ok");
      assert.ok(ticks >= 2, `expected async timer ticks during grading, saw ${ticks}`);
    } finally {
      clearInterval(timer);
    }
  });
});

describe("runner CLI guards and resume provenance", () => {
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

  test("CLI exits 2 naming differing fields when batch.json seed is tampered on resume", () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-runner-prov-cli-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const fakeBin = join(baseTmp, "bin");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    try {
      // Stub claude on PATH so real claude is never invoked during the CLI check.
      if (process.platform === "win32") {
        writeFileSync(join(fakeBin, "claude.cmd"), "@echo 2.1.330 (Claude Code)\r\n", "utf8");
      } else {
        const stub = join(fakeBin, "claude");
        writeFileSync(stub, "#!/bin/sh\necho '2.1.330 (Claude Code)'\n", "utf8");
        chmodSync(stub, 0o755);
      }

      const headRes = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      const headSha = headRes.stdout.trim();
      const beforeRes = spawnSync("git", ["rev-parse", "--verify", "31128bc^{commit}"], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      const beforeSha = beforeRes.stdout.trim();

      writeFileSync(
        join(outDir, "batch.json"),
        `${JSON.stringify({
          v: 1,
          claudeVersion: "2.1.330 (Claude Code)",
          model: MODEL,
          claudeFlags: [...CLAUDE_FLAGS],
          beforeSha,
          afterSha: headSha,
          evaluatorCommit: headSha,
          taskSetSha256: manifest.taskSetSha256,
          seed: 999999,
          k: 1,
          concurrency: 2,
          taskIds: ["SMOKE"],
        }, null, 2)}\n`,
        "utf8",
      );

      // Use a root dir without ancestor CLAUDE.md/.claude; on win32 tmpdir is under C:\Users\<user>
      // which may have .claude, so pick a top-level temp path if needed, or assert before/after.
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      const sep = process.platform === "win32" ? ";" : ":";
      const env = {
        ...process.env,
        [pathKey]: `${fakeBin}${sep}${process.env[pathKey] ?? ""}`,
        ROCKY_EVAL_OAUTH_TOKEN: "dummy-token",
      };

      const cliRoot = process.platform === "win32"
        ? join(process.env.SystemDrive ? `${process.env.SystemDrive}\\` : "C:\\", `rocky-eval-prov-test-${process.pid}`)
        : rootDir;
      mkdirSync(cliRoot, { recursive: true });
      try {
        const res = spawnSync(
          process.execPath,
          [
            runnerScript,
            "--out",
            outDir,
            "--root",
            cliRoot,
            "--before",
            "31128bc",
            "--after",
            "HEAD",
            "--auth",
            "token",
            "--only",
            "SMOKE",
            "--k",
            "1",
            "--seed",
            "7",
          ],
          { cwd: repoRoot, env, encoding: "utf8", windowsHide: true },
        );
        assert.equal(res.status, 2, `expected exit 2, got ${res.status}: ${res.stderr}`);
        assert.match(res.stderr, /\bseed\b/);
      } finally {
        if (cliRoot !== rootDir) {
          rmSync(cliRoot, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });
});

describe("spawnProcess timeout and win32 stray sweep", () => {
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
    assert.equal(slow.killFailed, false);
  });

  test(
    "sweepWin32Strays finds and kills detached descendants referencing the sandbox dir",
    { skip: process.platform !== "win32" },
    async () => {
      const fakeSandboxDir = mkdtempSync(join(tmpdir(), "rocky-stray-sweep-"));
      let strayPid = null;
      try {
        const scriptPath = join(fakeSandboxDir, "stray-child.mjs");
        writeFileSync(scriptPath, "setTimeout(() => {}, 60000);\n", "utf8");
        const child = spawn(process.execPath, [scriptPath], {
          cwd: repoRoot,
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        });
        child.unref();
        strayPid = child.pid;
        assert.ok(typeof strayPid === "number" && strayPid > 0);

        const killed = await sweepWin32Strays(fakeSandboxDir);
        assert.ok(killed >= 1, `expected sweepWin32Strays to kill at least 1 stray, got ${killed}`);

        // Confirm the stray PID is no longer alive.
        assert.throws(() => process.kill(strayPid, 0));
      } finally {
        if (typeof strayPid === "number") {
          try {
            process.kill(strayPid, "SIGKILL");
          } catch {
            // Already dead.
          }
        }
        rmSync(fakeSandboxDir, { recursive: true, force: true });
      }
    },
  );
});

describe("runBatch orchestration, artifacts, redaction, provenance, retries, and crash isolation", () => {
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

      const fakeDeps = makeFakeDeps({
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
            // On retry, verify retries.json was updated BEFORE launch and old run.json is still intact.
            if (count > 1) {
              const oldDir = join(outDir, "runs", runId);
              const durableRetries = JSON.parse(readFileSync(join(oldDir, "retries.json"), "utf8"));
              assert.equal(durableRetries.count, count - 1);
              const oldRun = JSON.parse(readFileSync(join(oldDir, "run.json"), "utf8"));
              assert.equal(oldRun.retries, count - 2);
              assert.equal(existsSync(`${oldDir}.next`), true);
            }
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
              killFailed: true,
            };
          }
          return {
            stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            stderr: "clean stderr\n",
            exitCode: 0,
            timedOut: false,
          };
        },
        destroySandbox: async (sandbox) => {
          destroyedSandboxes.push(sandbox.dir);
          rmSync(sandbox.dir, { recursive: true, force: true });
        },
        sweepStrays: async () => 1,
      });

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

      // 2. Every sandbox was destroyed, even the crashed run.
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
      assert.equal(leakedRun.strayKilled, 1);
      assert.match(readFileSync(join(noneDir, "transcript.jsonl"), "utf8"), /<redacted>/);
      assert.match(readFileSync(join(noneDir, "stderr.txt"), "utf8"), /<redacted>/);

      const timedOutRun = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-none-b2", "run.json"), "utf8"));
      assert.equal(timedOutRun.invalid, "timeout");
      assert.equal(timedOutRun.timedOut, true);
      assert.equal(timedOutRun.killFailed, true);

      // 6. Token secret NEVER appears in any file under outDir.
      for (const rel of listAllFiles(outDir)) {
        const text = readFileSync(join(outDir, rel), "utf8");
        assert.equal(text.includes(secretToken), false, `secret leaked in ${rel}`);
      }

      // 7. Plain resume (with different concurrency allowed) skips every existing run.json.
      const beforeResumeCounts = new Map(callCounts);
      await runBatch({ ...baseOpts, concurrency: 4 }, fakeDeps);
      assert.deepEqual(callCounts, beforeResumeCounts);

      // 8. --retry-invalid re-runs ONLY harness_crash and api_error (not timeout, token_leak, or valid),
      //    increments retries via retries.json + .next swap, and stops after 2 retries.
      await runBatch({ ...baseOpts, retryInvalid: true }, fakeDeps);
      assert.equal(callCounts.get("SMOKE-before-b1"), 2);
      assert.equal(callCounts.get("SMOKE-after-b1"), 2);
      assert.equal(callCounts.get("SMOKE-none-b1"), 1);
      assert.equal(callCounts.get("SMOKE-none-b2"), 1);
      const retriedCrash = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-before-b1", "run.json"), "utf8"));
      assert.equal(retriedCrash.invalid, null);
      assert.equal(retriedCrash.retries, 1);
      assert.equal(existsSync(join(outDir, "runs", "SMOKE-before-b1.next")), false);
      assert.equal(existsSync(join(outDir, "runs", "SMOKE-before-b1.prev")), false);

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

  test("skips symlinks/junctions at final/ and rocky-home/ boundaries and lists them in run.json.skippedLinks", async (t) => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-runner-links-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const outsideDir = join(baseTmp, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const outsideSecretFile = join(outsideDir, "host-secret.txt");
    writeFileSync(outsideSecretFile, "OUTSIDE-SECRET-DATA\n", "utf8");

    try {
      let createdTaskLink = false;
      let createdRockyLink = false;

      const fakeDeps = makeFakeDeps({
        materializeTask: async (task, sandbox, arm) => {
          writeFileSync(join(sandbox.taskDir, "ok.txt"), "safe\n", "utf8");
          const taskLinkPath = join(sandbox.taskDir, "escape-link");
          try {
            symlinkSync(outsideSecretFile, taskLinkPath, "file");
            createdTaskLink = true;
          } catch {
            if (process.platform === "win32") {
              try {
                symlinkSync(outsideDir, taskLinkPath, "junction");
                createdTaskLink = true;
              } catch {
                createdTaskLink = false;
              }
            }
          }
          if (arm === "after") {
            const rockyLink = join(sandbox.rockyHome, "memory.jsonl");
            try {
              symlinkSync(outsideSecretFile, rockyLink, "file");
              createdRockyLink = true;
            } catch {
              if (process.platform === "win32") {
                try {
                  symlinkSync(outsideDir, rockyLink, "junction");
                  createdRockyLink = true;
                } catch {
                  createdRockyLink = false;
                }
              }
            }
          }
          return { runs: [], cards: 0 };
        },
      });

      await runBatch(
        {
          outDir,
          rootDir,
          cacheDir,
          beforeRef: "31128bc",
          afterRef: "origin/main",
          auth: { kind: "token" },
          secrets: [],
          concurrency: 1,
          k: 1,
          seed: 7,
          only: ["SMOKE"],
        },
        fakeDeps,
      );

      if (!createdTaskLink) {
        t.skip("platform refused symlink and junction creation");
        return;
      }

      const afterRunDir = join(outDir, "runs", "SMOKE-after-b1");
      assert.equal(existsSync(join(afterRunDir, "final", "ok.txt")), true);
      assert.equal(existsSync(join(afterRunDir, "final", "escape-link")), false);

      const afterRun = JSON.parse(readFileSync(join(afterRunDir, "run.json"), "utf8"));
      assert.ok(
        afterRun.skippedLinks.includes("final/escape-link"),
        `expected final/escape-link in skippedLinks, got ${JSON.stringify(afterRun.skippedLinks)}`,
      );
      if (createdRockyLink) {
        assert.equal(existsSync(join(afterRunDir, "rocky-home", "memory.jsonl")), false);
        assert.ok(
          afterRun.skippedLinks.includes("rocky-home/memory.jsonl"),
          `expected rocky-home/memory.jsonl in skippedLinks, got ${JSON.stringify(afterRun.skippedLinks)}`,
        );
      }
      for (const rel of listAllFiles(outDir)) {
        const text = readFileSync(join(outDir, rel), "utf8");
        assert.equal(text.includes("OUTSIDE-SECRET-DATA"), false, `outside file leaked into ${rel}`);
      }
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("copy-credentials mode extracts >=20-char credential values and redacts them from stderr", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-runner-creds-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const credsPath = join(baseTmp, ".credentials.json");
    const credSecret = "oauth-copied-credential-secret-value-12345";
    writeFileSync(
      credsPath,
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: credSecret,
          subscriptionType: "pro",
        },
      })}\n`,
      "utf8",
    );

    try {
      const fakeDeps = makeFakeDeps({
        runClaude: async () => ({
          stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
          stderr: `plan=pro leaked=${credSecret}\n`,
          exitCode: 0,
          timedOut: false,
        }),
      });

      await runBatch(
        {
          outDir,
          rootDir,
          cacheDir,
          beforeRef: "31128bc",
          afterRef: "origin/main",
          auth: { kind: "copy-credentials", from: credsPath },
          concurrency: 1,
          k: 1,
          seed: 7,
          only: ["SMOKE"],
        },
        fakeDeps,
      );

      const runDir = join(outDir, "runs", "SMOKE-none-b1");
      const stderrText = readFileSync(join(runDir, "stderr.txt"), "utf8");
      assert.equal(stderrText, "plan=pro leaked=<redacted>\n");
      const runJson = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      assert.equal(runJson.invalid, "token_leak");

      for (const rel of listAllFiles(outDir)) {
        const text = readFileSync(join(outDir, rel), "utf8");
        assert.equal(text.includes(credSecret), false, `credential value leaked in ${rel}`);
      }
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("rejects resume before packing when batch.json provenance mismatches", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-runner-prov-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    let packCalls = 0;

    try {
      const fakeDeps = makeFakeDeps({
        packArm: async (sha, dir) => {
          packCalls += 1;
          return join(dir, `rocky-${sha}.tgz`);
        },
      });
      const opts = {
        outDir,
        rootDir,
        cacheDir,
        beforeRef: "31128bc",
        afterRef: "origin/main",
        auth: { kind: "token" },
        secrets: [],
        concurrency: 1,
        k: 1,
        seed: 7,
        only: ["SMOKE"],
      };

      await runBatch(opts, fakeDeps);
      assert.equal(packCalls, 2);

      // Tamper batch.json seed and verify resume fails with exitCode 2 BEFORE packing.
      const batchPath = join(outDir, "batch.json");
      const batch = JSON.parse(readFileSync(batchPath, "utf8"));
      batch.seed = 999;
      writeFileSync(batchPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");

      await assert.rejects(
        () => runBatch(opts, fakeDeps),
        (err) => {
          assert.ok(err instanceof ProvenanceMismatchError);
          assert.equal(err.exitCode, 2);
          assert.match(err.message, /\bseed\b/);
          return true;
        },
      );
      assert.equal(packCalls, 2, "packArm must not be called on provenance mismatch");
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("interrupted retry at retries.json count=2 is not retried, and malformed run.json is skipped and reported", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-runner-retry-dur-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const callCounts = new Map();
    const logs = [];

    try {
      const fakeDeps = makeFakeDeps({
        runClaude: async ({ runId }) => {
          callCounts.set(runId, (callCounts.get(runId) ?? 0) + 1);
          if (runId === "SMOKE-before-b1") {
            return {
              stdout: `${JSON.stringify({ type: "result", subtype: "error_api", is_error: true })}\n`,
              stderr: "api error\n",
              exitCode: 1,
              timedOut: false,
            };
          }
          return {
            stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        },
        log: (line) => logs.push(line),
      });

      const opts = {
        outDir,
        rootDir,
        cacheDir,
        beforeRef: "31128bc",
        afterRef: "origin/main",
        auth: { kind: "token" },
        secrets: [],
        concurrency: 1,
        k: 1,
        seed: 7,
        only: ["SMOKE"],
      };

      await runBatch(opts, fakeDeps);
      assert.equal(callCounts.get("SMOKE-before-b1"), 1);

      // Simulate an interrupted 2nd retry: retries.json is already 2 while run.json still shows retries: 0.
      writeFileSync(
        join(outDir, "runs", "SMOKE-before-b1", "retries.json"),
        `${JSON.stringify({ count: 2 }, null, 2)}\n`,
        "utf8",
      );
      // Corrupt another run's run.json to test malformed handling.
      writeFileSync(join(outDir, "runs", "SMOKE-after-b1", "run.json"), "{not-valid-json", "utf8");

      logs.length = 0;
      const summary = await runBatch({ ...opts, retryInvalid: true }, fakeDeps);
      assert.equal(summary.ran, 0);
      assert.equal(summary.malformed, 1);
      assert.equal(callCounts.get("SMOKE-before-b1"), 1, "interrupted retry at count=2 must not retry again");
      assert.equal(callCounts.get("SMOKE-after-b1"), 1, "malformed run.json must never be retried");
      assert.ok(
        logs.some((line) => line.includes("SMOKE-after-b1") && /malformed/i.test(line)),
        `expected malformed warning in stderr logs, got: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        logs.some((line) => line.includes("1 malformed")),
        `expected malformed count in summary log, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("runs destroySandbox before publishing run.json, records redacted cleanupError, and isolates unwritable run dirs", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-runner-crash-order-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const secret = "sk-ant-oat01-cleanup-secret-token-value";
    const logs = [];
    const destroyedRunIds = [];
    let runJsonExistedDuringDestroy = null;

    try {
      const fakeDeps = makeFakeDeps({
        materializeTask: async (task, sandbox, arm) => {
          writeFileSync(join(sandbox.taskDir, "ok.txt"), `arm=${arm}\n`, "utf8");
          if (arm === "none") {
            // Make SMOKE-none-b1's run.json and transcript.jsonl unwritable cross-platform
            // by placing non-empty directories at those target file paths.
            const runDir = join(outDir, "runs", "SMOKE-none-b1");
            mkdirSync(join(runDir, "transcript.jsonl", "blocker"), { recursive: true });
            mkdirSync(join(runDir, "run.json", "blocker"), { recursive: true });
          }
          return { runs: [], cards: 0 };
        },
        destroySandbox: async (sandbox) => {
          const match = /SMOKE-(none|before|after)-b1/.exec(sandbox.dir);
          const logicalRunId = match ? match[0] : sandbox.dir;
          destroyedRunIds.push(logicalRunId);
          if (logicalRunId === "SMOKE-before-b1") {
            runJsonExistedDuringDestroy = existsSync(join(outDir, "runs", logicalRunId, "run.json"));
            rmSync(sandbox.dir, { recursive: true, force: true });
            throw new Error(`EPERM removing sandbox with ${secret}`);
          }
          rmSync(sandbox.dir, { recursive: true, force: true });
        },
        log: (line) => logs.push(line),
      });

      const summary = await runBatch(
        {
          outDir,
          rootDir,
          cacheDir,
          beforeRef: "31128bc",
          afterRef: "origin/main",
          auth: { kind: "token" },
          secrets: [secret],
          concurrency: 2,
          k: 1,
          seed: 7,
          only: ["SMOKE"],
        },
        fakeDeps,
      );

      // destroySandbox ran BEFORE run.json was published.
      assert.equal(runJsonExistedDuringDestroy, false);
      assert.equal(destroyedRunIds.length, 3);

      // SMOKE-before-b1 had a cleanupError, artifacts existed -> still marked complete with redacted cleanupError.
      const beforeRun = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-before-b1", "run.json"), "utf8"));
      assert.equal(beforeRun.invalid, null);
      assert.match(beforeRun.cleanupError, /<redacted>/);
      assert.equal(beforeRun.cleanupError.includes(secret), false);

      // SMOKE-after-b1 completed normally despite SMOKE-none-b1 being unwritable.
      const afterRun = JSON.parse(readFileSync(join(outDir, "runs", "SMOKE-after-b1", "run.json"), "utf8"));
      assert.equal(afterRun.invalid, null);
      assert.equal(afterRun.accept.solved, true);

      // Unwritable run was logged, counted, and did not reject the worker pool.
      assert.equal(summary.publishFailed, 1);
      assert.equal(summary.ran, 2);
      assert.ok(
        logs.some((line) => line.includes("SMOKE-none-b1") && /failed to publish run\.json/i.test(line)),
        `expected publish error log for SMOKE-none-b1, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });
});
