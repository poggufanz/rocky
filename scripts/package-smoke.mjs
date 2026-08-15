import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  copyFileSync,
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
import {
  commandInvocation,
  fakeClientLaunchers,
  nodeOptionsRequire,
  shouldRunInstalledSetup,
} from "./package-smoke-support.mjs";

const PACKAGE_NAME = "@poggufanz/rocky-cli";
const PACKAGE_BINARY = "rocky";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Read from the manifest rather than pinning a literal: this script only runs
// in CI, so a stale copy here survives every local gate and fails the release
// build instead — which is exactly what it did on the 0.4.0 bump.
const PACKAGE_VERSION = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
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
  const commandProcessor = options.env?.ComSpec ?? options.env?.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
  const invocation = commandInvocation(
    file,
    args,
    process.platform,
    commandProcessor,
  );
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 20_000,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: process.platform === "win32" && invocation.file === commandProcessor,
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

function assertStatus(result, expectedStatus, label) {
  assert.equal(result.status, expectedStatus, `${label}: ${diagnostics(result)}`);
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
    || path === "CHANGELOG.md"
    || path === "package.json"
    || path === "dist/index.js"
    || path.startsWith("dist/commands/")
    || path.startsWith("dist/check/")
    || path.startsWith("dist/core/")
    || path.startsWith("dist/ui/")
    || path.startsWith("dist/mcp/")
    || path.startsWith("dist/setup/")
    || path.startsWith("dist/ai/")
    || path.startsWith("dist/agent/")
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
    "CHANGELOG.md",
    "package.json",
    "dist/index.js",
    "dist/agent/schema.js",
    "skills/rocky-voice/SKILL.md",
    "skills/rocky-voice/agents/openai.yaml",
  ]) {
    assert.ok(paths.includes(required), `missing packed path: ${required}`);
  }
  assert.ok(paths.some((path) => path.startsWith("dist/mcp/")), "MCP modules are missing");
  assert.ok(paths.some((path) => path.startsWith("dist/agent/")), "agent modules are missing");
  return paths;
}

function assertLfShellAssets(root, label) {
  const shellRoot = join(root, "dist", "shell");
  const assets = readdirSync(shellRoot).filter((name) => name.endsWith(".bash") || name.endsWith(".sh")).sort();
  assert.ok(assets.length > 0, `${label} has no shell assets`);
  for (const name of assets) {
    assert.equal(readFileSync(join(shellRoot, name)).includes(13), false, `${label}/${name} contains CR bytes`);
  }
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

function installedSetupWithConsent(installedEntry, options) {
  // The production prompt intentionally refuses piped stdin unless it is a
  // TTY. For deterministic tarball dogfood, this tiny Node-only runner marks
  // its pipe as the consenting terminal, then imports the installed entry.
  // There is no shell or command-string interpolation here.
  const entryUrl = pathToFileURL(installedEntry).href;
  const runner = [
    "Object.defineProperty(process.stdin, \"isTTY\", { value: true });",
    `process.argv = [process.execPath, ${JSON.stringify(installedEntry)}, "setup", "--agent-hooks"];`,
    `await import(${JSON.stringify(entryUrl)});`,
  ].join("\n");
  return childResult(process.execPath, ["--input-type=module", "-e", runner], options);
}

function waitBriefly() {
  // Keep the installed-artifact poll synchronous and shell-free on Node 18.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}

function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    waitBriefly();
  }
  assert.equal(predicate(), true, "timed out waiting for installed detached annotation");
}

