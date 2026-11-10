import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface RockyPaths {
  home: string;
  memory: string;
  pending: string;
  config: string;
  watchDir: string;
  spoolDir: string;
  labels: string;
  digestHint: string;
  agentLog: string;
  journal: string;
  state: string;
}

/** An empty ROCKY_HOME is a shell artefact, not a request to use the cwd. */
export function configuredRockyHome(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.ROCKY_HOME;
  return value === undefined || value === "" ? undefined : value;
}

export function resolveRockyPaths(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome = homedir(),
  cwd = process.cwd(),
): RockyPaths {
  const configured = configuredRockyHome(env) ?? join(fallbackHome, ".rocky");
  const home = isAbsolute(configured) ? configured : resolve(cwd, configured);
  return {
    home,
    memory: join(home, "memory.jsonl"),
    pending: join(home, "pending"),
    config: join(home, "config.json"),
    watchDir: join(home, "watch"),
    spoolDir: join(home, "spool"),
    labels: join(home, "labels"),
    digestHint: join(home, "digest-hint"),
    agentLog: join(home, "agent-hook.log"),
    journal: join(home, "journal.jsonl"),
    state: join(home, "state.json"),
  };
}
