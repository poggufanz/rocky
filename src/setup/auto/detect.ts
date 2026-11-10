import { realpathSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { canonicalPath } from "../../core/memory-read.js";
import { isCanonicalAbsoluteDirectory, isCanonicalAbsoluteFile } from "../claude-code.js";
import { resolveCodexHome } from "../harness-codex.js";
import { resolveCopilotConfigPath } from "../harness-copilot-cli.js";
import { resolveGeminiSettingsPath } from "../harness-gemini-cli.js";
import { MCP_HARNESS_IDS } from "../harness-mcp-dispatch.js";
import { resolveOpencodeConfigPath } from "../harness-opencode.js";
import type { McpHarnessId } from "./state.js";

export interface DetectEnv {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  appData?: string;
  fileExists(path: string): boolean;
  isFile(path: string): boolean;
}

export interface DetectedHarness {
  id: McpHarnessId;
  via: "binary" | "config-only";
}

export type LocationRefusal = "not-canonical" | "outside-home" | "symlink" | "missing" | "no-harness-file";

const WINDOWS_SUFFIXES = [".exe", ".com", ".cmd"] as const;

/**
 * File-existence lookup only: a shim counts as found without being run, so an
 * unfetchable or failing binary cannot make a harness look absent. A directory
 * with a matching name is not a binary.
 */
export function findOnPath(name: string, d: DetectEnv): string | undefined {
  const api = d.platform === "win32" ? win32 : posix;
  const suffixes = d.platform === "win32" ? WINDOWS_SUFFIXES : [""];
  const rawPath = typeof d.env.PATH === "string"
    ? d.env.PATH
    : d.platform === "win32" && typeof d.env.Path === "string" ? d.env.Path : "";
  for (const dir of rawPath.split(api.delimiter)) {
    if (dir.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = api.join(dir, `${name}${suffix}`);
      if (d.isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

interface HarnessProbe {
  binary: string;
  configPresent(d: DetectEnv): boolean;
}

function resolverInput(d: DetectEnv): {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  appData?: string;
} {
  return { env: d.env, home: d.home, platform: d.platform, appData: d.appData };
}

const PROBES: Record<McpHarnessId, HarnessProbe> = {
  "claude-code": {
    binary: "claude",
    configPresent: (d) => d.fileExists(join(d.home, ".claude")) || d.fileExists(join(d.home, ".claude.json")),
  },
  codex: {
    binary: "codex",
    configPresent: (d) => d.fileExists(resolveCodexHome(resolverInput(d))),
  },
  opencode: {
    binary: "opencode",
    configPresent: (d) => d.fileExists(dirname(resolveOpencodeConfigPath(resolverInput(d)))),
  },
  "gemini-cli": {
    binary: "gemini",
    configPresent: (d) => d.fileExists(dirname(resolveGeminiSettingsPath(resolverInput(d)))),
  },
  "copilot-cli": {
    binary: "copilot",
    configPresent: (d) => d.fileExists(dirname(resolveCopilotConfigPath(resolverInput(d)))),
  },
};

export function detectHarnesses(d: DetectEnv): DetectedHarness[] {
  const found: DetectedHarness[] = [];
  for (const id of MCP_HARNESS_IDS) {
    if (!Object.hasOwn(PROBES, id)) continue;
    const harness = id as McpHarnessId;
    const probe = PROBES[harness];
    if (findOnPath(probe.binary, d) !== undefined) {
      found.push({ id: harness, via: "binary" });
    } else if (probe.configPresent(d)) {
      found.push({ id: harness, via: "config-only" });
    }
  }
  return found;
}

const DIRECTORY_MARKERS: Partial<Record<McpHarnessId, readonly string[]>> = {
  "claude-code": [".claude.json", "settings.json"],
  codex: ["config.toml"],
  "copilot-cli": ["config.json"],
};

function realpath(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function isStrictlyUnder(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const childKey = canonicalPath(child, { platform });
  const parentKey = canonicalPath(parent, { platform });
  if (childKey.length === 0 || parentKey.length === 0 || childKey === parentKey) return false;
  return parentKey === "/" || childKey.startsWith(`${parentKey}/`);
}

/**
 * A default (non-env) target is created under a directory Rocky derives itself.
 * That parent must be a canonical absolute path, its own real path, and inside
 * the user's home; a missing parent stays for the caller's existence check.
 */
export function validateDefaultParent(parent: string, d: DetectEnv): LocationRefusal | undefined {
  const api = d.platform === "win32" ? win32 : posix;
  if (!isCanonicalAbsoluteDirectory(parent, api)) return "not-canonical";
  const real = realpath(parent);
  if (real === undefined) return undefined;
  if (canonicalPath(real, { platform: d.platform }) !== canonicalPath(parent, { platform: d.platform })) {
    return "symlink";
  }
  const homeReal = realpath(d.home);
  if (homeReal === undefined) return "outside-home";
  const atHome = canonicalPath(real, { platform: d.platform }) === canonicalPath(homeReal, { platform: d.platform });
  return atHome || isStrictlyUnder(real, homeReal, d.platform) ? undefined : "outside-home";
}

/**
 * Config locations are written by the engine later, so they must be canonical,
 * non-symlinked, and confined to the user's home before anything mutates them.
 */
export function validateConfigLocation(
  harness: McpHarnessId,
  value: string,
  d: DetectEnv,
): { ok: true; location: string } | { ok: false; reason: LocationRefusal } {
  const api = d.platform === "win32" ? win32 : posix;
  const markers = DIRECTORY_MARKERS[harness];
  const canonical = markers === undefined
    ? isCanonicalAbsoluteFile(value, api)
    : isCanonicalAbsoluteDirectory(value, api);
  if (!canonical) return { ok: false, reason: "not-canonical" };

  const real = realpath(value);
  if (real === undefined) return { ok: false, reason: "missing" };
  if (canonicalPath(real, { platform: d.platform }) !== canonicalPath(value, { platform: d.platform })) {
    return { ok: false, reason: "symlink" };
  }

  const homeReal = realpath(d.home);
  if (homeReal === undefined || !isStrictlyUnder(real, homeReal, d.platform)) {
    return { ok: false, reason: "outside-home" };
  }

  if (markers !== undefined && !markers.some((marker) => d.fileExists(api.join(value, marker)))) {
    return { ok: false, reason: "no-harness-file" };
  }
  return { ok: true, location: value };
}
