/**
 * Rocky's ears — the shell-hook side of the CLI.
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
 * itself. The bash caller always passes `label: "bashrc"`, so its wording is
 * byte-for-byte what it was before this generalization.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { CANCEL_CODES } from "../core/exec.js";
import { commandFingerprintCandidates } from "../core/fingerprint.js";
import { renderGuardRules, rulesFileIsPristine } from "../core/guard-rules.js";
import {
  addHookBlockBytes,
  classifyHookBlock,
  powershellHookBlockCodec,
  removeHookBlockBytes,
} from "../core/hook-block.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
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
import { ago, detail, detailTty, phrase, say, sayTty } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";

/**
 * An unreadable memory file is spoken over /dev/tty, not thrown — a detached
 * hook handler must never take the shell down.
 */
function readMemory(): MemoryRecord[] | undefined {
  try {
    const loaded = loadMemoryChecked();
    if (!isCompleteMemoryCoverage(loaded.coverage)) {
      sayTty("memory coverage incomplete. I do not claim prior fix. check, question");
      detailTty(`memory coverage: version ${loaded.coverage.version}; scanned ${loaded.coverage.scanned}; skipped ${loaded.coverage.skipped}; truncated ${loaded.coverage.truncated}${loaded.coverage.reason === undefined ? "" : `; reason ${loaded.coverage.reason}`}`);
      return undefined;
    }
    return loaded.records;
  } catch {
    sayTty("memory file does not open for me. I answer from nothing.");
    detailTty(`memory: ${resolveRockyPaths().memory}`);
    return undefined;
  }
}

