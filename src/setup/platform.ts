import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

export interface PlatformServices {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
  isWsl: boolean;
  wslDistro?: string;
  shell?: string;
  wslDesktopConfigPaths?: readonly string[];
  wslExecutablePaths?: readonly string[];
  wslpathExecutablePaths?: readonly string[];
  resolveExecutable(name: string): string | undefined;
  fileExists(path: string): boolean;
  hasBashHook(): boolean;
}

export interface PlatformServiceOverrides {
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string;
  isWsl?: boolean;
  wslDistro?: string;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  listDirectory?: (path: string) => readonly string[];
  bashHookInstalled?: boolean;
  wslDesktopConfigPaths?: readonly string[];
  wslExecutablePaths?: readonly string[];
  wslpathExecutablePaths?: readonly string[];
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
  return resolveUnixExecutables(name, env, fileExists)[0];
}

function resolveUnixExecutables(
  name: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string[] {
  if (posix.isAbsolute(name) || isAbsolute(name)) return fileExists(name) ? [name] : [];
  const matches: string[] = [];
  for (const directory of (env.PATH ?? "").split(":")) {
    if (directory === "") continue;
    const candidate = posix.join(directory, name);
    if (fileExists(candidate) && !matches.includes(candidate)) matches.push(candidate);
  }
  return matches;
}

function listProfileDirectories(path: string): readonly string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function discoverWslDesktopConfigs(
  listDirectory: (path: string) => readonly string[],
  fileExists: (path: string) => boolean,
): string[] {
  const usersRoot = "/mnt/c/Users";
  let profiles: readonly string[];
  try {
    profiles = listDirectory(usersRoot);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const profile of profiles) {
    if (profile.length === 0
      || profile === "."
      || profile === ".."
      || profile.includes("/")
      || profile.includes("\\")) continue;
    const candidate = posix.join(
      usersRoot,
      profile,
      "AppData",
      "Roaming",
      "Claude",
      "claude_desktop_config.json",
    );
    if (fileExists(candidate) && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

export function createPlatformServices(overrides: PlatformServiceOverrides = {}): PlatformServices {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const fileExists = overrides.fileExists ?? existsSync;
  const listDirectory = overrides.listDirectory ?? listProfileDirectories;
  const home = overrides.home ?? homedir();
  const service: PlatformServices = {
    platform,
    home,
    isWsl: overrides.isWsl ?? detectWsl(platform, env),
    resolveExecutable(name) {
      return platform === "win32"
        ? resolveWindowsExecutable(name, env, fileExists)
        : resolveUnixExecutable(name, env, fileExists);
    },
    fileExists,
    hasBashHook() {
      if (overrides.bashHookInstalled !== undefined) return overrides.bashHookInstalled;
      try {
        return readFileSync(join(home, ".bashrc"), "utf8").includes("# >>> rocky hook >>>");
      } catch {
        return false;
      }
    },
  };
  const appData = overrides.appData ?? env.APPDATA;
  if (appData !== undefined) service.appData = appData;
  const wslDistro = overrides.wslDistro ?? env.WSL_DISTRO_NAME;
  if (wslDistro !== undefined) service.wslDistro = wslDistro;
  if (env.SHELL !== undefined) service.shell = env.SHELL;
  if (service.isWsl) {
    const discoveredConfigs = discoverWslDesktopConfigs(listDirectory, fileExists);
    const explicitConfig = env.ROCKY_WSL_CLAUDE_CONFIG;
    const desktopConfigs = overrides.wslDesktopConfigPaths ?? [...new Set([
      ...discoveredConfigs,
      ...(explicitConfig === undefined ? [] : [explicitConfig]),
    ])];
    service.wslDesktopConfigPaths = Object.freeze([...desktopConfigs]);
    service.wslExecutablePaths = Object.freeze([
      ...(overrides.wslExecutablePaths ?? resolveUnixExecutables("wsl.exe", env, fileExists)),
    ]);
    service.wslpathExecutablePaths = Object.freeze([
      ...(overrides.wslpathExecutablePaths ?? resolveUnixExecutables("wslpath", env, fileExists)),
    ]);
  }
  return Object.freeze(service);
}
