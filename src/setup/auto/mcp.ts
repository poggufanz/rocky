/**
 * Prompt-free MCP targets for the setup engine: JSON harness configs and the
 * Codex TOML block. Every mutation goes through the shared ownership rule and
 * the shared transactional writer; nothing here runs a harness executable or
 * probes a server. A `rocky` entry that is neither current nor in history is
 * foreign and is never touched.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { canonicalPath } from "../../core/memory-read.js";
import type { McpRegistration } from "../clients.js";
import { isCanonicalAbsoluteDirectory } from "../claude-code.js";
import {
  atomicWriteBytesIfUnchanged,
  pathExists,
  recoverFileTransaction,
  type BytesReadResult,
} from "../file-transaction.js";
import { claudeCodeMcpConfigPath, toClaudeEntry } from "../harness-claude-code.js";
import {
  codexRockyBlock,
  resolveCodexHome,
  scanCodexRockyBlock,
  type TomlBlock,
} from "../harness-codex.js";
import { resolveCopilotConfigPath, toCopilotEntry } from "../harness-copilot-cli.js";
import { resolveGeminiSettingsPath, toGeminiEntry } from "../harness-gemini-cli.js";
import {
  fromOpencodeEntry,
  resolveOpencodeConfigPath,
  toOpencodeEntry,
} from "../harness-opencode.js";
import {
  entryToStoredRegistration,
  mergeRockyMcpServer,
  removeRockyMcpServer,
  writeMergedJsonConfig,
} from "../harness-mcp-shared.js";
import { readJsonObject, recoverJsonTransaction, type JsonReadResult } from "../json-config.js";
import {
  isOwnedRockyRegistration,
  registrationKey,
  type RegistrationOwnership,
} from "../registration.js";
import type { DetectEnv } from "./detect.js";
import type { McpHarnessId } from "./state.js";
import type { AutoState, AutoTargetReport } from "./types.js";

export interface McpTarget {
  harness: McpHarnessId;
  path: string;
  format: "json" | "toml";
  legacy?: boolean;
}

const LEGACY_MOVED = "moved to .claude.json";
const MANUAL_RECOVERY = "a pending MCP transaction needs manual recovery";
const PATH_API = process.platform === "win32" ? win32 : posix;

function report(t: McpTarget, state: AutoState, detail?: string): AutoTargetReport {
  return detail === undefined
    ? { harness: t.harness, kind: "mcp", path: t.path, state }
    : { harness: t.harness, kind: "mcp", path: t.path, state, detail };
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function jsonHarnessFor(harness: McpHarnessId): {
  containerKey: string;
  toEntry(registration: McpRegistration): Record<string, unknown>;
  fromEntry(entry: unknown): McpRegistration | undefined;
} {
  switch (harness) {
    case "claude-code":
      return { containerKey: "mcpServers", toEntry: toClaudeEntry, fromEntry: entryToStoredRegistration };
    case "copilot-cli":
      return { containerKey: "mcpServers", toEntry: toCopilotEntry, fromEntry: entryToStoredRegistration };
    case "gemini-cli":
      return { containerKey: "mcpServers", toEntry: toGeminiEntry, fromEntry: entryToStoredRegistration };
    case "opencode":
      return { containerKey: "mcp", toEntry: toOpencodeEntry, fromEntry: fromOpencodeEntry };
    case "codex":
      throw new Error("codex does not use a JSON MCP config");
  }
}

function defaultTargetPath(harness: McpHarnessId, d: DetectEnv): string {
  const input = { env: d.env, home: d.home, platform: d.platform, appData: d.appData };
  switch (harness) {
    case "claude-code":
      return claudeCodeMcpConfigPath(d.env, d.home);
    case "codex":
      return join(resolveCodexHome(input), "config.toml");
    case "copilot-cli":
      return resolveCopilotConfigPath(input);
    case "opencode":
      return resolveOpencodeConfigPath(input);
    case "gemini-cli":
      return resolveGeminiSettingsPath(input);
  }
}

function locationTargetPath(harness: McpHarnessId, location: string): string {
  if (harness === "codex") return join(location, "config.toml");
  if (harness === "copilot-cli") return join(location, "config.json");
  return location;
}

/**
 * Default path first, then one target per validated location. Legacy
 * `claude.json` targets come only from `CLAUDE_CONFIG_DIR` and the supplied
 * locations, never from home, and identical paths are reported once.
 */
