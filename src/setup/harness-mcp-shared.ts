/**
 * Shared P1-A helpers: canonical executable resolution (never basename-only),
 * Rocky-owned JSON MCP merge preserving foreign keys/order, atomic write with
 * backup, and verify-with-honesty. No host-specific paths in this module.
 */
import { realpathSync } from "node:fs";
import type { McpRegistration } from "./clients.js";
import type { HarnessId, DetectionStatus } from "./harness-registry.js";
import type { ProcessRunner } from "./process.js";
import type { PlatformServices } from "./platform.js";
import { checkMcpRegistration } from "./health.js";
import {
  atomicWriteJsonIfUnchanged,
  backupFile,
  recoverJsonTransaction,
  type JsonReadResult,
} from "./json-config.js";
import { isOwnedRockyRegistration } from "./registration.js";

export interface CanonicalExecutable {
  path: string;
  realPath: string;
  version: string;
}

export interface HarnessDetection {
  status: DetectionStatus;
  executable?: CanonicalExecutable;
  configPath?: string;
  detail: string;
}

const VERSION_TOKEN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

export function parseVersionOutput(output: string): string | undefined {
  const match = VERSION_TOKEN.exec(output);
  return match === null ? undefined : match[0];
}

function executableIsPlausible(realPath: string, names: readonly string[]): boolean {
  const lower = realPath.toLowerCase();
  return names.some((name) => lower.includes(name.toLowerCase()));
}

export async function resolveCanonicalExecutable(options: {
  runner: ProcessRunner;
  platform: PlatformServices;
  names: readonly string[];
  versionArgs: readonly string[];
  timeoutMs: number;
}): Promise<{ executable?: CanonicalExecutable; detail: string }> {
  for (const name of options.names) {
    const candidate = options.platform.resolveExecutable(name);
    if (candidate === undefined) continue;
    let realPath: string;
    try {
      realPath = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!executableIsPlausible(realPath, options.names)) continue;
    let version = "unknown";
    try {
      const probed = await options.runner.run(candidate, options.versionArgs, {
        timeoutMs: options.timeoutMs,
      });
      if (probed.status === 0 && probed.error === undefined) {
        version = parseVersionOutput(`${probed.stdout}\n${probed.stderr}`) ?? "unknown";
      }
    } catch {
      continue;
    }
    return { executable: { path: candidate, realPath, version }, detail: `resolved ${name} at ${realPath}` };
  }
  return { detail: `none of ${options.names.join(", ")} resolved to a versioned executable` };
}

export function notFoundDetection(
  id: HarnessId,
  tried: readonly string[],
  configHint: string,
): HarnessDetection {
  void id;
  return {
    status: "not-found",
    detail: `no ${tried.join(" or ")} executable resolved; looked for ${configHint} but wrote nothing`,
  };
}

function entryToStoredRegistration(entry: unknown): McpRegistration | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.command !== "string") return undefined;
  if (!Array.isArray(record.args) || !record.args.every((a) => typeof a === "string")) return undefined;
  const env: Record<string, string> = {};
  if (record.env !== undefined) {
    if (typeof record.env !== "object" || record.env === null || Array.isArray(record.env)) return undefined;
    for (const [k, v] of Object.entries(record.env as Record<string, unknown>)) {
      if (typeof v !== "string") return undefined;
      env[k] = v;
    }
  }
  return { name: "rocky", command: record.command, args: record.args as string[], env };
}

function containerOf(existing: Record<string, unknown>, containerKey: string): Record<string, unknown> {
  const container = existing[containerKey];
  if (container === undefined) return {};
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    throw new Error(`MCP container ${containerKey} is not an object`);
  }
  return { ...(container as Record<string, unknown>) };
}

export function mergeRockyMcpServer(
  existing: Record<string, unknown>,
  containerKey: string,
  registration: McpRegistration,
  toEntry: (r: McpRegistration) => Record<string, unknown>,
): { value: Record<string, unknown>; changed: boolean } {
  const container = containerOf(existing, containerKey);
  const stored = container.rocky === undefined
    ? undefined
    : entryToStoredRegistration(container.rocky);
  if (stored !== undefined && isOwnedRockyRegistration(stored, registration)
    && JSON.stringify(container.rocky) === JSON.stringify(toEntry(registration))) {
    return { value: { ...existing, [containerKey]: container }, changed: false };
  }
  return { value: { ...existing, [containerKey]: { ...container, rocky: toEntry(registration) } }, changed: true };
}

export function removeRockyMcpServer(
  existing: Record<string, unknown>,
  containerKey: string,
  registration: McpRegistration,
): { value: Record<string, unknown>; changed: boolean; owned: boolean } {
  const container = containerOf(existing, containerKey);
  if (container.rocky === undefined) {
    return { value: { ...existing, [containerKey]: container }, changed: false, owned: false };
  }
  const stored = entryToStoredRegistration(container.rocky);
  if (stored === undefined || !isOwnedRockyRegistration(stored, registration)) {
    return { value: { ...existing, [containerKey]: container }, changed: false, owned: false };
  }
  const { rocky: _removed, ...rest } = container;
  void _removed;
  return { value: { ...existing, [containerKey]: rest }, changed: true, owned: true };
}

export function writeMergedJsonConfig(
  path: string,
  value: Record<string, unknown>,
  prior: JsonReadResult,
  options: { backup?: boolean } = {},
): { status: "written" | "changed" | "recovery-required"; backupPath?: string } {
  const recovery = recoverJsonTransaction(path);
  if (recovery.status === "manual") {
    return { status: "recovery-required" };
  }
  let backupPath: string | undefined;
  if (options.backup !== false && prior.status === "valid") {
    backupPath = backupFile(path);
  }
  const outcome = atomicWriteJsonIfUnchanged(path, value, prior);
  if (outcome.status === "written") return { status: "written", backupPath };
  return { status: outcome.status };
}

export async function verifyMcpAfterWrite(options: {
  runner: ProcessRunner;
  registration: McpRegistration;
  listCommand?: { command: string; args: readonly string[]; timeoutMs: number };
  mustContain?: string;
}): Promise<{ verified: boolean; detail: string }> {
  if (options.listCommand !== undefined) {
    let observed: string;
    try {
      const result = await options.runner.run(
        options.listCommand.command,
        options.listCommand.args,
        { timeoutMs: options.listCommand.timeoutMs },
      );
      if (result.status !== 0 || result.error !== undefined) {
        return { verified: false, detail: `MCP list probe failed (exit ${String(result.status)})` };
      }
      observed = `${result.stdout}\n${result.stderr}`;
    } catch {
      return { verified: false, detail: "MCP list probe errored before producing output" };
    }
    if (options.mustContain !== undefined && !observed.includes(options.mustContain)) {
      return { verified: false, detail: `MCP list probe does not show ${options.mustContain}` };
    }
  }
  const health = await checkMcpRegistration(options.registration, options.runner);
  return health.healthy
    ? { verified: true, detail: health.detail }
    : { verified: false, detail: `protocol health failed: ${health.detail}` };
}
