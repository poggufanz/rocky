import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SESSION_START_STDIN_CAP_BYTES, sessionStartHook } from "../commands/session-start-hook.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
const PROCESS_TIMEOUT_MS = 30_000;

function makeSandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-session-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function encode(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

function validPayload(sessionId = "0b6f1a2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c"): string {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: sessionId,
    source: "startup",
  });
}

function spawnHook(
  args: readonly string[],
  stdin: string,
  envOverrides: NodeJS.ProcessEnv = {},
  cwd: string = packageRoot,
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...envOverrides };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    input: stdin,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

test("sessionStartHook appends export ROCKY_AGENT_SESSION line to CLAUDE_ENV_FILE", (t) => {
  const root = makeSandbox(t);
  const envFile = join(root, "claude.env");
  const sessionId = "0b6f1a2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c";

  const out = sessionStartHook(encode(validPayload(sessionId)), { CLAUDE_ENV_FILE: envFile });

  assert.equal(out, "{}");
  assert.equal(readFileSync(envFile, "utf8"), `export ROCKY_AGENT_SESSION='${sessionId}'\n`);
});

test("sessionStartHook prepends LF when existing CLAUDE_ENV_FILE has no trailing LF", (t) => {
  const root = makeSandbox(t);
  const envFile = join(root, "claude.env");
  const sessionId = "sess_no_trailing_lf-1";
  writeFileSync(envFile, "export A=1", "utf8");

  const out = sessionStartHook(encode(validPayload(sessionId)), { CLAUDE_ENV_FILE: envFile });

  assert.equal(out, "{}");
  assert.equal(readFileSync(envFile, "utf8"), `export A=1\nexport ROCKY_AGENT_SESSION='${sessionId}'\n`);
});

test("sessionStartHook adds no extra blank line when existing CLAUDE_ENV_FILE ends in LF", (t) => {
  const root = makeSandbox(t);
  const envFile = join(root, "claude.env");
  const sessionId = "sess_with_trailing_lf-2";
  writeFileSync(envFile, "export A=1\n", "utf8");

  const out = sessionStartHook(encode(validPayload(sessionId)), { CLAUDE_ENV_FILE: envFile });

  assert.equal(out, "{}");
  assert.equal(readFileSync(envFile, "utf8"), `export A=1\nexport ROCKY_AGENT_SESSION='${sessionId}'\n`);
});

test("sessionStartHook adds no leading blank line when existing CLAUDE_ENV_FILE is empty", (t) => {
  const root = makeSandbox(t);
  const envFile = join(root, "claude.env");
  const sessionId = "sess_empty_file-3";
  writeFileSync(envFile, "", "utf8");

  const out = sessionStartHook(encode(validPayload(sessionId)), { CLAUDE_ENV_FILE: envFile });

  assert.equal(out, "{}");
  assert.equal(readFileSync(envFile, "utf8"), `export ROCKY_AGENT_SESSION='${sessionId}'\n`);
});

test("sessionStartHook rejects invalid session_id, wrong event, malformed JSON, and oversized stdin", (t) => {
  const oversized = (() => {
    const base = validPayload("sess-valid");
    const pad = " ".repeat(SESSION_START_STDIN_CAP_BYTES - Buffer.byteLength(base, "utf8") + 1);
    return Buffer.from(base + pad, "utf8");
  })();
  assert.equal(oversized.byteLength, SESSION_START_STDIN_CAP_BYTES + 1);

  const cases: ReadonlyArray<{ name: string; stdin: Uint8Array }> = [
    { name: "session_id with space", stdin: encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "a b" })) },
    { name: "session_id with single quote", stdin: encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "x'y" })) },
    { name: "session_id with newline", stdin: encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "a\nb" })) },
    { name: "session_id 129 chars", stdin: encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "a".repeat(129) })) },
    { name: "session_id is a number", stdin: encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: 12345 })) },
    { name: "hook_event_name is Stop", stdin: encode(JSON.stringify({ hook_event_name: "Stop", session_id: "valid-id" })) },
    { name: "malformed JSON", stdin: encode("{not valid json") },
    { name: "stdin exceeds cap", stdin: oversized },
  ];

  for (const entry of cases) {
    const root = makeSandbox(t);
    const existing = join(root, "existing.env");
    const initial = Buffer.from("export KEEP=1", "utf8");
    writeFileSync(existing, initial);
    const absent = join(root, "absent.env");

    assert.equal(sessionStartHook(entry.stdin, { CLAUDE_ENV_FILE: existing }), "{}", entry.name);
    assert.deepEqual(readFileSync(existing), initial, `${entry.name}: existing file must stay byte-identical`);

    assert.equal(sessionStartHook(entry.stdin, { CLAUDE_ENV_FILE: absent }), "{}", entry.name);
    assert.equal(existsSync(absent), false, `${entry.name}: absent file must stay absent`);
  }
});

