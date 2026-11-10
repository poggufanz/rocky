/**
 * Prompt-free scope, plan, apply, and removal over the consent record.
 * Nothing here asks a question, reads stdin, or runs a harness executable:
 * every write goes through the per-target modules, and only a target whose
 * expected bytes were found after the write is reported as healthy.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultAgentHooksTarget, hasOwnedGateGroup } from "../agent-hooks.js";
import type { McpRegistration } from "../clients.js";
import { DESK_MARKER } from "../desk-hooks.js";
import { pruneSupersededTransactions } from "../file-transaction.js";
import { readJsonObject } from "../json-config.js";
import {
  applyClaudeSettings,
  claudeSettingsSnippets,
  inspectClaudeSettings,
  removeClaudeSettings,
} from "./claude-settings.js";
import { detectHarnesses, type DetectEnv } from "./detect.js";
import {
  applyMcp,
  inspectMcp,
  mcpSnippets,
  mcpTargets,
  removeMcp,
  type McpTarget,
} from "./mcp.js";
import {
  applyShell,
  inspectShell,
  removeShell,
  shellSnippets,
  type ShellHookPort,
} from "./shell.js";
import {
  readExpected,
  withHistory,
  writeConsentRecord,
  writeExpected,
  type ConsentRecord,
  type ConsentState,
  type ExpectedFile,
  type ExpectedRecord,
  type McpHarnessId,
} from "./state.js";
import type { AutoTargetReport, Paths } from "./types.js";

/** A recorded config location that stays absent this long is forgotten. */
export const CONFIG_LOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The five harnesses with an MCP adapter, in detection order. */
export const AUTO_MCP_HARNESSES: readonly McpHarnessId[] = [
  "claude-code",
  "codex",
  "opencode",
  "gemini-cli",
  "copilot-cli",
];

export interface AutoContext {
  rockyHome: string;
  detect: DetectEnv;
  paths: Paths;
  registration: McpRegistration;
  shell: ShellHookPort;
  now(): number;
}

export interface AutoResult {
  v: 1;
  action: string;
  consent: ConsentState | "none" | "invalid";
  targets: AutoTargetReport[];
  notes: string[];
  repo?: { key: string; main: string; decision: "allowed" | "declined" | "undecided" };
}

interface Scope {
  harnesses: readonly McpHarnessId[];
  claudeSettings: readonly string[];
  mcp: readonly McpTarget[];
  shell: boolean;
}

function locationsOf(record: ConsentRecord | undefined, harness: McpHarnessId): string[] {
  return (record?.config_dirs[harness] ?? []).map((entry) => entry.location);
}

/** The settings file Claude sessions load, plus one per recorded location. */
function claudeSettingsPaths(ctx: AutoContext, locations: readonly string[]): string[] {
  const paths: string[] = [];
  const resolved = defaultAgentHooksTarget(ctx.detect.home, ctx.detect.env, process.cwd());
  if (resolved.status === "resolved") paths.push(resolved.target.settingsPath);
  for (const location of locations) paths.push(join(location, "settings.json"));
  return [...new Set(paths)];
}

function scopeOf(ctx: AutoContext, record: ConsentRecord | undefined): Scope {
  const off = record?.harness_off ?? [];
  const harnesses = detectHarnesses(ctx.detect)
    .map((harness) => harness.id)
    .filter((harness) => !off.includes(harness));
  const claudeSettings = harnesses.includes("claude-code")
    ? claudeSettingsPaths(ctx, locationsOf(record, "claude-code"))
    : [];
  return {
    harnesses,
    claudeSettings,
    mcp: harnesses.flatMap((harness) => mcpTargets(harness, ctx.detect, locationsOf(record, harness))),
    shell: record === undefined || record.shell_hook,
  };
}

/** Read-only plan over every in-scope target; writes nothing. */
export function inspectAll(ctx: AutoContext, record: ConsentRecord | undefined): AutoTargetReport[] {
  const scope = scopeOf(ctx, record);
  const history = readExpected(ctx.rockyHome).history;
  const reports: AutoTargetReport[] = [];
  for (const harness of scope.harnesses) {
    if (harness === "claude-code") {
      for (const path of scope.claudeSettings) reports.push(...inspectClaudeSettings(path, ctx.paths));
    }
    for (const target of scope.mcp) {
      if (target.harness !== harness) continue;
      reports.push(inspectMcp(target, ctx.registration, history[target.path] ?? []));
    }
  }
  if (scope.shell) reports.push(inspectShell(ctx.shell));
  return reports;
}

/**
 * Present locations are stamped; absent ones are kept until the TTL passes.
 * The refreshed record is written only when it differs from the stored one.
 */
