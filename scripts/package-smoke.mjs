import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "@poggufanz/rocky-cli";
const PACKAGE_VERSION = "0.2.1-beta.0";
const PACKAGE_BINARY = "rocky";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const keepTemp = process.argv.slice(2).includes("--keep-temp");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--keep-temp");
assert.deepEqual(unknownArguments, [], `unknown arguments: ${unknownArguments.join(", ")}`);

const temporaryRoots = [];

function temporaryDirectory(label) {
  const path = mkdtempSync(join(tmpdir(), label));
  temporaryRoots.push(path);
  return path;
}

function resolveNpmExecutable() {
  const names = process.platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"];
  const candidates = [
    ...names.map((name) => join(dirname(process.execPath), name)),
    ...(process.env.PATH ?? "").split(delimiter).flatMap((directory) =>
      directory === "" ? [] : names.map((name) => join(directory, name))),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return resolve(candidate);
    } catch {
      // Continue through the bounded PATH candidates.
    }
  }
  throw new Error("npm executable is unavailable");
}

function childResult(file, args, options) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 20_000,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function diagnostics(result) {
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function assertSuccess(result, label) {
  assert.equal(result.status, 0, `${label} failed: ${diagnostics(result)}`);
  assert.equal(result.signal, null, `${label} received signal: ${diagnostics(result)}`);
}

function parseSinglePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed), "npm pack JSON must be an array");
  assert.equal(parsed.length, 1, "npm pack must produce exactly one package");
  return parsed[0];
}

function allowedPackPath(path) {
  return path === "LICENSE"
    || path === "README.md"
    || path === "package.json"
    || path === "dist/index.js"
    || path.startsWith("dist/commands/")
    || path.startsWith("dist/core/")
    || path.startsWith("dist/ui/")
    || path.startsWith("dist/mcp/")
    || path.startsWith("dist/setup/")
    || path.startsWith("dist/ai/")
    || path.startsWith("dist/shell/")
    || path === "skills/rocky-voice/SKILL.md"
    || path === "skills/rocky-voice/agents/openai.yaml";
}

function assertPackResult(packed) {
  assert.equal(packed.name, PACKAGE_NAME);
  assert.equal(packed.version, PACKAGE_VERSION);
  assert.equal(typeof packed.filename, "string");
  assert.ok(Number.isFinite(packed.size) && packed.size < 1_000_000, `tarball is ${packed.size} bytes`);
  assert.ok(Number.isFinite(packed.unpackedSize) && packed.unpackedSize > 0);
  assert.ok(Array.isArray(packed.files) && packed.files.length > 0);
  const paths = packed.files.map((file) => file.path).sort();
  for (const path of paths) {
    assert.equal(allowedPackPath(path), true, `unexpected packed path: ${path}`);
    const normalized = path.replaceAll("\\", "/");
    assert.doesNotMatch(
      normalized,
      /(^|\/)test(\/|$)|\.test\.|(^|\/)src(\/|$)|fixture|cache|validation|\.rocky-managed\.json/i,
    );
    if (normalized !== "dist/commands/model.js") assert.doesNotMatch(normalized, /model|weight/i);
  }
  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/index.js",
    "skills/rocky-voice/SKILL.md",
    "skills/rocky-voice/agents/openai.yaml",
  ]) {
    assert.ok(paths.includes(required), `missing packed path: ${required}`);
  }
  assert.ok(paths.some((path) => path.startsWith("dist/mcp/")), "MCP modules are missing");
  return paths;
}

function snapshotTree(root) {
  const snapshot = [];
  const visit = (path) => {
    const stat = lstatSync(path, { bigint: true });
    const type = stat.isDirectory()
      ? "directory"
      : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
    snapshot.push({
      path: relative(root, path).replaceAll("\\", "/") || ".",
      type,
      mode: Number(stat.mode),
      mtimeNs: stat.mtimeNs.toString(),
      bytes: type === "file"
        ? readFileSync(path).toString("base64")
        : type === "symlink" ? Buffer.from(readlinkSync(path), "utf8").toString("base64") : "",
    });
    if (type === "directory") {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    }
  };
  visit(root);
  return snapshot;
}

