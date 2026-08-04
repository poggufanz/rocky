import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isEphemeralInstall,
  isIdenticalMcpRegistration,
  isOwnedRockyRegistration,
  resolveMcpRegistration,
} from "../setup/registration.js";
import { PROCESS_CAPTURE_LIMIT_BYTES, createProcessRunner } from "../setup/process.js";
import { createPlatformServices } from "../setup/platform.js";

function executableFixture(prefix = "rocky setup "): { root: string; nodePath: string; entryPath: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const nodePath = join(root, "Node runtime", "node executable");
  const entryPath = join(root, "Rocky package", "dist", "index.js");
  mkdirSync(dirname(nodePath), { recursive: true });
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(nodePath, "node", "utf8");
  writeFileSync(entryPath, "entry", "utf8");
  return { root, nodePath, entryPath };
}

test("canonical registration uses absolute Node entry and absent Rocky home", () => {
  const fixture = executableFixture();
  const rockyHome = join(fixture.root, "fresh home", ".rocky");
  const registration = resolveMcpRegistration({
    exposure: "raw",
    nodePath: fixture.nodePath,
    entryPath: fixture.entryPath,
    rockyHome,
  });

  assert.deepEqual(registration, {
    name: "rocky",
    command: fixture.nodePath,
    args: [fixture.entryPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "raw", ROCKY_HOME: rockyHome },
  });
  assert.equal(registration.env.ROCKY_MCP_EXPOSURE, "raw");
  assert.throws(() => mkdirSync(rockyHome), { code: "ENOENT" });
});

test("canonical registration derives the compiled dist entry by default", () => {
  const fixture = executableFixture();
  const rockyHome = join(fixture.root, ".rocky");
  const registration = resolveMcpRegistration({
    exposure: "sanitized",
    nodePath: process.execPath,
    rockyHome,
  });
  const compiledEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

  assert.equal(registration.command, process.execPath);
  assert.deepEqual(registration.args, [compiledEntry, "mcp"]);
  assert.equal(registration.env.ROCKY_HOME, rockyHome);
});

test("canonical registration rejects relative and missing executable paths", () => {
  const fixture = executableFixture();
  assert.throws(() => resolveMcpRegistration({
    exposure: "sanitized",
    nodePath: "bin/node",
    entryPath: fixture.entryPath,
    rockyHome: join(fixture.root, ".rocky"),
  }), /Node path must be absolute/);
  assert.throws(() => resolveMcpRegistration({
    exposure: "sanitized",
    nodePath: fixture.nodePath,
    entryPath: "dist/index.js",
    rockyHome: join(fixture.root, ".rocky"),
  }), /entry path must be absolute/);
  assert.throws(() => resolveMcpRegistration({
    exposure: "sanitized",
    nodePath: join(fixture.root, "missing-node"),
    entryPath: fixture.entryPath,
    rockyHome: join(fixture.root, ".rocky"),
  }), /Node path does not exist/);
  assert.throws(() => resolveMcpRegistration({
    exposure: "sanitized",
    nodePath: fixture.nodePath,
    entryPath: join(fixture.root, "missing-entry.js"),
    rockyHome: join(fixture.root, ".rocky"),
  }), /entry path does not exist/);
});

test("relative Rocky home resolves absolutely without being created", () => {
  const fixture = executableFixture();
  const registration = resolveMcpRegistration({
    exposure: "sanitized",
    nodePath: fixture.nodePath,
    entryPath: fixture.entryPath,
    rockyHome: "state/.rocky",
    cwd: fixture.root,
  });

  assert.equal(registration.env.ROCKY_HOME, join(fixture.root, "state", ".rocky"));
  assert.throws(() => mkdirSync(join(fixture.root, "state", ".rocky")), { code: "ENOENT" });
});

test("ephemeral install detection is path-decisive across Unix and Windows", () => {
  assert.equal(isEphemeralInstall("/home/ada/.npm/_npx/abc/node_modules/rocky-cli/dist/index.js", {}), true);
  assert.equal(isEphemeralInstall("C:\\Users\\Ada\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\rocky-cli\\dist\\index.js", {}), true);
  assert.equal(isEphemeralInstall("/home/ada/.npm/_cacache/tmp/rocky-cli/dist/index.js", {}), true);
  assert.equal(isEphemeralInstall("/opt/npm/lib/node_modules/rocky-cli/dist/index.js", { npm_command: "exec" }), false);
});

