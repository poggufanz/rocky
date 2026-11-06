/**
 * rocky's shell hook: the CLI side of it.
 *
 * This file owns:
 *  - hidden handlers `_hookfail` / `_hooksuccess`, spawned in the background
 *    by rocky-hook.bash and rocky-hook.ps1 (stderr discarded — they speak
 *    over the console device: `/dev/tty` on POSIX, `\\.\CON` on native
 *    Windows, see `ui/rocky.ts`)
 *  - `rocky hook install|uninstall|status` for both Bash (`.bashrc`) and
 *    PowerShell (`$PROFILE`, both Windows PowerShell and PowerShell 7 when
 *    detected — Task 4)
 *
 * `.bashrc`/`$PROFILE` are user startup state: every mutation goes through
 * the strict byte parser in `core/hook-block.ts` and the recoverable
 * conditional transaction engine in `setup/file-transaction.ts`. In-place
 * writes are forbidden here. The transaction-safety machinery below
 * (`prepareTarget`/`publishTarget`/`settleTransactions`/`reportRecoveryStop`
 * and friends) is shell-agnostic and shared by every target — bash and every
 * detected PowerShell host alike — parameterized by a `label` used only in
 * user-facing message text, never in the parser or the transaction engine
 * itself. The bash caller always passes `label: "bashrc"`; `targetName` turns
 * that bare label into the prose name `.bashrc`.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { CANCEL_CODES } from "../core/exec.js";
import { commandFingerprintCandidates, commandIdentity } from "../core/fingerprint.js";
import { renderGuardRules, rulesFileIsPristine } from "../core/guard-rules.js";
import {
  addHookBlockBytes,
  classifyHookBlock,
  powershellHookBlockCodec,
  removeHookBlockBytes,
} from "../core/hook-block.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  boundCommand,
  drainGuardPending,
  recordHookFailure,
  resolveFixOnSuccess,
  type ResolveFixOptions,
  type MemoryRecord,
} from "../core/memory.js";
import { isCompleteMemoryCoverage, loadMemoryChecked } from "../core/memory-read.js";
import { findByFingerprint, fixFromElsewhere, getFix } from "../core/memory-query.js";
import {
  atomicWriteBytesIfUnchanged,
  inspectFileTransaction,
  pathExists,
  pruneSupersededTransactions,
  recoverFileTransaction,
} from "../setup/file-transaction.js";
import type {
  BytesReadResult,
  ConditionalBytesWriteResult,
  RecoveryOutcome,
} from "../setup/file-transaction.js";
import { quotePosixShell } from "../core/shell-quote.js";
import { ago, detail, detailTty, isVerbose, phrase, say, sayTty } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";

/**
 * The hook contract both `rocky-hook.bash` and `rocky-hook.ps1` implement.
 * Bump it whenever an installed hook file would behave differently from the
 * one this package ships, so `rocky hook status` can say a reinstall is
 * needed. Both hosts always move together: this names the protocol, not a
 * file. A test asserts both assets carry exactly this literal.
 */
export const ROCKY_HOOK_PROTOCOL_VERSION = "0.5.0";

/**
 * The line `rocky hook status` speaks when the installed hook file is older
 * (or newer) than the protocol this package implements -- or `undefined`
 * when there is nothing to say.
 *
 * `missing` and `unknown` are excluded on purpose: the version line above
 * this one already reports both, and a second line telling the person to
 * reinstall something that is not installed is noise stacked on noise.
 */
export function hookStaleLine(installed: string): string | undefined {
  if (installed === "missing" || installed === "unknown") return undefined;
  if (installed === ROCKY_HOOK_PROTOCOL_VERSION) return undefined;
  return "The installed hook file is not the version rocky expects, so hook messages can come out wrong. Run rocky hook install to update it.";
}

/**
 * An unreadable memory file is spoken over /dev/tty, not thrown — a detached
 * hook handler must never take the shell down.
 */
function readMemory(): MemoryRecord[] | undefined {
  try {
    const loaded = loadMemoryChecked();
    if (!isCompleteMemoryCoverage(loaded.coverage)) {
      sayTty("Memory coverage is incomplete, so no prior fix is claimed. Check the details below.");
      const words = describeMemoryCoverage(loaded.coverage, loaded.records.length, { counts: false });
      detailTty(!isVerbose() && words !== undefined
        ? words
        : `memory coverage: version ${loaded.coverage.version}; scanned ${loaded.coverage.scanned}; skipped ${loaded.coverage.skipped}; truncated ${loaded.coverage.truncated}${loaded.coverage.reason === undefined ? "" : `; reason ${loaded.coverage.reason}`}`);
      return undefined;
    }
    return loaded.records;
  } catch {
    sayTty("The memory file could not be opened, so nothing is recalled.");
    detailTty(`memory: ${resolveRockyPaths().memory}`);
    return undefined;
  }
}

/** A command failed in the hooked shell. Record it; speak only if memory has something to say. */
export function hookFail(cmd: string, exitCode: number, cwd: string): number {
  if (CANCEL_CODES.has(exitCode)) return 0;
  try {
    drainGuardPending();
  } catch {
    // Detached bookkeeping must never become the hooked command's outcome.
  }
  const memory = readMemory();

  try {
    recordHookFailure(cmd, exitCode, cwd);
  } catch {
    sayTty("The memory file could not be written. This event was not recorded.");
    detailTty(`memory: ${resolveRockyPaths().memory}`);
  }

  if (memory === undefined) return 0; // unreadable memory: recorded, but nothing to recall

  const now = Date.now();
  const fp = commandFingerprintCandidates(cmd, exitCode);
  const previous = findByFingerprint(memory, fp, now);

  if (previous.length === 0) return 0; // first time: the hook stays quiet

  const withFix = [...previous].reverse().find((f) => getFix(memory, f, now));
  if (withFix) {
    const fix = getFix(memory, withFix, now)!;
    // The recurrence match above is a coarse, masked fingerprint on `cmd`
    // (no stderr reaches a detached hook handler) — it can pair the current
    // failure with a past one whose literal command differs (a masked
    // number, a different filename). `fix.cmd` is always identity-equal to
    // that PAST failure's command (resolveFixOnSuccess only ever confirms a
    // fix under exact identity), never to whatever actually changed between
    // runs — so it is never "the fix", only a possibly-different command
    // that happened to work. Say only what's true in each case.
    const currentIdentity = commandIdentity(cmd);
    const fixIdentity = commandIdentity(fix.cmd, { platform: fix.platform ?? process.platform });
    const sameCommand = currentIdentity.reliable && fixIdentity.reliable && currentIdentity.value === fixIdentity.value;
    sayTty(`Same error as before, recorded ${ago(withFix.ts)}.`);
    if (sameCommand) {
      sayTty(phrase("fix-recurrence-same"));
    } else {
      sayTty("Last time, you ran:");
      detailTty(safeTerminalLine(fix.cmd));
      sayTty("Possible fix only.");
    }
    const elsewhere = fixFromElsewhere(fix, withFix.cwd);
    if (elsewhere !== undefined) {
      sayTty("But that fix comes from a different directory.");
      detailTty(`place: ${safeTerminalLine(elsewhere)}`);
      sayTty("Possible only. Check before acting.");
    }
    if (!sameCommand) sayTty("Try that command?");
  } else if (!isTypoSymptom(cmd, exitCode)) {
    const hint = deepMemoryHint(cmd);
    // No hint means the command already went through `rocky run`, so the full
    // stderr record exists and that run has already reported. The hook stays
    // quiet.
    if (hint) sayTty(`Same error again. The hook captures only the command, not stderr. To capture stderr too, run: ${safeTerminalLine(hint)}`);
  }
  return 0;
}

