import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "../json-config.js";
import { binDir } from "./state.js";

export type BinaryName = "rockyd" | "rocky-desk" | "rocky-hook";

export const BINARY_NAMES: readonly BinaryName[] = ["rockyd", "rocky-desk", "rocky-hook"];

const require = createRequire(import.meta.url);

export function binaryFileName(name: BinaryName, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

export function platformPackageName(platform: NodeJS.Platform, arch: string): string | undefined {
  if (arch !== "x64") return undefined;
  if (platform === "win32") return "@poggufanz/rocky-cli-win32-x64";
  if (platform === "linux") return "@poggufanz/rocky-cli-linux-x64";
  return undefined;
}

export interface PlatformPackage {
  dir: string;
  version: string;
  binaries: Record<BinaryName, string>;
}

export function resolvePlatformPackage(
  platform: NodeJS.Platform,
  arch: string,
  resolve: (id: string) => string = (id: string): string => require.resolve(id),
): PlatformPackage | undefined {
  const id = platformPackageName(platform, arch);
  if (id === undefined) return undefined;

  let manifestPath: string;
  try {
    manifestPath = resolve(`${id}/package.json`);
  } catch {
    return undefined;
  }

  const dir = dirname(manifestPath);
  let version: unknown;
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    version = typeof manifest === "object" && manifest !== null && "version" in manifest
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
  if (typeof version !== "string") return undefined;

  const binaries: Record<BinaryName, string> = {
    rockyd: join(dir, "bin", binaryFileName("rockyd", platform)),
    "rocky-desk": join(dir, "bin", binaryFileName("rocky-desk", platform)),
    "rocky-hook": join(dir, "bin", binaryFileName("rocky-hook", platform)),
  };
  if (!Object.values(binaries).every(isFile)) return undefined;
  return { dir, version, binaries };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Best effort: a running image may still hold its old name on win32. */
function ignoreFailure(action: () => void): void {
  try {
    action();
  } catch {
    // The next sync retries.
  }
}

export function binariesRecordPath(rockyHome: string): string {
  return join(binDir(rockyHome), "binaries.json");
}

export function binariesCurrent(rockyHome: string, version: string, platform: NodeJS.Platform): boolean {
  if (!holdsVersion(binariesRecordPath(rockyHome), version)) return false;
  return BINARY_NAMES.every((name) => isFile(join(binDir(rockyHome), binaryFileName(name, platform))));
}

function holdsVersion(path: string, version: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  if (!("v" in parsed) || !("version" in parsed)) return false;
  return parsed.v === 1 && parsed.version === version;
}

export type SyncResult =
  | { state: "unchanged" }
  | { state: "installed" }
  | { state: "error"; detail: string };

export function syncBinaries(
  rockyHome: string,
  pkg: PlatformPackage,
  platform: NodeJS.Platform,
  pid: number = process.pid,
): SyncResult {
  if (binariesCurrent(rockyHome, pkg.version, platform)) return { state: "unchanged" };

  const bin = binDir(rockyHome);
  const names = BINARY_NAMES.map((name) => binaryFileName(name, platform));
  const targets = names.map((name) => join(bin, name));
  const temps = targets.map((target) => `${target}.${pid}.new`);

  try {
    mkdirSync(bin, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { state: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  clearLeftovers(bin, names);

  try {
    for (const [index, name] of BINARY_NAMES.entries()) {
      copyFileSync(pkg.binaries[name], temps[index]);
      if (platform !== "win32") chmodSync(temps[index], 0o755);
    }
    for (const [index, target] of targets.entries()) {
      if (platform === "win32") {
        // ponytail: the win32 rename-aside leaves a sub-millisecond window where the hook path is absent; an async hook event in it is lost, never half-written. Upgrade path: a stable launcher exe if that window ever shows in health gaps.
        ignoreFailure(() => rmSync(`${target}.old`, { force: true }));
        ignoreFailure(() => renameSync(target, `${target}.old`));
      }
      renameSync(temps[index], target);
    }
    atomicWriteJson(binariesRecordPath(rockyHome), { v: 1, version: pkg.version });
  } catch (error) {
    return { state: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  return { state: "installed" };
}

/** Sweeps this name set's temp files and aside names from a previous sync. */
function clearLeftovers(bin: string, names: readonly string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(bin);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!names.some((name) => isLeftover(entry, name))) continue;
    ignoreFailure(() => rmSync(join(bin, entry), { force: true }));
  }
}

function isLeftover(entry: string, name: string): boolean {
  if (entry === `${name}.old`) return true;
  const prefix = `${name}.`;
  if (!entry.startsWith(prefix) || !entry.endsWith(".new")) return false;
  return /^\d+$/.test(entry.slice(prefix.length, -".new".length));
}