export function mcpTargets(
  harness: McpHarnessId,
  d: DetectEnv,
  locations: readonly string[],
): McpTarget[] {
  const format = harness === "codex" ? "toml" as const : "json" as const;
  const targets: McpTarget[] = [];
  const seen = new Set<string>();
  const push = (target: McpTarget): void => {
    const key = canonicalPath(target.path, { platform: d.platform });
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  push({ harness, path: defaultTargetPath(harness, d), format });
  if (harness === "claude-code") {
    const configured = d.env.CLAUDE_CONFIG_DIR;
    const dirs = typeof configured === "string" && configured.length > 0
      ? [configured, ...locations]
      : locations;
    for (const dir of dirs) {
      const path = join(dir, "claude.json");
      if (d.fileExists(path)) push({ harness, path, format, legacy: true });
    }
    return targets;
  }
  for (const location of locations) push({ harness, path: locationTargetPath(harness, location), format });
  return targets;
}

interface Refusal {
  state: "refused" | "error";
  detail: string;
}

/**
 * Non-canonical Claude Code directories never fall back to the home path, and
 * an existing directory where a config file belongs is an error, not a write.
 */
function pathRefusal(t: McpTarget): Refusal | undefined {
  if (t.harness === "claude-code" && !isCanonicalAbsoluteDirectory(dirname(t.path), PATH_API)) {
    return { state: "refused", detail: "not-canonical" };
  }
  try {
    if (statSync(t.path).isDirectory()) {
      return { state: "error", detail: `MCP config path is a directory: ${t.path}` };
    }
  } catch {
    // An absent target is expected; the writer decides whether to create it.
  }
  if (!pathExists(dirname(t.path))) {
    return { state: "refused", detail: "parent directory is missing" };
  }
  return undefined;
}

type JsonTarget =
  | { status: "refused"; detail?: string }
  | { status: "error"; detail: string }
  | { status: "missing"; prior: JsonReadResult }
  | {
    status: "present";
    prior: JsonReadResult;
    value: Record<string, unknown>;
    container: Record<string, unknown>;
  };

function readJsonTarget(t: McpTarget): JsonTarget {
  const refusal = pathRefusal(t);
  if (refusal !== undefined) {
    return refusal.state === "refused"
      ? { status: "refused", detail: refusal.detail }
      : { status: "error", detail: refusal.detail };
  }
  const cfg = jsonHarnessFor(t.harness);
  const prior = readJsonObject(t.path);
  if (prior.status === "invalid") return { status: "error", detail: `MCP config is unreadable: ${t.path}` };
  if (prior.status === "missing") return { status: "missing", prior };
  const raw = prior.value[cfg.containerKey];
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    return { status: "error", detail: `MCP container ${cfg.containerKey} is not an object: ${t.path}` };
  }
  return {
    status: "present",
    prior,
    value: prior.value,
    container: raw === undefined ? {} : raw as Record<string, unknown>,
  };
}

function entryOwnership(
  entry: unknown,
  harness: McpHarnessId,
  registration: McpRegistration,
  ownership: RegistrationOwnership,
): { owned: boolean; identical: boolean; stored?: McpRegistration } {
  const cfg = jsonHarnessFor(harness);
  const stored = cfg.fromEntry(entry);
  if (stored === undefined || !isOwnedRockyRegistration(stored, registration, ownership)) {
    return { owned: false, identical: false };
  }
  return {
    owned: true,
    identical: JSON.stringify(entry) === JSON.stringify(cfg.toEntry(registration)),
    stored,
  };
}

interface JsonInspection {
  report: AutoTargetReport;
  read?: JsonTarget;
  stored?: McpRegistration;
}