/**
 * The deep-memory suggestion, quoted so it survives a copy and paste, or
 * undefined when the command is already a `rocky run` and wrapping it again
 * would add nothing.
 */
export function deepMemoryHint(cmd: string): string | undefined {
  if (/^\s*rocky\s+run\b/.test(cmd)) return undefined;
  return `rocky run ${quotePosixShell(cmd)}`;
}

/**
 * Is this failure a typo rather than a real error?
 *
 * The deep-memory hint asks the person to re-run the command under
 * `rocky run` so rocky can capture its stderr. Good advice for a real error,
 * useless for a misspelling -- nobody wants to wrap `gti` in anything. And
 * typos are the most frequent failure in any terminal, so this is the
 * message the hint produces most often.
 *
 * One signal: exit 127, the POSIX command-not-found code. Bash sends it
 * natively; `rocky-hook.ps1` reports it when the failure was a
 * CommandNotFoundException. Both hosts now answer the same question the
 * same way, and rocky never has to guess.
 *
 * An earlier attempt guessed from PATH instead, and it was wrong on
 * PowerShell in the ordinary case: cmdlets, functions, and aliases live in
 * the shell's own command table, never on the filesystem, so `Get-Item`
 * looked exactly like a misspelling. rocky takes what the shell reports; it
 * does not go looking for evidence the shell already has.
 *
 * Only command-not-found is covered. A missing *file* (`cat nofile.txt`,
 * exit 1) is indistinguishable from an ordinary failure without stderr, and
 * a detached hook handler never receives stderr. Half the symptom class is
 * out of reach in this lane; saying so beats pretending otherwise.
 *
 * `cmd` stays in the signature: the caller reads as a question about this
 * failure, not about a bare number, and a future host that needs its own
 * disambiguation will need it.
 */
export function isTypoSymptom(cmd: string, exitCode: number): boolean {
  return exitCode === 127;
}

/** A command succeeded while the pending flag existed. Try to link a fix. */
export function hookSuccess(cmd: string, cwd: string, options: ResolveFixOptions = {}): number {
  try {
    drainGuardPending();
  } catch {
    // Detached bookkeeping must never become the hooked command's outcome.
  }
  try {
    const result = resolveFixOnSuccess(cmd, cwd, options);
    if (result.confirmedResolved > 0) {
      sayTty(phrase("fix-linked"));
      // The hook speaks one prompt late, so this line can read as being about
      // the next command. Name the one it is about, bounded and redacted
      // exactly as memory stores it, never the raw argument.
      detailTty(`command: ${safeTerminalLine(boundCommand(cmd))}`);
    }
  } catch {
    // Detached bookkeeping must never become the hooked command's outcome.
    sayTty("The memory file could not be written. This event was not recorded.");
    detailTty(`memory: ${resolveRockyPaths().memory}`);
  }
  return 0;
}

/** Legacy string helpers — thin wrappers over the strict byte parser. */
export function hasHookBlock(content: string): boolean {
  return classifyHookBlock(Buffer.from(content, "utf8")) === "managed";
}

export function addHookBlock(content: string): string {
  return addHookBlockBytes(Buffer.from(content, "utf8")).toString("utf8");
}

export function removeHookBlock(content: string): string {
  return removeHookBlockBytes(Buffer.from(content, "utf8")).toString("utf8");
}

function rockyHome(): string {
  return resolveRockyPaths().home;
}

function bashrcPath(): string {
  return join(homedir(), ".bashrc");
}

/** The bare label the bash caller passes through the shared target machinery. */
const BASHRC_LABEL = "bashrc";

/**
 * How a sentence names a target. Detail lines (`label: path`) keep the bare
 * label; prose writes the startup file the way people do, with its dot.
 */
function targetName(label: string): string {
  return label === BASHRC_LABEL ? ".bashrc" : label;
}

function assetDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "shell");
}

/**
 * Merges outcome facts across a settle loop that may recover more than one
 * stale transaction directory before reaching a clear state: any write or
 * removal an earlier iteration performed stays true once a later
 * iteration's own facts are folded in.
 */
function mergeOutcome(base: RecoveryOutcome | undefined, next: RecoveryOutcome): RecoveryOutcome {
  if (base === undefined) return next;
  return {
    transactionDirectory: next.transactionDirectory ?? base.transactionDirectory,
    provenCopy: next.provenCopy ?? base.provenCopy,
    targetExists: next.targetExists,
    targetWritten: base.targetWritten || next.targetWritten,
    artifactRetainedUnproven: base.artifactRetainedUnproven || next.artifactRetainedUnproven,
  };
}

/**
 * Every engine call this module makes populates `outcome`. This only guards
 * against a future engine regression silently dropping it — the point of
 * the record is that no message function ever falls back to re-deriving
 * facts from the filesystem itself, the exact pattern this round replaces.
 */
function requireOutcome(outcome: RecoveryOutcome | undefined): RecoveryOutcome {
  if (outcome === undefined) {
    throw new Error("internal: recovery outcome missing from engine result");
  }
  return outcome;
}

/**
 * Speaks only what `outcome` proves — established once, by the code that
 * acted, at the moment it acted (`file-transaction.ts`'s `RecoveryOutcome`).
 * This function makes no filesystem check of its own; every clause below
 * reads a field already on the record (final audit: "a name exists" is not
 * "the data is safe", and no message may re-derive that distinction later
 * from a bare path).
 *
 * No branch here ever instructs the user to do anything (round 9, R1 — the
 * primary finding of the sixth generation of this defect class). Earlier
 * rounds named a proven copy and then added an imperative telling the user
 * what to type: "restore by copying that file to the bashrc path yourself".
 * That instruction's correctness depended on a fact this function cannot
 * prove — what `cp` (or the user's own hand) does when it reaches the
 * bashrc path — and it is false exactly when bashrc is a live symlink to
 * real content: the copy follows the link and overwrites the user's actual
 * file, the precise failure R1 reproduced. A message may state what Rocky
 * proved (an artifact exists at this path and holds content, bashrc was or
 * was not written by this call, a transaction is unfinished) and nothing
 * more; every remedy verb is gone from every branch below, not only the one
 * R1 named, because the same call site cannot tell which remaining
 * imperative is safe for a path it does not control. `fromSettle` selects
 * between two histories that must not share a sentence: a transaction left
 * behind by an earlier, already-finished invocation ("from before") versus
 * this very call's own write turning ambiguous (final audit, F5).
 *
 * `label` names the target in every sentence below ("bashrc" for the Bash
 * hook, "Windows PowerShell profile" / "PowerShell 7 profile" for the
 * PowerShell hosts) — generalized so this one audited implementation serves
 * every target instead of being forked per shell. The Bash caller always
 * passes `"bashrc"`, so its wording is unchanged.
 */
