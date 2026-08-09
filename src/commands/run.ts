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
import { CANCEL_CODES, runProcess, type ExecResult } from "../core/exec.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  loadMemory,
  recordFailure,
  recordFix,
  type MemoryRecord,
} from "../core/memory.js";
import { findByFingerprint, fixFromElsewhere, getFix, recentUnresolvedFailures } from "../core/memory-query.js";
import { ago, detail, elapsed, say } from "../ui/rocky.js";

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
    } else if (!CANCEL_CODES.has(result.code)) {
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

/**
 * Speaks what memory knows about this fingerprint: a prior sighting and its
 * fix (naming the fix's own directory when it differs from `cwd`), or that
 * this is new. Shared by `run`'s onFailure and `watch`'s failure path — spec
 * §7 names `run`, `watch`, and `_hookfail` as the three paths that must carry
 * the cross-directory admission, and this is the one place `run` and `watch`
 * can't drift on it.
 */
export function speakFailureMemory(
  memory: MemoryRecord[],
  fp: string,
  exitCode: number,
  cwd: string,
): void {
  const previous = findByFingerprint(memory, fp);

  if (previous.length > 0) {
    const first = previous[0];
    say(`I remember this error. You hear it before. ${ago(first.ts)}. Same same.`);
    const withFix = [...previous].reverse().find((f) => getFix(memory, f));
    if (withFix) {
      const fix = getFix(memory, withFix)!;
      say(`last time, you fix with:`);
      detail(`    ${fix.cmd}`);
      // Say how much this link is worth. `recall` graded strong/weak from the
      // day it shipped; run/watch/hook did not, so the surfaces people actually
      // use presented a weak "same program" guess with the same confidence as a
      // real match. A wrong fix stated plainly is worse than no fix at all.
      const basis = fix.links?.find((link) => link.id === withFix.id)?.basis;
      if (basis === "signature") {
        say(`same command, ${elapsed(fix.ts - withFix.ts)} later. strong.`);
      } else if (basis === "program") {
        say(`same program, ${elapsed(fix.ts - withFix.ts)} later. maybe not fix. check, question`);
      }
      const elsewhere = fixFromElsewhere(fix, cwd);
      if (elsewhere !== undefined) {
        say("but fix comes from other place.");
        detail(`    place: ${elsewhere}`);
      }
      say("try, question");
    } else {
      say("no fix in memory yet. you fix, I remember. this is good trade.");
    }
  } else {
    say(`new error. bad. I remember it now. exit code ${exitCode}.`);
  }
}

function onFailure(cmd: string, result: ExecResult): void {
  const memory = readMemory();
  if (memory !== undefined) {
    // result.stderr is the bounded tail (last TAIL_LINES lines, each capped
    // at MAX_LINE_BYTES), not the full stderr stream — fingerprinting now
    // sees the last 200 lines, not everything the command wrote (spec §3.6).
    speakFailureMemory(memory, fingerprint(result.stderr, cmd, result.code), result.code, process.cwd());
  }

  recordFailure(cmd, result.code, result.stderr);
}

/**
 * Links this success as the fix for any unresolved failure of the same
 * program in `cwd` within the link window, and speaks about it unless
 * `quiet`. Shared by `run`'s onSuccess and `watch`'s success path so both
 * commands apply the exact same linking rule and say the exact same
 * sentence about it.
 */
export function linkFixOnSuccess(
  memory: MemoryRecord[],
  cmd: string,
  cwd: string,
  quiet = false,
): void {
  const unresolved = recentUnresolvedFailures(memory, cmd, { cwd });
  if (unresolved.length > 0) {
    recordFix(cmd, unresolved, cwd);
    if (!quiet) say("command works now. you fix it. I remember the fix. good good good.");
  }
}

function onSuccess(cmd: string): void {
  const memory = readMemory();
  if (memory === undefined) return;
  linkFixOnSuccess(memory, cmd, process.cwd());
}
