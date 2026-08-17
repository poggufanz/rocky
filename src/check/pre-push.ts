import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  atomicWriteBytesIfUnchanged,
  inspectFileTransaction,
  pruneSupersededTransactions,
  recoverFileTransaction,
} from "../setup/file-transaction.js";
import type { BytesReadResult, RecoveryOutcome } from "../setup/file-transaction.js";

export const HOOK_START = "# >>> rocky pre-push >>>";
export const HOOK_END = "# <<< rocky pre-push <<<";

export interface InstallHookResult {
  status: "installed" | "already-installed" | "refused";
  detail: string;
  recoveryPath?: string;
}

export function renderPrePushScript(): string {
  return [
    "#!/bin/sh",
    HOOK_START,
    "command -v rocky >/dev/null 2>&1 || exit 0",
    'rocky check --pre-push "$@"',
    "rc=$?",
    "# Only exit 3 finding blocks push; incomplete checks stay fail-open.",
    '[ "$rc" -eq 3 ] && exit 1',
    "exit 0",
    HOOK_END,
    "",
  ].join("\n");
}

export function classifyExisting(content: string | null): "absent" | "ours" | "foreign" {
  if (content === null) return "absent";
  return content.includes(HOOK_START) ? "ours" : "foreign";
}

interface RecoveryDisclosure {
  path?: string;
  kind: "copy" | "artifact";
}

type SettleResult =
  | { status: "clear"; outcome?: RecoveryOutcome }
  | { status: "stop"; disclosure: RecoveryDisclosure };

function mergeRecoveryOutcome(
  previous: RecoveryOutcome | undefined,
  next: RecoveryOutcome,
): RecoveryOutcome {
  if (previous === undefined) return next;
  return {
    transactionDirectory: next.transactionDirectory ?? previous.transactionDirectory,
    provenCopy: next.provenCopy ?? previous.provenCopy,
    targetExists: next.targetExists,
    targetWritten: previous.targetWritten || next.targetWritten,
    artifactRetainedUnproven: previous.artifactRetainedUnproven || next.artifactRetainedUnproven,
  };
}

function disclosureFor(
  outcome: RecoveryOutcome | undefined,
  recoveryPath?: string,
): RecoveryDisclosure {
  if (outcome?.provenCopy !== undefined) return { path: outcome.provenCopy, kind: "copy" };
  return { path: outcome?.transactionDirectory ?? recoveryPath, kind: "artifact" };
}

function settlePrePushTransactions(hookPath: string): SettleResult {
  let outcome: RecoveryOutcome | undefined;
  for (;;) {
    if (inspectFileTransaction(hookPath).status === "clear") return { status: "clear", outcome };
    const recovery = recoverFileTransaction(hookPath);
    if (recovery.status === "manual") {
      return { status: "stop", disclosure: disclosureFor(recovery.outcome, recovery.recoveryPath) };
    }
    if (recovery.status === "recovered") {
      if (recovery.outcome === undefined) {
        return { status: "stop", disclosure: disclosureFor(undefined, recovery.recoveryPath) };
      }
      outcome = mergeRecoveryOutcome(outcome, recovery.outcome);
    }
  }
}

function addSettledRecovery(result: InstallHookResult, outcome: RecoveryOutcome | undefined): InstallHookResult {
  const disclosure = disclosureFor(outcome);
  if (disclosure.path === undefined) return result;
  const label = disclosure.kind === "copy" ? "Recovery copy" : "Recovery artifact";
  return {
    ...result,
    detail: `${result.detail} Previous transaction settled. ${label}: ${disclosure.path}`,
    recoveryPath: disclosure.path,
  };
}

function refused(path: string, message: string, disclosure?: RecoveryDisclosure): InstallHookResult {
  const recovery = disclosure?.path === undefined
    ? ""
    : ` ${disclosure.kind === "copy" ? "Recovery copy" : "Recovery artifact"}: ${disclosure.path}`;
  return {
    status: "refused",
    detail: `${message}: ${path}.${recovery}`,
    recoveryPath: disclosure?.path,
  };
}

export function installPrePush(hookPath: string): InstallHookResult {
  const hooksDirectory = dirname(hookPath);
  try {
    mkdirSync(hooksDirectory, { recursive: true });
  } catch {
    return refused(hookPath, "Cannot create the hooks directory");
  }

  const settled = settlePrePushTransactions(hookPath);
  if (settled.status === "stop") {
    return refused(hookPath, "Pre-push hook has an unresolved transaction", settled.disclosure);
  }
  if (settled.outcome !== undefined
    && (settled.outcome.targetWritten || settled.outcome.provenCopy !== undefined)) {
    pruneSupersededTransactions(hookPath, settled.outcome.transactionDirectory);
  }

  let existing: string | null = null;
  let prior: BytesReadResult = { status: "missing" };
  try {
    const metadata = lstatSync(hookPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
      return addSettledRecovery(
        refused(hookPath, "Existing pre-push hook is not a plain file; install it manually"),
        settled.outcome,
      );
    }
    const bytes = readFileSync(hookPath);
    existing = bytes.toString("utf8");
    prior = { status: "valid", bytes, mode: metadata.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return addSettledRecovery(refused(hookPath, "Cannot read the existing pre-push hook"), settled.outcome);
    }
  }

  const classification = classifyExisting(existing);
  if (classification === "foreign") {
    return addSettledRecovery(
      refused(hookPath, "Existing pre-push hook belongs to another tool; install Rocky manually"),
      settled.outcome,
    );
  }
  if (classification === "ours") {
    return addSettledRecovery(
      { status: "already-installed", detail: `Rocky pre-push hook is already installed: ${hookPath}` },
      settled.outcome,
    );
  }

  try {
    const result = atomicWriteBytesIfUnchanged(hookPath, Buffer.from(renderPrePushScript(), "utf8"), prior);
    if ((result.status === "written" || result.status === "changed") && result.recoveryPath !== undefined) {
      pruneSupersededTransactions(hookPath, dirname(result.recoveryPath));
    }
    if (result.status !== "written") {
      return refused(
        hookPath,
        result.status === "changed"
          ? "Pre-push hook changed while Rocky was installing; install it manually"
          : "Pre-push hook write needs recovery",
        { path: result.recoveryPath, kind: "artifact" },
      );
    }
    if (process.platform !== "win32") chmodSync(hookPath, 0o755);
  } catch {
    return refused(hookPath, "Cannot safely write the pre-push hook");
  }

  return addSettledRecovery(
    { status: "installed", detail: `Rocky pre-push hook installed: ${hookPath}` },
    settled.outcome,
  );
}