/** A command failed in the hooked shell. Record it; speak only if memory has something to say. */
export function hookFail(cmd: string, exitCode: number, cwd: string): number {
  if (CANCEL_CODES.has(exitCode)) return 0;

  const memory = readMemory();

  try {
    recordHookFailure(cmd, exitCode, cwd);
  } catch {
    sayTty("I cannot write memory. this one I forget.");
    detailTty(`memory: ${resolveRockyPaths().memory}`);
  }

  if (memory === undefined) return 0; // unreadable memory: recorded, but nothing to recall

  const now = Date.now();
  const fp = commandFingerprintCandidates(cmd, exitCode);
  const previous = findByFingerprint(memory, fp, now);

  if (previous.length === 0) return 0; // first time: passive ears stay quiet

  const withFix = [...previous].reverse().find((f) => getFix(memory, f, now));
  if (withFix) {
    const fix = getFix(memory, withFix, now)!;
    sayTty(`I hear this error before. ${ago(withFix.ts)}. last time, you fix with:`);
    detailTty(safeTerminalLine(fix.cmd));
    const elsewhere = fixFromElsewhere(fix, withFix.cwd);
    if (elsewhere !== undefined) {
      sayTty("but fix comes from other place.");
      detailTty(`place: ${safeTerminalLine(elsewhere)}`);
      sayTty("possible only. check, question");
    }
    sayTty("try, question");
  } else {
    const hint = deepMemoryHint(cmd);
    // No hint means the command already went through `rocky run`, so deep
    // memory exists and that run has already spoken. Passive ears stay quiet.
    if (hint) sayTty(`this error again. deep memory need stderr. run with: ${safeTerminalLine(hint)}, question`);
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

/** A command succeeded while the pending flag existed. Try to link a fix. */
export function hookSuccess(cmd: string, cwd: string, options: ResolveFixOptions = {}): number {
  try {
    const result = resolveFixOnSuccess(cmd, cwd, options);
    if (result.confirmedResolved > 0) {
      sayTty("command works now. you fix it. I remember the fix. good good good.");
    }
  } catch {
    // Detached bookkeeping must never become the hooked command's outcome.
    sayTty("I cannot write memory. this one I forget.");
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
  const origin = fromSettle
    ? `${label} keeps unclear transaction from before.`
    : `${label} write leaves unclear state.`;
  const closing = outcome.targetWritten
    ? `${label} holds unfinished write. do not trust it.`
    : "I touch nothing more.";

  if (outcome.provenCopy !== undefined && outcome.targetExists) {
    say(`${origin} I keep safe copy. ${closing}`);
    detail(`inspect: ${outcome.provenCopy}`);
  } else if (outcome.provenCopy !== undefined) {
    // outcome.targetExists here is `pathExists`, not `isLiveRegularFile`
    // (round 9, R1 — see the RecoveryOutcome.targetExists doc comment): this
    // branch fires only when the target truly does not exist at all, so
    // "gone" is a fact Rocky proved, not a guess from a topology-blind check.
    say(`${origin} ${label} gone. I keep only copy of old bytes. ${closing}`);
    detail(`safe copy: ${outcome.provenCopy}`);
  } else {
    say(`${origin} no safe copy to name. ${closing}`);
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
  if (outcome.targetWritten) {
    say(`${label} gone. I already put old bytes back from safe copy.`);
  } else {
    say(`I keep safe copy of old ${label}.`);
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
      say(`I cannot check ${label}. I touch nothing.`);
      detail(`${label}: ${rc}`);
      return { status: "stop", exit: 1 };
    }
  }

  if (metadata !== undefined) {
    const refusal = metadata.isSymbolicLink()
      ? `${label} is symlink. I touch nothing. I write only plain file.`
      : !metadata.isFile()
        ? `${label} is not regular file. I touch nothing.`
        : metadata.nlink > 1
          ? `${label} has many names. I touch nothing. I write only file with one name.`
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
    say(`${label} does not open for me. I touch nothing.`);
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
 * `label === "bashrc"` reuses the canned, voice-validated `phrase()` entry
 * for the write-protected disclosure so its text stays byte-for-byte
 * unchanged; every other label builds the same sentence shape inline, since
 * `phrase()` has no parameterized entries.
 */
function publishTarget(rc: string, label: string, staged: Buffer, prior: BytesReadResult): PublishResult {
  // The rename-based transaction below needs write permission on the
  // target's *directory*, not on the target itself, so a mode-400 file still
  // gets legitimately replaced. That is correct, but a user who locked the
  // file stated an intent — say so before touching it, rather than walking
  // past it in silence.
  if (prior.status === "valid" && prior.mode !== undefined && (prior.mode & 0o200) === 0) {
    say(label === "bashrc" ? phrase("bashrc-write-protected") : `${label} is write-protected. I replace it anyway. your lines stay.`);
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
    say(`${label}'s folder does not exist. I cannot make it. I touch nothing. check permissions, then try again.`);
    detail(`${label}: ${rc}`);
    return { exit: 1 };
  }
  let result: ConditionalBytesWriteResult;
  try {
    result = atomicWriteBytesIfUnchanged(rc, staged, prior);
  } catch {
    say(`${label} write fails. I touch nothing. check disk space and permissions, then try again.`);
    detail(`${label}: ${rc}`);
    return { exit: 1 };
  }
  if (result.status === "written" || result.status === "changed") {
    if (result.recoveryPath !== undefined) {
      pruneSupersededTransactions(rc, dirname(result.recoveryPath));
    }
    if (result.status === "written") return { exit: 0, recoveryPath: result.recoveryPath };
    if (result.recoveryPath !== undefined) {
      say(`${label} changed while I worked. your bytes win. I keep safe copy too.`);
      detail(`${label}: ${rc}`);
      detail(`safe copy: ${result.recoveryPath}`);
    } else {
      say(`${label} changed while I worked. I touch nothing. your bytes win. run command again.`);
      detail(`${label}: ${rc}`);
    }
    return { exit: 1 };
  }
  return { exit: reportRecoveryStop(rc, label, requireOutcome(result.outcome), false) };
}

/** Corrupt marker bytes are preserved byte-for-byte; repair stays manual. */
function reportCorruptBlock(rc: string, label: string): number {
  say(`hook block in ${label} is corrupt. I touch nothing. repair markers by hand, then call me again.`);
  detail(`${label}: ${rc}`);
  return 1;
}

/** Rocky voice, kept identical wherever a recovery copy needs disclosing. */
function reportRetainedCopy(label: string, recoveryPath: string): void {
  say(`I keep safe copy of old ${label}. yours to remove, any time.`);
  detail(`safe copy: ${recoveryPath}`);
}

/**
 * I3: by the time `hookInstall` writes `~/.rocky` assets, a mkdir/copy/write
 * failure here (a stray `~/.rocky` file, ENOSPC, a permissions problem) must
 * never be allowed to escape as a raw, uncaught error. Before that fix it
 * did: the process died in `index.ts`'s top-level catch with an untranslated
 * Node error string, breaking Rocky's voice, and — if a write had just
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
  say(targetPublished
    ? `${label} already changed, but rocky home breaks right after. ears maybe not working yet.`
    : `${label} not touched. rocky home breaks. ears maybe not working yet.`);
  detail(`${label}: ${rc}`);
  if (recoveryPath !== undefined) reportRetainedCopy(label, recoveryPath);
  say("check disk space and permissions, then try again.");
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
      say(`hook file missing from install: ${f}. install incomplete. bad.`);
      return 1;
    }
  }

  const rc = bashrcPath();
  const label = "bashrc";
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
      say("guard rules file has your edits. I keep them. good.");
    }
  } catch {
    return reportRockyHomeWriteFailure(rc, label, recoveryPath, bashrcPublished);
  }

  say("ears installed. open new shell, I hear everything there.");
  detail(`hook:  ${join(home, "rocky-hook.bash")}`);
  detail(`rules: ${rulesPath}`);
  if (recoveryPath !== undefined) reportRetainedCopy(label, recoveryPath);
  say("dangerous command comes, I ask first. ROCKY_OFF=1 makes me deaf.");
  // bash-preexec must read every command through `history 1`, so it strips
  // ignorespace/ignoreboth from HISTCONTROL. A command deliberately typed with
  // a leading space — the usual way to keep a token out of history — starts
  // being recorded. Rocky changes it, so Rocky says it.
  say(phrase("hook-histcontrol"));
  return 0;
}

function runBashHookUninstall(): number {
  const rc = bashrcPath();
  const label = "bashrc";
  const preparation = prepareTarget(rc, label);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc, label);
  if (classification === "absent") {
    say("no ears installed. nothing to remove.");
    return 0;
  }
  const published = publishTarget(
    rc,
    label,
    removeHookBlockBytes(preparation.snapshot.bytes),
    preparation.snapshot.prior,
  );
  if (published.exit !== 0) return published.exit;
  say(`ears removed from shell. memory stays in ${rockyHome()}. I still remember.`);
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
  const label = "bashrc";
  const preparation = prepareTarget(rc, label);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc, label);
  if (classification !== "managed") {
    say("ears not installed. run: rocky hook install");
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
    say("ears installed, but I cannot check rocky home.");
    detail(`bashrc: ${rc}`);
    return 1;
  }
  say(`ears installed. hook version ${version}. ${ruleCount} guard rule${ruleCount === 1 ? "" : "s"} active.`);
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
 */
export interface PowerShellHost {
  /** "Windows PowerShell" | "PowerShell 7" — bare, for status's per-host line. */
  label: string;
  profile: string;
  version: string;
}

/**
 * Test-only injection seam, the PowerShell equivalent of the `HOME`/
 * `USERPROFILE` override `bashrcPath()` already reads. Real production use
 * never sets this; every test that does not want to reach this machine's
 * real `$PROFILE` sets it to `"[]"` (see `hook-block.test.ts`/
 * `hook-install.test.ts`'s `bashrcSandbox`, `cli-process.test.ts`'s
 * `processSandbox`, and `scripts/package-smoke.mjs`). Malformed JSON or a
 * non-array degrades to "no hosts" rather than throwing, matching every
 * other best-effort fallback in this file.
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
 * One `-NoProfile` call returns both facts a host needs: `$PROFILE` (asked,
 * never reconstructed) and the real version (`$PSVersionTable.PSVersion`,
 * never `Get-Command`'s own `Version` field — that field is a placeholder
 * `0.0.0.0` for the WindowsApps `pwsh` execution alias on this release's own
 * dev machine). `-NoProfile` matters doubly here: it keeps this probe from
 * ever loading a real, un-sandboxed profile — including one Rocky's own
 * `hook install` already manages — as a side effect of merely asking where
 * it lives.
 */
function probePowerShellHost(executable: string): { profile: string; version: string } | undefined {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(
      executable,
      ["-NoProfile", "-Command", "$PROFILE; $PSVersionTable.PSVersion.ToString()"],
      { encoding: "utf8", windowsHide: true },
    );
  } catch {
    return undefined;
  }
  if (result.error || result.status !== 0) return undefined;
  const lines = (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return undefined;
  const [profile, version] = lines;
  if (!profile || !version) return undefined;
  return { profile, version };
}

function detectWindowsPowerShellHost(): PowerShellHost | undefined {
  if (process.platform !== "win32") return undefined;
  const probe = probePowerShellHost("powershell.exe");
  return probe && { label: "Windows PowerShell", profile: probe.profile, version: probe.version };
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
    if (probe) return { label: "PowerShell 7", profile: probe.profile, version: probe.version };
  }
  return undefined;
}

/** Every host actually present on this machine — install/uninstall/status all loop over this same list (Ruling 3). */
export function detectPowerShellHosts(): PowerShellHost[] {
  const override = testOverridePowerShellHosts();
  if (override !== undefined) return override;
  const hosts: PowerShellHost[] = [];
  const windows = detectWindowsPowerShellHost();
  if (windows) hosts.push(windows);
  const pwsh = detectPwshHost();
  if (pwsh) hosts.push(pwsh);
  return hosts;
}

const POWERSHELL_ASSET = "rocky-hook.ps1";

/** "Windows PowerShell profile" / "PowerShell 7 profile" — the shared machinery's `label` for this host's target. */
function powerShellTargetLabel(host: PowerShellHost): string {
  return `${host.label} profile`;
}

/**
 * v1 is passive ears only (Ruling 4): `prompt` only sees a command after it
 * already ran, so there is no PowerShell equivalent of the Bash hook's
 * pre-execution guard confirmation, and this install path writes no
 * `guard.rules` and prints no HISTCONTROL-style warning — there is nothing
 * here for either to describe. That limitation is stated in README, not
 * repeated on every `hook install` — the Bash tail's warnings above describe
 * mutations this call actually makes (a changed HISTCONTROL setting, an
 * active guard); this call makes neither.
 */
function installPowerShellHost(host: PowerShellHost): number {
  const rc = host.profile;
  const label = powerShellTargetLabel(host);

  if (!existsSync(join(assetDir(), POWERSHELL_ASSET))) {
    say(`hook file missing from install: ${POWERSHELL_ASSET}. install incomplete. bad.`);
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

  say(`ears installed in ${host.label}. open new shell, I hear everything there.`);
  detail(`hook: ${join(home, POWERSHELL_ASSET)}`);
  if (recoveryPath !== undefined) reportRetainedCopy(label, recoveryPath);
  say("here I only listen. I do not stop command before it runs.");
  say("ROCKY_OFF=1 makes me deaf.");
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
    say(`no ears installed in ${host.label}. nothing to remove.`);
    return 0;
  }
  const published = publishTarget(
    rc,
    label,
    powershellHookBlockCodec.remove(preparation.snapshot.bytes),
    preparation.snapshot.prior,
  );
  if (published.exit !== 0) return published.exit;
  say(`ears removed from ${host.label}. memory stays in ${rockyHome()}. I still remember.`);
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
    say(`${host.label}: not installed. run: rocky hook install`);
    return 0;
  }
  const hookFile = join(rockyHome(), POWERSHELL_ASSET);
  let version: string;
  try {
    version = existsSync(hookFile)
      ? /ROCKY_HOOK_VERSION="([^"]+)"/.exec(readFileSync(hookFile, "utf8"))?.[1] ?? "unknown"
      : "missing";
  } catch {
    say(`${host.label}: installed, but I cannot check rocky home.`);
    detail(`${label}: ${rc}`);
    return 1;
  }
  say(`${host.label}: installed, hook version ${version}, PowerShell ${host.version}.`);
  // Ruling 2's disclosed trade-off, named where a user actually meets it: the
  // only way PowerShell allows forcing $? back to False after Rocky's own
  // bookkeeping runs is a real, suppressed non-terminating error, which
  // pushes one synthetic entry onto $Error ahead of your last real error.
  // $LASTEXITCODE and $?'s value stay exact either way -- only $Error[0]'s
  // position shifts, and that entry names Rocky so it is never a phantom.
  detail("exit status stays exact. forcing it false pushes one entry into $Error first, named as mine.");
  return 0;
}

/**
 * Bash runs unconditionally, then every detected PowerShell host runs
 * unconditionally too — a stop or refusal on one target never skips another
 * (each target is independent; a user with two shells expects ears checked
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
