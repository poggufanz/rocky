/**
 * Rocky's ears — the shell-hook side of the CLI.
 *
 * This file owns:
 *  - hidden handlers `_hookfail` / `_hooksuccess`, spawned in the background
 *    by rocky-hook.bash (stderr discarded — they speak via /dev/tty)
 *  - `rocky hook install|uninstall|status` (Task 6)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFingerprint } from "../core/fingerprint.js";
import { renderGuardRules, rulesFileIsPristine } from "../core/guard-rules.js";
import {
  clearPendingIfResolved,
  findByFingerprint,
  getFix,
  loadMemory,
  recentUnresolvedFailures,
  recordFix,
  recordHookFailure,
} from "../core/memory.js";
import { ago, detail, detailTty, say, sayTty } from "../ui/rocky.js";

/** A command failed in the hooked shell. Record it; speak only if memory has something to say. */
export function hookFail(cmd: string, exitCode: number, cwd: string): number {
  const memory = loadMemory();
  const fp = commandFingerprint(cmd, exitCode);
  const previous = findByFingerprint(memory, fp);

  recordHookFailure(cmd, exitCode, cwd);

  if (previous.length === 0) return 0; // first time: passive ears stay quiet

  const withFix = [...previous].reverse().find((f) => getFix(memory, f));
  if (withFix) {
    const fix = getFix(memory, withFix)!;
    sayTty(`I hear this error before. ${ago(withFix.ts)}. last time, you fix with:`);
    detailTty(fix.cmd);
    sayTty("try, question");
  } else {
    sayTty(`this error again. deep memory need stderr. run with: rocky run "${cmd}", question`);
  }
  return 0;
}

/** A command succeeded while the pending flag existed. Try to link a fix. */
export function hookSuccess(cmd: string, cwd: string): number {
  try {
    process.chdir(cwd); // recentUnresolvedFailures matches on process.cwd()
  } catch {
    /* cwd vanished — heuristic simply finds nothing */
  }
  const memory = loadMemory();
  const unresolved = recentUnresolvedFailures(memory, cmd);
  if (unresolved.length > 0) {
    recordFix(cmd, unresolved);
    sayTty("command works now. you fix it. I remember the fix. good good good.");
  }
  clearPendingIfResolved(loadMemory());
  return 0;
}

const HOOK_BEGIN = "# >>> rocky hook >>>";
const HOOK_END = "# <<< rocky hook <<<";
const HOOK_LINE =
  '[ -f "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash" ] && . "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash"';

export function hasHookBlock(content: string): boolean {
  return content.includes(HOOK_BEGIN);
}

export function addHookBlock(content: string): string {
  if (hasHookBlock(content)) return content;
  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}\n${HOOK_BEGIN}\n${HOOK_LINE}\n${HOOK_END}\n`;
}

export function removeHookBlock(content: string): string {
  if (!hasHookBlock(content)) return content;
  if (!content.split("\n").some((l) => l.trim() === HOOK_END)) return content; // BEGIN without END: corrupt block, touch nothing
  const lines = content.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const l of lines) {
    if (l.trim() === HOOK_BEGIN) { inside = true; continue; }
    if (l.trim() === HOOK_END) { inside = false; continue; }
    if (!inside) out.push(l);
  }
  return out.join("\n").replace(/\n{3,}$/, "\n\n");
}

function rockyHome(): string {
  return process.env.ROCKY_HOME ?? join(homedir(), ".rocky");
}

function bashrcPath(): string {
  return join(homedir(), ".bashrc");
}

function assetDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "shell");
}

export function hookInstall(): number {
  const home = rockyHome();
  mkdirSync(home, { recursive: true });

  for (const f of ["rocky-hook.bash", "bash-preexec.sh"]) {
    const src = join(assetDir(), f);
    if (!existsSync(src)) {
      say(`hook file missing from install: ${f}. install incomplete. bad.`);
      return 1;
    }
    copyFileSync(src, join(home, f));
  }

  const rulesPath = join(home, "guard.rules");
  if (!existsSync(rulesPath) || rulesFileIsPristine(readFileSync(rulesPath, "utf8"))) {
    writeFileSync(rulesPath, renderGuardRules(), "utf8");
  } else {
    say("guard rules file has your edits. I keep them. good.");
  }

  const rc = bashrcPath();
  const content = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (!hasHookBlock(content)) writeFileSync(rc, addHookBlock(content), "utf8");

  say("ears installed. open new shell, I hear everything there.");
  detail(`hook:  ${join(home, "rocky-hook.bash")}`);
  detail(`rules: ${rulesPath}`);
  say("dangerous command comes, I ask first. ROCKY_OFF=1 makes me deaf.");
  return 0;
}

export function hookUninstall(): number {
  const rc = bashrcPath();
  if (!existsSync(rc) || !hasHookBlock(readFileSync(rc, "utf8"))) {
    say("no ears installed. nothing to remove.");
    return 0;
  }
  writeFileSync(rc, removeHookBlock(readFileSync(rc, "utf8")), "utf8");
  say(`ears removed from shell. memory stays in ${rockyHome()}. I still remember.`);
  return 0;
}

export function hookStatus(): number {
  const rc = bashrcPath();
  const installed = existsSync(rc) && hasHookBlock(readFileSync(rc, "utf8"));
  if (!installed) {
    say("ears not installed. run: rocky hook install");
    return 0;
  }
  const hookFile = join(rockyHome(), "rocky-hook.bash");
  const version = existsSync(hookFile)
    ? /ROCKY_HOOK_VERSION="([^"]+)"/.exec(readFileSync(hookFile, "utf8"))?.[1] ?? "unknown"
    : "missing";
  const rulesPath = join(rockyHome(), "guard.rules");
  const ruleCount = existsSync(rulesPath)
    ? readFileSync(rulesPath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length
    : 0;
  say(`ears installed. hook version ${version}. ${ruleCount} guard rule${ruleCount === 1 ? "" : "s"} active.`);
  return 0;
}
