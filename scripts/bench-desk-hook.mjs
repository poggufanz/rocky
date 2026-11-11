#!/usr/bin/env node
// Bench rocky-hook latency vs the noop baseline.
//
// Usage:
//   node scripts/bench-desk-hook.mjs --hook <exe> --noop <exe> --payload <file|write-1mib> --n 1000 [--via-bash]
//   node scripts/bench-desk-hook.mjs --hook <exe> --noop <exe> --mode shell-env --n 1000 [--via-bash]
//   node scripts/bench-desk-hook.mjs --make-write-payload <file>
//   node scripts/bench-desk-hook.mjs --self-test
//
// --mode desk-hook (default) runs `desk-hook claude-code` with the payload on stdin.
// --mode shell-env runs `shell-env` with CLAUDE_CONFIG_DIR as the only one of the five
// shell variables set and no stdin; --payload does not apply to it.
//
// Design: hook and noop calls interleave (pair order alternates each
// iteration) so machine drift affects both equally. Each call is one
// spawnSync timed with process.hrtime.bigint. ROCKY_HOME points at a temp
// dir whose spool is cleared every 100 calls. First-run ms is measured on a
// freshly copied exe file so Defender scans a new image.
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const SPOOL_CLEAR_EVERY = 100;
// The five variables rocky-hook shell-env reads (SHELL_ENV_VARS in rocky-proto).
const SHELL_ENV_NAMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG", "GEMINI_SETTINGS", "COPILOT_HOME"];
const SHELL_ENV_BENCH_VALUE = "C:\\bench\\claude-config";
const NO_INPUT = Buffer.alloc(0);

// Percentile method: nearest-rank. rank = ceil(p/100 * n), 1-based into the
// ascending-sorted values. Documented here so self-test and bench agree.
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) throw new Error("percentile of empty array");
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1];
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) };
}

function ms(ns) {
  return Number(ns) / 1e6;
}

function fmt(x) {
  return x.toFixed(2);
}

// Valid PreToolUse Write hook payload whose tool_input.content is ~1 MiB.
function makeWritePayloadBytes() {
  const content = "x".repeat(1024 * 1024);
  return Buffer.from(
    JSON.stringify({
      session_id: "bench-session",
      hook_event_name: "PreToolUse",
      cwd: "C:\\bench",
      tool_name: "Write",
      tool_use_id: "bench-tool-use-1",
      tool_input: { file_path: "C:\\bench\\big.txt", content },
    }),
    "utf8",
  );
}

// Valid PreToolUse Bash hook payload whose command is exactly 4096 bytes and
// carries two tokens, one password assignment, and terminal escape sequences.
function makeBash4KiBPayloadBytes() {
  const head = [
    "set -euo pipefail",
    `export GH_TOKEN="ghp_${"a".repeat(36)}"`,
    "db --password=hunter2hunter2 -e 'select 1'",
    `\u001b[31mwarning: ghp_${"b".repeat(36)}\u001b[0m`,
    "echo ok",
  ].join("\n");
  const command = `${head}\n${"#".repeat(4096 - head.length - 1)}`;
  return Buffer.from(
    JSON.stringify({
      session_id: "bench-session",
      hook_event_name: "PreToolUse",
      cwd: "C:\\bench",
      tool_name: "Bash",
      tool_use_id: "bench-tool-use-2",
      tool_input: { command, description: "Bench bash command" },
    }),
    "utf8",
  );
}

// What one run executes: argv after the exe, stdin, and the environment.
// desk-hook keeps the caller's environment. shell-env clears the five shell
// variables first, so exactly one of them (CLAUDE_CONFIG_DIR) is set on every run.
function invocationFor(mode, payload) {
  if (mode === "shell-env") {
    const env = { ...process.env };
    for (const name of SHELL_ENV_NAMES) delete env[name];
    env.CLAUDE_CONFIG_DIR = SHELL_ENV_BENCH_VALUE;
    return { argv: ["shell-env"], input: NO_INPUT, env };
  }
  return { argv: ["desk-hook", "claude-code"], input: payload, env: process.env };
}

function usage() {
  return [
    "usage:",
    "  bench-desk-hook.mjs --hook <exe> --noop <exe> --payload <file|write-1mib|bash-4kib> --n <n> [--via-bash]",
    "  bench-desk-hook.mjs --hook <exe> --noop <exe> --mode shell-env --n <n> [--via-bash]",
    "  bench-desk-hook.mjs --make-write-payload <file>",
    "  bench-desk-hook.mjs --self-test",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { hook: null, noop: null, payload: null, n: null, viaBash: false, makeWritePayload: null, selfTest: false, mode: "desk-hook" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--via-bash") out.viaBash = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--hook" || a === "--noop" || a === "--payload" || a === "--n" || a === "--make-write-payload" || a === "--mode") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      if (a === "--hook") out.hook = v;
      else if (a === "--noop") out.noop = v;
      else if (a === "--payload") out.payload = v;
      else if (a === "--n") out.n = Number(v);
      else if (a === "--mode") out.mode = v;
      else out.makeWritePayload = v;
    } else throw new Error(`unknown arg: ${a}\n${usage()}`);
  }
  if (out.mode !== "desk-hook" && out.mode !== "shell-env") throw new Error(`--mode must be desk-hook or shell-env\n${usage()}`);
  return out;
}

