import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { resolveRockyPaths } from "./state-paths.js";

export type Exposure = "sanitized" | "raw";

export type AiConfig =
  | { enabled: false }
  | { enabled: true; provider: "ollama"; model: string; exposure: Exposure };

export interface RockyConfigV1 {
  version: 1;
  ai: AiConfig;
}

export type ConfigLoadResult =
  | { status: "missing"; path: string; config: RockyConfigV1 }
  | { status: "valid"; path: string; config: RockyConfigV1 }
  | { status: "invalid"; path: string; error: string };

const DISABLED_CONFIG: RockyConfigV1 = { version: 1, ai: { enabled: false } };

export function parseExposure(value: string | undefined, fallback: Exposure = "sanitized"): Exposure {
  if (value === undefined) return fallback;
  if (value === "sanitized" || value === "raw") return value;
  throw new Error(`invalid exposure: ${value}`);
}

export function parseConfig(value: unknown): RockyConfigV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== "version" && key !== "ai")) return undefined;
  if (root.version !== 1 || typeof root.ai !== "object" || root.ai === null || Array.isArray(root.ai)) return undefined;
  const ai = root.ai as Record<string, unknown>;
  if (ai.enabled === false) {
    if (Object.keys(ai).some((key) => key !== "enabled")) return undefined;
    return { version: 1, ai: { enabled: false } };
  }
  if (Object.keys(ai).some((key) => !["enabled", "provider", "model", "exposure"].includes(key))) return undefined;
  if (ai.enabled !== true || ai.provider !== "ollama" || typeof ai.model !== "string" || ai.model.trim() === "") return undefined;
  if (ai.exposure !== "sanitized" && ai.exposure !== "raw") return undefined;
  return { version: 1, ai: { enabled: true, provider: "ollama", model: ai.model, exposure: ai.exposure } };
}

export function loadConfig(path = resolveRockyPaths().config): ConfigLoadResult {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { status: "missing", path, config: DISABLED_CONFIG };
    return { status: "invalid", path, error: "unable to read config" };
  }

  try {
    const config = parseConfig(JSON.parse(contents) as unknown);
    return config === undefined
      ? { status: "invalid", path, error: "invalid config shape" }
      : { status: "valid", path, config };
  } catch {
    return { status: "invalid", path, error: "invalid config JSON" };
  }
}

export function saveConfigAtomic(config: RockyConfigV1, path = resolveRockyPaths().config): { path: string } {
  if (parseConfig(config) === undefined) throw new Error("invalid config shape");
  const current = loadConfig(path);
  if (current.status === "invalid" && !isDirectory(path)) throw new Error(`refusing to overwrite invalid config at ${path}`);

  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(config, null, 2) + "\n", "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, path);
    return { path };
  } catch (error) {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } catch {
      // Preserve the write error while attempting to remove only this temp file.
    }
    try {
      rmSync(temp, { force: true });
    } catch {
      // Cleanup failure must not replace the write error.
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