test("ownership accepts either lowercase exposure but protects command args and home", () => {
  const expected = {
    name: "rocky" as const,
    command: "/opt/node/bin/../bin/node",
    args: ["/opt/rocky/dist/index.js", "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
  };
  const storedRaw = {
    name: "rocky" as const,
    command: "/opt/node/bin/node",
    args: ["/opt/rocky/dist/index.js", "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "raw", ROCKY_HOME: "/home/ada/state/../.rocky", UNRELATED: "kept" },
  };

  assert.equal(isOwnedRockyRegistration(storedRaw, expected), true);
  assert.equal(isIdenticalMcpRegistration(storedRaw, expected), false);
  assert.equal(isOwnedRockyRegistration({ ...storedRaw, command: "/opt/other" }, expected), false);
  assert.equal(isOwnedRockyRegistration({ ...storedRaw, args: ["/opt/other.js", "mcp"] }, expected), false);
  assert.equal(isOwnedRockyRegistration({ ...storedRaw, env: { ...storedRaw.env, ROCKY_HOME: "/tmp/.rocky" } }, expected), false);
  assert.equal(isOwnedRockyRegistration({ ...storedRaw, env: { ...storedRaw.env, ROCKY_MCP_EXPOSURE: "RAW" } }, expected), false);
});

test("requested registration equality compares exposure and complete environment", () => {
  const expected = {
    name: "rocky" as const,
    command: "/opt/node",
    args: ["/opt/rocky/dist/index.js", "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
  };
  assert.equal(isIdenticalMcpRegistration({ ...expected, env: { ...expected.env } }, expected), true);
  assert.equal(isIdenticalMcpRegistration({ ...expected, env: { ...expected.env, ROCKY_MCP_EXPOSURE: "raw" } }, expected), false);
  assert.equal(isIdenticalMcpRegistration({ ...expected, env: { ...expected.env, EXTRA: "value" } }, expected), false);
});

test("process runner preserves exact argv and stdin without invoking a shell", async () => {
  const runner = createProcessRunner();
  const script = "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),input})))";
  const result = await runner.run(process.execPath, ["-e", script, "hello world", "$(echo compromised)"], {
    input: "line one\nline two",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    args: ["hello world", "$(echo compromised)"],
    input: "line one\nline two",
  });
});

test("process runner bounds both output streams", async () => {
  const runner = createProcessRunner();
  const result = await runner.run(process.execPath, [
    "-e",
    `process.stdout.write('o'.repeat(${PROCESS_CAPTURE_LIMIT_BYTES + 2048}));process.stderr.write('e'.repeat(${PROCESS_CAPTURE_LIMIT_BYTES + 2048}))`,
  ]);

  assert.equal(result.status, 0);
  assert.equal(Buffer.byteLength(result.stdout), PROCESS_CAPTURE_LIMIT_BYTES);
  assert.equal(Buffer.byteLength(result.stderr), PROCESS_CAPTURE_LIMIT_BYTES);
});

test("process runner aborts a timed-out child", async () => {
  const runner = createProcessRunner();
  const started = Date.now();
  const result = await runner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 });

  assert.equal(result.status, null);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /abort|timeout/i);
  assert.ok(Date.now() - started < 2_000);
});

test("native Windows executable discovery accepts exe and rejects cmd-only shims", () => {
  const directory = "C:\\Tools With Spaces";
  const executable = win32.join(directory, "codex.exe");
  const cmdShim = win32.join(directory, "claude.cmd");
  const files = new Set([executable, cmdShim]);
  const platform = createPlatformServices({
    platform: "win32",
    home: "C:\\Users\\Ada",
    appData: "C:\\Users\\Ada\\AppData\\Roaming",
    env: { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    fileExists: (path) => files.has(path),
    isWsl: false,
  });

  assert.equal(platform.resolveExecutable("codex"), executable);
  assert.equal(platform.resolveExecutable("claude"), undefined);
  assert.equal(platform.resolveExecutable("cmd.exe"), undefined);
});

test("Unix executable discovery uses injected PATH and file boundary", () => {
  const executable = "/opt/rocky tools/codex";
  const platform = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: ["/usr/bin", "/opt/rocky tools"].join(delimiter) },
    fileExists: (path) => path === executable,
    isWsl: false,
  });

  assert.equal(platform.resolveExecutable("codex"), executable);
  assert.equal(platform.resolveExecutable("missing"), undefined);
});
