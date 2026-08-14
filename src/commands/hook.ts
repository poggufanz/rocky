/**
 * Rocky's ears — the shell-hook side of the CLI.
 *
 * This file owns:
 *  - hidden handlers `_hookfail` / `_hooksuccess`, spawned in the background
 *    by rocky-hook.bash (stderr discarded — they speak via /dev/tty)
 *  - `rocky hook install|uninstall|status` (Task 6)
 *
 * `.bashrc` is user startup state: every mutation goes through the strict
 * byte parser in `core/hook-block.ts` and the recoverable conditional
 * transaction engine in `setup/file-transaction.ts`. In-place writes are
 * forbidden here.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFingerprint } from "../core/fingerprint.js";
import { CANCEL_CODES } from "../core/exec.js";
import { renderGuardRules, rulesFileIsPristine } from "../core/guard-rules.js";
import {
  addHookBlockBytes,
  classifyHookBlock,
  removeHookBlockBytes,
} from "../core/hook-block.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  loadMemory,
  recordHookFailure,
  resolveFixOnSuccess,
  type ResolveFixOptions,
  type MemoryRecord,
} from "../core/memory.js";
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
    return loadMemory();
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

  const fp = commandFingerprint(cmd, exitCode);
  const previous = findByFingerprint(memory, fp);

  if (previous.length === 0) return 0; // first time: passive ears stay quiet

  const withFix = [...previous].reverse().find((f) => getFix(memory, f));
  if (withFix) {
    const fix = getFix(memory, withFix)!;
    sayTty(`I hear this error before. ${ago(withFix.ts)}. last time, you fix with:`);
    detailTty(safeTerminalLine(fix.cmd));
    const elsewhere = fixFromElsewhere(fix, cwd);
    if (elsewhere !== undefined) {
      sayTty("but fix comes from other place.");
      detailTty(`place: ${safeTerminalLine(elsewhere)}`);
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
 */
