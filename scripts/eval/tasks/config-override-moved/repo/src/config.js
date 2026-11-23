import { existsSync, readFileSync } from "node:fs";

export function loadConfig() {
  const base = JSON.parse(readFileSync("config/default.json", "utf8"));
  const envCfg = existsSync("config/env.json")
    ? JSON.parse(readFileSync("config/env.json", "utf8"))
    : {};
  const merged = { ...base, ...envCfg };
  if (typeof merged.port !== "number" || !Number.isFinite(merged.port)) {
    throw new Error(`port must be a number, got ${JSON.stringify(merged.port)}`);
  }
  return merged;
}
