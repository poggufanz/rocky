/**
 * `rocky run "<command>"`
 *
 * Runs the command through a shell, streaming stdout/stderr untouched.
 * On failure: fingerprints stderr, checks memory for this exact error,
 * and if Rocky has heard it before (and knows what fixed it) he says so.
 * On success: if the same reliable command identity failed recently in this
 * directory, this success is recorded as the confirmed fix. Same-program-only
 * evidence remains a possible association.
 */

import { commandIdentity, fingerprintCandidates } from "../core/fingerprint.js";
import { CANCEL_CODES, runProcess, type ExecResult } from "../core/exec.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  recordFailure,
  resolveFixOnSuccess,
  type ResolveFixOptions,
  type ResolveFixResult,
  type FailureRecord,
  type MemoryRecord,
} from "../core/memory.js";
import { isCompleteMemoryCoverage, linkBasisRank, loadMemoryChecked } from "../core/memory-read.js";
import { findByFingerprint, fixFromElsewhere, getFix, possibleFixesForFailure, type PossibleFix } from "../core/memory-query.js";
import { ago, detail, elapsed, say } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";

export async function run(cmd: string, processRunner: (cmd: string) => Promise<ExecResult> = runProcess): Promise<number> {
  if (!cmd || cmd.trim().length === 0) {
    say("no command. give command, question");
    return 2;
  }

  const result = await processRunner(cmd);

  // Memory is bookkeeping. It must never change what the wrapped command did,
  // so a storage failure is reported and swallowed rather than propagated.
  if (result.started) {
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
  }
  return result.code;
}

/** An unreadable memory file is spoken, not thrown — callers get `undefined` and carry on. */
function readMemory(): MemoryRecord[] | undefined {
  try {
    const loaded = loadMemoryChecked();
    if (!isCompleteMemoryCoverage(loaded.coverage)) {
      say("memory coverage incomplete. I do not claim prior fix. check, question");
      detail(`    memory coverage: version ${loaded.coverage.version}; scanned ${loaded.coverage.scanned}; skipped ${loaded.coverage.skipped}; truncated ${loaded.coverage.truncated}${loaded.coverage.reason === undefined ? "" : `; reason ${loaded.coverage.reason}`}`);
      return undefined;
    }
    return loaded.records;
  } catch {
    say("memory file does not open for me. I answer from nothing.");
    detail(`    memory: ${resolveRockyPaths().memory}`);
    return undefined;
  }
}

/**
 * Speaks what memory knows about this fingerprint: a prior sighting and its
 * fix (naming the fix's own directory when it differs from linked failure cwd), or that
 * this is new. Shared by `run`'s onFailure and `watch`'s failure path — spec
 * §7 names `run`, `watch`, and `_hookfail` as the three paths that must carry
 * the cross-directory admission, and this is the one place `run` and `watch`
 * can't drift on it.
 */