function selfTest() {
  // nearest-rank on 1..100: p50=50, p95=95, p99=99, p100=100
  const h = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(h, 50), 50);
  assert.equal(percentile(h, 95), 95);
  assert.equal(percentile(h, 99), 99);
  assert.equal(percentile(h, 100), 100);
  assert.equal(percentile(h, 1), 1);
  // small arrays: ceil rounding picks the upper rank
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([10, 20, 30], 50), 20);
  // stats sorts before ranking
  const s = stats([3, 1, 2]);
  assert.deepEqual([s.n, s.p50, s.p95, s.p99], [3, 2, 3, 3]);
  // payload shape: valid JSON, Write tool, ~1 MiB content
  const p = JSON.parse(makeWritePayloadBytes().toString("utf8"));
  assert.equal(p.hook_event_name, "PreToolUse");
  assert.equal(p.tool_name, "Write");
  assert.equal(p.tool_input.content.length, 1024 * 1024);
  // payload shape: valid JSON, Bash tool, 4096-byte command with secrets and ANSI
  const b = JSON.parse(makeBash4KiBPayloadBytes().toString("utf8"));
  assert.equal(b.hook_event_name, "PreToolUse");
  assert.equal(b.tool_name, "Bash");
  assert.equal(Buffer.byteLength(b.tool_input.command, "utf8"), 4096);
  assert.equal((b.tool_input.command.match(/ghp_/g) ?? []).length, 2);
  assert.ok(b.tool_input.command.includes("password="));
  assert.ok(b.tool_input.command.includes("\u001b["));
  // invocations: desk-hook keeps its argv; shell-env runs with no stdin and exactly one of the five names set
  assert.deepEqual(invocationFor("desk-hook", NO_INPUT).argv, ["desk-hook", "claude-code"]);
  const se = invocationFor("shell-env", NO_INPUT);
  assert.deepEqual(se.argv, ["shell-env"]);
  assert.equal(se.input.length, 0);
  assert.deepEqual(SHELL_ENV_NAMES.filter((name) => name in se.env), ["CLAUDE_CONFIG_DIR"]);
  console.log("self-test: OK (percentile=nearest-rank, payloads=Write/1MiB,Bash/4KiB, shell-env=one variable)");
}

