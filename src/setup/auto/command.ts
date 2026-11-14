/**
 * `rocky setup --auto <action> --json`: the prompt-free entry a desktop app
 * or daemon calls. It never reads stdin, prints exactly one JSON object to
 * stdout, and writes only under an approved consent record (except `remove`).
 */
import { existsSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolveRockyPaths } from "../../core/state-paths.js";
import { purgeRepoCapture, setRepoCapture } from "../../listening/consent.js";
import { readRepoDecision } from "../../listening/repo-consent-read.js";
import { defaultAgentHooksEntryPath } from "../agent-hooks.js";
import { resolveMcpRegistration } from "../registration.js";
import { detectHarnesses, validateConfigLocation, type DetectEnv } from "./detect.js";
import {
  applyAll,
  applyShellOnly,
  AUTO_MCP_HARNESSES,
  inspectAll,
  refusalReports,
  removeAll,
  removeCardData,
  removeHarness,
  removeShellOnly,
  type AutoContext,
  type AutoResult,
} from "./engine.js";
import { listRepos } from "./repo-list.js";
import { createShellHookPort } from "./shell.js";
import {
  hookBinPath,
  readConsentRecord,
  writeConsentRecord,
  type ConsentRecord,
  type ConsentState,
  type McpHarnessId,
} from "./state.js";

const JSON_FLAG = "--json";

type RepoAction = "status" | "allow" | "decline" | "revoke" | "purge";

type Parsed =
  | { kind: "plan" | "status" | "apply" | "remove"; label: string }
  | { kind: "consent"; decision: "approve" | "later"; label: string }
  | { kind: "harness"; harness: McpHarnessId; enabled: boolean; label: string }
  | { kind: "shell"; enabled: boolean; label: string }
  | { kind: "repo-list"; label: string }
  | { kind: "config-dir"; harness: McpHarnessId; location: string; label: string }
  | { kind: "repo"; action: RepoAction; root: string; label: string };

function isHarnessId(value: string): value is McpHarnessId {
  return (AUTO_MCP_HARNESSES as readonly string[]).includes(value);
}

function isRepoAction(value: string): value is RepoAction {
  return value === "status" || value === "allow" || value === "decline"
    || value === "revoke" || value === "purge";
}

/** `<action> [args...] --json`; anything else is a usage error. */
function parseAutoArgs(argv: readonly string[]): Parsed | undefined {
  if (argv.length < 2 || argv[argv.length - 1] !== JSON_FLAG) return undefined;
  const args = argv.slice(0, -1);
  const label = args.join(" ");
  const [first, second, third] = args;
  if (args.length === 1) {
    if (first === "plan" || first === "status" || first === "apply" || first === "remove") {
      return { kind: first, label };
    }
    return undefined;
  }
  if (first === "consent" && args.length === 2 && (second === "approve" || second === "later")) {
    return { kind: "consent", decision: second, label };
  }
  if (first === "harness" && args.length === 3 && isHarnessId(second) && (third === "on" || third === "off")) {
    return { kind: "harness", harness: second, enabled: third === "on", label };
  }
  if (first === "shell" && args.length === 2 && (second === "on" || second === "off")) {
    return { kind: "shell", enabled: second === "on", label };
  }
  if (first === "repo" && args.length === 2 && second === "list") {
    return { kind: "repo-list", label };
  }
  if (first === "config-dir" && args.length === 3 && isHarnessId(second)) {
    return { kind: "config-dir", harness: second, location: third, label };
  }
  if (first === "repo" && args.length === 3 && isRepoAction(second) && third.length > 0) {
    return { kind: "repo", action: second, root: third, label };
  }
  return undefined;
}

/** Every consent write keeps the three scope fields a valid record carried. */
function consentRecord(
  record: ConsentRecord | undefined,
  state: ConsentState,
  at: number,
): ConsentRecord {
  return {
    v: 1,
    scope: 1,
    state,
    at,
    harness_off: record === undefined ? [] : [...record.harness_off],
    shell_hook: record?.shell_hook ?? true,
    config_dirs: record === undefined ? {} : { ...record.config_dirs },
  };
}

