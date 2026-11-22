/**
 * `rocky run "<command>"`
 *
 * Runs the command through a shell, streaming stdout/stderr untouched.
 * On failure: fingerprints stderr, checks memory for this exact error, and
 * says so when it was recorded before (and the same command passed again
 * after it). It never claims to know what changed in between.
 * On success: if the same reliable command identity failed recently in this
 * directory, this success is recorded as the confirmed fix. Same-program-only
 * evidence remains a possible association.
 */

import { agentStampFromEnv } from "../core/agent-session.js";
import { commandIdentity, fingerprintCandidates } from "../core/fingerprint.js";
import { CANCEL_CODES, runProcess, type ExecResult } from "../core/exec.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  boundCommand,
  recordFailure,
  resolveFixOnSuccess,
  type ResolveFixOptions,
  type ResolveFixResult,
  type FailureRecord,
  type MemoryRecord,
} from "../core/memory.js";
import { CLOCK_SKEW_MS, linkBasisRank, loadMemoryChecked, tailReadable, type AgentStamp, type MemoryCoverage } from "../core/memory-read.js";
import { findByFingerprint, fixFromElsewhere, getFix, LINK_WINDOW_MS, possibleFixesForFailure, type PossibleFix } from "../core/memory-query.js";
import { prepareLaneOneNote, type PreparedLaneOneNote } from "./attempt-note-lane.js";
import { ago, detail, gapSpan, isVerbose, phrase, say } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";

export async function run(cmd: string, processRunner: (cmd: string) => Promise<ExecResult> = runProcess): Promise<number> {
  if (!cmd || cmd.trim().length === 0) {
    say("No command given. Pass the command to run.");
    return 2;
  }

  const agent = agentStampFromEnv(process.env);
  const result = await processRunner(cmd);

  // Memory is bookkeeping. It must never change what the wrapped command did,
  // so a storage failure is reported and swallowed rather than propagated.
  if (result.started) {
    try {
      if (result.code === 0) {
        onSuccess(cmd, agent);
      } else if (!CANCEL_CODES.has(result.code)) {
        onFailure(cmd, result, agent);
      }
    } catch {
      say("Could not write to memory, so this run is not recorded.");
      detail(`    memory: ${resolveRockyPaths().memory}`);
    }
  }
  return result.code;
}

/** An unreadable memory file is reported, not thrown — callers get `undefined` and carry on. */
function readMemory(): { records: MemoryRecord[]; coverage: MemoryCoverage; historyMayStartEarlier: boolean; linesSkipped: boolean } | undefined {
  try {
    const loaded = loadMemoryChecked();
    const coverageDetail = (): string => {
      const words = describeMemoryCoverage(loaded.coverage, loaded.records.length, { counts: false });
      return !isVerbose() && words !== undefined
        ? `    ${words}`
        : `    memory coverage: version ${loaded.coverage.version}; scanned ${loaded.coverage.scanned}; skipped ${loaded.coverage.skipped}; truncated ${loaded.coverage.truncated}${loaded.coverage.reason === undefined ? "" : `; reason ${loaded.coverage.reason}`}`;
    };
    if (!tailReadable(loaded.coverage)) {
      say("Memory coverage is incomplete, so no earlier fix is claimed. Check the memory file.");
      detail(coverageDetail());
      return undefined;
    }
    if (loaded.coverage.skipped > 0) {
      detail(coverageDetail());
    }
    return {
      records: loaded.records,
      coverage: loaded.coverage,
      historyMayStartEarlier: loaded.coverage.window === "tail",
      linesSkipped: loaded.coverage.skipped > 0,
    };
  } catch {
    say("Memory file could not be opened. No records were read.");
    detail(`    memory: ${resolveRockyPaths().memory}`);
    return undefined;
  }
}

/**
 * Reports what memory holds for this fingerprint: a prior sighting and its
 * fix (naming the fix's own directory when it differs from linked failure cwd), or that
 * this is new. Shared by `run`'s onFailure and `watch`'s failure path so those
 * two paths cannot drift on the cross-directory admission. `_hookfail` has its
 * own tty speech branch and shares the prior-attempts note door
 * (`prepareLaneOneNote`), not `speakFailureMemory`.
 */
export function speakFailureMemory(
  memory: MemoryRecord[],
  fp: string | readonly string[],
  cmd: string,
  exitCode: number,
  _cwd: string,
  scope: { historyMayStartEarlier: boolean; linesSkipped: boolean },
  now = Date.now(),
): void {
  const previous = findByFingerprint(memory, fp, now);
  const partial = scope.historyMayStartEarlier || scope.linesSkipped;

  if (previous.length > 0) {
    const first = previous[0];
    say(scope.historyMayStartEarlier
      ? `Same error as before, first recorded ${ago(first.ts)} (earlier records were not read).`
      : scope.linesSkipped
        ? `Same error as before, first recorded ${ago(first.ts)} in the records read.`
        : `Same error as before, first recorded ${ago(first.ts)}.`);
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
        say(phrase("fix-recurrence-same"));
      } else {
        say("Last time, you ran:");
        detail(`    ${safeTerminalLine(fix.cmd)}`);
        say("Possible fix only.");
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
        say("But that fix comes from a different directory.");
        detail(`    place: ${safeTerminalLine(elsewhere)}`);
        say("Possible only. Check before acting.");
      } else if (basis === "identity" || basis === "signature") {
        say(`Same command, ${gapSpan(fix.ts - withFix.ts)} later. Strong link.`);
      } else if (basis === "program") {
        say(`Same program, ${gapSpan(fix.ts - withFix.ts)} later. May not be the fix. Check before acting.`);
      } else if (basis !== undefined) {
        // A recognized-but-weaker basis ("sequence") or a string a newer
        // writer emits that this reader does not recognize yet:
        // either way it must fall to the weakest hedge, never silently print
        // no grade line at all.
        say(`Different program, ${gapSpan(fix.ts - withFix.ts)} later. May not be the fix. Check before acting.`);
      }
      if (!sameCommand) say("Try that command?");
    } else {
      const candidate = speakablePossibleFix(memory, previous, now);
      if (candidate) {
        say(partial
          ? "No confirmed fix in the records read. After that error, you ran:"
          : "No confirmed fix. After that error, you ran:");
        detail(`    ${safeTerminalLine(candidate.cmd)}`);
        if (candidate.fromElsewhere) {
          say("But that command comes from a different directory.");
          detail(`    place: ${safeTerminalLine(candidate.cwd)}`);
        }
        say(linkBasisRank(candidate.basis) > linkBasisRank("program")
          ? "Different program. It may or may not be a fix. Check before acting."
          : "It may or may not be a fix. Check before acting.");
      } else {
        say(partial
          ? "No fix in the records read."
          : "No fix recorded yet.");
      }
    }
  } else {
    const checked = memory.length === 1
      ? "Only the newest record was checked."
      : `Only the newest ${memory.length} records were checked.`;
    say(scope.historyMayStartEarlier
      ? `New error recorded (exit code ${exitCode}). ${checked}`
      : scope.linesSkipped
        ? `New error recorded (exit code ${exitCode}). No match in the records read.`
        : `New error recorded (exit code ${exitCode}).`);
  }
}