// Locate Git for Windows bash.exe. NEVER WSL's C:\Windows\System32\bash.exe:
// "where" hits are filtered for System32, then well-known Git paths.
function findGitBash() {
  const found = spawnSync("where.exe", ["bash"], { encoding: "utf8" });
  if (found.status === 0) {
    for (const line of found.stdout.split(/\r?\n/)) {
      const p = line.trim();
      // Exclude WSL stubs (System32 + WindowsApps execution alias); Git's own
      // bash.exe is what Claude Code's Git-Bash hooks use.
      if (p && !/system32/i.test(p) && !/windowsapps/i.test(p) && existsSync(p)) return p;
    }
  }
  for (const dir of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]]) {
    if (!dir) continue;
    for (const sub of ["Git\\bin\\bash.exe", "Git\\usr\\bin\\bash.exe"]) {
      const p = join(dir, sub);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("Git Bash bash.exe not found (and WSL System32 bash is not acceptable); install Git for Windows");
}

// Run one exe the way Claude Code would: args + stdin for the invocation, ROCKY_HOME set.
function runOnce(exe, inv, rockyHome, bashExe) {
  const env = { ...inv.env, ROCKY_HOME: rockyHome };
  const start = process.hrtime.bigint();
  let r;
  if (bashExe) {
    // Git Bash understands C:/... paths; quote for spaces. No shell: argv direct.
    const posix = exe.replace(/\\/g, "/");
    r = spawnSync(bashExe, ["-c", `"${posix}" ${inv.argv.join(" ")}`], { input: inv.input, env });
  } else {
    r = spawnSync(exe, inv.argv, { input: inv.input, env });
  }
  const elapsed = process.hrtime.bigint() - start;
  return { ms: ms(elapsed), status: r.status, error: r.error ? String(r.error) : null };
}

// First-run on a freshly copied exe so Defender scans a new image.
function firstRun(exe, inv, bashExe) {
  const dir = mkdtempSync(join(tmpdir(), "bench-first-"));
  try {
    const copy = join(dir, `first-${process.pid}-${basename(exe)}`);
    copyFileSync(exe, copy);
    const home = join(dir, "home");
    mkdirSync(join(home, "desk", "spool"), { recursive: true });
    return runOnce(copy, inv, home, bashExe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    selfTest();
    return;
  }
  if (args.makeWritePayload) {
    writeFileSync(args.makeWritePayload, makeWritePayloadBytes());
    console.log(`wrote ${args.makeWritePayload}`);
    return;
  }
  if (!args.hook || !args.noop || !args.n) throw new Error(`missing required args\n${usage()}`);
  if (args.mode === "desk-hook" && !args.payload) throw new Error(`--payload is required for --mode desk-hook\n${usage()}`);
  if (args.mode === "shell-env" && args.payload) throw new Error("--payload does not apply to --mode shell-env");
  if (!Number.isInteger(args.n) || args.n < 1) throw new Error("--n must be a positive integer");
  const hook = resolve(args.hook);
  const noop = resolve(args.noop);
  if (!existsSync(hook)) throw new Error(`hook exe not found: ${hook}`);
  if (!existsSync(noop)) throw new Error(`noop exe not found: ${noop}`);

  let payload = NO_INPUT;
  let payloadLabel = "";
  if (args.mode === "desk-hook") {
    if (args.payload === "write-1mib") {
      payload = makeWritePayloadBytes();
      payloadLabel = "write-1mib (generated)";
    } else if (args.payload === "bash-4kib") {
      payload = makeBash4KiBPayloadBytes();
      payloadLabel = "bash-4kib (generated)";
    } else {
      payload = readFileSync(resolve(args.payload));
      payloadLabel = args.payload;
    }
  }
  const inv = invocationFor(args.mode, payload);

  const bashExe = args.viaBash ? findGitBash() : null;
  if (bashExe) console.log(`via-bash: ${bashExe}`);

  const firstHook = firstRun(hook, inv, bashExe);
  const firstNoop = firstRun(noop, inv, bashExe);
  const subject =
    args.mode === "shell-env"
      ? "mode shell-env (CLAUDE_CONFIG_DIR set, no stdin)"
      : `payload: ${payloadLabel} (${payload.length} bytes)`;
  console.log(`${subject}; n=${args.n} per exe; interleaved`);
  console.log(`first-run (freshly-copied exe, Defender scan included): hook=${fmt(firstHook.ms)}ms noop=${fmt(firstNoop.ms)}ms`);

  const home = mkdtempSync(join(tmpdir(), "bench-spool-"));
  const spool = join(home, "desk", "spool");
  mkdirSync(spool, { recursive: true });
  const hookMs = [];
  const noopMs = [];
  const diffs = [];
  let hookFail = 0;
  let noopFail = 0;
  let firstErr = null;
  try {
    for (let i = 0; i < args.n; i++) {
      // Alternate pair order each iteration so drift/order affects both equally.
      const order = i % 2 === 0 ? ["hook", "noop"] : ["noop", "hook"];
      let h;
      let q;
      for (const which of order) {
        if (which === "hook") {
          h = runOnce(hook, inv, home, bashExe);
          if (h.status !== 0) {
            hookFail++;
            if (!firstErr) firstErr = `hook status=${h.status} err=${h.error}`;
          }
        } else {
          q = runOnce(noop, inv, home, bashExe);
          if (q.status !== 0) {
            noopFail++;
            if (!firstErr) firstErr = `noop status=${q.status} err=${q.error}`;
          }
        }
      }
      hookMs.push(h.ms);
      noopMs.push(q.ms);
      diffs.push(h.ms - q.ms);
      if ((i + 1) % SPOOL_CLEAR_EVERY === 0) rmSync(spool, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const hs = stats(hookMs);
  const qs = stats(noopMs);
  const ds = stats(diffs);
  console.log(`hook: n=${hs.n} failures=${hookFail} p50=${fmt(hs.p50)}ms p95=${fmt(hs.p95)}ms p99=${fmt(hs.p99)}ms`);
  console.log(`noop: n=${qs.n} failures=${noopFail} p50=${fmt(qs.p50)}ms p95=${fmt(qs.p95)}ms p99=${fmt(qs.p99)}ms`);
  console.log(`diff (hook-noop per iteration): n=${ds.n} p50=${fmt(ds.p50)}ms p95=${fmt(ds.p95)}ms p99=${fmt(ds.p99)}ms`);
  if (firstErr) {
    console.error(`failures seen (${hookFail + noopFail}); first: ${firstErr}`);
    process.exitCode = 1;
  }
}

main();
