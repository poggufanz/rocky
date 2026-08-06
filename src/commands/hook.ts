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
import { renderGuardRules, rulesFileIsPristine } from "../core/guard-rules.js";
import {
  addHookBlockBytes,
  classifyHookBlock,
  removeHookBlockBytes,
} from "../core/hook-block.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  clearPendingIfResolved,
  loadMemory,
  recordFix,
  recordHookFailure,
} from "../core/memory.js";
import { findByFingerprint, getFix, recentUnresolvedFailures } from "../core/memory-query.js";
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
} from "../setup/file-transaction.js";
import { ago, detail, detailTty, say, sayTty } from "../ui/rocky.js";

/** A command failed in the hooked shell. Record it; speak only if memory has something to say. */
export function hookFail(cmd: string, exitCode: number, cwd: string): number {
  const memory = loadMemory();
  const fp = commandFingerprint(cmd, exitCode);
  const previous = findByFingerprint(memory, fp);

  recordHookFailure(cmd, exitCode, cwd);

  if (previous.length === 0) return 0; // first time: passive ears stay quiet

  const withFix = [...previous].reverse().find((f) => getFix(memory, f));
  if (withFix) {
    const fix = getFix(memory, withFix)!;
    sayTty(`I hear this error before. ${ago(withFix.ts)}. last time, you fix with:`);
    detailTty(fix.cmd);
    sayTty("try, question");
  } else {
    sayTty(`this error again. deep memory need stderr. run with: rocky run "${cmd}", question`);
  }
  return 0;
}