function createFakeClients(directory, quoteShellPath) {
  const script = join(directory, "fake-client.cjs");
  writeFileSync(script, String.raw`"use strict";

const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

function registration(kind, values) {
  let index = 2;
  const env = {};

  if (kind === "claude") {
    const prefix = ["--scope", "user", "--transport", "stdio", "rocky"];
    if (!prefix.every((value, offset) => values[index + offset] === value)) {
      throw new Error("invalid fake Claude registration prefix");
    }
    index += prefix.length;
  } else if (kind !== "codex") {
    throw new Error("unexpected fake-client kind: " + kind);
  }

  while (values[index] === "--env") {
    const pair = values[index + 1] ?? "";
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("invalid fake-client environment");
    env[pair.slice(0, separator)] = pair.slice(separator + 1);
    index += 2;
  }

  if (kind === "codex") {
    if (values[index] !== "rocky") throw new Error("invalid fake Codex registration name");
    index += 1;
  }
  if (values[index] !== "--") throw new Error("invalid fake-client command delimiter");
  index += 1;
  const command = values[index];
  index += 1;
  if (command === undefined) throw new Error("missing fake-client command");
  return { name: "rocky", command, args: values.slice(index), env };
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

function runFakeClient(kind, args) {
  const stateRoot = process.env.ROCKY_FAKE_CLIENT_STATE;
  if (stateRoot === undefined) throw new Error("missing fake-client state");
  mkdirSync(stateRoot, { recursive: true });
  if (kind === "codex") {
    const path = join(stateRoot, "codex.json");
    if (args[0] === "mcp" && args[1] === "get") {
      if (!existsSync(path)) {
        process.stderr.write("No MCP server named 'rocky' found\n");
        return 1;
      }
      process.stdout.write(readFileSync(path, "utf8"));
    } else if (args[0] === "mcp" && args[1] === "add") {
      writeFileSync(path, JSON.stringify(codexSnapshot(registration("codex", args))) + "\n", "utf8");
    } else if (args[0] === "mcp" && args[1] === "remove") {
      rmSync(path, { force: true });
    } else {
      throw new Error("unexpected fake Codex command: " + JSON.stringify(args));
    }
    return 0;
  }
  if (kind === "claude") {
    const path = join(process.env.HOME, ".claude.json");
    if (args[0] === "mcp" && args[1] === "add") {
      const value = registration("claude", args);
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
    return 0;
  }
  throw new Error("unexpected fake-client kind: " + kind);
}

module.exports = { runFakeClient };
if (require.main === module) {
  const [kind, ...args] = process.argv.slice(2);
  process.exitCode = runFakeClient(kind, args);
}
`, "utf8");

  for (const launcher of fakeClientLaunchers(process.platform, directory)) {
    if (launcher.type === "copy-node") {
      copyFileSync(process.execPath, launcher.path);
      continue;
    }
    writeFileSync(
      launcher.path,
      `#!/bin/sh\nexec ${quoteShellPath(process.execPath, process.platform)} ${quoteShellPath(script, process.platform)} ${launcher.kind} "$@"\n`,
      "utf8",
    );
    chmodSync(launcher.path, 0o755);
  }
  return script;
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
  const preload = join(packageRoot, "scripts", "package-smoke-preload.cjs");
  const fakeClientScript = join(fakeClientDirectory, "fake-client.cjs");

  const npmrc = join(isolatedHome, "empty-npmrc");
  const globalNpmrc = join(isolatedHome, "empty-global-npmrc");
  const appData = join(isolatedHome, "app-data");
  const claudeConfig = join(isolatedHome, "claude-config");
  const codexHome = join(isolatedHome, "codex-home");
  const xdgConfig = join(isolatedHome, "xdg-config");
  const wslClaudeConfig = join(isolatedHome, "wsl-claude-desktop-config.json");
  for (const directory of [appData, claudeConfig, codexHome, xdgConfig]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(npmrc, "", "utf8");
  writeFileSync(globalNpmrc, "", "utf8");
  writeFileSync(join(isolatedHome, ".bashrc"), "# package-smoke isolated home\n", "utf8");
  writeFileSync(wslClaudeConfig, "{}\n", "utf8");
  assert.equal(existsSync(preload), true, `package-smoke preload is missing: ${preload}`);

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
    ROCKY_PACKAGE_SMOKE_FAKE_CLIENT: fakeClientScript,
    ROCKY_PACKAGE_SMOKE_HERMETIC: "1",
    ROCKY_PACKAGE_SMOKE_NODE: process.execPath,
    ROCKY_WSL_CLAUDE_CONFIG: wslClaudeConfig,
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
    NODE_OPTIONS: nodeOptionsRequire(preload, process.platform),
    PATH: [fakeClientDirectory, dirname(process.execPath)].join(delimiter),
  });
  env.Path = env.PATH;
  delete env.NODE_TEST_CONTEXT;

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
  const installedAgentSchema = join(installedRoot, "dist", "agent", "schema.js");
  const shim = process.platform === "win32"
    ? join(prefixDirectory, "rocky.cmd")
    : join(prefixDirectory, "bin", "rocky");
  for (const path of [installedEntry, installedQuoteModule, installedAgentSchema, shim]) {
    assert.equal(existsSync(path), true, `installed path is missing: ${path}`);
  }
  assertLfShellAssets(installedRoot, "installed package");
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

  const agentSchema = await import(pathToFileURL(installedAgentSchema).href);
  const importedIntent = agentSchema.parseAgentEvent({
    v: 1,
    agent: "claude-code",
    kind: "intent",
    ts: 1,
    text: "installed agent import",
  });
  assert.equal(importedIntent?.kind, "intent");

  assert.equal(createFakeClients(fakeClientDirectory, quoteShellPath), fakeClientScript);

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

  // Installed tarball dogfood: replay one Claude turn through the real CLI.
  // Each hook has a strict stdout contract; Stop launches detached annotation,
  // so poll only the isolated scratch home until the durable triple appears.
  const memoryPath = join(rockyHome, "memory.jsonl");
  const spoolPath = join(rockyHome, "spool");
  const labelsPath = join(rockyHome, "labels");
  const spoolEntries = () => {
    try {
      return readdirSync(spoolPath);
    } catch {
      return [];
    }
  };

  // Current documented Claude hook payloads do not provide prompt_id. Rocky
  // must fail closed for capture rather than joining unrelated turns.
  const noIdentityMemory = readFileSync(memoryPath);
  const noIdentitySpool = spoolEntries();
  const noIdentityLabels = existsSync(labelsPath) ? readFileSync(labelsPath) : undefined;
  const documentedClaudePayload = {
    session_id: "documented-claude-session",
    hook_event_name: "UserPromptSubmit",
    cwd: isolatedHome,
    transcript_path: join(isolatedHome, "transcript.jsonl"),
    permission_mode: "default",
    prompt: "documented payload without turn identity",
  };
  const noIdentityHook = childResult(
    process.execPath,
    [installedEntry, "hook", "agent-event", "claude-code"],
    { env, cwd: isolatedHome, input: `${JSON.stringify(documentedClaudePayload)}\n` },
  );
  assertStatus(noIdentityHook, 0, "installed Claude hook without prompt_id");
  assert.equal(noIdentityHook.stdout, "{}", "Claude missing prompt_id stdout contract");
  assert.equal(noIdentityHook.stderr, "", "Claude missing prompt_id stderr");
  assert.deepEqual(readFileSync(memoryPath), noIdentityMemory, "missing prompt_id must not write a triple");
  assert.deepEqual(spoolEntries(), noIdentitySpool, "missing prompt_id must not create a spool batch");
  assert.deepEqual(
    existsSync(labelsPath) ? readFileSync(labelsPath) : undefined,
    noIdentityLabels,
    "missing prompt_id must not queue a label",
  );

  const hookSecret = "ghp_" + "a".repeat(36);
  const hookPayloads = [
    {
      session_id: "package-smoke-session",
      prompt_id: "package-smoke-turn",
      hook_event_name: "UserPromptSubmit",
      cwd: isolatedHome,
      prompt: "move button down",
    },
    {
      session_id: "package-smoke-session",
      prompt_id: "package-smoke-turn",
      hook_event_name: "PostToolUse",
      cwd: isolatedHome,
      tool_name: "Edit",
      tool_input: {
        file_path: "src/button.css",
        new_string: `margin-top: 8px; token=${hookSecret}`,
      },
    },
    {
      session_id: "package-smoke-session",
      prompt_id: "package-smoke-turn",
      hook_event_name: "Stop",
      cwd: isolatedHome,
      last_assistant_message: `changed spacing for button; rationale=${hookSecret}`,
    },
  ];
  for (const [index, payload] of hookPayloads.entries()) {
    const hook = childResult(
      process.execPath,
      [installedEntry, "hook", "agent-event", "claude-code"],
      { env, cwd: isolatedHome, input: `${JSON.stringify(payload)}\n` },
    );
    assertStatus(hook, 0, `installed Claude hook ${index + 1}`);
    assert.equal(hook.stdout, "{}", `installed Claude hook ${index + 1} stdout contract`);
    assert.equal(hook.stderr, "", `installed Claude hook ${index + 1} stderr`);
  }
  const readMemoryRecords = () => {
    try {
      return readFileSync(memoryPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  waitFor(() => {
    const records = readMemoryRecords();
    return records.filter((record) => record.kind === "triple").length === 1
      && spoolEntries().every((name) => !name.endsWith(".jsonl") && !name.endsWith(".lock"));
  });
  const triples = readMemoryRecords().filter((record) => record.kind === "triple");
  assert.equal(triples.length, 1, "installed Claude turn must produce one triple");
  const [triple] = triples;
  assert.equal(triple.agent, "claude-code");
  assert.equal(triple.intent?.text, "move button down");
  assert.equal(triple.mechanism.files.length, 1);
  assert.equal(triple.mechanism.files[0].path, "src/button.css");
  assert.match(triple.mechanism.files[0].excerpt, /margin-top: 8px/);
  assert.match(triple.mechanism.files[0].excerpt, /\[redacted credential assignment\]/);
  assert.match(triple.rationale.text, /\[redacted github token\]/);
  assert.doesNotMatch(JSON.stringify(triple), /ghp_/);
  assert.equal(spoolEntries().some((name) => name.endsWith(".jsonl") || name.endsWith(".lock")), false);
  const queuedLabels = readFileSync(labelsPath, "utf8").split("\n").filter(Boolean);
  assert.equal(queuedLabels.length, 2, "installed Claude turn must queue mapping plus first weekly digest hint");
  assert.match(
    queuedLabels[0] ?? "",
    /^you say "move button down"\. it is margin-top\. I think\. check, question$/u,
    "installed Claude turn must queue deterministic mapping label",
  );
  assert.doesNotMatch(queuedLabels[0] ?? "", /ghp_/u, "queued label must not contain raw token");
  assert.doesNotMatch(
    queuedLabels[0] ?? "",
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u,
    "queued label must contain no control or bidi characters",
  );
  assert.equal(
    queuedLabels[1],
    "week of work in memory. rocky digest, question",
    "installed first weekly turn must queue the bounded digest hint after its mapping label",
  );

  // Exercise the installed Codex adapter through both current stdin hooks and
  // legacy notify argv. The same turn identity must produce one deterministic,
  // redacted triple and one additional passive label.
  const codexSecret = "ghp_" + "b".repeat(36);
  const codexModernPayloads = [
    {
      session_id: "package-smoke-codex-session",
      turn_id: "package-smoke-codex-turn",
      hook_event_name: "UserPromptSubmit",
      cwd: isolatedHome,
      prompt: "move card right",
    },
    {
      session_id: "package-smoke-codex-session",
      turn_id: "package-smoke-codex-turn",
      hook_event_name: "PostToolUse",
      cwd: isolatedHome,
      tool_name: "apply_patch",
      tool_input: {
        file_path: "src/card.css",
        content: `margin-left: 4px; token=${codexSecret}`,
      },
    },
  ];
  for (const [index, payload] of codexModernPayloads.entries()) {
    const hook = childResult(
      process.execPath,
      [installedEntry, "hook", "agent-event", "codex"],
      { env, cwd: isolatedHome, input: `${JSON.stringify(payload)}\n` },
    );
    assertStatus(hook, 0, `installed Codex modern hook ${index + 1}`);
    assert.equal(hook.stdout, "{}", `installed Codex modern hook ${index + 1} stdout contract`);
    assert.equal(hook.stderr, "", `installed Codex modern hook ${index + 1} stderr`);
  }
  const codexNotify = {
    type: "agent-turn-complete",
    "thread-id": "package-smoke-codex-session",
    "turn-id": "package-smoke-codex-turn",
    "last-assistant-message": `changed card position; rationale=${codexSecret}`,
  };
  const legacyNotify = childResult(
    process.execPath,
    [installedEntry, "hook", "agent-event", "codex", JSON.stringify(codexNotify)],
    { env, cwd: isolatedHome },
  );
  assertStatus(legacyNotify, 0, "installed Codex legacy notify hook");
  assert.equal(legacyNotify.stdout, "{}", "installed Codex legacy notify stdout contract");
  assert.equal(legacyNotify.stderr, "", "installed Codex legacy notify stderr");
  waitFor(() => {
    const records = readMemoryRecords();
    return records.filter((record) => record.kind === "triple").length === 2
      && spoolEntries().every((name) => !name.endsWith(".jsonl") && !name.endsWith(".lock"));
  });
  const codexTriples = readMemoryRecords().filter((record) => record.kind === "triple");
  assert.equal(codexTriples.length, 2, "installed Codex turn must produce one additional triple");
  const codexTriple = codexTriples.find((record) => record.agent === "codex");
  assert.ok(codexTriple, "installed Codex turn must identify its agent");
  assert.equal(codexTriple.intent?.text, "move card right");
  assert.equal(codexTriple.mechanism.files[0].path, "src/card.css");
  assert.match(codexTriple.mechanism.files[0].excerpt, /margin-left: 4px/);
  assert.match(codexTriple.mechanism.files[0].excerpt, /\[redacted credential assignment\]/);
  assert.match(codexTriple.rationale.text, /\[redacted github token\]/);
  assert.doesNotMatch(JSON.stringify(codexTriple), /ghp_/);
  const labelsAfterCodex = readFileSync(labelsPath, "utf8").split("\n").filter(Boolean);
  assert.equal(labelsAfterCodex.length, 3, "installed Codex turn must queue one additional label without repeating weekly hint");
  assert.match(
    labelsAfterCodex[2] ?? "",
    /^you say "move card right"\. it is margin-left\. I think\. check, question$/u,
    "installed Codex turn must queue deterministic mapping label",
  );
  assert.doesNotMatch(labelsAfterCodex[2] ?? "", /ghp_/u, "Codex label must not contain raw token");

  // Setup dogfood uses explicit consent in an isolated HOME. The Claude
  // settings parent exists and remains private; Codex TOML is only printed.
  const claudeSettingsDirectory = join(isolatedHome, ".claude");
  mkdirSync(claudeSettingsDirectory, { recursive: true, mode: 0o700 });
  const codexConfigPaths = [
    join(isolatedHome, ".codex", "config.toml"),
    join(codexHome, "config.toml"),
  ];
  const codexBefore = codexConfigPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined);
  const agentSetup = installedSetupWithConsent(
    installedEntry,
    { env, cwd: isolatedHome, input: "y\n" },
  );
  assertStatus(agentSetup, 0, "installed agent-hook setup with explicit consent");
  assert.equal(agentSetup.stdout, "", "agent-hook setup keeps stdout clean");
  assert.match(agentSetup.stderr, /install ears for claude code, question/);
  assert.match(agentSetup.stderr, /claude-code agent hooks: written/);
  assert.match(agentSetup.stderr, /notify = \[/);
  assert.match(agentSetup.stderr, /\/\/hooks|\/hooks/);
  const claudeSettings = JSON.parse(readFileSync(join(claudeSettingsDirectory, "settings.json"), "utf8"));
  assert.ok(claudeSettings.hooks?.UserPromptSubmit);
  for (const [index, path] of codexConfigPaths.entries()) {
    assert.equal(existsSync(path), codexBefore[index] !== undefined, `Codex config path ${path} changed existence`);
    if (codexBefore[index] !== undefined) assert.deepEqual(readFileSync(path), codexBefore[index]);
  }

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

  assert.equal(shouldRunInstalledSetup(process.platform), true);

  // The fake clients only implement the pre-Task-3/4 name-only `mcp add` /
  // `mcp remove` contract. The reviewed adapters (src/setup/codex.ts,
  // src/setup/claude-code.ts) require Codex app-server CAS provenance and
  // Claude Code's policy-equivalent staged automation respectively, neither
  // of which these fakes can satisfy, so both correctly refuse to mutate
  // and fall back to manual guidance instead of touching state — exactly
  // README.md:56-64, and independently reproduced against fresh fake hosts
  // by evidence-packet-b64587b.md Gate 10 (cases A6/A7/A8/A9/A10). Voice
  // skill installation does not depend on MCP host capability, so it still
  // succeeds against the same fake clients (they are "detected" via
  // `--version`-shaped resolution, just not capability-complete).
  const configured = childResult(
    process.execPath,
    [installedEntry, "setup", "--yes", "--voice-skill"],
    { env },
  );
  assertStatus(configured, 1, "fake-client setup configure");
  assert.match(configured.stderr, /codex: failed/);
  assert.match(
    configured.stderr,
    /Codex app-server provenance and CAS capability is unavailable; use manual registration/,
  );
  assert.match(configured.stderr, /codex manual argv: \[/);
  assert.match(configured.stderr, /claude-code: failed/);
  assert.match(
    configured.stderr,
    /Claude Code policy-equivalent automation is unavailable; use manual registration/,
  );
  assert.match(configured.stderr, /claude-code manual argv: \[/);
  assert.match(configured.stderr, /voice-skill codex: installed/);
  assert.match(configured.stderr, /voice-skill claude-code: installed/);
  for (const markerPath of [
    join(isolatedHome, ".agents", "skills", "rocky-voice", ".rocky-managed.json"),
    join(claudeConfig, "skills", "rocky-voice", ".rocky-managed.json"),
  ]) {
    assert.equal(JSON.parse(readFileSync(markerPath, "utf8")).packageName, PACKAGE_NAME);
  }

  // `--check` never got a session either: Codex reads always need a
  // capability-proven app-server session, so it reports the same capability
  // failure. Claude Code's read is a direct JSON read of the (still empty,
  // since configure never wrote anything) effective config, so it correctly
  // reports `not-configured` rather than failing. Aggregate exit is 1
  // because nothing reached `healthy` (src/commands/setup.ts exitCode
  // "check" branch). Voice-skill state is unaffected by any of this.
  const checked = assertStateUnchanged(rockyHome, "fake-client setup check MCP", () => childResult(
    process.execPath,
    [installedEntry, "setup", "--check", "--voice-skill"],
    { env, timeout: 30_000 },
  ));
  assertStatus(checked, 1, "fake-client setup check");
  assert.match(checked.stderr, /codex: failed/);
  assert.match(
    checked.stderr,
    /Codex app-server provenance and CAS capability is unavailable; use manual registration/,
  );
  assert.match(checked.stderr, /claude-code: not-configured/);
  assert.match(checked.stderr, /voice-skill codex: unchanged/);
  assert.match(checked.stderr, /voice-skill claude-code: unchanged/);

  // Same shape for `--remove`: Codex still can't prove capability so it
  // fails; Claude Code correctly reports `not-configured` since it was
  // never actually written. Voice-skill removal is independent and moves
  // the managed skill to a backup, exactly as it did during `configure`.
  const removed = childResult(
    process.execPath,
    [installedEntry, "setup", "--remove", "--yes", "--voice-skill"],
    { env },
  );
  assertStatus(removed, 1, "fake-client setup remove");
  assert.match(removed.stderr, /codex: failed/);
  assert.match(
    removed.stderr,
    /Codex app-server provenance and CAS capability is unavailable; use manual registration/,
  );
  assert.match(removed.stderr, /claude-code: not-configured/);
  assert.match(removed.stderr, /voice-skill codex: removed/);
  assert.match(removed.stderr, /voice-skill claude-code: removed/);
  assert.equal(existsSync(join(isolatedHome, ".agents", "skills", "rocky-voice")), false);
  assert.equal(existsSync(join(claudeConfig, "skills", "rocky-voice")), false);

  // Zero-eligible-host shape (README.md:64): with neither fake client
  // reachable on PATH, Rocky must not invent a per-host voice-skill result;
  // it prints the exact `voice-skill: unavailable` literal and exits 1.
  // This is the one manual-required literal Gate 10 pins (cases A3/A4/A5)
  // that the fake-client flow above never exercises, since both fakes are
  // always "detected" there.
  const noHostsEnv = { ...env, PATH: dirname(process.execPath), Path: dirname(process.execPath) };
  const noHosts = assertStateUnchanged(
    rockyHome,
    "fake-client setup with no detected hosts",
    () => childResult(
      process.execPath,
      [installedEntry, "setup", "--yes", "--voice-skill"],
      { env: noHostsEnv },
    ),
  );
  assertStatus(noHosts, 1, "fake-client setup with no detected hosts");
  assert.match(noHosts.stderr, /voice-skill: unavailable/);

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