/**
 * Search prior sightings of this same recurring failure, most recent first,
 * for the top weak `AssociationRecord` candidate. Mirrors
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

/** cmd.exe's English rejection text. Another locale words it differently and gets silence, not a guess. */
const CMD_EXE_REJECTION = /is not recognized as an internal or external command/i;

/**
 * Names the shell when cmd.exe rejected the command. `shell: true`, the default
 * `runProcess` path, is `%ComSpec%` (cmd.exe) on win32, so Git Bash and PowerShell
 * words fail there and are recorded as ordinary failures. Disclosure only: it
 * makes no cause claim and names no remedy command, see the phrase. `defaultShell`
 * has no default so each caller states whether it used that path. Shared by `run`
 * and `watch`.
 */
export function cmdExeHint(stderr: string, platform: NodeJS.Platform, defaultShell: boolean): string | undefined {
  if (platform !== "win32" || !defaultShell) return undefined;
  return CMD_EXE_REJECTION.test(stderr) ? phrase("cmd-exe-parsed") : undefined;
}

function onFailure(cmd: string, result: ExecResult, agent?: AgentStamp): void {
  const cwd = process.cwd();
  const memory = readMemory();
  let preparedNote: PreparedLaneOneNote | undefined;
  let noteDelivered = false;
  if (memory !== undefined) {
    // ponytail: lookup must hash the bounded command form that recordFailure stores.
    const fingerprints = fingerprintCandidates(result.stderr, boundCommand(cmd), result.code);
    const now = Date.now();
    try {
      preparedNote = prepareLaneOneNote({
        lane: "run",
        records: memory.records,
        coverage: memory.coverage,
        fingerprints,
        cwd,
        now,
        env: process.env,
        home: resolveRockyPaths().home,
      });
    } catch {
      preparedNote = undefined;
    }
    // result.stderr is the bounded tail (last TAIL_LINES lines, each capped
    // at MAX_LINE_BYTES), not the full stderr stream — fingerprinting now
    // sees the last 200 lines, not everything the command wrote.
    speakFailureMemory(
      memory.records,
      fingerprints,
      cmd,
      result.code,
      cwd,
      { historyMayStartEarlier: memory.historyMayStartEarlier, linesSkipped: memory.linesSkipped },
      now,
    );
    if (preparedNote?.text !== undefined) {
      try {
        say(preparedNote.text);
        noteDelivered = true;
      } catch {
        // Fail open: note output must never disrupt a wrapped command.
      }
    }
  }

  // About the shell, not the history, so it is said even when memory is unreadable.
  // `run` never overrides runProcess's default `shell: true`.
  const hint = cmdExeHint(result.stderr, process.platform, true);
  if (hint !== undefined) say(hint);

  let recordedId: string | null = null;
  try {
    const rec = recordFailure(cmd, result.code, result.stderr, agent);
    recordedId = rec.id;
  } finally {
    try {
      preparedNote?.finish(recordedId, noteDelivered);
    } catch {
      // Fail open: exposure logging must never disrupt a wrapped command.
    }
  }
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
  resolveFix: (cmd: string, cwd: string, options: ResolveFixOptions) => ResolveFixResult = resolveFixOnSuccess,
): ResolveFixResult {
  const result = resolveFix(cmd, cwd, options);
  if (!quiet && result.confirmedResolved > 0) {
    say(phrase("fix-linked"));
  } else if (
    !quiet &&
    result.pausedReason === "coverage" &&
    result.pausedDetail?.tail &&
    result.pausedDetail.pendingWaiting
  ) {
    if (result.pausedDetail.shortTail) {
      const hours = (options.windowMs ?? LINK_WINDOW_MS) / 3_600_000;
      const minutes = CLOCK_SKEW_MS / 60_000;
      const count = result.pausedDetail.recordsRead;
      const subject = count === 1 ? "the newest record does" : `the newest ${count} records do`;
      say(`fix linking paused: ${subject} not reach back ${hours} hours and ${minutes} minutes.`);
    } else {
      say("fix linking paused: memory coverage is incomplete.");
    }
  }
  return result;
}

function onSuccess(cmd: string, agent?: AgentStamp): void {
  linkFixOnSuccess(cmd, process.cwd(), false, { agent });
}
