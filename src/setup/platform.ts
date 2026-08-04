import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

export interface PlatformServices {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
  isWsl: boolean;
  wslDistro?: string;
  resolveExecutable(name: string): string | undefined;
  fileExists(path: string): boolean;
}

export interface PlatformServiceOverrides {
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string;
  isWsl?: boolean;
  wslDistro?: string;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

function detectWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function windowsPathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string | undefined {
  const extension = win32.extname(name).toLowerCase();
  if (extension !== "" && extension !== ".exe" && extension !== ".com") return undefined;
  const suffixes = extension === "" ? [".exe", ".com"] : [""];
  const directories = win32.isAbsolute(name) ? [""] : windowsPathValue(env).split(";").filter(Boolean);
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = win32.isAbsolute(name) ? `${win32.normalize(name)}${suffix}` : win32.join(directory, `${name}${suffix}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveUnixExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string | undefined {
  if (posix.isAbsolute(name) || isAbsolute(name)) return fileExists(name) ? name : undefined;
  for (const directory of (env.PATH ?? "").split(":")) {
    if (directory === "") continue;
    const candidate = posix.join(directory, name);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

export function createPlatformServices(overrides: PlatformServiceOverrides = {}): PlatformServices {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const fileExists = overrides.fileExists ?? existsSync;
  const service: PlatformServices = {
    platform,
    home: overrides.home ?? homedir(),
    isWsl: overrides.isWsl ?? detectWsl(platform, env),
    resolveExecutable(name) {
      return platform === "win32"
        ? resolveWindowsExecutable(name, env, fileExists)
        : resolveUnixExecutable(name, env, fileExists);
    },
    fileExists,
  };
  const appData = overrides.appData ?? env.APPDATA;
  if (appData !== undefined) service.appData = appData;
  const wslDistro = overrides.wslDistro ?? env.WSL_DISTRO_NAME;
  if (wslDistro !== undefined) service.wslDistro = wslDistro;
  return Object.freeze(service);
}

export const platformServices: PlatformServices = createPlatformServices();
