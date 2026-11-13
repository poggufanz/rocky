import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "../json-config.js";

/** Setup hosts with an MCP adapter; the setup engine writes records for these only. */
export type McpHarnessId = "claude-code" | "codex" | "opencode" | "gemini-cli" | "copilot-cli";

export type ConsentState = "approved" | "later" | "removed";

export interface ConfigLocation {
  location: string;
  last_seen: number;
}

export interface ConsentRecord {
  v: 1;
  scope: 1;
  state: ConsentState;
  at: number;
  harness_off: McpHarnessId[];
  shell_hook: boolean;
  config_dirs: Partial<Record<McpHarnessId, ConfigLocation[]>>;
}

export interface ExpectedFile {
  path: string;
  snippets: string[];
}

export interface ExpectedRecord {
  v: 1;
  files: ExpectedFile[];
  history: Record<string, string[]>;
}

const HISTORY_CAP = 20;

const MCP_HARNESS_IDS: Record<McpHarnessId, true> = {
  "claude-code": true,
  codex: true,
  opencode: true,
  "gemini-cli": true,
  "copilot-cli": true,
};

export function consentFile(rockyHome: string): string {
  return join(rockyHome, "setup", "consent.json");
}

export function expectedFile(rockyHome: string): string {
  return join(rockyHome, "setup", "expected.json");
}

export function binDir(rockyHome: string): string {
  return join(rockyHome, "bin");
}

export function hookBinPath(rockyHome: string, platform: NodeJS.Platform): string {
  return join(binDir(rockyHome), platform === "win32" ? "rocky-hook.exe" : "rocky-hook");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMcpHarnessId(value: unknown): value is McpHarnessId {
  return typeof value === "string" && Object.hasOwn(MCP_HARNESS_IDS, value);
}

/** Validates the on-disk shape; anything an older or broken writer left reads as absent. */
function parseConsent(raw: string): ConsentRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  if (parsed.v !== 1 || parsed.scope !== 1) return undefined;
  if (parsed.state !== "approved" && parsed.state !== "later" && parsed.state !== "removed") return undefined;
  if (!isFiniteNumber(parsed.at) || typeof parsed.shell_hook !== "boolean") return undefined;
  if (!Array.isArray(parsed.harness_off) || !parsed.harness_off.every(isMcpHarnessId)) return undefined;
  if (!isPlainObject(parsed.config_dirs)) return undefined;
  for (const [id, locations] of Object.entries(parsed.config_dirs)) {
    if (!isMcpHarnessId(id) || !Array.isArray(locations)) return undefined;
    for (const location of locations) {
      if (!isPlainObject(location)) return undefined;
      if (typeof location.location !== "string" || !isFiniteNumber(location.last_seen)) return undefined;
    }
  }
  return parsed as unknown as ConsentRecord;
}

export function readConsentRecord(
  rockyHome: string,
): { status: "missing" } | { status: "invalid" } | { status: "valid"; record: ConsentRecord } {
  let raw: string;
  try {
    raw = readFileSync(consentFile(rockyHome), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "invalid" };
  }
  const record = parseConsent(raw);
  return record === undefined ? { status: "invalid" } : { status: "valid", record };
}

/** True only when a readable, valid consent record currently approves desk management. */
export function consentApproved(rockyHome: string): boolean {
  const consent = readConsentRecord(rockyHome);
  return consent.status === "valid" && consent.record.state === "approved";
}

export function writeConsentRecord(rockyHome: string, record: ConsentRecord): void {
  const target = consentFile(rockyHome);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  atomicWriteJson(target, record as unknown as Record<string, unknown>);
}

function parseExpected(raw: string): ExpectedRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || parsed.v !== 1) return undefined;
  if (!Array.isArray(parsed.files)) return undefined;
  for (const file of parsed.files) {
    if (!isPlainObject(file) || typeof file.path !== "string") return undefined;
    if (!Array.isArray(file.snippets) || !file.snippets.every((snippet) => typeof snippet === "string")) return undefined;
  }
  if (!isPlainObject(parsed.history)) return undefined;
  for (const values of Object.values(parsed.history)) {
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return undefined;
  }
  return parsed as unknown as ExpectedRecord;
}

export function readExpected(rockyHome: string): ExpectedRecord {
  let raw: string;
  try {
    raw = readFileSync(expectedFile(rockyHome), "utf8");
  } catch {
    return { v: 1, files: [], history: {} };
  }
  return parseExpected(raw) ?? { v: 1, files: [], history: {} };
}

export function writeExpected(rockyHome: string, record: ExpectedRecord): void {
  const target = expectedFile(rockyHome);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  atomicWriteJson(target, record as unknown as Record<string, unknown>);
}

/** Immutable: the newest value moves to the end, older duplicates are dropped. */
export function withHistory(record: ExpectedRecord, path: string, value: string): ExpectedRecord {
  const previous = record.history[path] ?? [];
  const history = [...previous.filter((entry) => entry !== value), value].slice(-HISTORY_CAP);
  return { ...record, history: { ...record.history, [path]: history } };
}
