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
import { assertNoAncestorInstructions, createSandbox, scrubEnv } from "../sandbox.mjs";
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

test("evaluation uses batch provider and saved task cwd while preserving Claude fixture metrics", (t) => {
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
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ taskId: task.id, taskDir: "/sbx/task", arm: "none", wallMs: 174 }));
  writeFileSync(join(runDir, "transcript.jsonl"), codex);
  const metrics = evaluateBatch(out, { manifest: { tasks: [task] } }).metrics.test;
  assert.equal(metrics.staleRepeat, true);
  assert.equal(metrics.repeatFailures, 1);
  assert.equal(metrics.numTurns, 1);
  assert.equal(metrics.wallMs, 174);
  assert.deepEqual(metrics.leak, ["none-arm-rocky"]);
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ arm: "none" }));
  assert.equal(runMetrics(parseJsonl(codex), task, runDir, "codex").staleRepeat, false);

  // Explicit run provenance wins over batch provenance.
  const expected = [
    ["after-lane2-no-transcript-note", "after", '{"repeatFailures":0,"turnsToPass":3,"numTurns":3,"wallMs":5400,"noteBytes":0,"noteDelivered":false,"staleRepeat":null,"leak":[]}'],
    ["four-turn-pass", "none", '{"repeatFailures":0,"turnsToPass":3,"numTurns":4,"wallMs":4200,"noteBytes":0,"noteDelivered":null,"staleRepeat":null,"leak":[]}'],
    ["multi-block-message-pass", "none", '{"repeatFailures":0,"turnsToPass":4,"numTurns":5,"wallMs":5100,"noteBytes":0,"noteDelivered":null,"staleRepeat":null,"leak":[]}'],
    ["none-arm-mcp-leak", "none", '{"repeatFailures":0,"turnsToPass":3,"numTurns":3,"wallMs":3100,"noteBytes":0,"noteDelivered":null,"staleRepeat":null,"leak":["none-arm-rocky"]}'],
  ];
  for (const [name, arm, bytes] of expected) {
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ arm, provider: "claude-code" }));
    assert.equal(JSON.stringify(runMetrics(parseJsonl(transcript(name)), manifest.tasks[0], runDir)), bytes, name);
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

test("offline Codex SMOKE runs through the runner and evaluator with isolated owner state", (t) => {
  // Windows user temp can inherit instructions from the owner's profile.
  const roots = process.platform === "win32"
    ? [tmpdir(), process.env.PUBLIC, parse(tmpdir()).root].filter(Boolean)
    : [tmpdir()];
  let root;
  const errors = [];
  for (const candidate of roots) {
    try {
      assertNoAncestorInstructions(candidate);
      root = mkdtempSync(join(candidate, "rocky-codex-smoke-"));
      break;
    } catch (error) {
      errors.push(error);
    }
  }
  if (!root) throw new AggregateError(errors, "Could not create an isolated smoke test directory");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const owner = join(root, "owner");
  const ownerConfig = join(owner, ".codex");
  mkdirSync(bin);
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
      if (fs.existsSync("src")) fs.writeFileSync("src/probe.js", 'export function runProbe() { return "ok"; }\\n');
      process.stdout.write(fs.readFileSync(process.env.EVAL_FIXTURE));
      if (process.env.EVAL_LEAK === "1") {
        const token = process.env.CODEX_API_KEY;
        fs.mkdirSync("logs");
        fs.writeFileSync("logs/output.txt", token);
        process.stderr.write(token.slice(0, 8));
        setTimeout(() => process.stderr.write(token.slice(8) + "\\n"), 75);
      }
    }
  `);
  if (process.platform === "win32") {
    writeFileSync(join(bin, "codex.cmd"), `@"${process.execPath}" "${fakeCodex}" %*\r\n`);
  } else {
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`, { mode: 0o755 });
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
    PATH: [bin, parentPath].join(delimiter),
    HOME: owner,
    USERPROFILE: owner,
    CODEX_HOME: ownerConfig,
    ROCKY_HOME: join(owner, ".rocky"),
    ROCKY_EVAL_CODEX_API_KEY: token,
  });
  for (const leak of [false, true]) {
    const out = join(root, leak ? "leaky" : "clean");
    const runnerArgs = [
      fileURLToPath(new URL("../runner.mjs", import.meta.url)),
      "--provider", "codex", "--set", "v1", "--only", "SMOKE", "--arms", "none",
      "--k", "1", "--concurrency", "1", "--out", out, "--root", join(root, "sbx"),
      "--before", "HEAD", "--after", "HEAD", "--auth", "token",
    ];
    const result = spawnSync(process.execPath, runnerArgs, {
      encoding: "utf8",
      env: {
        ...env,
        EVAL_LEAK: leak ? "1" : "0",
        EVAL_FIXTURE: fileURLToPath(new URL(leak ? "codex-after.jsonl" : "codex-none.jsonl", fixtures)),
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

    const runDir = join(out, "runs", "SMOKE-none-b1");
    const run = readJson(join(runDir, "run.json"));
    assert.equal(run.provider, "codex");
    assert.ok(run.wallMs > 0);
    assert.equal(run.invalid, leak ? "token_leak" : null);
    assert.deepEqual(run.quarantined ?? [], leak ? ["final/logs/output.txt"] : []);
    assert.equal(existsSync(join(runDir, "final", "logs", "output.txt")), false);
    assert.equal(readFileSync(join(runDir, "stderr.txt"), "utf8"), leak ? "<redacted>\n" : "");
    const scored = spawnSync(process.execPath, [
      fileURLToPath(new URL("../evaluate.mjs", import.meta.url)), "--out", out,
    ], { encoding: "utf8", env });
    assert.equal(scored.status, 0, scored.stderr);
    const metrics = readJson(join(out, "metrics.json"))["SMOKE-none-b1"];
    assert.equal(metrics.numTurns, 1);
    assert.equal(metrics.wallMs, run.wallMs);
    assert.deepEqual(metrics.leak, leak ? ["none-arm-rocky", "token-in-transcript"] : []);
    if (!leak) {
      const { provider, ...legacy } = batch;
      const legacyJson = JSON.stringify(legacy);
      writeFileSync(join(out, "batch.json"), legacyJson);
      const resume = spawnSync(process.execPath, runnerArgs, { encoding: "utf8", env });
      assert.equal(resume.status, 2, resume.stderr);
      assert.match(resume.stderr, /differing fields: provider/);
      assert.equal(readFileSync(join(out, "batch.json"), "utf8"), legacyJson);
    }
  }
  const captureOut = join(root, "capture");
  const captureFixture = fileURLToPath(new URL("codex-none.jsonl", fixtures));
  const captured = spawnSync(process.execPath, [
    fileURLToPath(new URL("../capture.mjs", import.meta.url)),
    "--provider", "codex", "--arm", "none", "--auth", "token", "--out", captureOut, "--root", join(root, "sbx"),
  ], { encoding: "utf8", env: { ...env, EVAL_FIXTURE: captureFixture, EVAL_LEAK: "0" } });
  assert.equal(captured.status, 0, captured.stderr);
  assert.match(captured.stdout, /tools used: command_execution/);
  assert.equal(readFileSync(join(captureOut, "transcript.jsonl"), "utf8"), transcript("codex-none"));
  assert.equal(readFileSync(codexOwnerFile, "utf8"), "# untouched owner fixture\n");
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
