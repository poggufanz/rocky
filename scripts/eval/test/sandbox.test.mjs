import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FLAGS,
  MODEL,
  assertNoAncestorInstructions,
  createSandbox,
  destroySandbox,
  packArm,
  redactText,
  scrubEnv,
  stripRockyFromPath,
} from "../sandbox.mjs";

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(evalDir, "..", "..");
const captureScript = join(evalDir, "capture.mjs");

describe("sandbox", () => {
  test("scrubEnv drops agent and rocky variables", () => {
    const input = {
      CLAUDECODE: "1",
      CLAUDE_CONFIG_DIR: "x",
      ROCKY_AGENT_SESSION: "s",
      ROCKY_HOME: "h",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_ENV_FILE: "f",
      NODE_OPTIONS: "--x",
      PATH: "p",
    };
    const snapshot = { ...input };

    const out = scrubEnv(input, process.platform);

    assert.deepEqual(out, { PATH: "p" });
    assert.deepEqual(input, snapshot);
  });

  test("stripRockyFromPath removes every dir holding a rocky shim", () => {
    const winOut = stripRockyFromPath("A;B;C", "win32", (dir) => dir === "B");
    assert.equal(winOut, "A;C");

    const posixOut = stripRockyFromPath("/a:/b:/c", "linux", (dir) => dir === "/b");
    assert.equal(posixOut, "/a:/c");
  });

  test("assertNoAncestorInstructions throws naming the first ancestor CLAUDE.md", () => {
    const offending = "/a/CLAUDE.md";
    const exists = (candidate) => candidate === offending;

    assert.throws(
      () => assertNoAncestorInstructions("/a/b/c", exists),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\/a\/CLAUDE\.md/);
        return true;
      },
    );
  });

  test("assertNoAncestorInstructions checks AGENTS.md and .claude in root and ancestors", () => {
    assert.throws(
      () => assertNoAncestorInstructions("/x/y", (candidate) => candidate === "/x/y/.claude"),
      /\/x\/y\/\.claude/,
    );
    assert.throws(
      () => assertNoAncestorInstructions("C:\\work\\sub\\run", (candidate) => candidate === "C:\\work\\AGENTS.md"),
      /C:\\work\\AGENTS\.md/,
    );
    assert.doesNotThrow(() => assertNoAncestorInstructions("/clean/root", () => false));
  });

  test("sandbox env points every home variable inside the sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "rocky-eval-test-"));
    let sandbox;
    try {
      sandbox = await createSandbox({
        arm: "none",
        runId: "run-home-check",
        root,
        exists: () => false,
      });

      for (const key of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "ROCKY_HOME"]) {
        const value = sandbox.env[key];
        assert.equal(typeof value, "string", `${key} should be set`);
        assert.equal(
          value.startsWith(sandbox.dir),
          true,
          `${key} (${value}) must start with ${sandbox.dir}`,
        );
      }

      const pathKey = Object.keys(sandbox.env).find((key) => key.toUpperCase() === "PATH");
      assert.ok(pathKey, "PATH must exist in sandbox env");
      const sep = process.platform === "win32" ? ";" : ":";
      const dirs = (sandbox.env[pathKey] ?? "").split(sep).filter(Boolean);
      const shimNames = process.platform === "win32"
        ? ["rocky.cmd", "rocky.exe", "rocky.ps1", "rocky.bat", "rocky"]
        : ["rocky"];
      for (const dir of dirs) {
        for (const name of shimNames) {
          assert.equal(
            existsSync(join(dir, name)),
            false,
            `rocky shim should not resolve on sandbox PATH: ${join(dir, name)}`,
          );
        }
      }

      assert.equal(existsSync(sandbox.home), true);
      assert.equal(existsSync(sandbox.configDir), true);
      assert.equal(existsSync(sandbox.rockyHome), true);
      assert.equal(existsSync(sandbox.taskDir), true);
    } finally {
      if (sandbox) await destroySandbox(sandbox);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createSandbox supports token and copy-credentials auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "rocky-eval-auth-"));
    const sourceDir = mkdtempSync(join(tmpdir(), "rocky-eval-creds-"));
    const credsPath = join(sourceDir, ".credentials.json");
    writeFileSync(credsPath, '{"accessToken":"fixture"}\n', "utf8");
    const extraFile = join(sourceDir, "unrelated.json");
    writeFileSync(extraFile, "{}\n", "utf8");

    let tokenSandbox;
    let copySandbox;
    try {
      const harnessEnv = { ...process.env, ROCKY_EVAL_OAUTH_TOKEN: "secret-eval-token-123" };
      tokenSandbox = await createSandbox({
        arm: "none",
        runId: "auth-token",
        root,
        auth: { kind: "token" },
        exists: () => false,
        env: harnessEnv,
      });
      assert.equal(tokenSandbox.env.CLAUDE_CODE_OAUTH_TOKEN, "secret-eval-token-123");
      assert.equal(tokenSandbox.env.ROCKY_EVAL_OAUTH_TOKEN, undefined);

      copySandbox = await createSandbox({
        arm: "none",
        runId: "auth-copy",
        root,
        auth: { kind: "copy-credentials", from: credsPath },
        exists: () => false,
      });
      const copied = join(copySandbox.configDir, ".credentials.json");
      assert.equal(existsSync(copied), true);
      assert.equal(readFileSync(copied, "utf8"), '{"accessToken":"fixture"}\n');
      assert.equal(existsSync(join(copySandbox.configDir, "unrelated.json")), false);
      assert.equal(copySandbox.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    } finally {
      if (tokenSandbox) await destroySandbox(tokenSandbox);
      if (copySandbox) await destroySandbox(copySandbox);
      rmSync(root, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test("exports provisional model, flags, and packArm", () => {
    assert.equal(MODEL, "claude-sonnet-5-5");
    assert.deepEqual(CLAUDE_FLAGS, [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "30",
      "--model",
      MODEL,
      "--allowedTools",
      "Bash,PowerShell,Edit,Write,Read,Glob,Grep,mcp__rocky__*",
    ]);
    assert.equal(typeof packArm, "function");
  });
});

describe("capture CLI guards", () => {
  test("exits 2 when ROCKY_EVAL_OAUTH_TOKEN is missing in token mode", () => {
    const outDir = mkdtempSync(join(tmpdir(), "rocky-eval-out-"));
    try {
      const env = { ...process.env };
      delete env.ROCKY_EVAL_OAUTH_TOKEN;
      const result = spawnSync(
        process.execPath,
        [captureScript, "--arm", "none", "--auth", "token", "--out", outDir],
        { env, encoding: "utf8", windowsHide: true },
      );
      assert.equal(result.status, 2);
      assert.match(result.stderr, /ROCKY_EVAL_OAUTH_TOKEN/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("exits 2 when --out is inside the repo", () => {
    const insideRepo = join(repoRoot, "scripts", "eval", "tmp-capture-out");
    const env = { ...process.env, ROCKY_EVAL_OAUTH_TOKEN: "dummy-token" };
    const result = spawnSync(
      process.execPath,
      [captureScript, "--arm", "none", "--auth", "token", "--out", insideRepo],
      { env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /outside the repo/i);
  });

  test("redactText replaces every occurrence of secrets", () => {
    const out = redactText("tok=abc-123 and again abc-123", ["abc-123", ""]);
    assert.equal(out, "tok=<redacted> and again <redacted>");
  });

  test("CLAUDE.md fixtures match expected structure", () => {
    const fixturesDir = join(evalDir, "fixtures", "claude-md");
    const baseLines = readFileSync(join(fixturesDir, "base.md"), "utf8").trim().split(/\r?\n/);
    assert.equal(baseLines.length, 3);
    const rockySection = readFileSync(join(fixturesDir, "rocky-section.md"), "utf8");
    assert.match(rockySection, /^## Rocky \(MUST\)/);
    assert.match(rockySection, /rocky run/);
    assert.match(rockySection, /rocky recall/);
    assert.doesNotMatch(rockySection, /rocky journal/);
  });
});
