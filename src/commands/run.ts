/**
 * `rocky run "<command>"`
 *
 * Runs the command through a shell, streaming stdout/stderr untouched.
 * On failure: fingerprints stderr, checks memory for this exact error,
 * and if Rocky has heard it before (and knows what fixed it) he says so.
 * On success: if the same program failed recently in this directory,
 * this success is recorded as the fix.
 */

import { fingerprint } from "../core/fingerprint.js";
import { runProcess, type ExecResult } from "../core/exec.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  loadMemory,
  recordFailure,
  recordFix,
  type MemoryRecord,
} from "../core/memory.js";
import { findByFingerprint, fixFromElsewhere, getFix, recentUnresolvedFailures } from "../core/memory-query.js";
import { ago, detail, say } from "../ui/rocky.js";

export async function run(cmd: string): Promise<number> {
  if (!cmd || cmd.trim().length === 0) {
    say("no command. give command, question");
    return 2;
  }

  const result = await runProcess(cmd);

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

/** An unreadable memory file is spoken, not thrown — callers get `undefined` and carry on. */
function readMemory(): MemoryRecord[] | undefined {
  try {
    return loadMemory();
  } catch {
    say("memory file does not open for me. I answer from nothing.");
    detail(`    memory: ${resolveRockyPaths().memory}`);
    return undefined;
  }
}

function onFailure(cmd: string, result: ExecResult): void {
  const memory = readMemory();
  if (memory !== undefined) {
    // result.stderr is the bounded tail (last TAIL_LINES lines, each capped
    // at MAX_LINE_BYTES), not the full stderr stream — fingerprinting now
    // sees the last 200 lines, not everything the command wrote (spec §3.6).
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
        const elsewhere = fixFromElsewhere(fix, process.cwd());
        if (elsewhere !== undefined) {
          say("but fix comes from other place.");
          detail(`    place: ${elsewhere}`);
        }
        say("try, question");
      } else {
        say("no fix in memory yet. you fix, I remember. this is good trade.");
      }
    } else {
      say(`new error. bad. I remember it now. exit code ${result.code}.`);
    }
  }

  recordFailure(cmd, result.code, result.stderr);
}

function onSuccess(cmd: string): void {
  const memory = readMemory();
  if (memory === undefined) return;
  const unresolved = recentUnresolvedFailures(memory, cmd, { cwd: process.cwd() });
  if (unresolved.length > 0) {
    recordFix(cmd, unresolved);
    say("command works now. you fix it. I remember the fix. good good good.");
  }
}
