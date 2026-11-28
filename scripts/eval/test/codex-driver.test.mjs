import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, parse } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getEvalDriver } from "../drivers/index.mjs";
import { evaluateBatch, parseJsonl, runMetrics } from "../evaluate.mjs";
import { buildHistoryRockyEnv, materializeTask, renderClaudeMd, renderInstructions } from "../history.mjs";
import { classifyOutcome, createRedactingFileWriter, diffBatchProvenance } from "../runner.mjs";
import { assertNoAncestorInstructions, buildCommandInvocation, createSandbox, resolveExecutableOnPath, scrubEnv } from "../sandbox.mjs";
import { ownerBaseline, ownerCheck } from "../owner-guard.mjs";

const fixtures = new URL("./fixtures/", import.meta.url);
const transcript = (name) => readFileSync(new URL(`${name}.jsonl`, fixtures), "utf8");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../tasks/manifest.json", import.meta.url), "utf8"));

test("Codex reduces the captured tool pairs and prompt-level turns", () => {
  const driver = getEvalDriver("codex");
  for (const arm of ["none", "after"]) {
    const reducer = driver.createReducer();
    for (const event of parseJsonl(transcript(`codex-${arm}`))) reducer.consume(event);
    const reduced = reducer.finish();
    assert.deepEqual(reduced.toolCalls.map(({ command, turn, exitCode, isError }) => (
      { command, turn, exitCode, isError }
    )), Array.from({ length: 2 }, () => ({ command: "npm test", turn: 1, exitCode: 1, isError: true })));
    assert.ok(reduced.toolCalls.every((call) => call.output.includes("AssertionError: probe")));
    assert.deepEqual(reduced.fileEdits, arm === "after" ? ["/sbx/task/probe-marker.txt"] : []);
    assert.deepEqual(reduced.mcpCalls.map(({ server, tool }) => ({ server, tool })),
      arm === "after" ? [{ server: "rocky", tool: "stats" }] : []);
    assert.equal(reduced.numTurns, 1);
    assert.equal(reduced.resultEvent.type, "turn.completed");
  }
  const failure = { type: "turn.failed", error: { message: "fixture failure" } };
  const failed = driver.createReducer();
  failed.consume({ type: "turn.started" });
  failed.consume(failure);
  assert.equal(failed.finish().resultEvent, failure);
  assert.equal(classifyOutcome({ provider: "codex", rawStdout: JSON.stringify(failure), timedOut: false }), "api_error");
});

test("evaluation checks the batch provider and uses the saved task cwd", (t) => {
  const out = mkdtempSync(join(tmpdir(), "rocky-codex-evaluate-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const runDir = join(out, "runs", "test");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(out, "batch.json"), JSON.stringify({ provider: "codex" }));
  const task = {
    id: "test",
    kind: "stale",
    fixture: "smoke",
    history: { fix: "fix" },
    target: { aliases: ["^npm test$"] },
    trapLine: "AssertionError: probe",
  };
  // The absolute edit can only match the relative fixture overlay with the saved cwd.
  const codex = transcript("codex-after").replaceAll("/sbx/task/probe-marker.txt", "/sbx/task/src/probe.js");
  const runMeta = { taskId: task.id, taskDir: "/sbx/task", arm: "none", wallMs: 174 };
  writeFileSync(join(runDir, "transcript.jsonl"), codex);
  for (const provider of [undefined, "claude-code"]) {
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...runMeta, provider }));
    assert.throws(() => evaluateBatch(out), /Run provider mismatch.*expected codex/);
    assert.equal(existsSync(join(out, "metrics.json")), false);
  }
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...runMeta, provider: "codex" }));
  const metrics = evaluateBatch(out, { manifest: { tasks: [task] } }).metrics.test;
  assert.equal(metrics.staleRepeat, true);
  assert.equal(metrics.repeatFailures, 1);
  assert.equal(metrics.numTurns, 1);
  assert.equal(metrics.wallMs, 174);
  assert.deepEqual(metrics.leak, ["none-arm-rocky"]);
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ arm: "none", provider: "codex" }));
  assert.equal(runMetrics(parseJsonl(codex), task, runDir, "codex").staleRepeat, false);

  // Missing provider fields are valid for legacy Claude Code data.
  writeFileSync(join(out, "batch.json"), "{}");
  const expected = [
    ["after-lane2-no-transcript-note", "after", '{"repeatFailures":0,"turnsToPass":3,"numTurns":3,"wallMs":5400,"noteBytes":0,"noteDelivered":false,"staleRepeat":null,"leak":[]}'],
    ["four-turn-pass", "none", '{"repeatFailures":0,"turnsToPass":3,"numTurns":4,"wallMs":4200,"noteBytes":0,"noteDelivered":null,"staleRepeat":null,"leak":[]}'],
    ["multi-block-message-pass", "none", '{"repeatFailures":0,"turnsToPass":4,"numTurns":5,"wallMs":5100,"noteBytes":0,"noteDelivered":null,"staleRepeat":null,"leak":[]}'],
    ["none-arm-mcp-leak", "none", '{"repeatFailures":0,"turnsToPass":3,"numTurns":3,"wallMs":3100,"noteBytes":0,"noteDelivered":null,"staleRepeat":null,"leak":["none-arm-rocky"]}'],
  ];
  for (const [name, arm, bytes] of expected) {
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ arm }));
    assert.equal(JSON.stringify(runMetrics(parseJsonl(transcript(name)), manifest.tasks[0], runDir)), bytes, name);
  }
  assert.ok(evaluateBatch(out).metrics.test);
});

