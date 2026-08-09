import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandInvocation } from "./package-smoke-support.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@poggufanz/rocky-cli";
const PACKAGE_VERSION = "0.3.0";
const COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;

class UsageError extends Error {}
class StepError extends Error {}

function canonicalTarget(path) {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

function refuseDanglingSymlinkComponents(path, label) {
  let current = path;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        try {
          realpathSync(current);
        } catch {
          throw new UsageError(`${label} path must not contain dangling symbolic links`);
        }
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function outsidePackagePath(value, label) {
  if (!isAbsolute(value)) throw new UsageError(`${label} path must be absolute`);
  const path = resolve(value);
  refuseDanglingSymlinkComponents(path, label);
  if (isWithin(realpathSync(packageRoot), canonicalTarget(path))) {
    throw new UsageError(`${label} path must be outside package`);
  }
  return path;
}

function reportArgument(argv) {
  if (argv.includes("--publish")) throw new UsageError("publishing arguments are refused");
  if (argv.length !== 2 || argv[0] !== "--report" || !argv[1]) {
    throw new UsageError("usage: release-check --report <absolute path outside package>");
  }
  return outsidePackagePath(argv[1], "report");
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
      // Continue through bounded PATH candidates.
    }
  }
  throw new StepError("npm executable is unavailable");
}

function isolatedEnvironment(root) {
  const paths = {
    home: join(root, "home"),
    appData: join(root, "appdata"),
    localAppData: join(root, "localappdata"),
    xdg: join(root, "xdg-config"),
    claude: join(root, "claude-config"),
    codex: join(root, "codex-home"),
    rocky: join(root, "rocky-home"),
    cache: join(root, "npm-cache"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const npmrc = join(root, "empty-npmrc");
  const globalNpmrc = join(root, "empty-global-npmrc");
  writeFileSync(npmrc, "", "utf8");
  writeFileSync(globalNpmrc, "", "utf8");

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || /(?:token|auth|proxy)/i.test(key) ||
        /(?:^|_)(?:key|secret|password|credential)(?:_|$)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CONFIG_HOME: paths.xdg,
    CLAUDE_CONFIG_DIR: paths.claude,
    CODEX_HOME: paths.codex,
    ROCKY_HOME: paths.rocky,
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    NPM_CONFIG_CACHE: paths.cache,
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  });
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runStep(state, env, label, file, args, display) {
  const invocation = commandInvocation(
    file,
    args,
    process.platform,
    env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC,
  );
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: packageRoot,
    env,
    shell: false,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true,
  });
  const status = result.status;
  const signal = result.signal;
  const error = result.error === undefined
    ? null
    : `${result.error.code === "ETIMEDOUT" ? "timeout" : "spawn error"}: ${result.error.code ?? result.error.name}`;
  state.commands.push({ label, command: display, status, signal, error });
  if (result.error !== undefined) throw new StepError(`${label} ${error}`);
  if (status !== 0 || signal !== null) {
    const diagnostic = (result.stderr || result.stdout).trim().slice(-4_000);
    if (diagnostic) process.stderr.write(`${diagnostic}\n`);
    throw new StepError(`${label} failed with ${status === null ? "no exit status" : `status ${status}`}`);
  }
  return result.stdout;
}

