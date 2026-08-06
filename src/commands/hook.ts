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
 * An ambiguous stop only ever names an artifact Rocky itself created — never
 * bashrc itself — and only ever claims a kept copy when one is proven to
 * still exist at the moment of speaking. `recoverFileTransaction` no longer
 * offers bashrc's own path as a `manual` recovery path (whole-branch
 * re-review, Important 1), but a caller can still hand this function a stale
 * or already-vanished path (e.g. a directory removed by this same process a
 * moment earlier, once `syncParentDirectory` then failed) — so the check is
 * repeated here, at the point where the words are actually spoken. When
 * nothing provable survives, Rocky says so instead of claiming a copy that
 * is not there.
 */
function reportBashrcRecoveryStop(rc: string, recoveryPath: string | undefined): number {
  const provenRecoveryPath = recoveryPath !== undefined && recoveryPath !== rc && pathExists(recoveryPath)
    ? recoveryPath
    : undefined;
  if (provenRecoveryPath !== undefined) {
    say("bashrc keeps unclear transaction from before. I keep safe copy. I touch nothing more.");
    detail(`inspect, then remove by hand: ${provenRecoveryPath}`);
  } else {
    say("bashrc keeps unclear transaction from before. no safe copy to name. I touch nothing more.");
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
  | {
    status: "ready";
    snapshot: BashrcSnapshot;
    /** Set only when settling found and recovered an already-finished, stale
     * transaction from some earlier invocation — not this call's own write.
     * A caller that would otherwise never publish anything of its own (e.g.
     * `hookStatus`) must still disclose this path (whole-branch re-review,
     * Minor 1). */
    staleRecoveryPath?: string;
  }
  | { status: "stop"; exit: number };

/**
 * Settle pending transactions, refuse unsafe topology (symlink, non-regular,
 * multi-linked), and snapshot current bytes/mode. A missing bashrc snapshots
 * as `missing` so install still creates it.
 */
function prepareBashrc(rc: string): BashrcPreparation {
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
      staleRecoveryPath: settled.recoveryPath,
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
    staleRecoveryPath: settled.recoveryPath,
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
 * Settling can convert a stale, already-finished transaction from an earlier
 * crashed invocation into a permanently retained copy holding the previous
 * bashrc's full contents — a mutation `status` performs as a side effect of
 * being safe to call at any time, not one it advertises up front. A
 * read-only status that never settled anything was considered and rejected
 * here: `hook status settles a pending transaction instead of reporting
 * stale state` already pins settling as status's behavior, and reverting
 * that would leave the exact stale, secret-holding transaction directory
 * this paragraph exists to disclose sitting unrecovered instead. Disclosing
 * accurately — see below — is the only remaining option that satisfies both
 * "status must recover what install/uninstall would" and "status must not
 * silently retain secrets it did not mention" (whole-branch re-review,
 * Minor 1).
 */
export function hookStatus(): number {
  const rc = bashrcPath();
  const preparation = prepareBashrc(rc);
  if (preparation.status === "stop") return preparation.exit;
  if (preparation.staleRecoveryPath !== undefined) {
    reportRetainedCopy(preparation.staleRecoveryPath);
    pruneSupersededTransactions(rc, dirname(preparation.staleRecoveryPath));
  }
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
