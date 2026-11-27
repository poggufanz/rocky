import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getEvalDriver } from "../drivers/index.mjs";
import { buildHistoryRockyEnv, materializeTask, renderClaudeMd, renderInstructions } from "../history.mjs";
import { assertNoAncestorInstructions, createSandbox, scrubEnv } from "../sandbox.mjs";
import { ownerBaseline, ownerCheck } from "../owner-guard.mjs";

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
      "-c", "windows.sandbox=unelevated", "-m", "gpt-6.2-sol", prompt,
    ],
  });
  assert.deepEqual(codex.buildCommand(prompt, "override", { taskDir, platform: "linux" }), {
    file: "codex",
    args: ["exec", "--json", "-C", taskDir, "-s", "workspace-write", "--ephemeral", "-m", "override", prompt],
  });
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
