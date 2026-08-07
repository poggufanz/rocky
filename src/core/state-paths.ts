import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface RockyPaths {
  home: string;
  memory: string;
  pending: string;
  config: string;
}

export function resolveRockyPaths(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome = homedir(),
  cwd = process.cwd(),
): RockyPaths {
  const configured = env.ROCKY_HOME ?? join(fallbackHome, ".rocky");
  const home = isAbsolute(configured) ? configured : resolve(cwd, configured);
  return {
    home,
    memory: join(home, "memory.jsonl"),
    pending: join(home, "pending"),
    config: join(home, "config.json"),
  };
}
