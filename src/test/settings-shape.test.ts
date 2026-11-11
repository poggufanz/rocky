import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(packageRoot, "scripts", "settings-shape.mjs");
const SECRET = "sk-SECRET-123";

function sandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-settings-shape-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function hookGroup(...commands: string[]): { hooks: { type: string; command: string }[] } {
  return { hooks: commands.map((command) => ({ type: "command", command })) };
}

/** Two desk hooks, one agent hook, and a foreign hook that holds a secret. */
function fixtureText(): string {
  return JSON.stringify(
    {
      env: { TOKEN: SECRET },
      hooks: {
        PreToolUse: [
          hookGroup(`rocky-hook desk-hook claude-code`, `echo ${SECRET}`),
          hookGroup(`node rocky hook agent-event claude-code`),
        ],
        Stop: [hookGroup(`rocky-hook desk-hook claude-code`)],
      },
    },
    null,
    2,
  );
}

function runShape(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: childEnv,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("settings shape counts Rocky hooks and never echoes content", (t) => {
  const root = sandbox(t);
  const file = join(root, "settings.json");
  const text = fixtureText();
  writeFileSync(file, text);

  const result = runShape([file]);

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, result.stdout);
  const bytes = Buffer.byteLength(text);
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  assert.equal(lines[0], `${file}: bytes=${bytes} sha256=${digest} agent=1 gate=0 desk=2`);
  assert.ok(!result.stdout.includes(SECRET), "settings content must not reach stdout");
  assert.ok(!result.stderr.includes(SECRET), "settings content must not reach stderr");
});

test("settings shape counts gate hooks apart from agent hooks", (t) => {
  const root = sandbox(t);
  const file = join(root, "settings.json");
  writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        PreToolUse: [hookGroup("node rocky hook gate-event claude-code", "node rocky hook gate-event claude-code")],
        PostToolUse: [hookGroup("node rocky hook agent-event claude-code")],
      },
    }),
  );

  const result = runShape([file]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, / agent=1 gate=2 desk=0\n$/);
});

test("settings shape reports a missing path as missing", (t) => {
  const root = sandbox(t);
  const file = join(root, "absent.json");

  const result = runShape([file]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${file}: missing\n`);
});

test("settings shape reports unparseable JSON as unreadable without echoing it", (t) => {
  const root = sandbox(t);
  const file = join(root, "settings.json");
  writeFileSync(file, `{ "env": "${SECRET}", `);

  const result = runShape([file]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${file}: unreadable\n`);
  assert.ok(!result.stderr.includes(SECRET), "settings content must not reach stderr");
});

test("settings shape reads the home and config-dir settings when given no path", (t) => {
  const root = sandbox(t);
  const home = join(root, "home");
  const configDir = join(root, "profile");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), fixtureText());
  writeFileSync(join(configDir, "settings.json"), "not json");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir };

  const result = runShape([], env);

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, result.stdout);
  assert.match(lines[0] ?? "", /settings\.json: bytes=\d+ sha256=[0-9a-f]{12} agent=1 gate=0 desk=2$/);
  assert.equal(lines[1], `${join(configDir, "settings.json")}: unreadable`);
  assert.ok(!result.stdout.includes(SECRET), "settings content must not reach stdout");
});

test("settings shape reads one file once when the config dir is the default dir", (t) => {
  const root = sandbox(t);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), fixtureText());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
  };

  const result = runShape([], env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trimEnd().split("\n").length, 1, result.stdout);
});

test("settings shape stays a dev script outside the published package", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { files?: string[] };
  const files = manifest.files ?? [];
  assert.ok(files.length > 0, "package.json must list its files");
  assert.deepEqual(
    files.filter((entry) => entry.includes("settings-shape") || entry === "scripts" || entry.startsWith("scripts/")),
    [],
  );
});