test("sessionStartHook ignores unset, empty, relative, or control-char CLAUDE_ENV_FILE", (t) => {
  const root = makeSandbox(t);
  const valid = encode(validPayload("valid-session"));
  const badEnvs: ReadonlyArray<{ name: string; env: NodeJS.ProcessEnv }> = [
    { name: "unset", env: {} },
    { name: "empty", env: { CLAUDE_ENV_FILE: "" } },
    { name: "relative", env: { CLAUDE_ENV_FILE: "relative/env" } },
    { name: "newline control char", env: { CLAUDE_ENV_FILE: join(root, "bad\n.env") } },
    { name: "nul control char", env: { CLAUDE_ENV_FILE: join(root, "bad\0.env") } },
    { name: "tab control char", env: { CLAUDE_ENV_FILE: join(root, "bad\t.env") } },
  ];

  for (const entry of badEnvs) {
    assert.equal(sessionStartHook(valid, entry.env), "{}", entry.name);
  }
  assert.equal(existsSync(join(process.cwd(), "relative", "env")), false);
});

test("sessionStartHook returns {} without creating missing parent directories", (t) => {
  const root = makeSandbox(t);
  const missingParent = join(root, "does-not-exist");
  const envFile = join(missingParent, "claude.env");

  const out = sessionStartHook(encode(validPayload("valid-session")), { CLAUDE_ENV_FILE: envFile });

  assert.equal(out, "{}");
  assert.equal(existsSync(missingParent), false);
  assert.equal(existsSync(envFile), false);
});

test("process: rocky hook session-start claude-code writes env file and prints {}", (t) => {
  const root = makeSandbox(t);
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  const envFile = join(root, "claude.env");
  const sessionId = "0b6f1a2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c";

  const result = spawnHook(
    ["hook", "session-start", "claude-code"],
    validPayload(sessionId),
    { ROCKY_HOME: rockyHome, CLAUDE_ENV_FILE: envFile },
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.equal(readFileSync(envFile, "utf8"), `export ROCKY_AGENT_SESSION='${sessionId}'\n`);
});

test("process: rocky hook session-start claude-code prints {} and exits 0 on invalid JSON", (t) => {
  const root = makeSandbox(t);
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  const envFile = join(root, "claude.env");

  const result = spawnHook(
    ["hook", "session-start", "claude-code"],
    "not json",
    { ROCKY_HOME: rockyHome, CLAUDE_ENV_FILE: envFile },
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.equal(existsSync(envFile), false);
});

test("process: rocky hook session-start claude-code rejects stdin past cap and exits 0", (t) => {
  const root = makeSandbox(t);
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  const envFile = join(root, "claude.env");
  const base = validPayload("sess-oversized-proc");
  const oversized = base + " ".repeat(SESSION_START_STDIN_CAP_BYTES - Buffer.byteLength(base, "utf8") + 64);

  const result = spawnHook(
    ["hook", "session-start", "claude-code"],
    oversized,
    { ROCKY_HOME: rockyHome, CLAUDE_ENV_FILE: envFile },
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.equal(existsSync(envFile), false);
});

test("process: rocky hook session-start rejects unknown vendor and extra args with exit 2", (t) => {
  const root = makeSandbox(t);
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });

  for (const args of [
    ["hook", "session-start", "codex"],
    ["hook", "session-start"],
    ["hook", "session-start", "claude-code", "extra"],
  ] as const) {
    const result = spawnHook(args, "", { ROCKY_HOME: rockyHome }, root);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /usage: rocky hook /);
  }
});
