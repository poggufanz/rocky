import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../json-config.js";
import { binDir } from "./state.js";

export interface CliRecord {
  v: 1;
  node: string;
  entry: string;
  version: string;
}

const GLOBAL_ENTRY_TAIL = ["node_modules", "@poggufanz", "rocky-cli", "dist", "index.js"] as const;
const CASE_INSENSITIVE = process.platform === "win32";

/** A published install's entry; a repo checkout or a shim is not one. */
export function isGlobalPackageEntry(entry: string): boolean {
  const segments = entry.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length < GLOBAL_ENTRY_TAIL.length) return false;
  const tail = segments.slice(-GLOBAL_ENTRY_TAIL.length);
  return tail.every((segment, index) => {
    const expected = GLOBAL_ENTRY_TAIL[index];
    return CASE_INSENSITIVE ? segment.toLowerCase() === expected.toLowerCase() : segment === expected;
  });
}

export function recordCli(rockyHome: string, record: Omit<CliRecord, "v">): "written" | "unchanged" | "skipped" {
  if (!isGlobalPackageEntry(record.entry)) return "skipped";
  const target = join(binDir(rockyHome), "cli.json");
  const next: CliRecord = { v: 1, ...record };
  if (holdsSameRecord(target, next)) return "unchanged";
  mkdirSync(binDir(rockyHome), { recursive: true, mode: 0o700 });
  atomicWriteJson(target, next as unknown as Record<string, unknown>);
  return "written";
}

function holdsSameRecord(path: string, record: CliRecord): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const candidate = parsed as Partial<CliRecord>;
  return candidate.v === 1
    && candidate.node === record.node
    && candidate.entry === record.entry
    && candidate.version === record.version;
}