test("a Codex lane-2 advisory cannot satisfy the positive control", (t) => {
  const runDir = mkdtempSync(join(tmpdir(), "rocky-codex-lanes-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ arm: "after", provider: "codex" }));
  const rockyHome = join(runDir, "rocky-home");
  mkdirSync(rockyHome);
  const events = [{ type: "turn.started" }, { type: "turn.completed" }];
  for (const lane of ["tool-result", "run", "mcp"]) {
    writeFileSync(join(rockyHome, "advisories.jsonl"), JSON.stringify({
      kind: "note", arm: "shown", delivered: true, bytes: 123, lane,
    }));
    const metrics = runMetrics(events, manifest.tasks[0], runDir);
    assert.equal(metrics.noteDelivered, lane !== "tool-result", lane);
    assert.equal(metrics.noteBytes, 0, lane);
  }
});

test("batch provenance resumes legacy Claude batches and rejects a Codex resume", () => {
  const legacy = {
    claudeVersion: "2.1.330 (Claude Code)",
    claudeFlags: ["--frozen"],
    claudeMdSha256: { none: "abc" },
    arms: ["none"],
    taskIds: ["SMOKE"],
  };
  const current = {
    provider: "claude-code",
    cliVersion: legacy.claudeVersion,
    flags: legacy.claudeFlags,
    instructionsSha256: legacy.claudeMdSha256,
    lanes: ["lane1", "lane2", "mcp"],
    arms: legacy.arms,
    taskIds: legacy.taskIds,
  };
  assert.deepEqual(diffBatchProvenance(legacy, current), []);
  assert.deepEqual(diffBatchProvenance(legacy, { ...current, provider: "codex" }), ["provider"]);
  assert.deepEqual(diffBatchProvenance(current, { ...current, instructionsSha256: { none: "def" } }),
    ["instructionsSha256"]);
});

test("pre-redaction scanning catches a token split across stream chunks even with a shorter secret prefix", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-codex-redact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "stderr.txt");
  const prefix = "probe-é-secret";
  const writer = createRedactingFileWriter(target, [prefix, `${prefix}-long`]);
  writer.write(Buffer.from(`before ${prefix}`));
  writer.write(Buffer.from("-long after"));
  assert.deepEqual(await writer.end(), { leaked: true });
  assert.equal(readFileSync(target, "utf8"), "before <redacted> after");
});

test("the stream scanner detects a single split secret before the writer ends", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-codex-overlap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "stderr.txt");
  const secret = Buffer.from("probe-é-secret");
  const split = secret.indexOf(0xc3) + 1;
  const writer = createRedactingFileWriter(target, [secret.toString()]);
  try {
    writer.write(secret.subarray(0, split));
    assert.equal(writer.getLeaked(), false);
    writer.write(secret.subarray(split));
    assert.equal(writer.getLeaked(), true);
  } finally {
    await writer.end();
  }
  assert.equal(readFileSync(target, "utf8"), "<redacted>");
});

