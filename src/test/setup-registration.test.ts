import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("batch process runner forwards the requested environment and cwd", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "rocky-process-cwd-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runner = createProcessRunner();
  const script = "console.log(JSON.stringify({cwd:process.cwd(),marker:process.env.ROCKY_RUN_MARKER,leaked:process.env.ROCKY_PARENT_ONLY}))";
  const previous = process.env.ROCKY_PARENT_ONLY;
  process.env.ROCKY_PARENT_ONLY = "must-not-merge";
  try {
    const result = await runner.run(process.execPath, ["-e", script], {
      cwd,
      env: { ROCKY_RUN_MARKER: "forwarded" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      cwd,
      marker: "forwarded",
    });
  } finally {
    if (previous === undefined) delete process.env.ROCKY_PARENT_ONLY;
    else process.env.ROCKY_PARENT_ONLY = previous;
  }
});

test("real batch runner distinguishes spawn failure from a nonzero child exit", async () => {
  const runner = createProcessRunner();
  const spawnFailure = await runner.run(
    join(tmpdir(), "rocky-definitely-missing-executable"),
    [],
  );
  const nonzero = await runner.run(process.execPath, [
    "-e",
    "process.stderr.write('classified-nonzero');process.exit(7)",
  ]);

  assert.equal(spawnFailure.status, null);
  assert.ok(spawnFailure.error instanceof Error);
  assert.equal(nonzero.status, 7);
  assert.equal(nonzero.error, undefined);
  assert.equal(nonzero.stderr, "classified-nonzero");
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

test("interactive process session exchanges one JSON line at a time and merges environment overrides", async () => {
  const runner = createProcessRunner();
  assert.ok(runner.openSession !== undefined);
  const script = [
    "process.stdin.setEncoding('utf8');",
    "let input = '';",
    "process.stdin.on('data', chunk => {",
    "  input += chunk;",
    "  while (input.includes('\\n')) {",
    "    const index = input.indexOf('\\n');",
    "    const line = input.slice(0, index);",
    "    input = input.slice(index + 1);",
    "    const message = JSON.parse(line);",
    "    process.stdout.write(JSON.stringify({ id: message.id, marker: process.env.ROCKY_TEST_MARKER }) + '\\n');",
    "  }",
    "});",
  ].join("");
  const session = await runner.openSession(process.execPath, ["-e", script], {
    env: { ROCKY_TEST_MARKER: "merged" },
  });

  await session.writeLine(JSON.stringify({ id: "first" }));
  assert.deepEqual(JSON.parse((await session.readLine()) ?? "null"), { id: "first", marker: "merged" });
  await session.writeLine(JSON.stringify({ id: "second" }));
  assert.deepEqual(JSON.parse((await session.readLine()) ?? "null"), { id: "second", marker: "merged" });
  session.end();
  const result = await session.wait();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("interactive process session rejects an oversized unterminated stdout line and kills only its child", async () => {
  const runner = createProcessRunner(128);
  assert.ok(runner.openSession !== undefined);
  const session = await runner.openSession(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(1024));setInterval(() => {}, 1000)",
  ]);

  await assert.rejects(() => session.readLine(), /exceeds capture limit/i);
  session.kill();
  const result = await session.wait();

  assert.equal(result.status === null || result.status > 0, true);
});

test("interactive process session bounds a final unterminated queued line", async () => {
  const runner = createProcessRunner(1024);
  assert.ok(runner.openSession !== undefined);
  const script = "process.stdout.write(Array(64).fill('x').join('\\n') + '\\ntail')";
  const session = await runner.openSession(process.execPath, ["-e", script]);

  await session.wait();

  await assert.rejects(() => session.readLine(), /exceeds capture limit/i);
  assert.equal(await session.readLine(), undefined);
});

test("interactive process session handles child stdin EPIPE without an uncaught stream error", async () => {
  const runner = createProcessRunner();
  assert.ok(runner.openSession !== undefined);
  const script = [
    "import('node:fs').then(({closeSync}) => {",
    "  closeSync(0);",
    "  process.stdout.write('ready\\n');",
    "});",
    "setInterval(() => {}, 1000);",
  ].join("");
  const session = await runner.openSession(process.execPath, ["-e", script]);

  assert.equal(await session.readLine(), "ready");
  let writeError: unknown;
  try {
    await session.writeLine("probe");
  } catch (error) {
    writeError = error;
  } finally {
    session.kill();
    await session.wait();
  }
  assert.ok(writeError instanceof Error);
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

test("WSL detection is automatic from injected runtime environment", () => {
  const distro = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "", WSL_DISTRO_NAME: "Ubuntu-24.04" },
    fileExists: () => false,
  });
  const interop = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "", WSL_INTEROP: "/run/WSL/interop" },
    fileExists: () => false,
  });
  const nonLinux = createPlatformServices({
    platform: "darwin",
    home: "/Users/Ada",
    env: { PATH: "", WSL_DISTRO_NAME: "not-wsl" },
    fileExists: () => false,
  });

  assert.equal(distro.isWsl, true);
  assert.equal(distro.wslDistro, "Ubuntu-24.04");
  assert.equal(interop.isWsl, true);
  assert.equal(nonLinux.isWsl, false);
});
