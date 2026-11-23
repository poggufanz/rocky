import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FLAGS,
  assertNoAncestorInstructions,
  assertOutsideWorkspace,
  buildCommandInvocation,
  buildToolEnv,
  createSandbox,
  destroySandbox,
  packArm,
  redactText,
  resolveExecutableOnPath,
} from "./sandbox.mjs";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_DIR, "..", "..");
const FIXTURES_DIR = join(EVAL_DIR, "fixtures", "claude-md");
export const ENV_REPORT_KEYS = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "ROCKY_HOME",
  "ROCKY_TEST_SEAMS",
  "ROCKY_ATTEMPT_ARM",
  "ROCKY_AGENT_SESSION",
  "PATH",
];
export const CAPTURE_PROMPT =
  `Run npm test twice, then print only these environment variables, one per line as NAME=value: ${ENV_REPORT_KEYS.join(", ")}. Then stop.`;

function usageError(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.stderr.write(
    "Usage: node scripts/eval/capture.mjs --arm <none|before|after> [--commit <sha>] " +
    "--auth <token|copy-credentials> [--from <credentials-path>] --out <dir> [--root <dir>] [--cache <dir>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    root: join(tmpdir(), "rocky-eval"),
    arm: undefined,
    commit: undefined,
    auth: undefined,
    from: undefined,
    out: undefined,
    cache: undefined,
    keepSandbox: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep-sandbox") {
      opts.keepSandbox = true;
      continue;
    }
    const next = argv[i + 1];
    const takeValue = (flag) => {
      if (next === undefined || next.startsWith("--")) {
        usageError(`${flag} requires a value`);
      }
      i += 1;
      return next;
    };
    if (arg === "--root") opts.root = takeValue("--root");
    else if (arg === "--arm") opts.arm = takeValue("--arm");
    else if (arg === "--commit") opts.commit = takeValue("--commit");
    else if (arg === "--auth") opts.auth = takeValue("--auth");
    else if (arg === "--from") opts.from = takeValue("--from");
    else if (arg === "--out") opts.out = takeValue("--out");
    else if (arg === "--cache") opts.cache = takeValue("--cache");
    else usageError(`Unknown option: ${arg}`);
  }

  if (opts.arm !== "none" && opts.arm !== "before" && opts.arm !== "after") {
    usageError("--arm must be one of: none, before, after");
  }
  if ((opts.arm === "before" || opts.arm === "after") && !opts.commit) {
    usageError(`--commit is required for arm '${opts.arm}'`);
  }
  if (opts.auth !== "token" && opts.auth !== "copy-credentials") {
    usageError("--auth must be 'token' or 'copy-credentials'");
  }
  if (opts.auth === "copy-credentials" && !opts.from) {
    usageError("--from <credentials path> is required when --auth copy-credentials is used");
  }
  if (opts.auth === "token" && opts.from) {
    usageError("--from is only valid when --auth copy-credentials is used");
  }
  if (!opts.out) {
    usageError("--out <dir> is required");
  }
  return opts;
}

function spawnNoShell(file, args, options) {
  const env = options.env ?? process.env;
  const comSpec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
  const invocation = buildCommandInvocation(file, args, process.platform, comSpec);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function seedInlineProbeRepo(taskDir, arm, toolEnv) {
  const pkg = {
    name: "capture-probe",
    version: "1.0.0",
    private: true,
    scripts: {
      test: "node -e \"console.error('Error: capture-probe'); process.exit(1)\"",
    },
  };
  writeFileSync(join(taskDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const baseMd = readFileSync(join(FIXTURES_DIR, "base.md"), "utf8").trimEnd();
  const claudeMd = arm === "none"
    ? `${baseMd}\n`
    : `${baseMd}\n\n${readFileSync(join(FIXTURES_DIR, "rocky-section.md"), "utf8").trimEnd()}\n`;
  writeFileSync(join(taskDir, "CLAUDE.md"), claudeMd, "utf8");

  const git = resolveExecutableOnPath(
    process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"],
    toolEnv.PATH ?? "",
  );
  if (git) {
    spawnNoShell(git, ["init"], { cwd: taskDir, env: toolEnv, timeout: 30_000 });
    spawnNoShell(git, ["add", "-A"], { cwd: taskDir, env: toolEnv, timeout: 30_000 });
    spawnNoShell(
      git,
      ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "-m", "init"],
      { cwd: taskDir, env: toolEnv, timeout: 30_000 },
    );
  }
}

function parseTranscriptEvents(rawJsonl) {
  const events = [];
  for (const line of rawJsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON lines if any appeared.
    }
  }
  return events;
}

function collectStrings(value, out) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
}

