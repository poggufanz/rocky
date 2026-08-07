import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Exposure } from "../core/config-read.js";
import type { McpRegistration } from "./clients.js";

export interface ResolveMcpRegistrationOptions {
  exposure: Exposure;
  nodePath?: string;
  entryPath?: string;
  rockyHome?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  fileExists?: (path: string) => boolean;
}

function defaultEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

function isAbsoluteOnEitherPlatform(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

function normalizePortablePath(path: string): string {
  if (posix.isAbsolute(path)) return posix.normalize(path);
  if (win32.isAbsolute(path)) return win32.normalize(path);
  return normalize(path);
}

function requireExistingAbsolutePath(
  value: string,
  label: "Node" | "entry",
  fileExists: (path: string) => boolean,
): string {
  if (!isAbsoluteOnEitherPlatform(value)) throw new Error(`${label} path must be absolute`);
  const normalized = normalizePortablePath(value);
  if (!fileExists(normalized)) throw new Error(`${label} path does not exist`);
  return normalized;
}

function resolveHome(path: string, cwd: string): string {
  if (isAbsoluteOnEitherPlatform(path)) return normalizePortablePath(path);
  return resolve(cwd, path);
}

export function resolveMcpRegistration(options: ResolveMcpRegistrationOptions): McpRegistration {
  if (options.exposure !== "sanitized" && options.exposure !== "raw") {
    throw new Error("MCP exposure must be sanitized or raw");
  }
  const fileExists = options.fileExists ?? existsSync;
  const command = requireExistingAbsolutePath(options.nodePath ?? process.execPath, "Node", fileExists);
  const entry = requireExistingAbsolutePath(options.entryPath ?? defaultEntryPath(), "entry", fileExists);
  const cwd = options.cwd ?? process.cwd();
  const configuredHome = options.rockyHome
    ?? options.env?.ROCKY_HOME
    ?? join(options.home ?? homedir(), ".rocky");
  const rockyHome = resolveHome(configuredHome, cwd);
  const args = Object.freeze([entry, "mcp"]);
  const env = Object.freeze({ ROCKY_MCP_EXPOSURE: options.exposure, ROCKY_HOME: rockyHome });
  return Object.freeze({ name: "rocky", command, args, env });
}

export function isEphemeralInstall(entryPath: string, _env: NodeJS.ProcessEnv = process.env): boolean {
  const segments = entryPath
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  return segments.includes("_npx") || segments.includes("_cacache");
}

function sameNormalizedAbsolutePath(left: string, right: string): boolean {
  if (!isAbsoluteOnEitherPlatform(left) || !isAbsoluteOnEitherPlatform(right)) return false;
  return normalizePortablePath(left) === normalizePortablePath(right);
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

function validExposure(value: string | undefined): value is Exposure {
  return value === "sanitized" || value === "raw";
}

export function isOwnedRockyRegistration(stored: McpRegistration, expected: McpRegistration): boolean {
  return stored.name === "rocky"
    && expected.name === "rocky"
    && sameNormalizedAbsolutePath(stored.command, expected.command)
    && sameArgs(stored.args, expected.args)
    && validExposure(stored.env.ROCKY_MCP_EXPOSURE)
    && validExposure(expected.env.ROCKY_MCP_EXPOSURE)
    && typeof stored.env.ROCKY_HOME === "string"
    && typeof expected.env.ROCKY_HOME === "string"
    && sameNormalizedAbsolutePath(stored.env.ROCKY_HOME, expected.env.ROCKY_HOME);
}

function sameEnvironment(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function isIdenticalMcpRegistration(stored: McpRegistration, expected: McpRegistration): boolean {
  return isOwnedRockyRegistration(stored, expected) && sameEnvironment(stored.env, expected.env);
}
