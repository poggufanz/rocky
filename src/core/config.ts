import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { resolveRockyPaths } from "./state-paths.js";
import { loadConfig, parseConfig, type RockyConfigV1 } from "./config-read.js";

export { loadConfig, parseConfig, parseExposure } from "./config-read.js";
export type { AiConfig, CheckConfig, ConfigLoadResult, Exposure, RockyConfigV1 } from "./config-read.js";

export function setCheckRegistry(enabled: boolean): void {
  const current = loadConfig();
  if (current.status === "invalid") throw new Error(`refusing to overwrite invalid config at ${current.path}`);
  saveConfigAtomic({ ...current.config, check: { registry: enabled } }, current.path);
}

export function saveConfigAtomic(config: RockyConfigV1, path = resolveRockyPaths().config): { path: string } {
  if (parseConfig(config) === undefined) throw new Error("invalid config shape");
  const current = loadConfig(path);
  if (current.status === "invalid") throw new Error(`refusing to overwrite invalid config at ${path}`);

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
