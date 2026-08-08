/**
 * `rocky run "<command>"`
 *
 * Runs the command through a shell, streaming stdout/stderr untouched.
 * On failure: fingerprints stderr, checks memory for this exact error,
 * and if Rocky has heard it before (and knows what fixed it) he says so.
 * On success: if the same program failed recently in this directory,
 * this success is recorded as the fix.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fingerprint } from "../core/fingerprint.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  loadMemory,
  recordFailure,
  recordFix,
} from "../core/memory.js";
import { findByFingerprint, getFix, recentUnresolvedFailures } from "../core/memory-query.js";
import { ago, detail, say } from "../ui/rocky.js";

interface RunResult {
  code: number;
  stderr: string;
}

export async function run(cmd: string): Promise<number> {
  if (!cmd || cmd.trim().length === 0) {
    say("no command. give command, question");
    return 2;
  }

  const result = await execute(cmd);

  // Memory is bookkeeping. It must never change what the wrapped command did,
  // so a storage failure is reported and swallowed rather than propagated.
  try {
    if (result.code === 0) {
      onSuccess(cmd);
    } else {
      onFailure(cmd, result);
    }
  } catch {
    say("I cannot write memory. this one I forget.");
    detail(`    memory: ${resolveRockyPaths().memory}`);
  }
  return result.code;
}

/** Shell convention: a command killed by signal N exits with 128 + N. */
function signalExit(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = constants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}

function execute(cmd: string): Promise<RunResult> {
  let stderr = "";
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ["inherit", "inherit", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      process.stderr.write(chunk); // stream through untouched
    });
    child.on("close", (code, signal) => resolve({ code: code ?? signalExit(signal), stderr }));
    child.on("error", (err) => {
      stderr += String(err.message);
      process.stderr.write(err.message + "\n");
      resolve({ code: 127, stderr });
    });
  });
}

function onFailure(cmd: string, result: RunResult): void {
  const memory = loadMemory();
  const fp = fingerprint(result.stderr);
  const previous = findByFingerprint(memory, fp);

  if (previous.length > 0) {
    const first = previous[0];
    say(`I remember this error. You hear it before. ${ago(first.ts)}. Same same.`);
    const withFix = [...previous].reverse().find((f) => getFix(memory, f));
    if (withFix) {
      const fix = getFix(memory, withFix)!;
      say(`last time, you fix with:`);
      detail(`    ${fix.cmd}`);
      say("try, question");
    } else {
      say("no fix in memory yet. you fix, I remember. this is good trade.");
    }
  } else {
    say(`new error. bad. I remember it now. exit code ${result.code}.`);
  }

  recordFailure(cmd, result.code, result.stderr);
}

function onSuccess(cmd: string): void {
  const memory = loadMemory();
  const unresolved = recentUnresolvedFailures(memory, cmd, { cwd: process.cwd() });
  if (unresolved.length > 0) {
    recordFix(cmd, unresolved);
    say("command works now. you fix it. I remember the fix. good good good.");
  }
}