export async function runAutoCommand(
  argv: readonly string[],
  ctx: AutoContext,
  out: (json: string) => void,
): Promise<number> {
  const parsed = parseAutoArgs(argv);
  if (parsed === undefined) {
    out(JSON.stringify({ v: 1, error: "usage" }));
    return 2;
  }
  const read = readConsentRecord(ctx.rockyHome);
  const record = read.status === "valid" ? read.record : undefined;
  const result: AutoResult = {
    v: 1,
    action: parsed.label,
    consent: read.status === "valid" ? read.record.state : read.status === "invalid" ? "invalid" : "none",
    targets: [],
    notes: [],
    harness_off: record === undefined ? [] : [...record.harness_off],
    shell_hook: record?.shell_hook ?? true,
  };

  try {
    executeAction(parsed, ctx, result, record);
    syncScopeFields(ctx, result);
  } catch (error) {
    // A valid action owes the caller one result object even when a Rocky-home
    // write fails after a partial pass.
    result.notes.push(`internal error: ${error instanceof Error ? error.message : String(error)}`);
    syncScopeFields(ctx, result);
    out(JSON.stringify(result));
    return 1;
  }

  out(JSON.stringify(result));
  return 0;
}

/**
 * Build the context before the command runs. A failure here is still owed to
 * the caller as one result object, because a daemon parses stdout, not stderr.
 */
export async function runAutoSetup(
  argv: readonly string[],
  buildContext: () => AutoContext,
  out: (json: string) => void,
): Promise<number> {
  let ctx: AutoContext;
  try {
    ctx = buildContext();
  } catch (error) {
    out(JSON.stringify({
      v: 1,
      action: parseAutoArgs(argv)?.label ?? argv.filter((arg) => arg !== JSON_FLAG).join(" "),
      consent: "none",
      targets: [],
      harness_off: [],
      shell_hook: true,
      notes: [`internal error: ${error instanceof Error ? error.message : String(error)}`],
    }));
    return 1;
  }
  return runAutoCommand(argv, ctx, out);
}

/** Report the scope fields as the record stands after the action ran. */
function syncScopeFields(ctx: AutoContext, result: AutoResult): void {
  const read = readConsentRecord(ctx.rockyHome);
  result.harness_off = read.status === "valid" ? [...read.record.harness_off] : [];
  result.shell_hook = read.status === "valid" ? read.record.shell_hook : true;
}