function reportRecoveryStop(rc: string, label: string, outcome: RecoveryOutcome, fromSettle: boolean): number {
  const name = targetName(label);
  const origin = fromSettle
    ? `${name} has an unclear transaction left from an earlier run.`
    : `The write to ${name} left an unclear state.`;
  const closing = outcome.targetWritten
    ? `${name} holds an unfinished write. Do not trust it.`
    : "No further changes were made.";

  if (outcome.provenCopy !== undefined && outcome.targetExists) {
    say(`${origin} A safe copy is kept. ${closing}`);
    detail(`inspect: ${outcome.provenCopy}`);
  } else if (outcome.provenCopy !== undefined) {
    // outcome.targetExists here is `pathExists`, not `isLiveRegularFile`
    // (round 9, R1 — see the RecoveryOutcome.targetExists doc comment): this
    // branch fires only when the target truly does not exist at all, so
    // "gone" is a fact rocky proved, not a guess from a check that ignores topology.
    say(`${origin} ${name} is gone. Only a copy of the old bytes is kept. ${closing}`);
    detail(`safe copy: ${outcome.provenCopy}`);
  } else {
    say(`${origin} There is no safe copy to name. ${closing}`);
    // m2: every outcome that can reach this branch (provenCopy undefined)
    // sets `transactionDirectory` and `artifactRetainedUnproven` from the
    // same boolean — the three outcomes that could disagree always set
    // provenCopy instead, routing to a branch above. The `transaction
    // directory:` arm this ternary used to have for artifactRetainedUnproven
    // === false was therefore unreachable dead code (round 8, m2/B18).
    if (outcome.transactionDirectory !== undefined) {
      // r9: states only that the directory exists and is unclear — no verb
      // about removing it, matching README's categorical "never invites you
      // to destroy" even in this leftover-artifact case.
      detail(`unclear leftover: ${outcome.transactionDirectory}`);
    }
  }
  detail(`${label}: ${rc}`);
  return 1;
}

type SettleResult =
  | { status: "clear"; outcome?: RecoveryOutcome }
  | { status: "stop"; exit: number };

/**
 * Recover interrupted bashrc transactions before any byte is trusted. A
 * manual/ambiguous recovery stops the command instead of continuing from
 * stale assumptions. A transaction actually recovered here belonged to some
 * earlier, already-finished invocation — not this call's own write — so its
 * outcome (when one exists) is carried back for the caller to disclose
 * rather than silently absorbed (whole-branch re-review, Minor 1).
 */
function settleTransactions(rc: string, label: string): SettleResult {
  let outcome: RecoveryOutcome | undefined;
  for (;;) {
    const inspection = inspectFileTransaction(rc);
    if (inspection.status === "clear") return { status: "clear", outcome };
    const recovery = recoverFileTransaction(rc);
    if (recovery.status === "manual") {
      return {
        status: "stop",
        exit: reportRecoveryStop(rc, label, mergeOutcome(outcome, requireOutcome(recovery.outcome)), true),
      };
    }
    // Recovered: fold this iteration's facts in, then re-inspect from fresh
    // state before proceeding — another stale directory may still remain.
    if (recovery.status === "recovered") {
      outcome = mergeOutcome(outcome, requireOutcome(recovery.outcome));
    }
  }
}

interface TargetSnapshot {
  prior: BytesReadResult;
  bytes: Buffer;
}

type TargetPreparation =
  | { status: "ready"; snapshot: TargetSnapshot }
  | { status: "stop"; exit: number };

/**
 * Discloses a stale, already-finished transaction that settling recovered —
 * not this call's own write. Two genuinely different things can have
 * happened, and the message must match which one actually did (final audit,
 * Important 1): settling can finish the bookkeeping for a transaction whose
 * publish had already reached bashrc before this call ever started (bashrc
 * unchanged, a copy is simply retained), or it can restore bashrc itself
 * from that copy because bashrc did not exist a moment ago and does now.
 * Both facts are read directly off `outcome.targetWritten` — proven by the
 * engine at the moment it acted, not inferred here from a before/after
 * snapshot (closes final audit F7's unpinned conjunct structurally, not
 * just narrowly). The finalize branch never promises the copy is "yours to
 * remove, any time": a publish later in this same invocation can still
 * supersede it (final audit, F4) — only a write's own, genuinely final
 * disclosure (`reportRetainedCopy`) makes that promise.
 */
function reportSettledRecovery(label: string, outcome: RecoveryOutcome): void {
  const name = targetName(label);
  if (outcome.targetWritten) {
    say(`${name} was gone. The old bytes were already put back from the safe copy.`);
  } else {
    say(`A safe copy of the old ${name} is kept.`);
  }
  if (outcome.provenCopy !== undefined) detail(`safe copy: ${outcome.provenCopy}`);
}

/**
 * Settle pending transactions, refuse unsafe topology (symlink, non-regular,
 * multi-linked), and snapshot current bytes/mode. A missing bashrc snapshots
 * as `missing` so install still creates it.
 *
 * Settling is shared by install/uninstall/status, so this is the one place
 * a stale recovery's disclosure and pruning happen — every caller gets the
 * same accurate report of what settling just did, not only whichever
 * command the reviewer's own reproduction happened to name (final audit:
 * apply the fix to the class of message, not the one instance reproduced).
 * The disclosure happens before any later stop in this function returns
 * (final audit, F6): a stop that follows a mutating settle must never claim
 * nothing was touched.
 */
function prepareTarget(rc: string, label: string): TargetPreparation {
  const settled = settleTransactions(rc, label);
  if (settled.status === "stop") return { status: "stop", exit: settled.exit };

  if (settled.outcome !== undefined
    && (settled.outcome.targetWritten || settled.outcome.provenCopy !== undefined)) {
    reportSettledRecovery(label, settled.outcome);
    pruneSupersededTransactions(rc, settled.outcome.transactionDirectory);
  }

  let metadata: Stats | undefined;
  try {
    metadata = lstatSync(rc);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      say(`${targetName(label)} could not be checked. Nothing was changed.`);
      detail(`${label}: ${rc}`);
      return { status: "stop", exit: 1 };
    }
  }

  if (metadata !== undefined) {
    const name = targetName(label);
    const refusal = metadata.isSymbolicLink()
      ? `${name} is a symlink. Nothing was changed. Only plain files are written.`
      : !metadata.isFile()
        ? `${name} is not a regular file. Nothing was changed.`
        : metadata.nlink > 1
          ? `${name} has more than one hard link. Nothing was changed. Only files with one link are written.`
          : undefined;
    if (refusal !== undefined) {
      say(refusal);
      detail(`${label}: ${rc}`);
      return { status: "stop", exit: 1 };
    }
  }
  if (metadata === undefined) {
    return {
      status: "ready",
      snapshot: { prior: { status: "missing" }, bytes: Buffer.alloc(0) },
    };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(rc);
  } catch {
    say(`${targetName(label)} could not be opened. Nothing was changed.`);
    detail(`${label}: ${rc}`);
    return { status: "stop", exit: 1 };
  }
  return {
    status: "ready",
    snapshot: { prior: { status: "valid", bytes, mode: metadata.mode & 0o777 }, bytes },
  };
}