function refreshedConfigDirs(ctx: AutoContext, record: ConsentRecord): ConsentRecord["config_dirs"] {
  const now = ctx.now();
  const updated: ConsentRecord["config_dirs"] = {};
  for (const harness of AUTO_MCP_HARNESSES) {
    const locations = record.config_dirs[harness];
    if (locations === undefined) continue;
    const kept: Array<{ location: string; last_seen: number }> = [];
    for (const entry of locations) {
      if (existsSync(entry.location)) kept.push({ location: entry.location, last_seen: now });
      else if (now - entry.last_seen <= CONFIG_LOCATION_TTL_MS) kept.push(entry);
    }
    if (kept.length > 0) updated[harness] = kept;
  }
  return updated;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Keeps only snippets actually present in the file now, and turns a target
 * whose own bytes are incomplete into an error instead of a false success.
 */
function expectedFilesAfterWrite(
  candidates: readonly ExpectedFile[],
  reports: AutoTargetReport[],
): ExpectedFile[] {
  const merged = new Map<string, string[]>();
  for (const candidate of candidates) {
    const snippets = merged.get(candidate.path) ?? [];
    for (const snippet of candidate.snippets) {
      if (snippet.length > 0 && !snippets.includes(snippet)) snippets.push(snippet);
    }
    merged.set(candidate.path, snippets);
  }
  const files: ExpectedFile[] = [];
  for (const [path, snippets] of merged) {
    const bytes = readText(path);
    const present = bytes === undefined
      ? []
      : snippets.filter((snippet) => bytes.includes(snippet));
    const healthy = (report: AutoTargetReport): boolean =>
      report.path === path && (report.state === "ok" || report.state === "written");
    if (present.length !== snippets.length && reports.some(healthy)) {
      for (const report of reports) {
        if (!healthy(report)) continue;
        report.state = "error";
        report.detail = "expected bytes not found after write";
      }
    }
    if (present.length > 0) files.push({ path, snippets: present });
  }
  return files;
}

/** Apply every in-scope target, then publish the bytes a daemon will check. */
export function applyAll(ctx: AutoContext, record: ConsentRecord): AutoTargetReport[] {
  const configDirs = refreshedConfigDirs(ctx, record);
  if (JSON.stringify(configDirs) !== JSON.stringify(record.config_dirs)) {
    writeConsentRecord(ctx.rockyHome, { ...record, config_dirs: configDirs });
  }
  const scope = scopeOf(ctx, { ...record, config_dirs: configDirs });
  let expected: ExpectedRecord = readExpected(ctx.rockyHome);
  const reports: AutoTargetReport[] = [];
  const candidates: ExpectedFile[] = [];

  for (const harness of scope.harnesses) {
    if (harness === "claude-code") {
      for (const path of scope.claudeSettings) {
        const settingsReports = applyClaudeSettings(path, ctx.paths);
        reports.push(...settingsReports);
        const after = readJsonObject(path);
        const keptGate = after.status !== "invalid" && hasOwnedGateGroup(after.value);
        const deskHealthy = settingsReports.some((report) => report.kind === "desk-hooks"
          && (report.state === "ok" || report.state === "written"));
        candidates.push({
          path,
          snippets: claudeSettingsSnippets(ctx.paths, keptGate)
            .filter((snippet) => deskHealthy || !snippet.includes(DESK_MARKER)),
        });
      }
    }
    for (const target of scope.mcp) {
      if (target.harness !== harness) continue;
      const outcome = applyMcp(target, ctx.registration, expected.history[target.path] ?? []);
      reports.push(outcome.report);
      if (outcome.wroteKey !== undefined) {
        expected = withHistory(expected, target.path, outcome.wroteKey);
      }
      // A legacy claude.json is only ever cleared, never kept; no bytes there are expected.
      if (target.legacy !== true) {
        candidates.push({ path: target.path, snippets: mcpSnippets(target, ctx.registration) });
      }
    }
  }
  if (scope.shell) {
    reports.push(applyShell(ctx.shell));
    candidates.push(...shellSnippets(ctx.shell));
  }
  writeExpected(ctx.rockyHome, {
    v: 1,
    files: expectedFilesAfterWrite(candidates, reports),
    history: expected.history,
  });
  return reports;
}

/**
 * Remove every default and recorded target in any consent state. Retained
 * recovery copies are pruned so a completed removal leaves nothing behind.
 */
export function removeAll(ctx: AutoContext, record: ConsentRecord | undefined): AutoTargetReport[] {
  const expected = readExpected(ctx.rockyHome);
  const reports: AutoTargetReport[] = [];
  const touched = new Set<string>();

  for (const path of claudeSettingsPaths(ctx, locationsOf(record, "claude-code"))) {
    reports.push(...removeClaudeSettings(path));
    touched.add(path);
  }
  for (const harness of AUTO_MCP_HARNESSES) {
    for (const target of mcpTargets(harness, ctx.detect, locationsOf(record, harness))) {
      reports.push(removeMcp(target, ctx.registration, expected.history[target.path] ?? []));
      touched.add(target.path);
    }
  }
  reports.push(removeShell(ctx.shell));
  touched.add(ctx.shell.bashrcPath());
  for (const path of touched) pruneSupersededTransactions(path);
  writeExpected(ctx.rockyHome, { v: 1, files: [], history: expected.history });
  return reports;
}

/** Remove one harness's defaults and recorded locations, then its expectations. */
export function removeHarness(
  ctx: AutoContext,
  record: ConsentRecord | undefined,
  harness: McpHarnessId,
): AutoTargetReport[] {
  const expected = readExpected(ctx.rockyHome);
  const reports: AutoTargetReport[] = [];
  const removed = new Set<string>();

  if (harness === "claude-code") {
    for (const path of claudeSettingsPaths(ctx, locationsOf(record, "claude-code"))) {
      reports.push(...removeClaudeSettings(path));
      removed.add(path);
    }
  }
  for (const target of mcpTargets(harness, ctx.detect, locationsOf(record, harness))) {
    reports.push(removeMcp(target, ctx.registration, expected.history[target.path] ?? []));
    removed.add(target.path);
  }
  for (const path of removed) pruneSupersededTransactions(path);
  writeExpected(ctx.rockyHome, {
    v: 1,
    files: expected.files.filter((file) => !removed.has(file.path)),
    history: expected.history,
  });
  return reports;
}

/** A copy for callers that report the same targets without writing them. */
export function refusalReports(targets: readonly AutoTargetReport[]): AutoTargetReport[] {
  return targets.map(({ harness, kind, path }) => ({ harness, kind, path, state: "not_consented" }));
}