test("a raw stream hit halts resume after interruption before publication", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-eval-interrupted-leak-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = "SMOKE-none-b1";
  const out = join(root, "out");
  const script = `
    import { runBatch, createRedactingFileWriter } from ${JSON.stringify(new URL("../runner.mjs", import.meta.url).href)};
    import assert from "node:assert/strict";
    import { mkdirSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    const root = ${JSON.stringify(root)};
    const token = "fixture-interrupted-secret";
    try {
      await runBatch({
        outDir: join(root, "out"), rootDir: root, cacheDir: join(root, "cache"),
        beforeRef: "HEAD", afterRef: "HEAD", set: "v1", only: ["SMOKE"],
        k: 1, arms: ["none"], auth: { kind: "token" }, secrets: [token],
      }, {
        resolveCommit: () => "fixture-sha",
        getHeadCommit: () => "fixture-sha",
        getClaudeVersion: () => "fixture-version",
        assertRootClean: () => {},
        ownerBaseline: () => ({}),
        ownerCheck: () => ({ leak: false }),
        createSandbox: async ({ runId }) => {
          const dir = join(root, runId);
          mkdirSync(dir);
          return { dir, taskDir: dir };
        },
        materializeTask: async () => {},
        runClaude: async ({ stderrPath, secrets, onLeak }) => {
          let persistedAtHit;
          const writer = createRedactingFileWriter(stderrPath, secrets, {
            onLeak() {
              onLeak();
              persistedAtHit = JSON.parse(readFileSync(join(root, "out", "batch.json"), "utf8")).halted;
            },
          });
          writer.write(Buffer.from(token.slice(0, 8)));
          writer.write(Buffer.from(token.slice(8)));
          await writer.end();
          assert.equal(persistedAtHit?.reason, "token_leak");
          process.exit(77);
        },
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = error.exitCode ?? 1;
    }
  `;
  const launch = () => spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const interrupted = launch();
  assert.equal(interrupted.status, 77, interrupted.stderr);
  const runDir = join(out, "runs", runId);
  assert.equal(existsSync(join(runDir, "run.json")), false);
  assert.equal(readFileSync(join(runDir, "stderr.txt"), "utf8"), "<redacted>");
  const batchPath = join(out, "batch.json");
  const halted = readFileSync(batchPath, "utf8");
  const batch = JSON.parse(halted);
  assert.equal(batch.halted.reason, "token_leak");
  assert.equal(batch.halted.runId, runId);
  const resume = launch();
  assert.equal(resume.status, 3, resume.stderr);
  assert.match(resume.stderr, /Batch is halted \(reason=token_leak/);
  assert.equal(readFileSync(batchPath, "utf8"), halted);
  assert.equal(existsSync(join(runDir, "run.json")), false);
});

test("the runner reports the saved provider mismatch without Codex credentials", (t) => {
  const out = mkdtempSync(join(tmpdir(), "rocky-eval-provider-resume-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const batchPath = join(out, "batch.json");
  const noCodexKeys = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !["ROCKY_EVAL_CODEX_API_KEY", "ROCKY_EVAL_OPENAI_API_KEY"].includes(key.toUpperCase())
  )));
  for (const provider of [undefined, "claude-code"]) {
    const saved = JSON.stringify({ provider, claudeVersion: "2.1.330 (Claude Code)" });
    writeFileSync(batchPath, saved);
    const resume = spawnSync(process.execPath, [
      fileURLToPath(new URL("../runner.mjs", import.meta.url)),
      "--provider", "codex", "--set", "v1", "--before", "HEAD", "--after", "HEAD",
      "--only", "SMOKE", "--out", out, "--auth", "token",
    ], { encoding: "utf8", env: noCodexKeys });
    assert.equal(resume.status, 2, resume.stderr);
    assert.match(resume.stderr, /Batch provenance mismatch .* differing fields: provider/);
    assert.equal(readFileSync(batchPath, "utf8"), saved);
  }
});