function reportBashrcRecoveryStop(rc: string, outcome: RecoveryOutcome, fromSettle: boolean): number {
  const origin = fromSettle
    ? "bashrc keeps unclear transaction from before."
    : "bashrc write leaves unclear state.";
  const closing = outcome.targetWritten
    ? "bashrc holds unfinished write. do not trust it."
    : "I touch nothing more.";

  if (outcome.provenCopy !== undefined && outcome.targetExists) {
    say(`${origin} I keep safe copy. ${closing}`);
    detail(`inspect: ${outcome.provenCopy}`);
  } else if (outcome.provenCopy !== undefined) {
    // outcome.targetExists here is `pathExists`, not `isLiveRegularFile`
    // (round 9, R1 — see the RecoveryOutcome.targetExists doc comment): this
    // branch fires only when bashrc truly does not exist at all, so "bashrc
    // gone" is a fact Rocky proved, not a guess from a topology-blind check.
    say(`${origin} bashrc gone. I keep only copy of old bytes. ${closing}`);
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
  detail(`bashrc: ${rc}`);
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
function settleBashrcTransactions(rc: string): SettleResult {
  let outcome: RecoveryOutcome | undefined;
  for (;;) {
    const inspection = inspectFileTransaction(rc);
    if (inspection.status === "clear") return { status: "clear", outcome };
    const recovery = recoverFileTransaction(rc);
    if (recovery.status === "manual") {
      return {
        status: "stop",
        exit: reportBashrcRecoveryStop(rc, mergeOutcome(outcome, requireOutcome(recovery.outcome)), true),
      };
    }
    // Recovered: fold this iteration's facts in, then re-inspect from fresh
    // state before proceeding — another stale directory may still remain.
    if (recovery.status === "recovered") {
      outcome = mergeOutcome(outcome, requireOutcome(recovery.outcome));
    }
  }
}

interface BashrcSnapshot {
  prior: BytesReadResult;
  bytes: Buffer;
}

type BashrcPreparation =
  | { status: "ready"; snapshot: BashrcSnapshot }
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
function reportSettledRecovery(outcome: RecoveryOutcome): void {
  if (outcome.targetWritten) {
    say("bashrc gone. I already put old bytes back from safe copy.");
  } else {
    say("I keep safe copy of old bashrc.");
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
function prepareBashrc(rc: string): BashrcPreparation {
  const settled = settleBashrcTransactions(rc);
  if (settled.status === "stop") return { status: "stop", exit: settled.exit };

  if (settled.outcome !== undefined
    && (settled.outcome.targetWritten || settled.outcome.provenCopy !== undefined)) {
    reportSettledRecovery(settled.outcome);
    pruneSupersededTransactions(rc, settled.outcome.transactionDirectory);
  }

  let metadata: Stats | undefined;
  try {
    metadata = lstatSync(rc);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      say("I cannot check bashrc. I touch nothing.");
      detail(`bashrc: ${rc}`);
      return { status: "stop", exit: 1 };
    }
  }

  if (metadata !== undefined) {
    const refusal = metadata.isSymbolicLink()
      ? "bashrc is symlink. I touch nothing. I write only plain file."
      : !metadata.isFile()
        ? "bashrc is not regular file. I touch nothing."
        : metadata.nlink > 1
          ? "bashrc has many names. I touch nothing. I write only file with one name."
          : undefined;
    if (refusal !== undefined) {
      say(refusal);
      detail(`bashrc: ${rc}`);
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
    say("bashrc does not open for me. I touch nothing.");
    detail(`bashrc: ${rc}`);
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
 * Publish staged bytes only while bashrc still matches the snapshot.
 *
 * A successful publish, and a refusal that had to displace bashrc before
 * discovering a concurrent edit, both retain one recovery copy of the
 * previous bytes (`result.recoveryPath`). Callers must report that path
 * instead of claiming nothing was touched — see Important 2 of the
 * whole-branch review. Once a fresh copy commits, any older superseded
 * copies for this same target are pruned so at most one survives.
 */
function publishBashrc(rc: string, staged: Buffer, prior: BytesReadResult): PublishResult {
  // The rename-based transaction below needs write permission on bashrc's
  // *directory*, not on bashrc itself, so a mode-400 bashrc still gets
  // legitimately replaced. That is correct, but a user who locked the file
  // stated an intent — say so before touching it, rather than walking past
  // it in silence.
  if (prior.status === "valid" && prior.mode !== undefined && (prior.mode & 0o200) === 0) {
    say(phrase("bashrc-write-protected"));
  }
  let result: ConditionalBytesWriteResult;
  try {
    result = atomicWriteBytesIfUnchanged(rc, staged, prior);
  } catch {
    say("bashrc write fails. I touch nothing. check disk space and permissions, then try again.");
    detail(`bashrc: ${rc}`);
    return { exit: 1 };
  }
  if (result.status === "written" || result.status === "changed") {
    if (result.recoveryPath !== undefined) {
      pruneSupersededTransactions(rc, dirname(result.recoveryPath));
    }
    if (result.status === "written") return { exit: 0, recoveryPath: result.recoveryPath };
    if (result.recoveryPath !== undefined) {
      say("bashrc changed while I worked. your bytes win. I keep safe copy too.");
      detail(`bashrc: ${rc}`);
      detail(`safe copy: ${result.recoveryPath}`);
    } else {
      say("bashrc changed while I worked. I touch nothing. your bytes win. run command again.");
      detail(`bashrc: ${rc}`);
    }
    return { exit: 1 };
  }
  return { exit: reportBashrcRecoveryStop(rc, requireOutcome(result.outcome), false) };
}

/** Corrupt marker bytes are preserved byte-for-byte; repair stays manual. */
function reportCorruptBlock(rc: string): number {
  say("hook block in bashrc is corrupt. I touch nothing. repair markers by hand, then call me again.");
  detail(`bashrc: ${rc}`);
  return 1;
}

/** Rocky voice, kept identical wherever a recovery copy needs disclosing. */
function reportRetainedCopy(recoveryPath: string): void {
  say("I keep safe copy of old bashrc. yours to remove, any time.");
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
 * `bashrcPublished` states which of `hookInstall`'s two paths reached this
 * call (round 9, R2): a fresh install (`classification === "absent"`)
 * publishes `.bashrc` before ever reaching this code, but a re-install onto
 * an already-managed block never publishes anything and skips straight to
 * these same `~/.rocky` writes. The two paths need two different sentences —
 * one asserting a mutation that provably happened, one stating plainly that
 * none did — never one sentence covering both, which is false on whichever
 * path did not write.
 */
function reportRockyHomeWriteFailure(
  rc: string,
  recoveryPath: string | undefined,
  bashrcPublished: boolean,
): number {
  say(bashrcPublished
    ? "bashrc already changed, but rocky home breaks right after. ears maybe not working yet."
    : "bashrc not touched. rocky home breaks. ears maybe not working yet.");
  detail(`bashrc: ${rc}`);
  if (recoveryPath !== undefined) reportRetainedCopy(recoveryPath);
  say("check disk space and permissions, then try again.");
  return 1;
}

export function hookInstall(): number {
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
  const preparation = prepareBashrc(rc);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc);

  let recoveryPath: string | undefined;
  const bashrcPublished = classification === "absent";
  if (bashrcPublished) {
    const published = publishBashrc(
      rc,
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
    return reportRockyHomeWriteFailure(rc, recoveryPath, bashrcPublished);
  }

  const rulesPath = join(home, "guard.rules");
  try {
    if (!existsSync(rulesPath) || rulesFileIsPristine(readFileSync(rulesPath, "utf8"))) {
      writeFileSync(rulesPath, renderGuardRules(), "utf8");
    } else {
      say("guard rules file has your edits. I keep them. good.");
    }
  } catch {
    return reportRockyHomeWriteFailure(rc, recoveryPath, bashrcPublished);
  }

  say("ears installed. open new shell, I hear everything there.");
  detail(`hook:  ${join(home, "rocky-hook.bash")}`);
  detail(`rules: ${rulesPath}`);
  if (recoveryPath !== undefined) reportRetainedCopy(recoveryPath);
  say("dangerous command comes, I ask first. ROCKY_OFF=1 makes me deaf.");
  // bash-preexec must read every command through `history 1`, so it strips
  // ignorespace/ignoreboth from HISTCONTROL. A command deliberately typed with
  // a leading space — the usual way to keep a token out of history — starts
  // being recorded. Rocky changes it, so Rocky says it.
  say(phrase("hook-histcontrol"));
  return 0;
}

export function hookUninstall(): number {
  const rc = bashrcPath();
  const preparation = prepareBashrc(rc);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc);
  if (classification === "absent") {
    say("no ears installed. nothing to remove.");
    return 0;
  }
  const published = publishBashrc(
    rc,
    removeHookBlockBytes(preparation.snapshot.bytes),
    preparation.snapshot.prior,
  );
  if (published.exit !== 0) return published.exit;
  say(`ears removed from shell. memory stays in ${rockyHome()}. I still remember.`);
  if (published.recoveryPath !== undefined) reportRetainedCopy(published.recoveryPath);
  return 0;
}

/**
 * Status shares `prepareBashrc` with install/uninstall so it never diverges
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
 * sitting unrecovered instead. Accurate disclosure — via `prepareBashrc`,
 * shared by every caller so none of them can silently do this and stay quiet
 * about it — is the only remaining option that satisfies "status must
 * recover what install/uninstall would", "status must not silently retain
 * secrets it did not mention", and "status must not silently rewrite bashrc
 * without saying so" all at once.
 */
export function hookStatus(): number {
  const rc = bashrcPath();
  const preparation = prepareBashrc(rc);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc);
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