function inspectJsonTarget(
  t: McpTarget,
  registration: McpRegistration,
  ownership: RegistrationOwnership,
): JsonInspection {
  const read = readJsonTarget(t);
  if (read.status === "refused") return { report: report(t, "refused", read.detail) };
  if (read.status === "error") return { report: report(t, "error", read.detail) };
  const entry = read.status === "present" ? read.container.rocky : undefined;
  const legacyDetail = t.legacy === true ? LEGACY_MOVED : undefined;
  if (entry === undefined) {
    return { report: report(t, t.legacy === true ? "ok" : "missing", legacyDetail), read };
  }
  const ownershipOf = entryOwnership(entry, t.harness, registration, ownership);
  if (!ownershipOf.owned) return { report: report(t, "foreign"), read };
  if (t.legacy === true) return { report: report(t, "stale", LEGACY_MOVED), read, stored: ownershipOf.stored };
  if (ownershipOf.identical) return { report: report(t, "ok"), read, stored: ownershipOf.stored };
  return { report: report(t, "stale"), read, stored: ownershipOf.stored };
}

function containerObject(existing: Record<string, unknown>, key: string): Record<string, unknown> {
  const container = existing[key];
  if (container === undefined) return {};
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    throw new Error(`MCP container ${key} is not an object`);
  }
  return { ...(container as Record<string, unknown>) };
}

/**
 * OpenCode stores the command as an argv array, which the shared JSON merge
 * cannot parse, so its container is merged here under the same ownership rule.
 */
function mergeOpencode(
  existing: Record<string, unknown>,
  registration: McpRegistration,
  ownership: RegistrationOwnership,
): { value: Record<string, unknown>; changed: boolean } {
  const container = containerObject(existing, "mcp");
  const stored = container.rocky === undefined ? undefined : fromOpencodeEntry(container.rocky);
  if (stored !== undefined && isOwnedRockyRegistration(stored, registration, ownership)
    && JSON.stringify(container.rocky) === JSON.stringify(toOpencodeEntry(registration))) {
    return { value: { ...existing, mcp: container }, changed: false };
  }
  return {
    value: { ...existing, mcp: { ...container, rocky: toOpencodeEntry(registration) } },
    changed: true,
  };
}

function removeOpencode(
  existing: Record<string, unknown>,
  registration: McpRegistration,
  ownership: RegistrationOwnership,
): { value: Record<string, unknown>; changed: boolean } {
  const container = containerObject(existing, "mcp");
  if (container.rocky === undefined) return { value: { ...existing, mcp: container }, changed: false };
  const stored = fromOpencodeEntry(container.rocky);
  if (stored === undefined || !isOwnedRockyRegistration(stored, registration, ownership)) {
    return { value: { ...existing, mcp: container }, changed: false };
  }
  const { rocky: _removed, ...rest } = container;
  void _removed;
  return { value: { ...existing, mcp: rest }, changed: true };
}

/** Install only an owned or absent entry; a foreign entry is never replaced. */
export function applyMcp(
  t: McpTarget,
  reg: McpRegistration,
  history: readonly string[],
): { report: AutoTargetReport; wroteKey?: string } {
  const ownership: RegistrationOwnership = { mode: "history", history };
  if (t.format === "toml") return applyToml(t, reg, ownership);
  const refusal = pathRefusal(t);
  if (refusal !== undefined) return { report: report(t, refusal.state, refusal.detail) };
  // An interrupted write must be settled before the target is interpreted.
  if (recoverJsonTransaction(t.path).status === "manual") {
    return { report: report(t, "error", MANUAL_RECOVERY) };
  }
  const inspected = inspectJsonTarget(t, reg, ownership);
  const read = inspected.read;
  if (read === undefined || (read.status !== "missing" && read.status !== "present")) {
    return { report: inspected.report };
  }
  if (inspected.report.state !== "missing" && inspected.report.state !== "stale") {
    return { report: inspected.report };
  }
  if (t.legacy === true) {
    return { report: removeJsonEntry(t, read, reg, ownership, LEGACY_MOVED) };
  }
  let registration = reg;
  const storedExposure = inspected.stored?.env.ROCKY_MCP_EXPOSURE;
  if (inspected.report.state === "stale" && storedExposure !== undefined) {
    registration = { ...reg, env: { ...reg.env, ROCKY_MCP_EXPOSURE: storedExposure } };
  }
  const value = read.status === "present" ? read.value : {};
  try {
    const merged = t.harness === "opencode"
      ? mergeOpencode(value, registration, ownership)
      : mergeRockyMcpServer(value, jsonHarnessFor(t.harness).containerKey, registration, jsonHarnessFor(t.harness).toEntry, ownership);
    if (!merged.changed) return { report: report(t, "ok") };
    const outcome = writeMergedJsonConfig(t.path, merged.value, read.prior, { backup: false });
    if (outcome.status === "written") {
      return { report: report(t, "written"), wroteKey: registrationKey(registration) };
    }
    if (outcome.status === "changed") return { report: report(t, "changed") };
    return { report: report(t, "error", MANUAL_RECOVERY) };
  } catch (error) {
    return { report: report(t, "error", messageOf(error)) };
  }
}

