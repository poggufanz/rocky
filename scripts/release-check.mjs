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
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const PACKAGE_NAME = "@poggufanz/rocky-cli";
const PACKAGE_VERSION = packageMetadata.version;
const PACKAGE_BINARY = "rocky";
const RELEASE_TAG = "v0.5.0";
const RELEASE_COMMIT = "20bc32090843334afa0ee92c0f0705fde625d1c3";
const CANONICAL_BRANCH = "main";
const CANONICAL_REPOSITORY_URL = "https://github.com/poggufanz/rocky.git";
const CANONICAL_PACKAGE_ROOT = "rocky/";
const COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const HIDDEN_MARKER = "\u0000";

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
  const releaseFlags = argv.filter((argument) => argument === "--release");
  const truthOnlyFlags = argv.filter((argument) => argument === "--truth-only");
  if (releaseFlags.length > 1 || truthOnlyFlags.length > 1) {
    throw new UsageError("release-check accepts each mode flag at most once");
  }
  const mode = releaseFlags.length === 1 ? "release" : "branch";
  const truthOnly = truthOnlyFlags.length === 1;
  if (mode === "release" && truthOnly) {
    throw new UsageError("--release cannot combine with --truth-only; release mode runs the full release gate");
  }
  const reportArgs = argv.filter((argument) => argument !== "--release" && argument !== "--truth-only");
  if (reportArgs.length !== 2 || reportArgs[0] !== "--report" || !reportArgs[1]) {
    throw new UsageError("usage: release-check [--release] [--truth-only] --report <absolute path outside package>");
  }
  return { path: outsidePackagePath(reportArgs[1], "report"), mode, truthOnly };
}

export function sanitizeReleaseEnvironment(source = process.env) {
  const env = { ...source };
  let removed = false;
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) || /^(?:NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT)$/i.test(key)) {
      delete env[key];
      removed = true;
    }
  }
  return removed ? env : source;
}

function regularFile(candidate, executable = false) {
  try {
    if (!lstatSync(candidate).isFile()) return undefined;
    if (executable && process.platform !== "win32") accessSync(candidate, constants.X_OK);
    return resolve(candidate);
  } catch {
    return undefined;
  }
}

