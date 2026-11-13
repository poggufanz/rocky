import { resolveRockyPaths } from "../core/state-paths.js";
import { defaultAutoContext, runAutoSetup } from "../setup/auto/command.js";
import type { AutoContext } from "../setup/auto/engine.js";
import { consentApproved } from "../setup/auto/state.js";
import { say } from "../ui/rocky.js";
import { hookUninstall } from "./hook.js";

/** Dependencies injected by tests; production uses `defaultDeps()`. */
export interface HookUninstallDeps {
  rockyHome: string;
  buildContext: () => AutoContext;
  uninstall: () => number;
}

interface AutoTargetState {
  state?: unknown;
}

interface AutoCommandOutput {
  targets?: unknown;
}

function defaultDeps(): HookUninstallDeps {
  return {
    rockyHome: resolveRockyPaths().home,
    buildContext: defaultAutoContext,
    uninstall: hookUninstall,
  };
}

function hasFailedTarget(chunks: readonly string[]): boolean {
  if (chunks.length !== 1) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunks[0]!);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return true;
  const targets = (parsed as AutoCommandOutput).targets;
  if (!Array.isArray(targets)) return true;
  return targets.some((target) => {
    if (typeof target !== "object" || target === null) return false;
    const state = (target as AutoTargetState).state;
    return state === "error" || state === "refused";
  });
}

/**
 * Remove the shell hook; while desk consent is approved, route through
 * `shell off` so the desk switch and expected files stay in sync.
 */
export async function hookUninstallCommand(deps: HookUninstallDeps = defaultDeps()): Promise<number> {
  if (!consentApproved(deps.rockyHome)) return deps.uninstall();
  const chunks: string[] = [];
  const code = await runAutoSetup(["shell", "off", "--json"], deps.buildContext, (chunk) => {
    chunks.push(chunk);
  });
  if (code !== 0 || hasFailedTarget(chunks)) return 1;
  say("Shell hook off. The desk switch is off too.");
  return 0;
}