function cacheFixtureRocky(root, env) {
  const fixturePackage = join(root, "fixture-rocky");
  const cache = join(root, "pack-cache");
  mkdirSync(fixturePackage);
  mkdirSync(cache);
  writeFileSync(join(fixturePackage, "package.json"), JSON.stringify({
    name: "offline-rocky-fixture", version: "1.0.0", bin: { rocky: "rocky.cjs" },
  }));
  writeFileSync(join(fixturePackage, "rocky.cjs"), `#!/usr/bin/env node
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    assert.deepEqual(process.argv.slice(2), ["setup", "--harness", "codex", "--yes"]);
    assert.equal(process.env.CODEX_API_KEY, undefined);
    const entries = process.env.PATH.split(path.delimiter);
    assert.ok(!entries.includes(process.env.EVAL_OWNER_BIN));
    const bin = entries.find((entry) => path.basename(entry) === "provider-bin");
    assert.ok(bin);
    const win = process.platform === "win32";
    const launcher = path.join(bin, win ? "codex.cmd" : "codex");
    assert.deepEqual(fs.readdirSync(bin), [path.basename(launcher)]);
    const result = require("node:child_process").spawnSync(
      win ? process.env.ComSpec : launcher,
      win ? ["/d", "/s", "/c", '""' + launcher + '" --version"'] : ["--version"],
      { encoding: "utf8", windowsVerbatimArguments: win },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "codex-cli 0.171.0");
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "# fixture Rocky registered\\n");
    fs.writeFileSync(path.join(process.env.ROCKY_HOME, "memory.jsonl"), '{}\\n');
    if (process.env.ROCKY_ATTEMPT_ARM === "shown") {
      fs.writeFileSync(path.join(process.env.ROCKY_HOME, "advisories.jsonl"),
        JSON.stringify({ kind: "note", arm: "shown", delivered: true, lane: "run" }) + "\\n");
    }
  `, { mode: 0o755 });
  const npm = resolveExecutableOnPath(process.platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"], env.PATH);
  assert.ok(npm, "npm must be available for the offline sandbox install");
  const command = buildCommandInvocation(npm, ["pack", "--offline", "--ignore-scripts", "--pack-destination", cache]);
  const packed = spawnSync(command.file, command.args, {
    cwd: fixturePackage, env, encoding: "utf8", windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(rev.status, 0, rev.stderr);
  writeFileSync(join(cache, `rocky-${rev.stdout.trim()}.tgz`), readFileSync(join(cache, "offline-rocky-fixture-1.0.0.tgz")));
  return cache;
}

function isolatedSmokeDirectory(t, prefix) {
  // Windows user temp can inherit instructions from the owner's profile.
  const roots = process.platform === "win32"
    ? [tmpdir(), process.env.PUBLIC, parse(tmpdir()).root].filter(Boolean)
    : [tmpdir()];
  let root;
  const errors = [];
  for (const candidate of roots) {
    try {
      assertNoAncestorInstructions(candidate);
      root = mkdtempSync(join(candidate, prefix));
      break;
    } catch (error) {
      errors.push(error);
    }
  }
  if (!root) throw new AggregateError(errors, "Could not create an isolated smoke test directory");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("offline Codex SMOKE runs through the runner and evaluator with isolated owner state", (t) => {
  const root = isolatedSmokeDirectory(t, "rocky-codex-smoke-");
  const bin = join(root, "bin");
  const decoyBin = join(root, "decoy-bin");
  const owner = join(root, "owner");
  const ownerConfig = join(owner, ".codex");
  mkdirSync(bin);
  mkdirSync(decoyBin);
  mkdirSync(ownerConfig, { recursive: true });
  const codexOwnerFile = join(ownerConfig, "config.toml");
  writeFileSync(codexOwnerFile, "# untouched owner fixture\n");
  const fakeCodex = join(bin, "fixture.cjs");
  writeFileSync(fakeCodex, `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const args = process.argv.slice(2);
    if (args[0] === "--version") {
      console.log("codex-cli 0.171.0");
    } else {
      assert.deepEqual(args.slice(0, 4), ["exec", "--json", "-C", process.cwd()]);
      assert.ok(fs.existsSync("AGENTS.md"));
      assert.equal(process.env.CODEX_HOME, path.join(process.env.HOME, ".codex"));
      assert.ok(process.env.CODEX_API_KEY);
      const arm = path.basename(path.dirname(process.env.ROCKY_HOME)).split("-")[1];
      const config = path.join(process.env.CODEX_HOME, "config.toml");
      if (arm === "none") {
        assert.equal(fs.existsSync(config), false);
      } else {
        assert.equal(fs.readFileSync(config, "utf8"), "# fixture Rocky registered\\n");
        assert.equal(fs.readFileSync(path.join(process.env.ROCKY_HOME, "memory.jsonl"), "utf8"), "{}\\n");
      }
      if (fs.existsSync("src")) fs.writeFileSync("src/probe.js", 'export function runProbe() { return "ok"; }\\n');
      const fixture = arm === "after" || process.env.EVAL_LEAK === "1" ? "codex-after.jsonl" : "codex-none.jsonl";
      process.stdout.write(fs.readFileSync(path.join(process.env.EVAL_FIXTURES, fixture)));
      if (process.env.EVAL_CAPTURE_LEAK) {
        process[process.env.EVAL_CAPTURE_LEAK].write(process.env.CODEX_API_KEY);
      }
      if (process.env.EVAL_LEAK === "1") {
        const token = process.env.CODEX_API_KEY;
        process.stderr.write(token.slice(0, 8));
        setTimeout(() => process.stderr.write(token.slice(8) + "\\n"), 75);
      }
    }
  `);
  if (process.platform === "win32") {
    writeFileSync(join(bin, "codex.cmd"), `@"${process.execPath}" "${fakeCodex}" %*\r\n`);
    writeFileSync(join(bin, "rocky.cmd"), "@exit /b 90\r\n");
    writeFileSync(join(decoyBin, "codex.cmd"), "@exit /b 91\r\n");
  } else {
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, "rocky"), "#!/bin/sh\nexit 90\n", { mode: 0o755 });
    writeFileSync(join(decoyBin, "codex"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  }

  const token = "offline-fixture-secret";
  const env = { ...process.env };
  const parentPath = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  for (const key of Object.keys(env)) {
    if (["PATH", "HOME", "USERPROFILE", "CODEX_HOME", "ROCKY_HOME", "ROCKY_EVAL_CODEX_API_KEY"].includes(key.toUpperCase())) {
      delete env[key];
    }
  }
  Object.assign(env, {
    PATH: [bin, decoyBin, parentPath].join(delimiter),
    HOME: owner,
    USERPROFILE: owner,
    CODEX_HOME: ownerConfig,
    ROCKY_HOME: join(owner, ".rocky"),
    ROCKY_EVAL_CODEX_API_KEY: token,
    EVAL_FIXTURES: fileURLToPath(fixtures),
    EVAL_OWNER_BIN: bin,
    NPM_CONFIG_OFFLINE: "true",
  });
  const cache = cacheFixtureRocky(root, env);
  for (const leak of [false, true]) {
    const out = join(root, leak ? "leaky" : "clean");
    const arms = leak ? ["none"] : ["none", "before", "after"];
    const runnerArgs = [
      fileURLToPath(new URL("../runner.mjs", import.meta.url)),
      "--provider", "codex", "--set", "v1", "--only", "SMOKE", "--arms", arms.join(","),
      "--k", "1", "--concurrency", "1", "--out", out, "--root", join(root, "sbx"),
      "--before", "HEAD", "--after", "HEAD", "--cache", cache, "--auth", "token",
    ];
    const result = spawnSync(process.execPath, runnerArgs, {
      encoding: "utf8",
      env: {
        ...env,
        EVAL_LEAK: leak ? "1" : "0",
      },
    });
    assert.equal(result.status, leak ? 3 : 0, result.stderr);
    const batch = readJson(join(out, "batch.json"));
    assert.equal(batch.provider, "codex");
    assert.deepEqual(batch.lanes, ["lane1", "mcp"]);
    assert.equal(batch.cliVersion, "codex-cli 0.171.0");
    assert.equal(batch.model, "gpt-6.2-sol");
    assert.deepEqual(batch.flags, getEvalDriver("codex").defaultFlags);
    assert.match(batch.instructionsSha256.none, /^[a-f0-9]{64}$/);
    assert.equal(batch.ownerCheck.leak, false);
    assert.ok(batch.ownerBaseline.settings.some(({ path }) => path === codexOwnerFile));
    assert.deepEqual(batch.arms, arms);

    const scored = spawnSync(process.execPath, [
      fileURLToPath(new URL("../evaluate.mjs", import.meta.url)), "--out", out,
    ], { encoding: "utf8", env });
    assert.equal(scored.status, 0, scored.stderr);
    const metrics = readJson(join(out, "metrics.json"));
    assert.equal(Object.keys(metrics).length, arms.length);
    for (const arm of arms) {
      const runId = `SMOKE-${arm}-b1`;
      const runDir = join(out, "runs", runId);
      const run = readJson(join(runDir, "run.json"));
      assert.equal(run.provider, "codex");
      assert.ok(run.wallMs > 0);
      assert.equal(run.invalid, leak ? "token_leak" : null, JSON.stringify(run));
      if (!leak) assert.equal(run.accept.solved, true);
      assert.deepEqual(run.quarantined ?? [], []);
      assert.equal(readFileSync(join(runDir, "stderr.txt"), "utf8"), leak ? "<redacted>\n" : "");
      assert.equal(readFileSync(join(runDir, "final", "AGENTS.md"), "utf8"), renderInstructions(arm, "codex"));
      const memoryPath = join(runDir, "rocky-home", "memory.jsonl");
      if (arm === "none") assert.equal(existsSync(memoryPath), false);
      else assert.equal(readFileSync(memoryPath, "utf8"), "{}\n");
      assert.equal(existsSync(join(runDir, "rocky-home", "advisories.jsonl")), arm === "after");
      assert.equal(metrics[runId].numTurns, 1);
      assert.equal(metrics[runId].wallMs, run.wallMs);
      assert.equal(metrics[runId].noteDelivered, arm === "after" ? true : null);
      assert.deepEqual(metrics[runId].leak, leak ? ["none-arm-rocky", "token-in-transcript"] : []);
    }
  }
  const captureOut = join(root, "capture");
  const captureArgs = [
    fileURLToPath(new URL("../capture.mjs", import.meta.url)),
    "--provider", "codex", "--arm", "none", "--auth", "token", "--out", captureOut, "--root", join(root, "sbx"),
  ];
  const captured = spawnSync(process.execPath, captureArgs, { encoding: "utf8", env: { ...env, EVAL_LEAK: "0" } });
  assert.equal(captured.status, 0, captured.stderr);
  assert.match(captured.stdout, /tools used: command_execution/);
  assert.equal(readFileSync(join(captureOut, "transcript.jsonl"), "utf8"), transcript("codex-none"));
  for (const stream of ["stdout", "stderr"]) {
    const leakOut = join(root, `capture-${stream}-leak`);
    const leaking = spawnSync(process.execPath, captureArgs.map((arg) => arg === captureOut ? leakOut : arg), {
      encoding: "utf8", env: { ...env, EVAL_CAPTURE_LEAK: stream },
    });
    assert.equal(leaking.status, 1);
    assert.match(leaking.stderr, /provider output contained an evaluation credential/);
    assert.equal(leaking.stdout, "");
    assert.equal(leaking.stderr.includes(token), false);
    assert.equal(existsSync(leakOut), false);
  }
  assert.equal(readFileSync(codexOwnerFile, "utf8"), "# untouched owner fixture\n");
});

test("standalone copy-credentials capture discards raw stdout and stderr containing fixture tokens", (t) => {
  const root = isolatedSmokeDirectory(t, "rocky-capture-copy-creds-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const from = join(root, ".credentials.json");
  const accessToken = "fixture-capture-access-token";
  const refreshToken = "fixture-capture-refresh-token";
  writeFileSync(from, JSON.stringify({ claudeAiOauth: { accessToken, refreshToken } }));
  const provider = join(bin, "fixture.cjs");
  writeFileSync(provider, `
    if (process.argv[2] === "--version") console.log("Claude Code fixture");
    else if (process.env.EVAL_CAPTURE_STREAM === "stdout") process.stdout.write(${JSON.stringify(accessToken)});
    else process.stderr.write(${JSON.stringify(refreshToken)});
  `);
  if (process.platform === "win32") {
    writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "${provider}" %*\r\n`);
  } else {
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${provider}" "$@"\n`, { mode: 0o755 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = bin;

  for (const stream of ["stdout", "stderr"]) {
    const out = join(root, `capture-${stream}`);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../capture.mjs", import.meta.url)),
      "--arm", "none", "--auth", "copy-credentials", "--from", from, "--out", out, "--root", join(root, "sbx"),
    ], { encoding: "utf8", env: { ...env, EVAL_CAPTURE_STREAM: stream } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /provider output contained an evaluation credential/);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(accessToken) || result.stderr.includes(refreshToken), false);
    assert.equal(existsSync(out), false);
  }
});

test("scrubEnv drops CODEX* and OPENAI_* alongside CLAUDE*/ANTHROPIC_*", () => {
  const cleaned = scrubEnv({
    PATH: "/usr/bin",
    CODEX_HOME: "/home/u/.codex",
    CODEX_API_KEY: "sk-test",
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_API_KEY: "sk-anthropic",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
  });
  assert.deepEqual(cleaned, { PATH: "/usr/bin" });
});

test("assertNoAncestorInstructions rejects .codex in ancestor", () => {
  const base = mkdtempSync(join(tmpdir(), "rocky-codex-anc-"));
  try {
    const codexDir = join(base, ".codex");
    mkdirSync(codexDir);
    assert.throws(() => assertNoAncestorInstructions(join(base, "sbx")), (error) => {
      assert.ok(error.message.endsWith(codexDir), error.message);
      return true;
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("getEvalDriver returns distinct instructionFile and lanes for codex vs claude-code", () => {
  const claude = getEvalDriver("claude-code");
  const codex = getEvalDriver("codex");
  assert.equal(claude.instructionFile, "CLAUDE.md");
  assert.equal(codex.instructionFile, "AGENTS.md");
  assert.deepEqual(codex.lanes, ["lane1", "mcp"]);
  assert.throws(() => getEvalDriver("unknown"), /Unknown eval provider: unknown/);
});

test("Codex builds the frozen exec command with Windows settings only on Windows", () => {
  const codex = getEvalDriver("codex");
  const taskDir = join("sandbox", "task with spaces");
  const prompt = "Fix the failing test";
  assert.deepEqual(codex.buildCommand(prompt, undefined, { taskDir, platform: "win32" }), {
    file: "codex",
    args: [
      "exec", "--json", "-C", taskDir, "-s", "workspace-write", "--ephemeral",
      "-c", "windows.sandbox=unelevated", "-m", "gpt-6.2-sol", "--", prompt,
    ],
  });
  assert.deepEqual(codex.buildCommand(prompt, "override", { taskDir, platform: "linux" }), {
    file: "codex",
    args: [
      "exec", "--json", "-C", taskDir, "-s", "workspace-write", "--ephemeral",
      "-m", "override", "--", prompt,
    ],
  });
});

test("Codex treats a flag-like prompt as a positional argument", () => {
  const { args } = getEvalDriver("codex").buildCommand("--help");
  assert.deepEqual(args.slice(-2), ["--", "--help"]);
});

test("Codex sandbox uses only eval keys and materializes AGENTS.md from the shared fixtures", async () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-codex-sandbox-"));
  const owner = join(root, "owner-codex");
  mkdirSync(owner);
  writeFileSync(join(owner, "auth.json"), '{"token":"owner-fixture"}\n');
  try {
    const options = {
      arm: "none",
      provider: "codex",
      root,
      exists: () => false,
    };
    const env = {
      ...process.env,
      CODEX_HOME: owner,
      CODEX_API_KEY: "owner-codex-key",
      OPENAI_API_KEY: "owner-openai-key",
      ROCKY_EVAL_CODEX_API_KEY: undefined,
      ROCKY_EVAL_OPENAI_API_KEY: "fallback-eval-key",
    };
    const sandbox = await createSandbox({
      ...options,
      runId: "preferred",
      env: { ...env, ROCKY_EVAL_CODEX_API_KEY: "preferred-eval-key" },
    });
    assert.equal(sandbox.env.CODEX_HOME, join(sandbox.home, ".codex"));
    assert.equal(sandbox.configDir, sandbox.env.CODEX_HOME);
    assert.equal(sandbox.env.CODEX_API_KEY, "preferred-eval-key");
    assert.equal(sandbox.env.OPENAI_API_KEY, undefined);
    assert.equal(sandbox.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(existsSync(join(sandbox.configDir, "auth.json")), false);
    assert.equal(existsSync(join(sandbox.configDir, "config.toml")), false);
    assert.equal(sandbox.prefixBin, null);

    const replayEnv = buildHistoryRockyEnv(sandbox);
    assert.equal(replayEnv.CODEX_HOME, sandbox.configDir);
    assert.equal(replayEnv.CODEX_API_KEY, undefined);

    const fallback = await createSandbox({ ...options, runId: "fallback", env });
    assert.equal(fallback.env.CODEX_API_KEY, "fallback-eval-key");
    const unauthenticated = await createSandbox({
      ...options,
      runId: "unauthenticated",
      env: { ...env, ROCKY_EVAL_OPENAI_API_KEY: undefined },
    });
    assert.equal(unauthenticated.env.CODEX_API_KEY, undefined);
    await assert.rejects(
      createSandbox({
        ...options,
        runId: "copy",
        auth: { kind: "copy-credentials", from: join(owner, "auth.json") },
      }),
      /Codex.*copy-credentials/,
    );

    await materializeTask({ fixture: "smoke", history: null }, sandbox, "none");
    assert.equal(readFileSync(join(sandbox.taskDir, "AGENTS.md"), "utf8"), renderClaudeMd("none"));
    assert.equal(existsSync(join(sandbox.taskDir, "CLAUDE.md")), false);
    for (const arm of ["none", "before", "after"]) {
      assert.equal(renderInstructions(arm, "codex"), renderClaudeMd(arm));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownerBaseline and ownerCheck detect mutation of Codex config, hooks, and auth files", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-codex-owner-"));
  try {
    const codexDir = join(home, ".codex");
    const customDir = join(home, "custom-codex");
    const explicitDir = join(home, "explicit-codex");
    mkdirSync(codexDir);
    mkdirSync(customDir);
    mkdirSync(explicitDir);
    const config = join(codexDir, "config.toml");
    const hooks = join(codexDir, "hooks.json");
    const auth = join(customDir, "auth.json");
    const explicitConfig = join(explicitDir, "config.toml");
    writeFileSync(config, "# base\n");
    writeFileSync(hooks, "{}\n");
    writeFileSync(auth, '{"token":"fixture-secret"}\n');
    const baseline = ownerBaseline({
      ownerHome: home,
      ownerConfigDir: explicitDir,
      ownerRockyHome: join(home, ".rocky"),
      provider: "codex",
      env: { CODEX_HOME: customDir },
    });
    assert.equal(baseline.settings.length, 9);
    const authSnapshot = baseline.settings.find((entry) => entry.path === auth);
    assert.deepEqual(Object.keys(authSnapshot).sort(), ["mtimeMs", "path", "sha256"]);
    assert.match(authSnapshot.sha256, /^[a-f0-9]{64}$/);

    writeFileSync(config, "# changed\n");
    writeFileSync(hooks, '{"hooks":[]}\n');
    writeFileSync(auth, '{"token":"rotated-fixture-secret"}\n');
    writeFileSync(explicitConfig, "# new config\n");
    const check = ownerCheck(baseline, { evalRoot: join(home, "sbx") });
    assert.deepEqual(check.settingsChanged, [config, hooks, auth, explicitConfig]);
    assert.equal(check.leak, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