function nodeDirectoryCandidates() {
  const nodeDirectory = dirname(process.execPath);
  if (process.platform !== "win32") {
    return [nodeDirectory, "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  }
  const programFiles = dirname(nodeDirectory);
  const volumeRoot = parse(process.execPath).root;
  return [
    nodeDirectory,
    join(programFiles, "Git", "cmd"),
    join(programFiles, "Git", "bin"),
    join(volumeRoot, "Program Files", "Git", "cmd"),
    join(volumeRoot, "Program Files", "Git", "bin"),
    join(volumeRoot, "Program Files (x86)", "Git", "cmd"),
    join(volumeRoot, "Program Files (x86)", "Git", "bin"),
    join(volumeRoot, "Windows", "System32"),
  ];
}

function trustedGitCandidates() {
  return nodeDirectoryCandidates().map((directory) => join(directory, process.platform === "win32" ? "git.exe" : "git"));
}

function trustedNpmCandidates() {
  const nodeDirectory = dirname(process.execPath);
  return [
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDirectory, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
  ];
}

function trustedCommandProcessor() {
  if (process.platform !== "win32") return undefined;
  const volumeRoot = parse(process.execPath).root;
  return regularFile(join(volumeRoot, "Windows", "System32", "cmd.exe"));
}

export function resolveNpmExecutable(_environment = process.env) {
  for (const candidate of trustedNpmCandidates()) {
    const npmCli = regularFile(candidate);
    if (npmCli !== undefined) return npmCli;
  }
  throw new StepError("npm CLI executable is unavailable");
}

export function resolveNpmInvocation(environment = process.env) {
  return { file: process.execPath, argsPrefix: [resolveNpmExecutable(environment)] };
}

export function resolveGitExecutable(_environment = process.env) {
  for (const candidate of trustedGitCandidates()) {
    const git = regularFile(candidate, true);
    if (git !== undefined) return git;
  }
  throw new StepError("git executable is unavailable");
}

export function releaseCheckCommandPlan(npm, root = packageRoot) {
  const invocation = typeof npm === "string" ? { file: npm, argsPrefix: [] } : npm;
  if (invocation === null || typeof invocation !== "object" || typeof invocation.file !== "string" || !Array.isArray(invocation.argsPrefix)) {
    throw new StepError("npm invocation is invalid");
  }
  const npmArgs = (args) => [ ...invocation.argsPrefix, ...args ];
  return {
    npmVersion: { file: invocation.file, args: npmArgs(["--version"]), display: "npm --version" },
    fullTest: { file: invocation.file, args: npmArgs(["test"]), display: "npm test" },
    pack: { file: invocation.file, args: npmArgs(["pack", "--dry-run", "--json"]), display: "npm pack --dry-run --json" },
    smoke: {
      file: process.execPath,
      args: [join(root, "scripts", "package-smoke.mjs")],
      display: "node scripts/package-smoke.mjs",
    },
  };
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
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" || key.toLowerCase() === "comspec") delete env[key];
  }
  env.PATH = [...new Set(nodeDirectoryCandidates())].join(process.platform === "win32" ? ";" : ":");
  const commandProcessor = trustedCommandProcessor();
  if (commandProcessor !== undefined) env.ComSpec = commandProcessor;
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return sanitizeReleaseEnvironment(env);
}

export function runReleaseStep(state, env, label, file, args, display, runner = spawnSync) {
  const result = runner(file, args, {
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

function gitOutput(root, args, options = {}) {
  const env = sanitizeReleaseEnvironment(options.env ?? process.env);
  const executable = options.gitExecutable ?? resolveGitExecutable(env);
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    shell: false,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) return undefined;
  return result.stdout.trim();
}

export function readGitReleaseState(root, mode, runner = gitOutput, options = {}) {
  const env = sanitizeReleaseEnvironment(options.env ?? process.env);
  const gitExecutable = options.gitExecutable ?? (runner === gitOutput ? resolveGitExecutable(env) : undefined);
  const run = (args) => runner(root, args, { env, gitExecutable });
  return {
    branch: run(["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "(detached)",
    head: run(["rev-parse", "--verify", "HEAD^{commit}"]),
    status: run(["status", "--short", "--untracked-files=all", "--"]) ?? "(git status unavailable)",
    tagCommit: run(["rev-parse", "--verify", `refs/tags/${RELEASE_TAG}^{commit}`]),
    mode,
  };
}

export function assertReleaseTruth(state, { root = packageRoot, mode = "branch", env, gitExecutable } = {}) {
  const evidenceEnv = sanitizeReleaseEnvironment(env ?? process.env);
  const evidenceGit = gitExecutable ?? resolveGitExecutable(evidenceEnv);
  const snapshot = readReleaseTruthSnapshot(root, evidenceEnv);
  const documentErrors = validateReleaseTruth(snapshot);
  const git = readGitReleaseState(root, mode, gitOutput, { env: evidenceEnv, gitExecutable: evidenceGit });
  const gitErrors = validateGitReleaseState(git);
  state.releaseTruth = {
    mode,
    canonicalBranch: CANONICAL_BRANCH,
    tag: RELEASE_TAG,
    immutableCommit: RELEASE_COMMIT,
    packageRoot: root,
    documents: documentErrors.length === 0 ? "passed" : "failed",
    git,
  };
  if (documentErrors.length > 0 || gitErrors.length > 0) {
    throw new StepError(`release truth failed: ${[...documentErrors, ...gitErrors].join("; ")}`);
  }
}

function isEmptyDependencyRecord(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).length === 0;
}

function isEmptyBundleMetadata(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function isCanonicalBinary(value, target) {
  const binary = objectRecord(value);
  if (binary === undefined) return false;
  const prototype = Object.getPrototypeOf(binary);
  return (prototype === Object.prototype || prototype === null)
    && Object.keys(binary).length === 1
    && binary[PACKAGE_BINARY] === target;
}

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function packageInfoValues(source) {
  const canonical = [
    `export const PACKAGE_NAME = "${PACKAGE_NAME}";`,
    `export const PACKAGE_VERSION = "${PACKAGE_VERSION}";`,
    `export const PACKAGE_BINARY = "${PACKAGE_BINARY}";`,
  ].join("\n") + "\n";
  if (source.replace(/\r\n?/gu, "\n") !== canonical) {
    return { name: undefined, version: undefined, binary: undefined };
  }
  return { name: PACKAGE_NAME, version: PACKAGE_VERSION, binary: PACKAGE_BINARY };
}

function fullGitObjectId(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function blankHiddenMarkdownSpans(text) {
  if (text.includes(HIDDEN_MARKER)) return text.replace(/[^\r\n]/gu, HIDDEN_MARKER);
  const output = text.split("");
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (output[index] !== "\n" && output[index] !== "\r") output[index] = HIDDEN_MARKER;
    }
  };
  const isPreOpening = (index) => {
    if (text.slice(index, index + 4).toLowerCase() !== "<pre") return false;
    const next = text[index + 4];
    return next === ">" || (next !== undefined && /[ \t\r\n\f]/u.test(next));
  };
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      const end = close < 0 ? text.length : close + 3;
      blank(index, end);
      index = end;
      continue;
    }
    if (isPreOpening(index)) {
      const openingEnd = text.indexOf(">", index + 4);
      if (openingEnd < 0) {
        blank(index, text.length);
        break;
      }
      const close = /<\/pre[ \t\r\n\f]*>/iu.exec(text.slice(openingEnd + 1));
      if (close === null) {
        blank(index, text.length);
        break;
      }
      const end = openingEnd + 1 + close.index + close[0].length;
      blank(index, end);
      index = end;
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function markdownSourceLines(text) {
  let fence;
  return blankHiddenMarkdownSpans(text).split(/\r?\n/u).map((line) => {
    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      const closing = /^\s{0,3}(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
      if (closing !== undefined && closing[0] === fence.character && closing.length >= fence.length) fence = undefined;
      return "";
    }
    if (opening !== undefined) {
      fence = { character: opening[0], length: opening.length };
      return "";
    }
    if (/^(?: {4}|\t)/u.test(line.replaceAll(HIDDEN_MARKER, ""))) return "";
    return line.replaceAll(HIDDEN_MARKER, " ");
  });
}

function markdownTextBlocks(text) {
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current.join(" "));
    current = [];
  };
  for (const line of markdownSourceLines(text)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    if (/^\s{0,3}#{1,6}\s+/u.test(line)) {
      flush();
      current.push(trimmed);
      continue;
    }
    if (/^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+|>)/u.test(line)) {
      flush();
      current.push(trimmed);
      continue;
    }
    current.push(trimmed);
  }
  flush();
  return blocks;
}

function markdownH2Sections(text) {
  const sections = [];
  let current;
  for (const line of markdownSourceLines(text)) {
    const heading = /^\s{0,3}##(?!#)\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      current = { title: heading[1].trim(), lines: [line] };
      sections.push(current);
    } else if (current !== undefined) {
      current.lines.push(line);
    }
  }
  return sections.map((section) => ({
    title: section.title,
    lines: section.lines,
    text: section.lines.join("\n"),
  }));
}

function releaseClauses(line) {
  return line
    .split(/(?:[.!?;](?=\s|$))\s*/u)
    .flatMap((sentence) => sentence.split(/\s+\b(?:but|however|although|though)\b\s*/iu));
}

function directlyNegated(clause, start, end) {
  const before = clause.slice(0, start);
  const after = clause.slice(end);
  if (/(?:^|\s)\b(?:not|never)(?:\s+(?:currently|actually|yet|been))*\s*$/i.test(before)) return true;
  if (/(?:^|\s)\b(?:no|without)(?:\s+(?:npm|the|package|publication|version|release|registry)){0,3}\s*$/i.test(before)) {
    return true;
  }
  if (/\bno\s+version\s+bump\s+or\s*$/i.test(before)) return true;
  return /^\s*(?:(?:is|are|was|were|has|have|had|does|did|can|could|will|would)\s+)?(?:no|not|never)\b/i.test(after);
}

function hasPositivePublicationClaim(text) {
  const context = /(?:\bnpm\b|\bpackage\b|\brelease\b|\bversion\b|\btarball\b|\bartifact\b|\bregistry\b|\bv?\d+\.\d+\.\d+\b|@poggufanz\/rocky-cli)/i;
  const signals = [
    /\b(?:publish\w*|publication\w*)\b/gi,
    /\b(?:available|availability|live)\b[\s\S]{0,80}\b(?:on|from|via|in)\s+(?:npm|the npm registry|npm registry|the registry|registry\.npmjs\.org)\b/gi,
    /\b(?:(?:is|are|was|were)\s+)?(?:now|landed|downloadable)\s+(?:on|from|via|in)\s+(?:npm|the npm registry|npm registry|the registry|registry\.npmjs\.org)\b/gi,
    /\b(?:package|version|release|tarball|artifact|v\d+\.\d+(?:\.\d+)?)\b(?:(?!\b(?:not|never|no|without)\b)[\s\S]){0,80}\b(?:(?:is|are|was|were)\s+(?:now\s+)?(?:(?:available|availability|live|downloadable)\s+)?|(?:now\s+)?(?:available|availability|live|downloadable|landed)\s+)(?:on|from|via|in)\s+(?:npm|the npm registry|npm registry|the registry|registry\.npmjs\.org)\b/gi,
  ];
  return markdownTextBlocks(text).some((line) => releaseClauses(line).some((clause) => {
    if (!context.test(clause)) return false;
    const matches = new Map();
    for (const signal of signals) {
      for (const match of clause.matchAll(signal)) {
        const start = match.index ?? 0;
        matches.set(`${start}:${start + match[0].length}`, { start, end: start + match[0].length });
      }
    }
    return [...matches.values()].some(({ start, end }) => !directlyNegated(clause, start, end));
  }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateReleaseTruth(snapshot) {
  const errors = [];
  const expectedVersion = RELEASE_TAG.slice(1);
  const value = objectRecord(snapshot);
  if (value === undefined) return ["release truth snapshot is not an object"];

  const metadata = objectRecord(value.metadata);
  if (metadata === undefined || !validateReleaseMetadata(metadata) || metadata.version !== expectedVersion) {
    errors.push("package metadata does not match canonical release identity");
  }

  const lock = objectRecord(value.lock);
  const lockPackages = lock === undefined ? undefined : objectRecord(lock.packages);
  const lockRoot = lockPackages === undefined ? undefined : objectRecord(lockPackages[""]);
  if (lock === undefined || lock.name !== PACKAGE_NAME || lock.version !== expectedVersion
      || lockRoot === undefined || lockRoot.name !== PACKAGE_NAME || lockRoot.version !== expectedVersion
      || !isEmptyDependencyRecord(lockRoot.dependencies) || !isEmptyDependencyRecord(lockRoot.optionalDependencies)
      || !isEmptyDependencyRecord(lockRoot.peerDependencies) || !isEmptyDependencyRecord(lockRoot.peerDependenciesMeta)
      || !isEmptyBundleMetadata(lockRoot.bundledDependencies) || !isEmptyBundleMetadata(lockRoot.bundleDependencies)
      || !isCanonicalBinary(lockRoot.bin, "dist/index.js")) {
    errors.push("package lock does not match canonical release identity");
  }

  const info = typeof value.packageInfoSource === "string"
    ? packageInfoValues(value.packageInfoSource)
    : { name: undefined, version: undefined, binary: undefined };
  if (info.name !== PACKAGE_NAME || info.version !== expectedVersion || info.binary !== PACKAGE_BINARY) {
    errors.push("package-info constants do not match canonical release identity");
  }

  const readme = typeof value.readme === "string" ? value.readme : "";
  const visibleReadmeLines = markdownSourceLines(readme);
  const roadmapSections = markdownH2Sections(readme).filter((section) => /^Roadmap$/i.test(section.title));
  const roadmap = roadmapSections.length === 1 ? roadmapSections[0] : undefined;
  const currentRoadmapLines = roadmap?.lines.filter((line) => /\(current release\)/i.test(line)) ?? [];
  const roadmapToken = /^[-*]\s+\*\*(v\d+\.\d+(?:\.\d+)?)\s+/i.exec(currentRoadmapLines[0] ?? "")?.[1];
  const allowedRoadmapTokens = new Set([`v${expectedVersion}`, `v${expectedVersion.replace(/\.0$/, "")}`]);
  const allowedRoadmapToken = roadmapToken !== undefined && allowedRoadmapTokens.has(roadmapToken);
  const currentReleaseLines = visibleReadmeLines.filter((line) => /^\s*Current release\s*:/i.test(line));
  const currentReleaseMarkerCount = (visibleReadmeLines.join("\n").match(/\bCurrent release\s*:/gi) ?? []).length;
  const canonicalCurrentMarker = `Current release: \`${PACKAGE_NAME}@${expectedVersion}\``;
  const canonicalLayout = `Repository layout: a fresh clone of the canonical upstream repository (\`${CANONICAL_REPOSITORY_URL}\`) is the package root; run \`npm install\`, \`npm test\`, and \`npm pack\` there. In this outer workspace, that same package root is the \`${CANONICAL_PACKAGE_ROOT}\` directory. Canonical developer branch is \`${CANONICAL_BRANCH}\`; \`iq\` is a remediation branch, not a second release line.`;
  const canonicalLayoutLines = visibleReadmeLines.filter((line) => /^\s*Repository layout\s*:/i.test(line));
  if (currentReleaseMarkerCount !== 1
      || currentReleaseLines.length !== 1
      || !new RegExp(`^${escapeRegExp(canonicalCurrentMarker)}(?:\\.|$)`, "u").test(currentReleaseLines[0].trim())
      || roadmap === undefined
      || currentRoadmapLines.length !== 1
      || !allowedRoadmapToken
      || canonicalLayoutLines.length !== 1
      || canonicalLayoutLines[0].trim() !== canonicalLayout
      || hasPositivePublicationClaim(readme)) {
    errors.push("README release identity or publication status is stale");
  }

  const changelog = typeof value.changelog === "string" ? value.changelog : "";
  const changelogSections = markdownH2Sections(changelog);
  const releaseSections = changelogSections.filter((section) => /^\d+\.\d+\.\d+(?:\s|$)/u.test(section.title));
  const headingVersion = /^(\d+\.\d+\.\d+)(?:\s|$)/u.exec(releaseSections[0]?.title ?? "")?.[1];
  const expectedSections = releaseSections.filter((section) => new RegExp(`^${escapeRegExp(expectedVersion)}(?:\\s|$)`).test(section.title));
  const currentSection = expectedSections.length === 1 ? expectedSections[0].text : "";
  if (headingVersion !== expectedVersion
      || expectedSections.length !== 1
      || (currentSection !== "" && /\b(?:unreleased|unpublished)\b/i.test(currentSection))
      || hasPositivePublicationClaim(changelog)) {
    errors.push("CHANGELOG release status is stale");
  }

  const helpStdout = typeof value.helpStdout === "string" ? value.helpStdout : "";
  const helpStderr = typeof value.helpStderr === "string" ? value.helpStderr : "";
  const helpVersionMarkers = [...helpStdout.matchAll(new RegExp(`${PACKAGE_NAME.replace("/", "\\/")}@([^\\s\\r\\n]+)`, "g"))]
    .map((match) => match[1]);
  const versionLines = helpStdout.split(/\r?\n/u).filter((line) => /^\s*version\s*:/i.test(line));
  if (value.helpCompleted !== true
      || helpStderr !== ""
      || !helpStdout.includes(`version: ${PACKAGE_NAME}@${expectedVersion}`)
      || helpVersionMarkers.length !== 1
      || helpVersionMarkers[0] !== expectedVersion
      || versionLines.length !== 1
      || versionLines[0].trim() !== `version: ${PACKAGE_NAME}@${expectedVersion}`) {
    errors.push("CLI help does not expose canonical release identity");
  }
  const versionStdout = typeof value.versionStdout === "string" ? value.versionStdout : "";
  const versionStderr = typeof value.versionStderr === "string" ? value.versionStderr : "";
  if (value.versionCompleted !== true || versionStderr !== "" || versionStdout !== `${expectedVersion}\n`) {
    errors.push("CLI --version does not match canonical release identity");
  }
  return errors;
}

export function readReleaseTruthSnapshot(root = packageRoot, env = sanitizeReleaseEnvironment()) {
  env = sanitizeReleaseEnvironment(env);
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const packageInfoSource = readFileSync(join(root, "src", "core", "package-info.ts"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const helpResult = spawnSync(process.execPath, [join(root, "dist", "index.js"), "--help"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  const versionResult = spawnSync(process.execPath, [join(root, "dist", "index.js"), "--version"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  const helpStdout = helpResult.stdout ?? "";
  const helpStderr = helpResult.stderr ?? "";
  const versionStdout = versionResult.stdout ?? "";
  const versionStderr = versionResult.stderr ?? "";
  return {
    metadata,
    lock,
    packageInfoSource,
    readme,
    changelog,
    help: `${helpStdout}${helpStderr}`,
    helpStdout,
    helpStderr,
    versionOutput: versionStdout,
    versionStdout,
    versionStderr,
    helpCompleted: helpResult.error === undefined && helpResult.status === 0 && helpResult.signal === null,
    versionCompleted: versionResult.error === undefined && versionResult.status === 0 && versionResult.signal === null,
  };
}

export function validateGitReleaseState(state) {
  const errors = [];
  const value = objectRecord(state);
  if (value === undefined) return ["git release state is not an object"];
  if (!fullGitObjectId(value.head)) errors.push("git HEAD evidence is missing or not a full object id");
  if (typeof value.status !== "string" || value.status.trim() !== "") errors.push("package worktree is dirty");
  if (value.tagCommit !== RELEASE_COMMIT) errors.push(`${RELEASE_TAG} does not resolve to immutable release commit`);
  if (value.mode === "release") {
    if (value.head !== RELEASE_COMMIT) errors.push("release mode requires HEAD at immutable release commit");
  } else if (value.mode !== "branch") {
    errors.push("release mode must be branch or release");
  }
  return errors;
}

export function validateReleaseMetadata(value) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    return isEmptyDependencyRecord(value.dependencies)
      && isEmptyDependencyRecord(value.optionalDependencies)
      && isEmptyDependencyRecord(value.peerDependencies)
      && isEmptyDependencyRecord(value.peerDependenciesMeta)
      && isEmptyBundleMetadata(value.bundledDependencies)
      && isEmptyBundleMetadata(value.bundleDependencies)
      && value.name === PACKAGE_NAME
      && value.version === PACKAGE_VERSION
      && isCanonicalBinary(value.bin, "./dist/index.js")
      && value.engines?.node === ">=18"
      && value.license === "MIT"
      && value.author === "Muhammad Faiq"
      && value.repository?.type === "git"
      && value.repository?.url === "git+https://github.com/poggufanz/rocky.git"
      && value.homepage === "https://github.com/poggufanz/rocky#readme"
      && value.bugs?.url === "https://github.com/poggufanz/rocky/issues"
      && value.publishConfig?.access === "public";
  } catch {
    return false;
  }
}

export function assertMetadata(state) {
  const value = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const valid = validateReleaseMetadata(value);
  if (!valid) throw new StepError("package metadata assertion failed");
  const dependencies = value.dependencies ?? {};
  const optionalDependencies = value.optionalDependencies ?? {};
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
    "LICENSE", "README.md", "CHANGELOG.md", "package.json", "dist/index.js", "dist/agent/schema.js",
    "skills/rocky-voice/SKILL.md", "skills/rocky-voice/agents/openai.yaml",
  ]) {
    if (!paths.includes(required)) throw new StepError(`required packed path is missing: ${required}`);
  }
  if (!paths.some((path) => path.startsWith("dist/mcp/"))) throw new StepError("MCP package payload is missing");
  if (!paths.some((path) => path.startsWith("dist/agent/"))) throw new StepError("agent package payload is missing");
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
  const truthOnly = state.scope === "truth-only";
  const lines = [
    `# Rocky ${PACKAGE_VERSION} release check`,
    "",
    `- Result: **${status}**`,
    `- Scope: **${state.scope ?? "full release gate"}**`,
    ...(truthOnly
      ? ["- Truth-only scope: document and Git evidence only; build, tests, pack, smoke, and benchmark did not run in this invocation."]
      : []),
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
  if (state.manifest === undefined) lines.push(truthOnly
    ? "Not run: truth-only scope does not execute package pack."
    : "Pending: manifest step did not complete.");
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
    const benchmarkStatus = state.benchmark?.status === "not-run" ? "not run" : "pending";
    lines.push(`- Result: ${benchmarkStatus} (${state.benchmark?.reason ?? "benchmark step did not complete"})`);
  }
  lines.push("", "## Git evidence", "");
  if (state.releaseTruth === undefined) lines.push("- Release truth: not completed", "");
  else {
    lines.push(
      `- Mode: ${state.releaseTruth.mode}`,
      `- Canonical developer branch: ${state.releaseTruth.canonicalBranch}`,
      `- Package root: ${state.releaseTruth.packageRoot}`,
      `- Immutable tag: ${state.releaseTruth.tag}`,
      `- Immutable release commit: ${state.releaseTruth.immutableCommit}`,
      `- Released baseline: ${state.releaseTruth.tag} remains at that commit; branch mode does not retag remediation HEAD`,
      `- Document markers: ${state.releaseTruth.documents}`,
      `- Branch: ${state.releaseTruth.git.branch}`,
      `- HEAD: ${state.releaseTruth.git.head ?? "unavailable"}`,
      `- Tag dereference: ${state.releaseTruth.git.tagCommit ?? "unavailable"}`,
      `- Package tree: ${state.releaseTruth.git.status?.trim() === "" ? "clean" : "dirty"}`,
      "",
    );
  }
  lines.push(`- Diff check: ${state.diffCheckPassed ? "passed" : "not completed"}`);
  lines.push("- Status (`git status --short --untracked-files=all`) is a release-truth cleanliness gate:", "", "```text");
  lines.push(state.gitStatus?.trimEnd() || "(clean or unavailable)", "```", "");
  if (state.failure !== undefined) lines.push("## Failure", "", state.failure, "");
  lines.push("This checker did not publish or mutate registry state.", "");
  return lines.join("\n");
}

async function main(reportPath, mode, truthOnly = false) {
  const state = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    commands: [],
    scope: truthOnly ? "truth-only" : "full release gate",
  };
  let temporaryRoot;
  let failed = false;
  try {
    temporaryRoot = mkdtempSync(join(tmpdir(), "rocky-release-check-"));
    const env = isolatedEnvironment(temporaryRoot);
    const gitExecutable = resolveGitExecutable(env);
    if (truthOnly) {
      assertMetadata(state);
      state.benchmark = { status: "not-run", reason: "truth-only validation" };
    } else {
      const npm = process.env.ROCKY_RELEASE_CHECK_TEST_SPAWN_ERROR === "1"
        ? { file: join(temporaryRoot, "missing-npm-executable"), argsPrefix: [] }
        : resolveNpmInvocation(env);
      const commands = releaseCheckCommandPlan(npm, packageRoot);
      state.npm = runReleaseStep(state, env, "npm version", commands.npmVersion.file, commands.npmVersion.args, commands.npmVersion.display).trim();
      runReleaseStep(state, env, "clean build and full tests", commands.fullTest.file, commands.fullTest.args, commands.fullTest.display);
      assertMetadata(state);
      state.manifest = parseManifest(runReleaseStep(
        state,
        env,
        "dry-run package manifest",
        commands.pack.file,
        commands.pack.args,
        commands.pack.display,
      ));
      runReleaseStep(
        state,
        env,
        "installed tarball smoke",
        commands.smoke.file,
        commands.smoke.args,
        commands.smoke.display,
      );

      if (process.platform === "linux" && Number(process.versions.node.split(".")[0]) === 22) {
        const benchmarkPath = join(temporaryRoot, "benchmark.json");
        runReleaseStep(
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
    }

    runReleaseStep(state, env, "git diff check", gitExecutable, ["diff", "--check"], "git diff --check");
    state.diffCheckPassed = true;
    state.gitStatus = runReleaseStep(state, env, "git status evidence", gitExecutable, ["status", "--short", "--untracked-files=all"], "git status --short --untracked-files=all");
    assertReleaseTruth(state, { mode, env, gitExecutable });
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

const launchedAsScript = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (launchedAsScript) {
  try {
    const parsed = reportArgument(process.argv.slice(2));
    await main(parsed.path, parsed.mode, parsed.truthOnly);
    process.stdout.write(`${parsed.path}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