interface PublishResult {
  exit: number;
  /** Set only when this write left a live retained copy of the prior bytes. */
  recoveryPath?: string;
}

/**
 * Publish staged bytes only while the target still matches the snapshot.
 *
 * A successful publish, and a refusal that had to displace the target before
 * discovering a concurrent edit, both retain one recovery copy of the
 * previous bytes (`result.recoveryPath`). Callers must report that path
 * instead of claiming nothing was touched — see Important 2 of the
 * whole-branch review. Once a fresh copy commits, any older superseded
 * copies for this same target are pruned so at most one survives.
 *
 * `label === BASHRC_LABEL` reuses the catalog `phrase()` entry for the
 * write-protected disclosure; every other label builds the same sentence
 * shape inline, since `phrase()` has no parameterized entries.
 */
function publishTarget(rc: string, label: string, staged: Buffer, prior: BytesReadResult): PublishResult {
  // The rename-based transaction below needs write permission on the
  // target's *directory*, not on the target itself, so a mode-400 file still
  // gets legitimately replaced. That is correct, but a user who locked the
  // file stated an intent — say so before touching it, rather than walking
  // past it in silence.
  if (prior.status === "valid" && prior.mode !== undefined && (prior.mode & 0o200) === 0) {
    say(label === BASHRC_LABEL ? phrase("bashrc-write-protected") : `${label} is write-protected. Replacing it anyway; your lines are kept.`);
  }
  // F1: the target's parent directory is bashrc's inherited assumption --
  // $HOME always exists, so bashrc never needed this. `$PROFILE` breaks that
  // assumption: `Documents\WindowsPowerShell\` is not created by a default
  // Windows install, only by a user who has already customized their profile
  // once, so a default-state user hits ENOENT here on the very first
  // install. Recursive mkdir is idempotent (a no-op when the directory
  // already exists, the bashrc case on every real machine), and this runs
  // only here, immediately before the write it exists to enable -- every
  // earlier refusal above (settle, symlink/non-regular/multi-link, corrupt
  // block) has already had its chance to stop this call before anything is
  // created. A failure here is reported with its own message, distinct from
  // the write failure below: "directory missing" and "cannot write" send a
  // user to check two different things, and the pre-fix message sent every
  // reader to check disk space and permissions when the real problem was
  // that the directory was never there to write into.
  try {
    mkdirSync(dirname(rc), { recursive: true });
  } catch {
    say(`${targetName(label)}'s folder does not exist and could not be created. Nothing was changed. Check permissions, then try again.`);
    detail(`${label}: ${rc}`);
    return { exit: 1 };
  }
  let result: ConditionalBytesWriteResult;
  try {
    result = atomicWriteBytesIfUnchanged(rc, staged, prior);
  } catch {
    say(`Writing ${targetName(label)} failed. Nothing was changed. Check disk space and permissions, then try again.`);
    detail(`${label}: ${rc}`);
    return { exit: 1 };
  }
  if (result.status === "written" || result.status === "changed") {
    if (result.recoveryPath !== undefined) {
      pruneSupersededTransactions(rc, dirname(result.recoveryPath));
    }
    if (result.status === "written") return { exit: 0, recoveryPath: result.recoveryPath };
    if (result.recoveryPath !== undefined) {
      say(`${targetName(label)} changed during the write. The newer content was kept, and a safe copy is kept too.`);
      detail(`${label}: ${rc}`);
      detail(`safe copy: ${result.recoveryPath}`);
    } else {
      say(`${targetName(label)} changed during the write, so nothing was written. Run the command again.`);
      detail(`${label}: ${rc}`);
    }
    return { exit: 1 };
  }
  return { exit: reportRecoveryStop(rc, label, requireOutcome(result.outcome), false) };
}

/** Corrupt marker bytes are preserved byte-for-byte; repair stays manual. */
function reportCorruptBlock(rc: string, label: string): number {
  say(`The hook block in ${targetName(label)} is corrupt. Nothing was changed. Repair the markers by hand, then run the command again.`);
  detail(`${label}: ${rc}`);
  return 1;
}

/** One wording, kept identical wherever a recovery copy needs disclosing. */
function reportRetainedCopy(label: string, recoveryPath: string): void {
  say(`A safe copy of the old ${targetName(label)} is kept. You can remove it at any time.`);
  detail(`safe copy: ${recoveryPath}`);
}

/**
 * I3: by the time `hookInstall` writes `~/.rocky` assets, a mkdir/copy/write
 * failure here (a stray `~/.rocky` file, ENOSPC, a permissions problem) must
 * never be allowed to escape as a raw, uncaught error. Before that fix it
 * did: the process died in `index.ts`'s top-level catch with an untranslated
 * Node error string instead of a rocky message, and — if a write had just
 * displaced the previous `.bashrc` — leaving that retained copy's path
 * unprinted, falsifying README's unconditional promise that install prints
 * it whenever one survives.
 *
 * `targetPublished` states which of `hookInstall`'s two paths reached this
 * call (round 9, R2): a fresh install (`classification === "absent"`)
 * publishes the target before ever reaching this code, but a re-install onto
 * an already-managed block never publishes anything and skips straight to
 * these same `~/.rocky` writes. The two paths need two different sentences —
 * one asserting a mutation that provably happened, one stating plainly that
 * none did — never one sentence covering both, which is false on whichever
 * path did not write.
 */
function reportRockyHomeWriteFailure(
  rc: string,
  label: string,
  recoveryPath: string | undefined,
  targetPublished: boolean,
): number {
  const name = targetName(label);
  say(targetPublished
    ? `${name} was already changed, but writing to the rocky home folder failed afterward. The hook may not work yet.`
    : `${name} was not changed, and writing to the rocky home folder failed. The hook may not work yet.`);
  detail(`${label}: ${rc}`);
  if (recoveryPath !== undefined) reportRetainedCopy(label, recoveryPath);
  say("Check disk space and permissions, then try again.");
  return 1;
}