function summarizeTranscript(events) {
  const initEvent = events.find(
    (event) => event?.type === "system" && event?.subtype === "init",
  ) ?? events.find((event) => Array.isArray(event?.mcp_servers));

  const hookSignals = [];
  const toolNames = [];
  const toolSeen = new Set();
  const textBlobs = [];

  for (const event of events) {
    const serialized = JSON.stringify(event);
    if (
      /"additionalContext"\s*:/.test(serialized)
      || /"hookSpecificOutput"\s*:/.test(serialized)
      || (event?.type === "system" && typeof event?.subtype === "string" && /hook/i.test(event.subtype))
    ) {
      hookSignals.push({
        type: event?.type ?? null,
        subtype: event?.subtype ?? null,
        snippet: serialized.slice(0, 240),
      });
    }

    const content = event?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_use" && typeof block?.name === "string") {
          if (!toolSeen.has(block.name)) {
            toolSeen.add(block.name);
            toolNames.push(block.name);
          }
        }
        if (block?.type === "tool_result") {
          collectStrings(block.content, textBlobs);
        }
        if (block?.type === "text" && typeof block.text === "string") {
          textBlobs.push(block.text);
        }
      }
    }
    if (typeof event?.result === "string") textBlobs.push(event.result);
    if (event?.tool_use_result !== undefined) collectStrings(event.tool_use_result, textBlobs);
  }

  const envLines = [];
  const envSeen = new Set();
  const keyPattern = ENV_REPORT_KEYS.join("|");
  const posixEnvRe = new RegExp(`^\\s*(?:${keyPattern})=.*$`, "i");
  const pwshEnvRe = new RegExp(`^\\s*(?:${keyPattern})\\s+\\S.*$`, "i");
  for (const blob of textBlobs) {
    for (const rawLine of blob.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (posixEnvRe.test(line) || pwshEnvRe.test(line)) {
        const normalized = line.trim();
        if (!envSeen.has(normalized)) {
          envSeen.add(normalized);
          envLines.push(normalized);
        }
      }
    }
  }

  return { initEvent, hookSignals, toolNames, envLines };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = resolve(opts.out);
  try {
    assertOutsideWorkspace(outDir, REPO_ROOT);
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }

  const secrets = [];
  let auth;
  if (opts.auth === "token") {
    const token = process.env.ROCKY_EVAL_OAUTH_TOKEN;
    if (typeof token !== "string" || token.length === 0) {
      process.stderr.write(
        "Error: ROCKY_EVAL_OAUTH_TOKEN is missing or empty in environment (required for --auth token).\n",
      );
      process.exit(2);
    }
    secrets.push(token);
    auth = { kind: "token" };
  } else {
    auth = { kind: "copy-credentials", from: resolve(opts.from) };
  }

  const redact = (value) => redactText(value, secrets);
  const resolvedRoot = resolve(opts.root);
  const cacheDir = opts.cache ? resolve(opts.cache) : join(resolvedRoot, "_pack-cache");

  let sandbox;
  try {
    assertNoAncestorInstructions(resolvedRoot);
    const tgz = opts.arm === "none" ? undefined : await packArm(opts.commit, cacheDir);
    const runId = `capture-${opts.arm}-${Date.now()}`;
    sandbox = await createSandbox({
      arm: opts.arm,
      runId,
      root: resolvedRoot,
      tgz,
      auth,
    });

    seedInlineProbeRepo(
      sandbox.taskDir,
      opts.arm,
      buildToolEnv(process.env, process.platform, { home: sandbox.home }),
    );

    const claudeExe = resolveExecutableOnPath(
      process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"],
      sandbox.env.PATH ?? "",
    );
    if (!claudeExe) {
      throw new Error("claude executable not found on sandbox PATH");
    }

    const versionResult = spawnNoShell(claudeExe, ["--version"], {
      cwd: sandbox.taskDir,
      env: sandbox.env,
      timeout: 30_000,
    });

    const credsFile = join(sandbox.configDir, ".credentials.json");
    const credsMtimeBefore = opts.auth === "copy-credentials" && existsSync(credsFile)
      ? statSync(credsFile).mtimeMs
      : null;

    const runResult = spawnNoShell(claudeExe, [...CLAUDE_FLAGS, CAPTURE_PROMPT], {
      cwd: sandbox.taskDir,
      env: sandbox.env,
      timeout: 300_000,
    });

    const credsMtimeAfter = opts.auth === "copy-credentials" && existsSync(credsFile)
      ? statSync(credsFile).mtimeMs
      : null;

    const redactedTranscript = redact(runResult.stdout);
    const redactedStderr = redact(runResult.stderr);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "transcript.jsonl"), redactedTranscript, "utf8");
    writeFileSync(join(outDir, "stderr.txt"), redactedStderr, "utf8");

    const advisoriesPath = join(sandbox.rockyHome, "advisories.jsonl");
    const advisoryRows = existsSync(advisoriesPath)
      ? readFileSync(advisoriesPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => redact(line))
      : [];

    const events = parseTranscriptEvents(redactedTranscript);
    const summary = summarizeTranscript(events);
    const init = summary.initEvent;

    const mcpServers = Array.isArray(init?.mcp_servers)
      ? init.mcp_servers.map((srv) => ({ name: srv?.name ?? null, status: srv?.status ?? null }))
      : [];

    const reportLines = [
      `arm: ${opts.arm}`,
      `claude --version: ${redact(versionResult.stdout.trim() || versionResult.stderr.trim() || "(unavailable)")}`,
      `claude exit: ${runResult.status}${runResult.signal ? ` (signal ${runResult.signal})` : ""}`,
      `transcript: ${join(outDir, "transcript.jsonl")}`,
      `stderr: ${join(outDir, "stderr.txt")}`,
      "",
      "init:",
      `  model: ${init?.model ?? "(missing)"}`,
      `  permissionMode: ${init?.permissionMode ?? "(missing)"}`,
      `  tools: ${Array.isArray(init?.tools) ? init.tools.join(", ") : "(missing)"}`,
      `  mcp_servers: ${mcpServers.length > 0 ? JSON.stringify(mcpServers) : "[]"}`,
      "",
      `hook/additionalContext in stream-json: ${summary.hookSignals.length > 0 ? `yes (${summary.hookSignals.length})` : "no"}`,
      ...summary.hookSignals.map((sig) => `  - ${sig.type}/${sig.subtype}: ${sig.snippet}`),
      "",
      `tools used: ${summary.toolNames.length > 0 ? summary.toolNames.join(", ") : "(none)"}`,
      "",
      "env lines:",
      ...(summary.envLines.length > 0
        ? summary.envLines.map((line) => `  ${redact(line)}`)
        : ["  (none captured)"]),
      "",
      `advisories.jsonl (${advisoryRows.length} rows):`,
      ...(advisoryRows.length > 0
        ? advisoryRows.map((row) => `  ${row}`)
        : ["  (none)"]),
    ];

    if (opts.auth === "copy-credentials") {
      const changed = credsMtimeBefore !== null && credsMtimeAfter !== null && credsMtimeBefore !== credsMtimeAfter;
      reportLines.push("", `.credentials.json mtime changed: ${changed}`);
    }

    process.stdout.write(`${redact(reportLines.join("\n"))}\n`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${redact(message)}\n`);
    process.exitCode = 1;
  } finally {
    if (sandbox && !opts.keepSandbox) {
      await destroySandbox(sandbox);
    }
  }
}

export function isMainModule(
  argv1 = process.argv[1],
  metaUrl = import.meta.url,
  realpath = realpathSync,
) {
  if (!argv1) return false;
  try {
    return realpath(argv1) === realpath(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
