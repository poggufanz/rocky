/**
 * Prompt-free shell hook target for the setup engine: wraps the existing Bash
 * and PowerShell installer behind a small port. Inspect is read-only and reads
 * only the Bash side — a PowerShell profile can be found only by starting a
 * PowerShell, so the expected-file snippets collect those paths on demand
 * instead. A malformed managed block stays refused exactly as `hook install`
 * refuses it, and reports as an error rather than being rewritten.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ROCKY_HOOK_PROTOCOL_VERSION,
  detectPowerShellHosts,
  hookInstall,
  hookUninstall,
} from "../../commands/hook.js";
import {
  HOOK_BLOCK_BEGIN,
  POWERSHELL_HOOK_LINE,
  classifyHookBlock,
} from "../../core/hook-block.js";
import { resolveRockyPaths } from "../../core/state-paths.js";
import type { ExpectedFile } from "./state.js";
import type { AutoState, AutoTargetReport } from "./types.js";

/** Everything the engine needs from the installer, injected so tests never touch a real home. */
export interface ShellHookPort {
  install(): number;
  uninstall(): number;
  bashrcPath(): string;
  powerShellProfiles(): string[];
  rockyHome(): string;
}

const HOOK_SCRIPT = "rocky-hook.bash";
const POWERSHELL_HOOK_SCRIPT = "rocky-hook.ps1";
const VERSION_LITERAL = `ROCKY_HOOK_VERSION="${ROCKY_HOOK_PROTOCOL_VERSION}"`;
const VERSION_PATTERN = /ROCKY_HOOK_VERSION="([^"]+)"/;
const MALFORMED_BLOCK = "the managed hook block is malformed; repair its markers by hand";

function report(path: string, state: AutoState, detail?: string): AutoTargetReport {
  return detail === undefined
    ? { harness: "shell", kind: "shell-hook", path, state }
    : { harness: "shell", kind: "shell-hook", path, state, detail };
}

/** The installed script's own literal; an unreadable or older script has no current version. */
function installedVersion(scriptPath: string): string | undefined {
  try {
    return VERSION_PATTERN.exec(readFileSync(scriptPath, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/** Read-only: never settles a pending write and never starts a PowerShell. */
export function inspectShell(port: ShellHookPort): AutoTargetReport {
  const bashrc = port.bashrcPath();
  let bytes: Buffer;
  try {
    bytes = readFileSync(bashrc);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return report(bashrc, "error", error instanceof Error ? error.message : "bashrc could not be read");
    }
    return report(bashrc, "missing");
  }
  const classification = classifyHookBlock(bytes);
  if (classification === "corrupt") return report(bashrc, "error", MALFORMED_BLOCK);
  if (classification === "absent") return report(bashrc, "missing");
  const version = installedVersion(join(port.rockyHome(), HOOK_SCRIPT));
  return report(bashrc, version === ROCKY_HOOK_PROTOCOL_VERSION ? "ok" : "stale");
}

/** Install in place; an already current target stays reported as ok. */
export function applyShell(port: ShellHookPort): AutoTargetReport {
  const before = inspectShell(port);
  const exit = port.install();
  if (exit !== 0) return report(port.bashrcPath(), "error", `hook install exited ${exit}`);
  return report(port.bashrcPath(), before.state === "ok" ? "ok" : "written");
}

export function removeShell(port: ShellHookPort): AutoTargetReport {
  const exit = port.uninstall();
  if (exit !== 0) return report(port.bashrcPath(), "error", `hook uninstall exited ${exit}`);
  return report(port.bashrcPath(), "missing");
}

/** The bytes a daemon later checks for: markers, the version literal each script really holds, and each profile line. */
export function shellSnippets(port: ShellHookPort): ExpectedFile[] {
  const rockyHome = port.rockyHome();
  const files: ExpectedFile[] = [
    { path: port.bashrcPath(), snippets: [HOOK_BLOCK_BEGIN] },
    { path: join(rockyHome, HOOK_SCRIPT), snippets: [VERSION_LITERAL] },
  ];
  if (process.platform === "win32") {
    files.push({ path: join(rockyHome, POWERSHELL_HOOK_SCRIPT), snippets: [VERSION_LITERAL] });
  }
  for (const profile of port.powerShellProfiles()) {
    files.push({ path: profile, snippets: [POWERSHELL_HOOK_LINE] });
  }
  return files;
}

export function createShellHookPort(): ShellHookPort {
  return {
    install: () => hookInstall(),
    uninstall: () => hookUninstall(),
    bashrcPath: () => join(homedir(), ".bashrc"),
    // Empty off win32 without calling the detector: every call starts a PowerShell.
    powerShellProfiles: () => process.platform === "win32"
      ? detectPowerShellHosts().map((host) => host.profile)
      : [],
    rockyHome: () => resolveRockyPaths().home,
  };
}