/** Every bash-specific message/order below is unchanged from before this file's PowerShell generalization. */
function runBashHookInstall(): number {
  // Check installability before writing anything: a missing hook asset must
  // fail before any write, exactly like the bashrc topology/corrupt refusals
  // below it (Minor: hookInstall must not write ~/.rocky assets ahead of a
  // refusal whose message claims nothing was touched).
  const assets = ["rocky-hook.bash", "bash-preexec.sh"];
  for (const f of assets) {
    if (!existsSync(join(assetDir(), f))) {
      say(`A hook file is missing from the install: ${f}. The install is incomplete.`);
      return 1;
    }
  }

  const rc = bashrcPath();
  const label = BASHRC_LABEL;
  const preparation = prepareTarget(rc, label);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc, label);

  let recoveryPath: string | undefined;
  const bashrcPublished = classification === "absent";
  if (bashrcPublished) {
    const published = publishTarget(
      rc,
      label,
      addHookBlockBytes(preparation.snapshot.bytes),
      preparation.snapshot.prior,
    );
    if (published.exit !== 0) return published.exit;
    recoveryPath = published.recoveryPath;
    // On Windows only Git Bash reads this file. On a machine where the person
    // lives in PowerShell, the success line below would read as if every shell
    // has the hook, so a file this call really made says so. An existing file, or
    // one made on an earlier call, is never claimed.
    if (process.platform === "win32" && preparation.snapshot.prior.status === "missing") {
      say(phrase("bashrc-created"));
    }
  }

  const home = rockyHome();
  try {
    mkdirSync(home, { recursive: true });
    for (const f of assets) {
      copyFileSync(join(assetDir(), f), join(home, f));
    }
  } catch {
    return reportRockyHomeWriteFailure(rc, label, recoveryPath, bashrcPublished);
  }

  const rulesPath = join(home, "guard.rules");
  try {
    if (!existsSync(rulesPath) || rulesFileIsPristine(readFileSync(rulesPath, "utf8"))) {
      writeFileSync(rulesPath, renderGuardRules(), "utf8");
    } else {
      say("The guard rules file has your edits, so it was left as is.");
    }
  } catch {
    return reportRockyHomeWriteFailure(rc, label, recoveryPath, bashrcPublished);
  }

  say("Hook installed in Bash. Open a new shell to activate it.");
  detail(`hook:  ${join(home, "rocky-hook.bash")}`);
  detail(`rules: ${rulesPath}`);
  if (recoveryPath !== undefined) reportRetainedCopy(label, recoveryPath);
  say("The guard asks before a dangerous command runs. Set ROCKY_OFF=1 to turn the hook off.");
  // bash-preexec must read every command through `history 1`, so it strips
  // ignorespace/ignoreboth from HISTCONTROL. A command deliberately typed with
  // a leading space — the usual way to keep a token out of history — starts
  // being recorded. rocky changes it, so rocky says it.
  say(phrase("hook-histcontrol"));
  return 0;
}

function runBashHookUninstall(): number {
  const rc = bashrcPath();
  const label = BASHRC_LABEL;
  const preparation = prepareTarget(rc, label);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc, label);
  if (classification === "absent") {
    say("No hook installed in Bash. Nothing to remove.");
    return 0;
  }
  const published = publishTarget(
    rc,
    label,
    removeHookBlockBytes(preparation.snapshot.bytes),
    preparation.snapshot.prior,
  );
  if (published.exit !== 0) return published.exit;
  say(`Hook removed from Bash. Memory stays in ${rockyHome()}.`);
  if (published.recoveryPath !== undefined) reportRetainedCopy(label, published.recoveryPath);
  return 0;
}

/**
 * Status shares `prepareTarget` with install/uninstall so it never diverges
 * from them: it settles any pending transaction, refuses (via lstat) the same
 * symlink/non-regular/multi-link topology, and reports corrupt truthfully —
 * instead of following symlinks through `existsSync`/`readFileSync` and
 * telling the user to run a command that install would then refuse.
 *
 * Settling can write bashrc: it can convert a stale, already-finished
 * transaction from an earlier crashed invocation into a permanently retained
 * copy, and — when bashrc itself was missing — restore it from that copy.
 * `status` never edits the hook block itself; the README says exactly that,
 * not that it "never writes bashrc" (that claim was checked here and found
 * false: settling a `displaced`-holding transaction over an absent bashrc
 * recreates it, silently, unless disclosed — final audit, Important 1).
 *
 * A read-only status that never settled anything was considered and
 * rejected: `hook status settles a pending transaction instead of reporting
 * stale state` already pins settling as status's behavior (an earlier
 * round, not this one), and reverting that would both weaken an existing
 * assertion (forbidden except for the two pinned false claims this round
 * corrects, and this is not one of them) and leave the exact stale,
 * secret-holding transaction directory this paragraph exists to disclose
 * sitting unrecovered instead. Accurate disclosure — via `prepareTarget`,
 * shared by every caller so none of them can silently do this and stay quiet
 * about it — is the only remaining option that satisfies "status must
 * recover what install/uninstall would", "status must not silently retain
 * secrets it did not mention", and "status must not silently rewrite bashrc
 * without saying so" all at once.
 */
function runBashHookStatus(): number {
  const rc = bashrcPath();
  const label = BASHRC_LABEL;
  const preparation = prepareTarget(rc, label);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc, label);
  if (classification !== "managed") {
    say("Bash: not installed. Run rocky hook install to enable it.");
    return 0;
  }
  // r3: these reads used to sit outside any try/catch, so a non-ENOENT
  // failure (rocky-hook.bash replaced by a directory, EACCES, ...) reached
  // index.ts's top-level catch as a raw Node error string — the same class
  // I3 already closed for hookInstall's writes, left open here for status's
  // reads.
  const hookFile = join(rockyHome(), "rocky-hook.bash");
  const rulesPath = join(rockyHome(), "guard.rules");
  let version: string;
  let ruleCount: number;
  try {
    version = existsSync(hookFile)
      ? /ROCKY_HOOK_VERSION="([^"]+)"/.exec(readFileSync(hookFile, "utf8"))?.[1] ?? "unknown"
      : "missing";
    ruleCount = existsSync(rulesPath)
      ? readFileSync(rulesPath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length
      : 0;
  } catch {
    say("Bash: installed, but the rocky home folder could not be checked.");
    detail(`bashrc: ${rc}`);
    return 1;
  }
  say(`Bash: installed, hook version ${version}, ${ruleCount} guard rule${ruleCount === 1 ? "" : "s"} active.`);
  const stale = hookStaleLine(version);
  if (stale) say(stale);
  return 0;
}

