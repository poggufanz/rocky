/**
 * `rocky setup --auto <action> --json`: the prompt-free entry a desktop app
 * or daemon calls. It never reads stdin, prints exactly one JSON object to
 * stdout, and writes only under an approved consent record (except `remove`).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolveRockyPaths } from "../../core/state-paths.js";
import { purgeRepoCapture, setRepoCapture } from "../../listening/consent.js";
import { readRepoDecision } from "../../listening/repo-consent-read.js";
import { defaultAgentHooksEntryPath } from "../agent-hooks.js";
import { resolveMcpRegistration } from "../registration.js";
import { validateConfigLocation, type DetectEnv } from "./detect.js";
import {
  applyAll,
  AUTO_MCP_HARNESSES,
  inspectAll,
  refusalReports,
  removeAll,
  removeHarness,
  type AutoContext,
  type AutoResult,
} from "./engine.js";
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
  };

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
    case "remove":
      result.targets = removeAll(ctx, record);
      writeConsentRecord(ctx.rockyHome, consentRecord(record, "removed", ctx.now()));
      result.consent = "removed";
      break;
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
        const changed = setRepoCapture(
          before.main,
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

  out(JSON.stringify(result));
  return 0;
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
  };
  const deskHookBin = hookBinPath(rockyHome, process.platform);
  return {
    rockyHome,
    detect,
    paths: existsSync(deskHookBin)
      ? { nodePath: process.execPath, entryPath, deskHookBin }
      : { nodePath: process.execPath, entryPath },
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