function assertStateUnchanged(root, label, work) {
  const before = snapshotTree(root);
  const result = work();
  assert.deepEqual(snapshotTree(root), before, `${label} mutated ROCKY_HOME`);
  return result;
}

function jsonLines(result, label) {
  assertSuccess(result, label);
  assert.equal(result.stderr, "", `${label} wrote diagnostics: ${result.stderr}`);
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function createFakeClients(directory, stateRoot, quoteShellPath) {
  const script = join(directory, "fake-client.mjs");
  writeFileSync(script, String.raw`import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [kind, ...args] = process.argv.slice(2);
const stateRoot = process.env.ROCKY_FAKE_CLIENT_STATE;
if (stateRoot === undefined) throw new Error("missing fake-client state");
mkdirSync(stateRoot, { recursive: true });

function registration(values) {
  let index = 2;
  const env = {};
  while (values[index]?.startsWith("--")) {
    const option = values[index];
    if (option === "--env") {
      const pair = values[index + 1] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) throw new Error("invalid fake-client environment");
      env[pair.slice(0, separator)] = pair.slice(separator + 1);
      index += 2;
      continue;
    }
    if (option === "--scope" || option === "--transport") {
      index += 2;
      continue;
    }
    throw new Error("unexpected fake-client option: " + option);
  }
  const name = values[index];
  index += 1;
  if (name !== "rocky" || values[index] !== "--") throw new Error("invalid fake-client registration");
  index += 1;
  const command = values[index];
  index += 1;
  if (command === undefined) throw new Error("missing fake-client command");
  return { name, command, args: values.slice(index), env };
}

function codexSnapshot(value) {
  return {
    name: "rocky",
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "stdio",
      command: value.command,
      args: value.args,
      env: value.env,
      env_vars: [],
      cwd: null,
    },
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null,
  };
}

function readObject(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

if (kind === "codex") {
  const path = join(stateRoot, "codex.json");
  if (args[0] === "mcp" && args[1] === "get") {
    if (!existsSync(path)) {
      process.stderr.write("No MCP server named 'rocky' found\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(readFileSync(path, "utf8"));
    }
  } else if (args[0] === "mcp" && args[1] === "add") {
    writeFileSync(path, JSON.stringify(codexSnapshot(registration(args))) + "\n", "utf8");
  } else if (args[0] === "mcp" && args[1] === "remove") {
    rmSync(path, { force: true });
  } else {
    throw new Error("unexpected fake Codex command: " + JSON.stringify(args));
  }
} else if (kind === "claude") {
  const path = join(process.env.HOME, ".claude.json");
  if (args[0] === "mcp" && args[1] === "add") {
    const value = registration(args);
    const config = readObject(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...config,
      mcpServers: {
        ...(config.mcpServers ?? {}),
        rocky: { type: "stdio", command: value.command, args: value.args, env: value.env },
      },
    }) + "\n", "utf8");
  } else if (args[0] === "mcp" && args[1] === "remove") {
    const config = readObject(path);
    const servers = { ...(config.mcpServers ?? {}) };
    delete servers.rocky;
    writeFileSync(path, JSON.stringify({ ...config, mcpServers: servers }) + "\n", "utf8");
  } else {
    throw new Error("unexpected fake Claude command: " + JSON.stringify(args));
  }
} else {
  throw new Error("unexpected fake-client kind: " + kind);
}
`, "utf8");

  if (process.platform === "win32") {
    for (const kind of ["codex", "claude"]) {
      const wrapper = join(directory, `${kind}.cmd`);
      writeFileSync(
        wrapper,
        `@echo off\r\n${quoteShellPath(process.execPath, "win32")} ${quoteShellPath(script, "win32")} ${kind} %*\r\n`,
        "utf8",
      );
    }
    return;
  }

  for (const kind of ["codex", "claude"]) {
    const wrapper = join(directory, kind);
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${quoteShellPath(process.execPath, process.platform)} ${quoteShellPath(script, process.platform)} ${kind} "$@"\n`,
      "utf8",
    );
    chmodSync(wrapper, 0o755);
  }
}

function nativeLinux() {
  if (process.platform !== "linux") return false;
  try {
    return !/microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return true;
  }
}

async function main() {
  const packDirectory = temporaryDirectory("rocky-package-pack-");
  const cacheDirectory = temporaryDirectory("rocky-package-cache-");
  const prefixDirectory = temporaryDirectory("rocky-package-prefix-");
  const rockyHome = temporaryDirectory("rocky-package-home-");
  const isolatedHome = temporaryDirectory("rocky-package-user-");
  const fakeClientDirectory = temporaryDirectory("rocky-package-clients-");
  const fakeClientState = temporaryDirectory("rocky-package-client-state-");
  const npm = resolveNpmExecutable();

  const npmrc = join(isolatedHome, "empty-npmrc");
  const globalNpmrc = join(isolatedHome, "empty-global-npmrc");
  const appData = join(isolatedHome, "app-data");
  const claudeConfig = join(isolatedHome, "claude-config");
  const codexHome = join(isolatedHome, "codex-home");
  const xdgConfig = join(isolatedHome, "xdg-config");
  for (const directory of [appData, claudeConfig, codexHome, xdgConfig]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(npmrc, "", "utf8");
  writeFileSync(globalNpmrc, "", "utf8");
  writeFileSync(join(isolatedHome, ".bashrc"), "# package-smoke isolated home\n", "utf8");

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || /^(?:npm_token|node_auth_token)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: appData,
    LOCALAPPDATA: appData,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: codexHome,
    ROCKY_HOME: rockyHome,
    ROCKY_FAKE_CLIENT_STATE: fakeClientState,
    XDG_CONFIG_HOME: xdgConfig,
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    NPM_CONFIG_CACHE: cacheDirectory,
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_SCRIPT_SHELL: process.platform === "win32"
      ? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
      : "/bin/sh",
    NODE_OPTIONS: "",
    PATH: [fakeClientDirectory, dirname(process.execPath)].join(delimiter),
  });
  env.Path = env.PATH;
  delete env.NODE_TEST_CONTEXT;
  delete env.WSL_DISTRO_NAME;
  delete env.WSL_INTEROP;
  delete env.ROCKY_WSL_CLAUDE_CONFIG;

  const pack = childResult(npm, [
    "pack",
    "--json",
    "--pack-destination",
    packDirectory,
  ], { env, timeout: 120_000 });
  assertSuccess(pack, "npm pack");
  const packed = parseSinglePackResult(pack.stdout);
  const packedPaths = assertPackResult(packed);
  const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
  assert.deepEqual(tarballs, [packed.filename]);
  const tarball = join(packDirectory, packed.filename);
  assert.equal(existsSync(tarball), true, "packed tarball is missing");

  const install = childResult(npm, [
    "install",
    "--global",
    "--prefix",
    prefixDirectory,
    tarball,
    "--ignore-scripts",
    "--offline",
    "--no-audit",
    "--no-fund",
    "--cache",
    cacheDirectory,
  ], { env, timeout: 120_000 });
  assertSuccess(install, "offline tarball install");

  const installedRoot = process.platform === "win32"
    ? join(prefixDirectory, "node_modules", "@poggufanz", "rocky-cli")
    : join(prefixDirectory, "lib", "node_modules", "@poggufanz", "rocky-cli");
  const installedEntry = join(installedRoot, "dist", "index.js");
  const installedQuoteModule = join(installedRoot, "dist", "core", "shell-quote.js");
  const shim = process.platform === "win32"
    ? join(prefixDirectory, "rocky.cmd")
    : join(prefixDirectory, "bin", "rocky");
  for (const path of [installedEntry, installedQuoteModule, shim]) {
    assert.equal(existsSync(path), true, `installed path is missing: ${path}`);
  }
  const installedMetadata = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedMetadata.name, PACKAGE_NAME);
  assert.equal(installedMetadata.version, PACKAGE_VERSION);
  assert.deepEqual(installedMetadata.bin, { [PACKAGE_BINARY]: "./dist/index.js" });
  assert.deepEqual(installedMetadata.dependencies ?? {}, {});
  assert.deepEqual(installedMetadata.optionalDependencies ?? {}, {});

  const quoteModule = await import(pathToFileURL(installedQuoteModule).href);
  const quoteShellPath = quoteModule.quoteShellPath;
  assert.equal(typeof quoteShellPath, "function");
  assert.equal(quoteShellPath("/tmp/rocky's path", "linux"), "'/tmp/rocky'\\''s path'");
  assert.equal(
    quoteShellPath("C:\\Program Files\\Rocky\\rocky.js", "win32"),
    '"C:\\Program Files\\Rocky\\rocky.js"',
  );
  for (const unsafe of ['"', "\r", "\n", "\0", "%", "!"]) {
    assert.throws(() => quoteShellPath(`C:\\Rocky\\${unsafe}`, "win32"), /unsafe/i);
  }

  createFakeClients(fakeClientDirectory, fakeClientState, quoteShellPath);

  const shimHelp = childResult(shim, ["--help"], { env });
  const entryHelp = childResult(process.execPath, [installedEntry, "--help"], { env });
  assertSuccess(shimHelp, "installed shim --help");
  assertSuccess(entryHelp, "installed entry --help");
  assert.equal(shimHelp.stdout, entryHelp.stdout);
  assert.equal(shimHelp.stderr, entryHelp.stderr);

  const failingChild = join(packDirectory, "rocky's distinctive failing child.mjs");
  const distinctiveFailure = "ROCKY_PACKAGE_SMOKE_DISTINCTIVE_FAILURE";
  writeFileSync(
    failingChild,
    `process.stderr.write(${JSON.stringify(`${distinctiveFailure}\n`)});\nprocess.exit(7);\n`,
    "utf8",
  );
  const shellCommand = [
    quoteShellPath(process.execPath, process.platform),
    quoteShellPath(failingChild, process.platform),
  ].join(" ");
  const failedRun = childResult(
    process.execPath,
    [installedEntry, "run", shellCommand],
    { env, cwd: isolatedHome },
  );
  assert.equal(failedRun.status, 7, diagnostics(failedRun));
  assert.match(failedRun.stderr, new RegExp(distinctiveFailure));
  assert.equal(existsSync(join(rockyHome, "memory.jsonl")), true);
  assert.equal(existsSync(join(rockyHome, "pending")), true);

  writeFileSync(join(rockyHome, "config.json"), '{"version":1,"ai":{"enabled":false}}\n', "utf8");
  writeFileSync(join(rockyHome, "guard.rules"), "^never-run\\tpackage smoke sentinel\n", "utf8");
  mkdirSync(join(rockyHome, "nested", "sentinels"), { recursive: true });
  writeFileSync(join(rockyHome, "nested", "sentinels", "unrelated.bin"), Buffer.from([0, 1, 2, 255]));

  const recall = childResult(
    process.execPath,
    [installedEntry, "recall", "distinctive", "failure"],
    { env },
  );
  assertSuccess(recall, "installed recall");
  assert.match(`${recall.stdout}\n${recall.stderr}`, new RegExp(distinctiveFailure));

  const stats = childResult(process.execPath, [installedEntry, "stats"], { env });
  assertSuccess(stats, "installed stats");
  assert.match(`${stats.stdout}\n${stats.stderr}`, /I remember 1 error/);

  const hookStatus = childResult(process.execPath, [installedEntry, "hook", "status"], { env });
  assertSuccess(hookStatus, "installed hook status");
  assert.match(`${hookStatus.stdout}\n${hookStatus.stderr}`, /ears not installed/);

  const networkGuard = join(packDirectory, "forbid-network.cjs");
  writeFileSync(
    networkGuard,
    'globalThis.fetch = () => { throw new Error("package smoke forbids network"); };\n',
    "utf8",
  );
  const aiRecall = childResult(
    process.execPath,
    ["--require", networkGuard, installedEntry, "recall", "--ai", "distinctive", "failure"],
    { env },
  );
  assertSuccess(aiRecall, "installed no-Ollama recall --ai");
  assert.match(`${aiRecall.stdout}\n${aiRecall.stderr}`, /small model sleeps\. memory still works\./);

  const modernRequest = {
    jsonrpc: "2.0",
    id: "package-smoke-modern",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "package-smoke", version: "1.0.0" },
      },
    },
  };
  const modern = assertStateUnchanged(rockyHome, "modern MCP", () => childResult(
    process.execPath,
    [installedEntry, "mcp"],
    { env, input: `${JSON.stringify(modernRequest)}\n` },
  ));
  const modernResponses = jsonLines(modern, "installed modern MCP");
  assert.equal(modernResponses.length, 1);
  assert.deepEqual(modernResponses[0].result._meta["io.modelcontextprotocol/serverInfo"], {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });

  const legacyInput = [
    {
      jsonrpc: "2.0",
      id: "package-smoke-legacy-init",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "package-smoke", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: "package-smoke-legacy-ping", method: "ping", params: {} },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const legacy = assertStateUnchanged(rockyHome, "legacy MCP", () => childResult(
    process.execPath,
    [installedEntry, "mcp"],
    { env, input: legacyInput },
  ));
  const legacyResponses = jsonLines(legacy, "installed legacy MCP");
  assert.equal(legacyResponses.length, 2);
  assert.deepEqual(legacyResponses[0].result.serverInfo, {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });
  assert.deepEqual(legacyResponses[1].result, {});

  if (nativeLinux()) {
    const configured = childResult(
      process.execPath,
      [installedEntry, "setup", "--yes", "--voice-skill"],
      { env },
    );
    assertSuccess(configured, "fake-client setup configure");
    assert.match(configured.stderr, /voice-skill codex: installed/);
    assert.match(configured.stderr, /voice-skill claude-code: installed/);
    for (const markerPath of [
      join(isolatedHome, ".agents", "skills", "rocky-voice", ".rocky-managed.json"),
      join(claudeConfig, "skills", "rocky-voice", ".rocky-managed.json"),
    ]) {
      assert.equal(JSON.parse(readFileSync(markerPath, "utf8")).packageName, PACKAGE_NAME);
    }

    const checked = assertStateUnchanged(rockyHome, "fake-client setup check MCP", () => childResult(
      process.execPath,
      [installedEntry, "setup", "--check", "--voice-skill"],
      { env, timeout: 30_000 },
    ));
    assertSuccess(checked, "fake-client setup check");
    assert.match(checked.stderr, /voice-skill codex: unchanged/);
    assert.match(checked.stderr, /voice-skill claude-code: unchanged/);

    const removed = childResult(
      process.execPath,
      [installedEntry, "setup", "--remove", "--yes", "--voice-skill"],
      { env },
    );
    assertSuccess(removed, "fake-client setup remove");
    assert.match(removed.stderr, /voice-skill codex: removed/);
    assert.match(removed.stderr, /voice-skill claude-code: removed/);
    assert.equal(existsSync(join(isolatedHome, ".agents", "skills", "rocky-voice")), false);
    assert.equal(existsSync(join(claudeConfig, "skills", "rocky-voice")), false);
  } else {
    const voiceModule = await import(pathToFileURL(join(installedRoot, "dist", "setup", "voice-skill.js")).href);
    const target = {
      host: "codex",
      destination: join(isolatedHome, ".agents", "skills", "rocky-voice"),
      backupRoot: join(isolatedHome, ".agents", ".rocky", "backups", "voice-skills"),
    };
    assert.equal((await voiceModule.installVoiceSkill(target, { replace: false })).status, "installed");
    assert.equal((await voiceModule.checkVoiceSkill(target)).status, "unchanged");
    assert.equal((await voiceModule.removeVoiceSkill(target)).status, "removed");
  }

  process.stdout.write([
    "package smoke passed",
    `package: ${packed.name}@${packed.version}`,
    `tarball: ${packed.filename}`,
    `size: ${packed.size} bytes`,
    `unpackedSize: ${packed.unpackedSize} bytes`,
    `files: ${packedPaths.length}`,
    ...packedPaths.map((path) => `  ${path}`),
  ].join("\n") + "\n");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (keepTemp) {
    for (const path of temporaryRoots) process.stderr.write(`kept temp: ${path}\n`);
  } else {
    for (const path of [...temporaryRoots].reverse()) rmSync(path, { recursive: true, force: true });
  }
}