/**
 * PowerShell hosts (Ruling 3, task-4-brief). `rocky-hook.ps1` is a
 * Windows-only surface — the managed-block install story, `$PROFILE`
 * semantics, and console codepage handling it depends on do not apply
 * off Windows. `powershell.exe` (Windows PowerShell) only ever exists on
 * win32, so `detectWindowsPowerShellHost` naturally returns nothing
 * elsewhere. `pwsh` (PowerShell 7) is a cross-platform *binary*, though —
 * ubuntu-latest and macos-latest GitHub runners ship it preinstalled — so
 * `detectPwshHost` gates on `process.platform === "win32"` explicitly too;
 * finding a `pwsh` executable on PATH is necessary but never sufficient to
 * decide the hook applies. On Windows, `pwsh` is probed PATH first, then
 * the two documented Windows install roots — bare `pwsh` was found, on
 * this release's own dev machine, not to resolve reliably through every
 * spawn path even though it is on `PATH` via a WindowsApps execution
 * alias, so the fallback is not speculative. `$PROFILE` is always asked
 * from the host itself, never reconstructed — this machine's own profile
 * paths are OneDrive-redirected, which a hardcoded algorithm would miss
 * entirely.
 *
 * That same "ask the real host" design has a sharp edge: `probePowerShellHost`
 * spawns the real `powershell.exe`/`pwsh.exe` on `PATH`, a process Node never
 * constructs from `homedir()`/`USERPROFILE` — it resolves `$PROFILE` through
 * its own environment, which a sandboxed `USERPROFILE`/`HOME` (CI, tests,
 * stress sandboxes) does not reach. Left unguarded, `detectPowerShellHosts`
 * would report this machine's real profile even while every other target in
 * this file (bashrc via `bashrcPath()`, rockyHome) correctly stays inside the
 * sandbox — and `hook uninstall` run inside that sandbox would then strip the
 * Rocky block from the real profile. Not hypothetical: stress testing hit
 * this exactly (2026-08-18 findings, #2) — a real, OneDrive-redirected profile
 * got written outside the sandbox it was supposed to be confined to.
 * `detectPowerShellHosts` therefore checks every probed profile against
 * `os.homedir()` (`profileWithinHome`, below `detectPowerShellHosts` itself)
 * before ever admitting a host — the PowerShell equivalent of `bashrcPath()`
 * already honoring `HOME`/`USERPROFILE` through `homedir()`, just enforced
 * after the probe instead of before it, since `$PROFILE` is only known once
 * the host has already answered.
 *
 * The same probe asks the host for its effective execution policy, because a
 * profile only runs when the policy lets it: Windows PowerShell 5.1 ships
 * `Restricted`, which refuses every script, `$PROFILE` included. Install and
 * status say so instead of claiming a working hook (`policyBlocksProfile`). The
 * probe runs without `PSExecutionPolicyPreference`: a parent that set a
 * Process-scope policy (`Set-ExecutionPolicy -Scope Process`, or an automation
 * harness) hands it to every child through that variable, and
 * `Get-ExecutionPolicy` would then report the parent's `Bypass` for a shell
 * whose own policy refuses the profile (see `probeEnvironment`, which also
 * drops the variable that would stop that cmdlet from loading at all).
 */
export interface PowerShellHost {
  /** "Windows PowerShell" | "PowerShell 7" — bare, for status's per-host line. */
  label: string;
  profile: string;
  version: string;
  /**
   * The effective execution policy ("Restricted", "RemoteSigned", ...) exactly
   * as the host reported it. Absent when the host did not say; Rocky makes no
   * claim from a missing answer.
   */
  policy?: string;
}

/**
 * Test-only injection seam, the PowerShell equivalent of the `HOME`/
 * `USERPROFILE` override `bashrcPath()` already reads. Real production use
 * never sets this; every test that does not want to reach this machine's
 * real `$PROFILE` sets it to `"[]"` (see `hook-block.test.ts`/
 * `hook-install.test.ts`'s `bashrcSandbox`, `cli-process.test.ts`'s
 * `processSandbox`, and `scripts/package-smoke.mjs`). Malformed JSON or a
 * non-array degrades to "no hosts" rather than throwing, matching every
 * other best-effort fallback in this file. This seam keeps absolute
 * precedence over the home-containment guard documented on `PowerShellHost`
 * above: `detectPowerShellHosts` returns the override, when set, before ever
 * probing a real host or checking `profileWithinHome`, so injected test
 * profiles never need to actually live under the test process's home. An
 * entry may also carry `policy`, standing in for the probe's third line.
 */
function testOverridePowerShellHosts(): PowerShellHost[] | undefined {
  const raw = process.env.ROCKY_TEST_POWERSHELL_HOSTS;
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PowerShellHost =>
      typeof entry === "object" && entry !== null
      && typeof (entry as Record<string, unknown>).label === "string"
      && typeof (entry as Record<string, unknown>).profile === "string"
      && typeof (entry as Record<string, unknown>).version === "string");
  } catch {
    return [];
  }
}

/**
 * True when `policy` is one that refuses Rocky's unsigned profile block:
 * `Restricted` runs no script at all and `AllSigned` runs only signed ones.
 * Any other policy, and no answer at all (`undefined`), is no claim.
 */
export function policyBlocksProfile(policy: string | undefined): boolean {
  return policy === "Restricted" || policy === "AllSigned";
}

const POLICY_PREFERENCE_KEY = "psexecutionpolicypreference";
const MODULE_PATH_KEY = "psmodulepath";

/**
 * `env` without `PSExecutionPolicyPreference`, matched in any letter case:
 * Windows variable names are case-insensitive, and a plain-object copy of
 * `process.env` is not. Returns a new object and never mutates `env`.
 */
export function withoutPolicyPreference(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== POLICY_PREFERENCE_KEY) kept[key] = value;
  }
  return kept;
}

/**
 * The environment a probe runs in: a fresh shell's own view of itself. Two
 * variables make a child PowerShell answer for whichever PowerShell launched
 * this process instead. `PSExecutionPolicyPreference` carries a Process-scope
 * policy down (`withoutPolicyPreference`). `PSModulePath` carries the launching
 * edition's module folders: a PowerShell 7 parent puts its own first, and
 * Windows PowerShell 5.1 then cannot load `Microsoft.PowerShell.Security`, the
 * module `Get-ExecutionPolicy` lives in. Each host builds its default module
 * path itself when the variable is absent.
 */
function probeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(withoutPolicyPreference(env))) {
    if (key.toLowerCase() !== MODULE_PATH_KEY) kept[key] = value;
  }
  return kept;
}

interface HostProbe {
  profile: string;
  version: string;
  policy?: string;
}

/**
 * One `-NoProfile` call returns every fact a host needs: `$PROFILE` (asked,
 * never reconstructed), the real version (`$PSVersionTable.PSVersion`, never
 * `Get-Command`'s own `Version` field — that field is a placeholder `0.0.0.0`
 * for the WindowsApps `pwsh` execution alias on this release's own dev
 * machine) and the effective execution policy. `-NoProfile` matters doubly
 * here: it keeps this probe from ever loading a real, un-sandboxed profile —
 * including one Rocky's own `hook install` already manages — as a side effect
 * of merely asking where it lives.
 *
 * The policy line is optional on the way back, and a missing one must never
 * cost a host: when `Get-ExecutionPolicy` fails the exit status turns to 1
 * although `$PROFILE` and the version already came back clean, so the exit
 * status is not consulted. Two answers make a host whose policy Rocky makes
 * no claim about; fewer than two make no host. A probe killed before it
 * answered (no status at all) is not trusted either.
 */
