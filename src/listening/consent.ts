/**
 * Write-only repo-consent grants (spec §3 + setup §7). The read side lives
 * in repo-consent-read.ts, which MCP may import. This module MCP must
 * never import: it mutates the consent store. GUI Add/Revoke and the setup
 * CLI share this backend; opening or selecting a repo never grants.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalPath } from "../core/memory-read.js";
import { consentsPath, listeningHome } from "./store-paths.js";
import { normalizeRepoRoot } from "./repo-consent-read.js";

function isGitRoot(canonicalRoot: string): boolean {
  try {
    const gitDir = lstatSync(join(canonicalRoot, ".git"));
    if (gitDir.isSymbolicLink()) return false;
    if (!gitDir.isDirectory() && !gitDir.isFile()) return false;
  } catch {
    return false;
  }
  // A .git is only a root when Git itself reads it as one. A stub Git cannot
  // read used to pass, and capture then walked the folder wholesale; a stray
  // .git inside a repo names a subfolder, never a root.
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: canonicalRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    return top.length > 0 && canonicalPath(realpathSync(top)) === canonicalPath(canonicalRoot);
  } catch {
    return false;
  }
}

/**
 * Grant or revoke capture for one canonical Git root. `yes` is the explicit
 * consent switch: without it the call reports requires-confirmation and
 * writes nothing. Revoke stops future capture; history stays on disk.
 */
export function setRepoCapture(
  canonicalRoot: string,
  allow: boolean,
  opts: { yes: boolean; actor: "cli" | "gui" },
  home?: string,
): { ok: boolean; root?: string; reason?: string } {
  if (opts.yes !== true) return { ok: false, reason: "requires-confirmation" };
  if (typeof canonicalRoot !== "string" || !isAbsolute(canonicalRoot)) {
    return { ok: false, reason: "path-must-be-absolute" };
  }
  let real: string;
  try {
    real = realpathSync(canonicalRoot);
  } catch {
    return { ok: false, reason: "path-unresolvable" };
  }
  try {
    if (lstatSync(canonicalRoot).isSymbolicLink()) return { ok: false, reason: "symlink-rejected" };
  } catch {
    return { ok: false, reason: "path-unresolvable" };
  }
  const root = canonicalPath(real);
  if (root.length === 0) return { ok: false, reason: "path-unresolvable" };
  if (!isGitRoot(real)) return { ok: false, reason: "not-a-git-root" };
  let current: Record<string, unknown> = {};
  try {
    const raw = readFileSync(consentsPath(home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const next: Record<string, true> = {};
  for (const [key, value] of Object.entries(current)) {
    if (value === true && typeof key === "string" && key.length > 0) next[normalizeRepoRoot(key)] = true;
  }
  if (allow) {
    next[root] = true;
  } else {
    delete next[root];
  }
  void opts.actor;
  try {
    mkdirSync(listeningHome(home), { recursive: true, mode: 0o700 });
    const tmp = join(listeningHome(home), `repo-consents.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, consentsPath(home));
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
  return { ok: true, root };
}