/** Remove exactly the owned entry; the file itself is never deleted. */
export function removeMcp(
  t: McpTarget,
  reg: McpRegistration,
  history: readonly string[],
): AutoTargetReport {
  const ownership: RegistrationOwnership = { mode: "history", history };
  if (t.format === "toml") return removeToml(t, reg, ownership);
  const refusal = pathRefusal(t);
  if (refusal !== undefined) return report(t, refusal.state, refusal.detail);
  if (recoverJsonTransaction(t.path).status === "manual") {
    return report(t, "error", MANUAL_RECOVERY);
  }
  return removeJsonEntry(t, readJsonTarget(t), reg, ownership, t.legacy === true ? LEGACY_MOVED : undefined);
}

function removeJsonEntry(
  t: McpTarget,
  read: JsonTarget,
  registration: McpRegistration,
  ownership: RegistrationOwnership,
  detail: string | undefined,
): AutoTargetReport {
  if (read.status === "missing") return report(t, "ok", detail);
  if (read.status !== "present") {
    return report(t, read.status === "refused" ? "refused" : "error", read.detail);
  }
  if (read.container.rocky === undefined) return report(t, "ok", detail);
  try {
    if (t.harness === "opencode") {
      const removed = removeOpencode(read.value, registration, ownership);
      return removed.changed
        ? writeRemoval(t, removed.value, read.prior, detail)
        : report(t, "foreign");
    }
    const removed = removeRockyMcpServer(
      read.value,
      jsonHarnessFor(t.harness).containerKey,
      registration,
      ownership,
    );
    if (!removed.owned) return report(t, "foreign");
    return removed.changed
      ? writeRemoval(t, removed.value, read.prior, detail)
      : report(t, "ok", detail);
  } catch (error) {
    return report(t, "error", messageOf(error));
  }
}

function writeRemoval(
  t: McpTarget,
  value: Record<string, unknown>,
  prior: JsonReadResult,
  detail: string | undefined,
): AutoTargetReport {
  const outcome = writeMergedJsonConfig(t.path, value, prior, { backup: false });
  if (outcome.status === "written") return report(t, "written", detail);
  if (outcome.status === "changed") return report(t, "changed", detail);
  return report(t, "error", MANUAL_RECOVERY);
}

const ABSENT_BLOCK: TomlBlock = { status: "absent", start: -1, end: -1 };

type TomlTarget =
  | { status: "refused"; detail: string }
  | { status: "error"; detail: string }
  | { status: "missing" }
  | {
    status: "present";
    text: string;
    prior: BytesReadResult;
    block: TomlBlock;
    blockText: string;
  };

function readTomlTarget(t: McpTarget): TomlTarget {
  const refusal = pathRefusal(t);
  if (refusal !== undefined) {
    return refusal.state === "refused"
      ? { status: "refused", detail: refusal.detail }
      : { status: "error", detail: refusal.detail };
  }
  if (!pathExists(t.path)) return { status: "missing" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(t.path);
  } catch {
    return { status: "error", detail: `MCP config is unreadable: ${t.path}` };
  }
  const text = bytes.toString("utf8");
  const lines = text === "" ? [] : text.split("\n");
  const block = scanCodexRockyBlock(lines);
  return {
    status: "present",
    text,
    prior: { status: "valid", bytes },
    block,
    blockText: lines.slice(block.start, block.end).join("\n").trimEnd(),
  };
}

interface TomlInspection {
  report: AutoTargetReport;
  read?: TomlTarget;
}