function probePowerShellHost(executable: string): HostProbe | undefined {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(
      executable,
      ["-NoProfile", "-Command", "$PROFILE; $PSVersionTable.PSVersion.ToString(); (Get-ExecutionPolicy).ToString()"],
      { encoding: "utf8", windowsHide: true, env: probeEnvironment(process.env) },
    );
  } catch {
    return undefined;
  }
  if (result.error || result.status === null) return undefined;
  const lines = (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return undefined;
  const [profile, version, policy] = lines;
  if (!profile || !version) return undefined;
  return { profile, version, policy };
}

function detectWindowsPowerShellHost(): PowerShellHost | undefined {
  if (process.platform !== "win32") return undefined;
  const probe = probePowerShellHost("powershell.exe");
  return probe && { label: "Windows PowerShell", ...probe };
}

function detectPwshHost(): PowerShellHost | undefined {
  // `pwsh` is a real binary on Linux/macOS (GitHub's ubuntu-latest and
  // macos-latest runners ship it preinstalled), but the PowerShell hook
  // itself is Windows-only — finding the executable does not mean the
  // hook applies. Gate on platform before ever probing for it.
  if (process.platform !== "win32") return undefined;
  const candidates = ["pwsh"];
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"));
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
  for (const candidate of candidates) {
    if (candidate !== "pwsh" && !existsSync(candidate)) continue;
    const probe = probePowerShellHost(candidate);
    if (probe) return { label: "PowerShell 7", ...probe };
  }
  return undefined;
}

/**
 * True when `profilePath` resolves under `home` — the containment check
 * behind the guard documented on `PowerShellHost` above. Exported as a pure
 * function, independent of `os.homedir()` and of ever spawning PowerShell,
 * so the boundary logic is unit-testable directly.
 *
 * Uses `path.relative`, not a string prefix check, specifically because a
 * prefix check has a real boundary bug here: `"C:\\Users\\mf"` is a string
 * prefix of `"C:\\Users\\mfaiq\\..."` even though the latter is a sibling
 * directory, not a descendant. `path.relative` compares path *segments*, so
 * that trap resolves correctly (the first differing segment is `mf` vs
 * `mfaiq`, giving a `".."`-leading result, i.e. not contained) without any
 * separate boundary-safe special-casing. A result of `""` means the two
 * paths are the same directory, treated as contained; a result that is
 * itself absolute means Windows put them on different drives entirely, which
 * `path.relative` cannot express as a `".."`-relative walk — also correctly
 * not contained.
 *
 * `path.resolve` on both sides normalizes `/` vs `\` and relative segments
 * before comparison. Case-folded only on win32: NTFS/ReFS are
 * case-preserving but not case-sensitive, so `C:\Users\Name` and
 * `c:\users\name` name the same directory there; POSIX filesystems are
 * case-sensitive, and folding case there would wrongly admit a path that is
 * genuinely distinct on disk.
 */