function assertMetadata(state) {
  const value = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const dependencies = value.dependencies ?? {};
  const optionalDependencies = value.optionalDependencies ?? {};
  const valid = value.name === PACKAGE_NAME
    && value.version === PACKAGE_VERSION
    && JSON.stringify(value.bin) === JSON.stringify({ rocky: "./dist/index.js" })
    && value.engines?.node === ">=18"
    && value.license === "MIT"
    && value.author === "Muhammad Faiq"
    && value.repository?.type === "git"
    && value.repository?.url === "git+https://github.com/poggufanz/rocky.git"
    && value.homepage === "https://github.com/poggufanz/rocky#readme"
    && value.bugs?.url === "https://github.com/poggufanz/rocky/issues"
    && value.publishConfig?.access === "public"
    && value.publishConfig?.tag === "beta"
    && Object.keys(dependencies).length === 0
    && Object.keys(optionalDependencies).length === 0;
  if (!valid) throw new StepError("package metadata assertion failed");
  state.metadata = {
    name: value.name,
    version: value.version,
    binary: "rocky",
    license: value.license,
    author: value.author,
    runtimeDependencies: Object.keys(dependencies).length,
    optionalDependencies: Object.keys(optionalDependencies).length,
  };
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

function parseManifest(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new StepError("dry-run pack manifest is invalid");
  const packed = parsed[0];
  if (packed?.name !== PACKAGE_NAME || packed?.version !== PACKAGE_VERSION || !Array.isArray(packed.files)) {
    throw new StepError("dry-run pack identity is invalid");
  }
  if (!Number.isFinite(packed.size) || packed.size >= 1_000_000 ||
      !Number.isFinite(packed.unpackedSize) || packed.unpackedSize <= 0 || packed.files.length === 0) {
    throw new StepError("dry-run pack size or file list is invalid");
  }
  const paths = packed.files.map((file) => file.path);
  for (const path of paths) {
    if (!allowedPackPath(path)) throw new StepError(`unexpected packed path: ${path}`);
    const normalized = path.replaceAll("\\", "/");
    if (/(^|\/)test(\/|$)|\.test\.|(^|\/)src(\/|$)|fixture|cache|validation|\.rocky-managed\.json/i.test(normalized)) {
      throw new StepError(`forbidden source or test payload: ${path}`);
    }
    if (normalized !== "dist/commands/model.js" && /model|weight/i.test(normalized)) {
      throw new StepError(`forbidden model payload: ${path}`);
    }
  }
  for (const required of [
    "LICENSE", "README.md", "package.json", "dist/index.js",
    "skills/rocky-voice/SKILL.md", "skills/rocky-voice/agents/openai.yaml",
  ]) {
    if (!paths.includes(required)) throw new StepError(`required packed path is missing: ${required}`);
  }
  if (!paths.some((path) => path.startsWith("dist/mcp/"))) throw new StepError("MCP package payload is missing");
  return {
    filename: packed.filename,
    packageSize: packed.size,
    unpackedSize: packed.unpackedSize,
    files: packed.files.map((file) => ({ path: file.path, size: file.size })),
  };
}

function safeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdown(state) {
  const status = state.failure === undefined ? "PASS" : "FAIL";
  const lines = [
    "# Rocky v0.2.1 release check",
    "",
    `- Result: **${status}**`,
    `- Measured at: ${state.measuredAt}`,
    `- Node: ${state.node}`,
    `- npm: ${state.npm ?? "not captured"}`,
    `- Platform: ${state.platform} ${state.arch}`,
    "",
    "## Commands",
    "",
    "| Step | Command | Exit | Signal | Error |",
    "|---|---|---:|---|---|",
    ...state.commands.map((command) =>
      `| ${safeCell(command.label)} | \`${safeCell(command.command)}\` | ` +
      `${command.status === null ? "not exited" : command.status} | ${command.signal ?? "none"} | ${command.error ?? "none"} |`),
    "",
    "## Package metadata",
    "",
  ];
  if (state.metadata === undefined) lines.push("Pending: metadata step did not complete.");
  else {
    lines.push(
      `- Name/version: ${state.metadata.name}@${state.metadata.version}`,
      `- Binary: ${state.metadata.binary}`,
      `- License/author: ${state.metadata.license} / ${state.metadata.author}`,
      `- Runtime dependencies: ${state.metadata.runtimeDependencies}`,
      `- Optional dependencies: ${state.metadata.optionalDependencies}`,
    );
  }
  lines.push("", "## Dry-run package manifest", "");
  if (state.manifest === undefined) lines.push("Pending: manifest step did not complete.");
  else {
    lines.push(
      `- Filename: ${state.manifest.filename}`,
      `- Packed bytes: ${state.manifest.packageSize}`,
      `- Unpacked bytes: ${state.manifest.unpackedSize}`,
      `- Files: ${state.manifest.files.length}`,
      "",
      "```text",
      ...state.manifest.files.map((file) => `${file.path}\t${file.size}`),
      "```",
    );
  }
  lines.push("", "## MCP acceptance measurement", "");
  if (state.benchmark?.status === "passed") {
    const report = state.benchmark.report;
    lines.push(
      `- Result: passed on ${report.node} ${report.platform}/${report.arch}`,
      `- Empty cold start median/p95: ${report.emptyColdStartMs.median} / ${report.emptyColdStartMs.p95} ms`,
      `- Fixture: ${report.fixture.records} records / ${report.fixture.bytes} bytes`,
      `- Steady RSS median/p95: ${report.steadyStateRssBytes.median} / ${report.steadyStateRssBytes.p95} bytes`,
      `- RSS method: ${report.steadyStateRssBytes.method}`,
    );
  } else {
    lines.push(`- Result: pending (${state.benchmark?.reason ?? "benchmark step did not complete"})`);
  }
  lines.push("", "## Git evidence", "");
  lines.push(`- Diff check: ${state.diffCheckPassed ? "passed" : "not completed"}`);
  lines.push("- Status (`git status --short` is evidence, not a cleanliness gate):", "", "```text");
  lines.push(state.gitStatus?.trimEnd() || "(clean or unavailable)", "```", "");
  if (state.failure !== undefined) lines.push("## Failure", "", state.failure, "");
  lines.push("This checker did not publish or mutate registry state.", "");
  return lines.join("\n");
}

async function main(reportPath) {
  const state = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    commands: [],
  };
  let temporaryRoot;
  let failed = false;
  try {
    temporaryRoot = mkdtempSync(join(tmpdir(), "rocky-release-check-"));
    const env = isolatedEnvironment(temporaryRoot);
    const npm = process.env.ROCKY_RELEASE_CHECK_TEST_SPAWN_ERROR === "1"
      ? join(temporaryRoot, "missing-npm-executable")
      : resolveNpmExecutable();
    state.npm = runStep(state, env, "npm version", npm, ["--version"], "npm --version").trim();
    runStep(state, env, "clean build and full tests", npm, ["test"], "npm test");
    assertMetadata(state);
    state.manifest = parseManifest(runStep(
      state,
      env,
      "dry-run package manifest",
      npm,
      ["pack", "--dry-run", "--json"],
      "npm pack --dry-run --json",
    ));
    runStep(
      state,
      env,
      "installed tarball smoke",
      process.execPath,
      [join(packageRoot, "scripts", "package-smoke.mjs")],
      "node scripts/package-smoke.mjs",
    );

    if (process.platform === "linux" && Number(process.versions.node.split(".")[0]) === 22) {
      const benchmarkPath = join(temporaryRoot, "benchmark.json");
      runStep(
        state,
        env,
        "MCP benchmark",
        process.execPath,
        [join(packageRoot, "scripts", "benchmark-mcp.mjs"), "--output", benchmarkPath],
        "node scripts/benchmark-mcp.mjs --output <temporary-report>",
      );
      const report = JSON.parse(readFileSync(benchmarkPath, "utf8"));
      if (report?.gates?.passed !== true) throw new StepError("MCP benchmark gate did not pass");
      state.benchmark = { status: "passed", report };
    } else {
      state.benchmark = { status: "pending", reason: "requires Node 22 on Linux" };
    }

    runStep(state, env, "git diff check", "git", ["diff", "--check"], "git diff --check");
    state.diffCheckPassed = true;
    state.gitStatus = runStep(state, env, "git status evidence", "git", ["status", "--short"], "git status --short");
  } catch (error) {
    failed = true;
    state.failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, markdown(state), "utf8");
    } finally {
      if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  if (failed) throw new StepError(state.failure);
}

try {
  const report = reportArgument(process.argv.slice(2));
  await main(report);
  process.stdout.write(`${report}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