function executeAction(
  parsed: Parsed,
  ctx: AutoContext,
  result: AutoResult,
  record: ConsentRecord | undefined,
): void {
  switch (parsed.kind) {
    case "plan":
    case "status":
      result.targets = inspectAll(ctx, record);
      break;
    case "apply":
      result.targets = record?.state === "approved"
        ? applyAll(ctx, record)
        : refusalReports(inspectAll(ctx, record));
      break;
    case "remove": {
      // Record the decision first: a daemon re-applies while consent reads
      // approved, so a slow removal must not run under that state. Removal
      // itself is safe in any consent state.
      writeConsentRecord(ctx.rockyHome, consentRecord(record, "removed", ctx.now()));
      result.consent = "removed";
      result.targets = removeAll(ctx, record);
      const cardData = removeCardData(ctx.rockyHome);
      if (cardData.errors > 0) {
        result.notes.push(
          cardData.errors === 1
            ? "1 card data entry could not be removed"
            : `${cardData.errors} card data entries could not be removed`,
        );
      }
      break;
    }
    case "consent":
      if (parsed.decision === "approve") {
        const next = consentRecord(record, "approved", ctx.now());
        writeConsentRecord(ctx.rockyHome, next);
        result.consent = "approved";
        result.targets = applyAll(ctx, next);
      } else {
        writeConsentRecord(ctx.rockyHome, consentRecord(record, "later", ctx.now()));
        result.consent = "later";
      }
      break;
    case "harness": {
      if (record?.state !== "approved") {
        result.targets = refusalReports(inspectAll(ctx, record));
        break;
      }
      if (parsed.enabled) {
        const next: ConsentRecord = {
          ...record,
          harness_off: record.harness_off.filter((harness) => harness !== parsed.harness),
        };
        writeConsentRecord(ctx.rockyHome, next);
        result.targets = applyAll(ctx, next);
      } else {
        const next: ConsentRecord = record.harness_off.includes(parsed.harness)
          ? { ...record, harness_off: [...record.harness_off] }
          : { ...record, harness_off: [...record.harness_off, parsed.harness] };
        writeConsentRecord(ctx.rockyHome, next);
        result.targets = removeHarness(ctx, next, parsed.harness);
      }
      break;
    }
    case "shell": {
      if (!parsed.enabled) {
        // Removal is safe in any consent state; the record only changes when one is valid.
        if (record !== undefined) writeConsentRecord(ctx.rockyHome, { ...record, shell_hook: false });
        result.targets = removeShellOnly(ctx);
        break;
      }
      if (record?.state !== "approved") {
        result.targets = refusalReports(inspectAll(ctx, record));
        break;
      }
      writeConsentRecord(ctx.rockyHome, { ...record, shell_hook: true });
      result.targets = applyShellOnly(ctx);
      break;
    }
    case "repo-list":
      result.repos = listRepos(ctx.rockyHome);
      break;
    case "config-dir": {
      if (record?.state !== "approved") {
        result.targets = refusalReports(inspectAll(ctx, record));
        break;
      }
      const validated = validateConfigLocation(parsed.harness, parsed.location, ctx.detect);
      if (!validated.ok) {
        result.notes.push(validated.reason);
        result.targets = inspectAll(ctx, record);
        break;
      }
      const existing = record.config_dirs[parsed.harness] ?? [];
      const next: ConsentRecord = {
        ...record,
        config_dirs: {
          ...record.config_dirs,
          [parsed.harness]: [
            ...existing.filter((entry) => entry.location !== validated.location),
            { location: validated.location, last_seen: ctx.now() },
          ],
        },
      };
      writeConsentRecord(ctx.rockyHome, next);
      if (!detectHarnesses(ctx.detect).some((harness) => harness.id === parsed.harness)) {
        // The location is valid and kept for later, but this run cannot write
        // anything for a harness detection does not report.
        result.notes.push(`harness not detected: ${parsed.harness}`);
      }
      result.targets = applyAll(ctx, next);
      break;
    }
    case "repo": {
      const before = readRepoDecision(parsed.root, ctx.rockyHome);
      if (parsed.action === "purge") {
        // The store is per worktree, so purge names the path it was given.
        const purged = purgeRepoCapture(
          parsed.root,
          { yes: true, actor: "desk", onRevoke: "decline" },
          ctx.rockyHome,
        );
        if (!purged.ok) result.notes.push(purged.reason ?? "purge failed");
      } else if (parsed.action !== "status") {
        // Revoke and decline act on the path the desk named, so a worktree
        // store is cleared even when its own key, not the main key, is set.
        const changed = setRepoCapture(
          parsed.action === "allow" ? before.main : parsed.root,
          parsed.action === "allow",
          { yes: true, actor: "desk", onRevoke: "decline" },
          ctx.rockyHome,
        );
        if (!changed.ok) result.notes.push(changed.reason ?? "repo action failed");
      }
      result.repo = readRepoDecision(parsed.root, ctx.rockyHome);
      break;
    }
  }
}

/** The desk hook binary is usable only as a regular file; a symlink is not one. */
export function deskHookBinFor(rockyHome: string, platform: NodeJS.Platform): string | undefined {
  const bin = hookBinPath(rockyHome, platform);
  try {
    return lstatSync(bin).isFile() ? bin : undefined;
  } catch {
    return undefined;
  }
}

export function defaultAutoContext(): AutoContext {
  const rockyHome = resolveRockyPaths().home;
  const home = homedir();
  const entryPath = defaultAgentHooksEntryPath();
  const detect: DetectEnv = {
    home,
    env: process.env,
    platform: process.platform,
    appData: process.env.APPDATA,
    fileExists: existsSync,
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
  };
  const deskHookBin = deskHookBinFor(rockyHome, process.platform);
  return {
    rockyHome,
    detect,
    paths: deskHookBin === undefined
      ? { nodePath: process.execPath, entryPath }
      : { nodePath: process.execPath, entryPath, deskHookBin },
    registration: resolveMcpRegistration({
      exposure: "sanitized",
      nodePath: process.execPath,
      entryPath,
      rockyHome,
      home,
      env: process.env,
      fileExists: existsSync,
    }),
    shell: createShellHookPort(),
    now: () => Date.now(),
  };
}