export function speakFailureMemory(
  memory: MemoryRecord[],
  fp: string | readonly string[],
  cmd: string,
  exitCode: number,
  _cwd: string,
  now = Date.now(),
): void {
  const previous = findByFingerprint(memory, fp, now);

  if (previous.length > 0) {
    const first = previous[0];
    say(`I remember this error. You hear it before. ${ago(first.ts)}. Same same.`);
    const withFix = [...previous].reverse().find((f) => getFix(memory, f, now));
    if (withFix) {
      const fix = getFix(memory, withFix, now)!;
      // The recurrence match above is a stderr-signature fingerprint (see
      // `fingerprint()`): when stderr carries signature lines, the hash is
      // derived from those lines alone, never from `cmd` — so it can pair
      // this failure with a past one from a genuinely different command
      // that happened to produce a matching error shape. `fix.cmd` is
      // always identity-equal to that PAST failure's command (a confirmed
      // FixRecord only ever forms under exact identity), never to whatever
      // actually changed between runs — so it is never "the fix", only a
      // possibly-different command that happened to work. Say only what's
      // true in each case, exactly like `hookFail`'s recurrence path.
      const currentIdentity = commandIdentity(cmd);
      const fixIdentity = commandIdentity(fix.cmd, { platform: fix.platform ?? process.platform });
      const sameCommand = currentIdentity.reliable && fixIdentity.reliable && currentIdentity.value === fixIdentity.value;
      if (sameCommand) {
        say("last time, something between fix it. what, I not hear. works again, I remember.");
      } else {
        say("last time, you run:");
        detail(`    ${safeTerminalLine(fix.cmd)}`);
        say("possible fix only, question");
      }
      const elsewhere = fixFromElsewhere(fix, withFix.cwd);
      // Say how much this link is worth. `recall` graded strong/weak from the
      // day it shipped; run/watch/hook did not, so the surfaces people actually
      // use presented a weak "same program" guess with the same confidence as a
      // real match. A wrong fix stated plainly is worse than no fix at all.
      // This grade describes the historical fix<->failure link's own evidence
      // basis — a separate axis from `sameCommand` above (whether that history
      // even matches what's failing right now) — so it still prints regardless.
      const basis = fix.links?.find((link) => link.id === withFix.id)?.basis;
      if (elsewhere !== undefined) {
        say("but fix comes from other place.");
        detail(`    place: ${safeTerminalLine(elsewhere)}`);
        say("possible only. check, question");
      } else if (basis === "identity" || basis === "signature") {
        say(`same command, ${elapsed(fix.ts - withFix.ts)} later. strong.`);
      } else if (basis === "program") {
        say(`same program, ${elapsed(fix.ts - withFix.ts)} later. maybe not fix. check, question`);
      } else if (basis !== undefined) {
        // A recognized-but-weaker basis ("sequence") or a string a newer
        // writer emits that this reader does not recognize yet (spec §2.5):
        // either way it must fall to the weakest hedge, never silently print
        // no grade line at all.
        say(`different program, ${elapsed(fix.ts - withFix.ts)} later. maybe not fix. check, question`);
      }
      if (!sameCommand) say("try, question");
    } else {
      const candidate = speakablePossibleFix(memory, previous, now);
      if (candidate) {
        say("no confirmed fix. but after error, you run this:");
        detail(`    ${safeTerminalLine(candidate.cmd)}`);
        if (candidate.fromElsewhere) {
          say("but this comes from other place.");
          detail(`    place: ${safeTerminalLine(candidate.cwd)}`);
        }
        say(linkBasisRank(candidate.basis) > linkBasisRank("program")
          ? "different program. maybe fix, maybe not. check, question"
          : "maybe fix, maybe not. check, question");
      } else {
        say("no fix in memory yet. you fix, I remember. this is good trade.");
      }
    }
  } else {
    say(`new error. bad. I remember it now. exit code ${exitCode}.`);
  }
}

/**
 * Search prior sightings of this same recurring failure, most recent first,
 * for the top weak `AssociationRecord` candidate (spec §3 Fix 1). Mirrors
 * the `withFix` search above it so the two evidence classes cannot drift.
 */
function speakablePossibleFix(
  memory: MemoryRecord[],
  previous: readonly FailureRecord[],
  now: number,
): PossibleFix | undefined {
  for (const failure of [...previous].reverse()) {
    const candidate = possibleFixesForFailure(memory, failure, now)[0];
    if (candidate) return candidate;
  }
  return undefined;
}

function onFailure(cmd: string, result: ExecResult): void {
  const memory = readMemory();
  if (memory !== undefined) {
    // result.stderr is the bounded tail (last TAIL_LINES lines, each capped
    // at MAX_LINE_BYTES), not the full stderr stream — fingerprinting now
    // sees the last 200 lines, not everything the command wrote (spec §3.6).
    speakFailureMemory(memory, fingerprintCandidates(result.stderr, cmd, result.code), cmd, result.code, process.cwd());
  }

  recordFailure(cmd, result.code, result.stderr);
}

/**
 * Atomically links this success to unresolved failures in `cwd`: exact
 * reliable identity is a confirmed fix, while same-program-only evidence is
 * retained as a possible association. Shared by run and watch so attribution,
 * pending reconciliation, and the selected window cannot drift.
 */
export function linkFixOnSuccess(
  cmd: string,
  cwd: string,
  quiet = false,
  options: ResolveFixOptions = {},
): ResolveFixResult {
  const result = resolveFixOnSuccess(cmd, cwd, options);
  if (!quiet && result.confirmedResolved > 0) {
    say("command works now. something between fix it. what, I not hear. works again, I remember. good good good.");
  }
  return result;
}

function onSuccess(cmd: string): void {
  linkFixOnSuccess(cmd, process.cwd());
}
