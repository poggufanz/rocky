import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  binariesCurrent,
  binaryFileName,
  resolvePlatformPackage,
  syncBinaries,
  type PlatformPackage,
} from "../setup/auto/binaries.js";
import { defaultAutoContext, runAutoSetup } from "../setup/auto/command.js";
import { binDir } from "../setup/auto/state.js";

/** How long a launched desk may take to prove it is not a second instance. */
export const DESK_EARLY_EXIT_MS = 1500;

export type LaunchOutcome = "running" | "handed-off" | "failed";

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * A remote shell has no screen to open a window on. win32 always has one;
 * linux needs a display server; every other platform stays browser-only.
 */
export function hasDesktopSession(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (nonEmpty(env.SSH_CONNECTION) || nonEmpty(env.SSH_CLIENT) || nonEmpty(env.SSH_TTY)) return false;
  if (platform === "win32") return true;
  if (platform === "linux") return nonEmpty(env.DISPLAY) || nonEmpty(env.WAYLAND_DISPLAY);
  return false;
}

/**
 * A second desk relays the show request to the first and exits 0 inside the
 * window, so an early exit means the screen already has an owner. A desk still
 * alive at the deadline is this launch: detach it and let it run.
 */
export function launchDesk(
  command: string,
  args: readonly string[],
  windowMs: number = DESK_EARLY_EXIT_MS,
): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: LaunchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
    } catch {
      finish("failed");
      return;
    }
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve("running");
    }, windowMs);
    child.once("error", () => finish("failed"));
    child.once("exit", (code, signal) => finish(code === 0 && signal === null ? "handed-off" : "failed"));
  });
}

export interface DeskOpenDeps {
  rockyHome: string;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  cliChanged: boolean;
  resolvePackage: (platform: NodeJS.Platform, arch: string) => PlatformPackage | undefined;
  runQuit: (deskExe: string) => number;
  sync: typeof syncBinaries;
  launch: (deskExe: string) => Promise<LaunchOutcome>;
  applySetup: () => Promise<void>;
  say: (line: string) => void;
}

/**
 * Copy the desk binaries in when the home is behind and open the desk. Every
 * non-open answer lets the caller fall back to the browser view; only
 * "opened" means a window is (or just became) the screen's owner.
 */
export async function openDesk(deps: DeskOpenDeps): Promise<"opened" | "unavailable" | "failed"> {
  if (!hasDesktopSession(deps.env, deps.platform)) return "unavailable";
  const pkg = deps.resolvePackage(deps.platform, deps.arch);
  if (pkg === undefined) return "unavailable";

  const bin = binDir(deps.rockyHome);
  let swapped = false;
  if (!binariesCurrent(deps.rockyHome, pkg.version, deps.platform)) {
    const quitCode = deps.runQuit(pkg.binaries["rocky-desk"]);
    const result = deps.sync(deps.rockyHome, pkg, deps.platform);
    if (result.state === "error") {
      deps.say(`rocky: cannot install the desktop app into ${bin}: ${result.detail}`);
      return "failed";
    }
    if (quitCode !== 0) {
      deps.say(
        `rocky: the running desktop app or its background process did not close. Quit Rocky from its tray menu, or end the rockyd process if no tray icon shows, then run rocky again to use version ${pkg.version}.`,
      );
    }
    swapped = result.state === "installed";
  }

  const deskExe = join(bin, binaryFileName("rocky-desk", deps.platform));
  if (await deps.launch(deskExe) === "failed") {
    deps.say("rocky: the desktop app did not start. Opening the browser view instead.");
    return "failed";
  }

  if (swapped || deps.cliChanged) await deps.applySetup();
  return "opened";
}

export function defaultDeskOpenDeps(cliChanged: boolean): DeskOpenDeps {
  return {
    rockyHome: resolveRockyPaths().home,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    cliChanged,
    resolvePackage: (platform, arch) => resolvePlatformPackage(platform, arch),
    runQuit: (deskExe) =>
      spawnSync(deskExe, ["--quit"], { stdio: "ignore", windowsHide: true, timeout: 15_000 }).status ?? -1,
    sync: syncBinaries,
    launch: (deskExe) => launchDesk(deskExe, []),
    applySetup: async () => {
      try {
        await runAutoSetup(["apply", "--json"], defaultAutoContext, () => undefined);
      } catch {
        // The desk is open either way. Setup is retried only after a binary
        // swap or a rewritten cli.json, not on every launch.
      }
    },
    say: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}
