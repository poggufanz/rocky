/**
 * Read-only repo-consent checks (spec §3). This module is MCP-safe: it
 * imports only node:fs READ functions plus pure helpers. The write path
 * lives in consent.ts, which MCP must never import. See also
 * src/test/mcp-import-boundary.test.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalPath } from "../core/memory-read.js";
import { consentsPath } from "./store-paths.js";

/** Normalize a repo root for identity comparison. NOT a consent grant. */
export function normalizeRepoRoot(value: string): string {
  return canonicalPath(value);
}

function readConsents(home?: string): Record<string, true> {
  try {
    if (home !== undefined && !isAbsolute(home)) return {};
    const raw = readFileSync(consentsPath(home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true && typeof key === "string" && key.length > 0) out[key] = true;
    }
    return out;
  } catch {
    return {};
  }
}

/** Fail-closed: corrupt/missing store means no consent. */
export function isRepoCaptureAllowed(canonicalRoot: string, home?: string): boolean {
  const normalized = normalizeRepoRoot(canonicalRoot);
  if (normalized.length === 0) return false;
  return readConsents(home)[normalized] === true;
}

export function getRepoConsentDetail(
  canonicalRoot: string,
  home?: string,
): { allowed: boolean; root: string } {
  const root = normalizeRepoRoot(canonicalRoot);
  if (root.length === 0) return { allowed: false, root: "" };
  return { allowed: readConsents(home)[root] === true, root };
}

export function consentStoreExists(home?: string): boolean {
  try {
    return existsSync(consentsPath(home));
  } catch {
    return false;
  }
}
