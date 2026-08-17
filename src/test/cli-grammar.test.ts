import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteShellPath } from "../core/shell-quote.js";
import { PACKAGE_VERSION } from "../core/package-info.js";
import { parseExactCommand } from "../commands/cli-args.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(packageRoot, "dist", "index.js");

function runCli(args: readonly string[], options: { cwd?: string; input?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "rocky-cli-grammar-home-"));
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? packageRoot,
      env: { ...process.env, ROCKY_HOME: home },
      input: options.input,
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertUsage(args: readonly string[], label: string, options: { cwd?: string; input?: string } = {}): void {
  const result = runCli(args, options);
  assert.equal(result.error, undefined, `${label}: ${String(result.error)}`);
  assert.equal(result.signal, null, label);
  assert.equal(result.status, 2, `${label}: ${result.stderr}`);
  assert.equal(result.stdout, "", label);
  assert.match(result.stderr, /usage|option|argument|query|command/i, label);
}

interface OpenStdinResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function runCliWithOpenStdin(args: readonly string[], deadlineMs = 1_500): Promise<OpenStdinResult> {
  const home = mkdtempSync(join(tmpdir(), "rocky-cli-open-stdin-home-"));
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    env: { ...process.env, ROCKY_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const close = new Promise<OpenStdinResult>((resolve) => {
    child.once("error", () => resolve({ status: null, signal: null, stdout: "", stderr: "" }));
    child.once("close", (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), deadlineMs);
    });
    const result = await Promise.race([close, deadline]);
    if (result === undefined) throw new Error(`CLI did not exit within ${deadlineMs} ms`);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (child.exitCode === null) {
      child.stdin.destroy();
      child.kill("SIGKILL");
      await Promise.race([
        close,
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("strict no-argument commands reject positional junk before opening state", () => {
  for (const command of ["stats", "mcp", "hook status", "digest", "quiz"]) {
    assertUsage(command.split(" ").concat("junk"), `${command} junk`, { input: "" });
  }
});

test("MCP junk exits with usage while stdin remains open and emits no protocol frame", async () => {
  const result = await runCliWithOpenStdin(["mcp", "junk"]);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /usage|argument|option/i);
});

test("dictionary query options are positional and -- makes leading flags literal", () => {
  assertUsage(["what", "move", "--ai"], "what trailing --ai");
  assertUsage(["how", "move", "--unknown"], "how unknown option");
  assertUsage(["why", "src/app.css", "--unknown"], "why unknown option");

  const ai = runCli(["what", "--ai", "missing-query"]);
  assert.equal(ai.status, 0, ai.stderr);
  assert.equal(ai.error, undefined);

  for (const args of [
    ["what", "--", "--ai"],
    ["how", "--", "--flag"],
    ["why", "--", "--path"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.error, undefined, `${args.join(" ")}: ${String(result.error)}`);
  }
});

test("manual check rejects positional junk before Git inspection", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rocky-cli-grammar-cwd-"));
  try {
    assertUsage(["check", "junk"], "check positional junk", { cwd });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("manual check rejects unknown flags regardless of help ordering", () => {
  for (const args of [
    ["check", "--help", "--bogus"],
    ["check", "--bogus", "--help"],
  ]) {
    assertUsage(args, args.join(" "));
  }
});

test("run uses one exact non-empty command string and preserves it", () => {
  assertUsage(["run"], "run missing command");
  assertUsage(["run", ""], "run empty command");
  assertUsage(["run", "node", "-e", "process.exit(0)"], "run multiple argv");

  const command = `${quoteShellPath(process.execPath, process.platform)} -e ${quoteShellPath(
    "process.stdout.write('run-contract-sentinel\\n')",
    process.platform,
  )}`;
  const result = runCli(["run", command]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "run-contract-sentinel\n");
  assert.doesNotMatch(result.stderr, /usage|argument/i);
});

test("exact run parser preserves quote, trailing slash, Unicode, and spaced paths", () => {
  const commands = [
    `node -e "console.log('quoted')"`,
    "echo trailing\\",
    "printf 'naïve 東京 🪐'",
    `node "C:\\Program Files\\rocky\\entry.js"`,
  ];
  for (const command of commands) {
    assert.equal(parseExactCommand([command], "rocky run <command>"), command);
  }
  assert.throws(() => parseExactCommand([], "rocky run <command>"), /exactly one/);
  assert.throws(() => parseExactCommand(["one", "two"], "rocky run <command>"), /exactly one/);
  assert.throws(() => parseExactCommand(["   "], "rocky run <command>"), /exactly one/);
});

test("help and version reject trailing arguments while clean version stays stdout-pure", () => {
  assertUsage(["--help", "junk"], "help trailing argument");
  assertUsage(["--version", "junk"], "version trailing argument");

  const help = runCli(["--help"]);
  assert.equal(help.error, undefined, String(help.error));
  assert.equal(help.signal, null);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage:/i);
  assert.equal(help.stderr, "");

  const result = runCli(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${PACKAGE_VERSION}\n`);
  assert.equal(result.stderr, "");
});