function inspectToml(
  t: McpTarget,
  registration: McpRegistration,
  ownership: RegistrationOwnership,
): TomlInspection {
  const read = readTomlTarget(t);
  if (read.status === "refused") return { report: report(t, "refused", read.detail), read };
  if (read.status === "error") return { report: report(t, "error", read.detail), read };
  if (read.status === "missing") return { report: report(t, "missing"), read };
  if (read.block.status === "absent") return { report: report(t, "missing"), read };
  if (read.block.status === "malformed") {
    return { report: report(t, "error", `Codex config is unreadable: ${t.path}`), read };
  }
  if (read.blockText === codexRockyBlock(registration).join("\n")) {
    return { report: report(t, "ok"), read };
  }
  const ownedEarlier = read.blockText.length > 0
    && ownership.mode === "history"
    && ownership.history.includes(read.blockText);
  return { report: report(t, ownedEarlier ? "stale" : "foreign"), read };
}

function applyToml(
  t: McpTarget,
  registration: McpRegistration,
  ownership: RegistrationOwnership,
): { report: AutoTargetReport; wroteKey?: string } {
  const refusal = pathRefusal(t);
  if (refusal !== undefined) return { report: report(t, refusal.state, refusal.detail) };
  if (recoverFileTransaction(t.path).status === "manual") {
    return { report: report(t, "error", MANUAL_RECOVERY) };
  }
  const inspected = inspectToml(t, registration, ownership);
  const read = inspected.read;
  if (read === undefined) return { report: inspected.report };
  if (inspected.report.state !== "missing" && inspected.report.state !== "stale") {
    return { report: inspected.report };
  }
  const lines = read.status === "present" ? read.text.split("\n") : [];
  const block = read.status === "present" ? read.block : ABSENT_BLOCK;
  const replacement = codexRockyBlock(registration);
  const next = block.status === "absent"
    ? [...lines, ...(lines.length > 0 && lines[lines.length - 1] !== "" ? [""] : []), ...replacement]
    : [...lines.slice(0, block.start), ...replacement, ...lines.slice(block.end)];
  try {
    const prior: BytesReadResult = read.status === "present" ? read.prior : { status: "missing" };
    const outcome = atomicWriteBytesIfUnchanged(
      t.path,
      Buffer.from(`${next.join("\n")}\n`, "utf8"),
      prior,
    );
    if (outcome.status === "written") {
      return { report: report(t, "written"), wroteKey: replacement.join("\n") };
    }
    if (outcome.status === "changed") return { report: report(t, "changed") };
    return { report: report(t, "error", MANUAL_RECOVERY) };
  } catch (error) {
    return { report: report(t, "error", messageOf(error)) };
  }
}

function removeToml(
  t: McpTarget,
  registration: McpRegistration,
  ownership: RegistrationOwnership,
): AutoTargetReport {
  const refusal = pathRefusal(t);
  if (refusal !== undefined) return report(t, refusal.state, refusal.detail);
  if (recoverFileTransaction(t.path).status === "manual") {
    return report(t, "error", MANUAL_RECOVERY);
  }
  const inspected = inspectToml(t, registration, ownership);
  const read = inspected.read;
  if (read === undefined || read.status !== "present") return inspected.report;
  if (inspected.report.state !== "ok" && inspected.report.state !== "stale") return inspected.report;
  const lines = read.text.split("\n");
  const next = [...lines.slice(0, read.block.start), ...lines.slice(read.block.end)];
  try {
    const outcome = atomicWriteBytesIfUnchanged(
      t.path,
      Buffer.from(`${next.join("\n")}\n`, "utf8"),
      read.prior,
    );
    if (outcome.status === "written") return report(t, "written");
    if (outcome.status === "changed") return report(t, "changed");
    return report(t, "error", MANUAL_RECOVERY);
  } catch (error) {
    return report(t, "error", messageOf(error));
  }
}

/** Read-only plan for one MCP target; never recovers, writes, or probes. */
export function inspectMcp(
  t: McpTarget,
  reg: McpRegistration,
  history: readonly string[],
): AutoTargetReport {
  const ownership: RegistrationOwnership = { mode: "history", history };
  return t.format === "toml"
    ? inspectToml(t, reg, ownership).report
    : inspectJsonTarget(t, reg, ownership).report;
}

/** Paste-ready values for the manual setup path. */
export function mcpSnippets(t: McpTarget, reg: McpRegistration): string[] {
  if (t.format === "toml") {
    const line = codexRockyBlock(reg).find((candidate) => candidate.startsWith("command ="));
    return line === undefined ? [] : [line];
  }
  return [JSON.stringify(reg.command), JSON.stringify(reg.args[0]) ?? ""];
}