export function profileWithinHome(profilePath: string, home: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const resolvedProfile = normalize(profilePath);
  const resolvedHome = normalize(home);
  if (resolvedProfile === resolvedHome) return true;
  const rel = relative(resolvedHome, resolvedProfile);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Applies the home-containment guard to one probed host: passes it through
 * unchanged when its profile lives under `home`, otherwise discloses the
 * refusal (once, one line, matching this file's other skip/absent
 * disclosures) and drops it. A dropped host never silently vanishes — a real
 * user with an exotic setup (e.g. a Documents folder moved to another drive)
 * needs to see why `hook install`/`status` stopped finding a host that
 * `powershell.exe`/`pwsh.exe` itself just confirmed exists.
 *
 * `ROCKY_HOOK_ALLOW_PROFILE_OUTSIDE_HOME=1` is the explicit-consent escape
 * hatch for setups where `$PROFILE` legitimately lives outside
 * `os.homedir()` — classic Group-Policy Folder Redirection points Documents
 * (and so `$PROFILE`) at a UNC share like `\\fileserver\home\user`, which no
 * containment check can bless. Consent must be per-invocation and explicit
 * (an env var the user sets, never a default) because the guard exists to
 * stop a *sandboxed* USERPROFILE from ever reaching the real profile; a
 * config file or silent allowlist would be readable by the very sandbox the
 * guard defends against. The admission is disclosed the same one-line way as
 * the refusal, so `status` output always says which regime is in force. The
 * refusal names the variable on the same line: it is the only place a person
 * learns the escape hatch exists, and a refusal with no way forward is a dead
 * end. A refused host still exits clean — it is simply not a target.
 */
export function admitHostWithinHome(host: PowerShellHost | undefined, home: string): PowerShellHost | undefined {
  if (!host) return undefined;
  if (profileWithinHome(host.profile, home)) return host;
  if (process.env.ROCKY_HOOK_ALLOW_PROFILE_OUTSIDE_HOME === "1") {
    detail(`${host.label} profile is outside the home folder. You allowed it, so it will be changed.`);
    return host;
  }
  detail(`${host.label} profile is outside the home folder, so it is skipped and nothing there is changed. To allow it, set ROCKY_HOOK_ALLOW_PROFILE_OUTSIDE_HOME=1.`);
  return undefined;
}

/**
 * Every host actually present on this machine — install/uninstall/status all
 * loop over this same list (Ruling 3). The one choke point for the
 * home-containment guard too (see `PowerShellHost` above): every host is
 * passed through `admitHostWithinHome` before it ever reaches this list, so
 * install/uninstall/status all inherit the guard uniformly rather than each
 * needing their own copy of it.
 */
export function detectPowerShellHosts(): PowerShellHost[] {
  const override = testOverridePowerShellHosts();
  if (override !== undefined) return override;
  // Each probe starts a real PowerShell, and a cold start takes a second or
  // more: without a word the command looks hung. The probes stay synchronous —
  // an async detour would save about a quarter second — so rocky says so once,
  // before the first one starts. Off win32 no probe runs, so nothing is said.
  if (process.platform === "win32") detail("Asking PowerShell where its profile lives. This can take a moment.");
  const home = homedir();
  const hosts: PowerShellHost[] = [];
  const windows = admitHostWithinHome(detectWindowsPowerShellHost(), home);
  if (windows) hosts.push(windows);
  const pwsh = admitHostWithinHome(detectPwshHost(), home);
  if (pwsh) hosts.push(pwsh);
  return hosts;
}

const POWERSHELL_ASSET = "rocky-hook.ps1";

/** "Windows PowerShell profile" / "PowerShell 7 profile" — the shared machinery's `label` for this host's target. */
function powerShellTargetLabel(host: PowerShellHost): string {
  return `${host.label} profile`;
}

/**
 * What rocky says in place of any "hook works" claim when the host's execution
 * policy refuses to load its profile. The managed block is written either way,
 * but a profile PowerShell will not run records nothing. The fix named is the
 * smallest one PowerShell offers a person without administrator rights.
 */
function reportBlockedPolicy(host: PowerShellHost): void {
  say(`${host.label} blocks scripts under its current execution policy, so the hook cannot load.`);
  detail("fix: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned");
}

/**
 * v1 is passive observation only (Ruling 4): `prompt` only sees a command after it
 * already ran, so there is no PowerShell equivalent of the Bash hook's
 * pre-execution guard confirmation, and this install path writes no
 * `guard.rules` and prints no HISTCONTROL-style warning — there is nothing
 * here for either to describe. That limitation is stated in README, not
 * repeated on every `hook install` — the Bash tail's warnings above describe
 * mutations this call actually makes (a changed HISTCONTROL setting, an
 * active guard); this call makes neither.
 *
 * A blocking execution policy changes only the words: the profile is still
 * written and the exit code stays 0, because `hookInstall` aggregates exit
 * codes across hosts and another host must not fail for this one's policy.
 */
function installPowerShellHost(host: PowerShellHost): number {
  const rc = host.profile;
  const label = powerShellTargetLabel(host);

  if (!existsSync(join(assetDir(), POWERSHELL_ASSET))) {
    say(`A hook file is missing from the install: ${POWERSHELL_ASSET}. The install is incomplete.`);
    return 1;
  }

  const preparation = prepareTarget(rc, label);
  if (preparation.status === "stop") return preparation.exit;
  const classification = powershellHookBlockCodec.classify(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc, label);

  let recoveryPath: string | undefined;
  const profilePublished = classification === "absent";
  if (profilePublished) {
    const published = publishTarget(
      rc,
      label,
      powershellHookBlockCodec.add(preparation.snapshot.bytes),
      preparation.snapshot.prior,
    );
    if (published.exit !== 0) return published.exit;
    recoveryPath = published.recoveryPath;
  }

  const home = rockyHome();
  try {
    mkdirSync(home, { recursive: true });
    copyFileSync(join(assetDir(), POWERSHELL_ASSET), join(home, POWERSHELL_ASSET));
  } catch {
    return reportRockyHomeWriteFailure(rc, label, recoveryPath, profilePublished);
  }

  if (policyBlocksProfile(host.policy)) {
    reportBlockedPolicy(host);
  } else {
    say(`Hook installed in ${host.label}. Open a new shell to activate it.`);
  }
  detail(`hook: ${join(home, POWERSHELL_ASSET)}`);
  if (recoveryPath !== undefined) reportRetainedCopy(label, recoveryPath);
  say("The hook only observes here. It does not stop a command before it runs.");
  say("Set ROCKY_OFF=1 to turn the hook off.");
  return 0;
}

function uninstallPowerShellHost(host: PowerShellHost): number {
  const rc = host.profile;
  const label = powerShellTargetLabel(host);
  const preparation = prepareTarget(rc, label);
  if (preparation.status === "stop") return preparation.exit;
  const classification = powershellHookBlockCodec.classify(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc, label);
  if (classification === "absent") {
    say(`No hook installed in ${host.label}. Nothing to remove.`);
    return 0;
  }
  const published = publishTarget(
    rc,
    label,
    powershellHookBlockCodec.remove(preparation.snapshot.bytes),
    preparation.snapshot.prior,
  );
  if (published.exit !== 0) return published.exit;
  say(`Hook removed from ${host.label}. Memory stays in ${rockyHome()}.`);
  if (published.recoveryPath !== undefined) reportRetainedCopy(label, published.recoveryPath);
  return 0;
}

function statusPowerShellHost(host: PowerShellHost): number {
  const rc = host.profile;
  const label = powerShellTargetLabel(host);
  const preparation = prepareTarget(rc, label);
  if (preparation.status === "stop") return preparation.exit;
  const classification = powershellHookBlockCodec.classify(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc, label);
  if (classification !== "managed") {
    say(`${host.label}: not installed. Run rocky hook install to enable it.`);
    return 0;
  }
  const hookFile = join(rockyHome(), POWERSHELL_ASSET);
  let version: string;
  try {
    version = existsSync(hookFile)
      ? /ROCKY_HOOK_VERSION="([^"]+)"/.exec(readFileSync(hookFile, "utf8"))?.[1] ?? "unknown"
      : "missing";
  } catch {
    say(`${host.label}: installed, but the rocky home folder could not be checked.`);
    detail(`${label}: ${rc}`);
    return 1;
  }
  // The profile holds Rocky's block, but "installed" is only true of the file.
  // Under a blocking policy status says what install says, with the facts the
  // ordinary line carries kept as a plain detail.
  if (policyBlocksProfile(host.policy)) {
    reportBlockedPolicy(host);
    detail(`hook version ${version}, PowerShell ${host.version}.`);
  } else {
    say(`${host.label}: installed, hook version ${version}, PowerShell ${host.version}.`);
  }
  const stale = hookStaleLine(version);
  if (stale) say(stale);
  // Ruling 2's disclosed trade-off, named where a user actually meets it: the
  // only way PowerShell allows forcing $? back to False after Rocky's own
  // bookkeeping runs is a real, suppressed non-terminating error, which
  // pushes one synthetic entry onto $Error ahead of your last real error.
  // $LASTEXITCODE and $?'s value stay exact either way -- only $Error[0]'s
  // position shifts, and that entry names Rocky so it is never a phantom.
  detail("Exit status stays exact. Forcing it back to false pushes one entry onto $Error first; that entry names rocky-hook.");
  return 0;
}

/**
 * Bash runs unconditionally, then every detected PowerShell host runs
 * unconditionally too — a stop or refusal on one target never skips another
 * (each target is independent; a user with two shells expects the hook checked
 * in both, not an early exit after the first). Exit code aggregation keeps
 * the Bash-only exit code byte-for-byte where it already was: every existing
 * bash-focused test suppresses PowerShell-host detection entirely (see
 * `testOverridePowerShellHosts`), so `hosts` is always empty there and these
 * loops are no-ops, leaving `bashExit` as the sole determinant exactly as
 * before this generalization.
 */
export function hookInstall(): number {
  const bashExit = runBashHookInstall();
  let hostsFailed = false;
  for (const host of detectPowerShellHosts()) {
    if (installPowerShellHost(host) !== 0) hostsFailed = true;
  }
  if (bashExit !== 0) return bashExit;
  return hostsFailed ? 1 : 0;
}

export function hookUninstall(): number {
  const bashExit = runBashHookUninstall();
  let hostsFailed = false;
  for (const host of detectPowerShellHosts()) {
    if (uninstallPowerShellHost(host) !== 0) hostsFailed = true;
  }
  if (bashExit !== 0) return bashExit;
  return hostsFailed ? 1 : 0;
}

export function hookStatus(): number {
  const bashExit = runBashHookStatus();
  let hostsFailed = false;
  for (const host of detectPowerShellHosts()) {
    if (statusPowerShellHost(host) !== 0) hostsFailed = true;
  }
  if (bashExit !== 0) return bashExit;
  return hostsFailed ? 1 : 0;
}
