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
  notes?: unknown;
}

function defaultDeps(): HookUninstallDeps {
  return {
    rockyHome: resolveRockyPaths().home,
    buildContext: defaultAutoContext,
    uninstall: hookUninstall,
  };
}

function inspectAutoResult(chunks: readonly string[]): { failed: boolean; notes: string[] } {
  if (chunks.length !== 1) return { failed: true, notes: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunks[0]!);
  } catch {
    return { failed: true, notes: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { failed: true, notes: [] };
  }
  const output = parsed as AutoCommandOutput;
  const notes = Array.isArray(output.notes)
    ? output.notes
      .filter((note): note is string => typeof note === "string")
      .map((note) => note.trim())
      .filter((note) => note.length > 0)
    : [];
  if (!Array.isArray(output.targets)) return { failed: true, notes };
  const failed = output.targets.some((target) => {
    if (typeof target !== "object" || target === null) return false;
    const state = (target as AutoTargetState).state;
    return state === "error" || state === "refused";
  });
  return { failed, notes };
}

function failureLine(notes: readonly string[]): string {
  if (notes.length === 0) return "Shell hook uninstall failed.";
  const summary = notes.join("; ").replace(/\.+$/u, "");
  return `Shell hook uninstall failed: ${summary}.`;
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
  const result = inspectAutoResult(chunks);
  if (code !== 0 || result.failed) {
    say(failureLine(result.notes));
    return 1;
  }
  say("Shell hook off. The desk switch is off too.");
  return 0;
}