/** A command succeeded while the pending flag existed. Try to link a fix. */
export function hookSuccess(cmd: string, cwd: string): number {
  const memory = loadMemory();
  const unresolved = recentUnresolvedFailures(memory, cmd, { cwd });
  if (unresolved.length > 0) {
    recordFix(cmd, unresolved, cwd);
    sayTty("command works now. you fix it. I remember the fix. good good good.");
  }
  clearPendingIfResolved(loadMemory());
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
 * Resolves an engine-supplied `recoveryPath` candidate down to "the
 * transaction directory it names", proven independently at the point the
 * words are spoken — never trusting the candidate's shape. `path` exists is
 * not proof of anything worth naming: the missing-prior `EEXIST` race in
 * `atomicWriteBytesIfUnchanged` can still hand back bashrc's own live path
 * (final audit, Minor 3/N1), and `recoverFileTransaction` no longer offers it
 * either, but a future engine regression could. Excluding `rc` by identity —
 * not by guessing at path shape — is the one check that has to hold for
 * every candidate this function is ever handed.
 */
function resolveTransactionDirectory(candidate: string | undefined, rc: string): string | undefined {
  if (candidate === undefined || candidate === rc || !pathExists(candidate)) return undefined;
  try {
    return lstatSync(candidate).isDirectory() ? candidate : dirname(candidate);
  } catch {
    return undefined;
  }
}

/** True only when `path` is proven, right now, to be a live regular file — never absent, a directory, or a symlink. */
function isLiveRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * An ambiguous stop only ever claims a kept copy when a `displaced` artifact
 * is proven — right now, at the point of speaking — to be a live regular
 * file (final audit, Important 2: a transaction directory existing is not
 * evidence that a copy of anything survives inside it). And a removal
 * imperative is only ever spoken when bashrc itself still exists: if bashrc
 * is gone, the proven copy is the only surviving place holding its content,
 * and telling the user to remove it would destroy their last copy (final
 * audit, Important 3). In that state Rocky instead says where the content
 * is, that it is the only copy, and how to put it back — never "remove".
 */
function reportBashrcRecoveryStop(rc: string, recoveryPath: string | undefined): number {
  const transactionDirectory = resolveTransactionDirectory(recoveryPath, rc);
  const displacedPath = transactionDirectory !== undefined
    ? join(transactionDirectory, "displaced")
    : undefined;
  const provenCopy = displacedPath !== undefined && isLiveRegularFile(displacedPath)
    ? displacedPath
    : undefined;

  if (provenCopy !== undefined && pathExists(rc)) {
    say("bashrc keeps unclear transaction from before. I keep safe copy. I touch nothing more.");
    detail(`inspect, then remove by hand: ${provenCopy}`);
  } else if (provenCopy !== undefined) {
    say("bashrc gone. I keep only copy of old bytes. I touch nothing more.");
    detail(`safe copy: ${provenCopy}`);
    detail("restore by copying that file to the bashrc path yourself");
  } else {
    say("bashrc keeps unclear transaction from before. no safe copy to name. I touch nothing more.");
    if (transactionDirectory !== undefined) detail(`transaction directory: ${transactionDirectory}`);
  }
  detail(`bashrc: ${rc}`);
  return 1;
}

type SettleResult =
  | { status: "clear"; recoveryPath?: string }
  | { status: "stop"; exit: number };

/**
 * Recover interrupted bashrc transactions before any byte is trusted. A
 * manual/ambiguous recovery stops the command instead of continuing from
 * stale assumptions. A transaction actually recovered here belonged to some
 * earlier, already-finished invocation — not this call's own write — so its
 * retained-copy path (when one exists) is carried back for the caller to
 * disclose rather than silently absorbed (whole-branch re-review, Minor 1).
 */
function settleBashrcTransactions(rc: string): SettleResult {
  let recoveryPath: string | undefined;
  for (;;) {
    const inspection = inspectFileTransaction(rc);
    if (inspection.status === "clear") return { status: "clear", recoveryPath };
    const recovery = recoverFileTransaction(rc);
    if (recovery.status === "manual") {
      return {
        status: "stop",
        exit: reportBashrcRecoveryStop(rc, recovery.recoveryPath ?? inspection.recoveryPath),
      };
    }
    // Recovered: re-inspect from fresh state before proceeding.
    if (recovery.status === "recovered" && recovery.recoveryPath !== undefined) {
      recoveryPath = recovery.recoveryPath;
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
 * "I keep safe copy" is true of both, but only the second one is also true
 * of "I already put old bytes back" — and a command claiming only the first
 * when the second happened is the exact gap the audit reproduced against
 * `rocky hook status`.
 */
function reportSettledRecovery(recoveryPath: string, recreatedBashrc: boolean): void {
  if (recreatedBashrc) {
    say("bashrc gone. I already put old bytes back from safe copy.");
    detail(`safe copy: ${recoveryPath}`);
  } else {
    reportRetainedCopy(recoveryPath);
  }
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
 */
function prepareBashrc(rc: string): BashrcPreparation {
  const existedBeforeSettling = pathExists(rc);
  const settled = settleBashrcTransactions(rc);
  if (settled.status === "stop") return { status: "stop", exit: settled.exit };

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

  if (settled.recoveryPath !== undefined) {
    reportSettledRecovery(settled.recoveryPath, !existedBeforeSettling && metadata !== undefined);
    pruneSupersededTransactions(rc, dirname(settled.recoveryPath));
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
  return { exit: reportBashrcRecoveryStop(rc, result.recoveryPath) };
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
  if (classification === "absent") {
    const published = publishBashrc(
      rc,
      addHookBlockBytes(preparation.snapshot.bytes),
      preparation.snapshot.prior,
    );
    if (published.exit !== 0) return published.exit;
    recoveryPath = published.recoveryPath;
  }

  const home = rockyHome();
  mkdirSync(home, { recursive: true });
  for (const f of assets) {
    copyFileSync(join(assetDir(), f), join(home, f));
  }

  const rulesPath = join(home, "guard.rules");
  if (!existsSync(rulesPath) || rulesFileIsPristine(readFileSync(rulesPath, "utf8"))) {
    writeFileSync(rulesPath, renderGuardRules(), "utf8");
  } else {
    say("guard rules file has your edits. I keep them. good.");
  }

  say("ears installed. open new shell, I hear everything there.");
  detail(`hook:  ${join(home, "rocky-hook.bash")}`);
  detail(`rules: ${rulesPath}`);
  if (recoveryPath !== undefined) reportRetainedCopy(recoveryPath);
  say("dangerous command comes, I ask first. ROCKY_OFF=1 makes me deaf.");
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
  const hookFile = join(rockyHome(), "rocky-hook.bash");
  const version = existsSync(hookFile)
    ? /ROCKY_HOOK_VERSION="([^"]+)"/.exec(readFileSync(hookFile, "utf8"))?.[1] ?? "unknown"
    : "missing";
  const rulesPath = join(rockyHome(), "guard.rules");
  const ruleCount = existsSync(rulesPath)
    ? readFileSync(rulesPath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length
    : 0;
  say(`ears installed. hook version ${version}. ${ruleCount} guard rule${ruleCount === 1 ? "" : "s"} active.`);
  return 0;
}
