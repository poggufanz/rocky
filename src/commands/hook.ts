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

/** An ambiguous stop keeps a secret-free recovery path: diagnostics name paths only. */
function reportBashrcRecoveryStop(rc: string, recoveryPath: string | undefined): number {
  say("bashrc write stops halfway. I keep safe copy. I touch nothing more.");
  if (recoveryPath !== undefined) detail(`recovery: ${recoveryPath}`);
  detail(`bashrc: ${rc}`);
  return 1;
}

/**
 * Recover interrupted bashrc transactions before any byte is trusted. Returns
 * undefined once inspection is clear; a manual/ambiguous recovery stops the
 * command instead of continuing from stale assumptions.
 */
function settleBashrcTransactions(rc: string): number | undefined {
  for (;;) {
    const inspection = inspectFileTransaction(rc);
    if (inspection.status === "clear") return undefined;
    const recovery = recoverFileTransaction(rc);
    if (recovery.status === "manual") {
      return reportBashrcRecoveryStop(rc, recovery.recoveryPath ?? inspection.recoveryPath);
    }
    // Recovered: re-inspect from fresh state before proceeding.
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
 * Settle pending transactions, refuse unsafe topology (symlink, non-regular,
 * multi-linked), and snapshot current bytes/mode. A missing bashrc snapshots
 * as `missing` so install still creates it.
 */
function prepareBashrc(rc: string): BashrcPreparation {
  const settled = settleBashrcTransactions(rc);
  if (settled !== undefined) return { status: "stop", exit: settled };

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
    return { status: "ready", snapshot: { prior: { status: "missing" }, bytes: Buffer.alloc(0) } };
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

/** Publish staged bytes only while bashrc still matches the snapshot. */
function publishBashrc(rc: string, staged: Buffer, prior: BytesReadResult): number {
  let result: ConditionalBytesWriteResult;
  try {
    result = atomicWriteBytesIfUnchanged(rc, staged, prior);
  } catch {
    say("bashrc write fails. I touch nothing. check disk space and permissions, then try again.");
    detail(`bashrc: ${rc}`);
    return 1;
  }
  if (result.status === "written") return 0;
  if (result.status === "changed") {
    say("bashrc changed while I worked. I touch nothing. your bytes win. run command again.");
    detail(`bashrc: ${rc}`);
    return 1;
  }
  return reportBashrcRecoveryStop(rc, result.recoveryPath);
}

/** Corrupt marker bytes are preserved byte-for-byte; repair stays manual. */
function reportCorruptBlock(rc: string): number {
  say("hook block in bashrc is corrupt. I touch nothing. repair markers by hand, then call me again.");
  detail(`bashrc: ${rc}`);
  return 1;
}

export function hookInstall(): number {
  const home = rockyHome();
  mkdirSync(home, { recursive: true });

  for (const f of ["rocky-hook.bash", "bash-preexec.sh"]) {
    const src = join(assetDir(), f);
    if (!existsSync(src)) {
      say(`hook file missing from install: ${f}. install incomplete. bad.`);
      return 1;
    }
    copyFileSync(src, join(home, f));
  }

  const rulesPath = join(home, "guard.rules");
  if (!existsSync(rulesPath) || rulesFileIsPristine(readFileSync(rulesPath, "utf8"))) {
    writeFileSync(rulesPath, renderGuardRules(), "utf8");
  } else {
    say("guard rules file has your edits. I keep them. good.");
  }

  const rc = bashrcPath();
  const preparation = prepareBashrc(rc);
  if (preparation.status === "stop") return preparation.exit;
  const classification = classifyHookBlock(preparation.snapshot.bytes);
  if (classification === "corrupt") return reportCorruptBlock(rc);
  if (classification === "absent") {
    const published = publishBashrc(
      rc,
      addHookBlockBytes(preparation.snapshot.bytes),
      preparation.snapshot.prior,
    );
    if (published !== 0) return published;
  }

  say("ears installed. open new shell, I hear everything there.");
  detail(`hook:  ${join(home, "rocky-hook.bash")}`);
  detail(`rules: ${rulesPath}`);
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
  if (published !== 0) return published;
  say(`ears removed from shell. memory stays in ${rockyHome()}. I still remember.`);
  return 0;
}

export function hookStatus(): number {
  const rc = bashrcPath();
  if (!existsSync(rc)) {
    say("ears not installed. run: rocky hook install");
    return 0;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(rc);
  } catch {
    say("bashrc does not open for me. I touch nothing.");
    detail(`bashrc: ${rc}`);
    return 1;
  }
  const classification = classifyHookBlock(bytes);
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
