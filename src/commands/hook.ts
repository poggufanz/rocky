/**
 * Rocky's ears — the shell-hook side of the CLI.
 *
 * This file owns:
 *  - hidden handlers `_hookfail` / `_hooksuccess`, spawned in the background
 *    by rocky-hook.bash (stderr discarded — they speak via /dev/tty)
 *  - `rocky hook install|uninstall|status` (Task 6)
 */

import { commandFingerprint } from "../core/fingerprint.js";
import {
  clearPendingIfResolved,
  findByFingerprint,
  getFix,
  loadMemory,
  recentUnresolvedFailures,
  recordFix,
  recordHookFailure,
} from "../core/memory.js";
import { ago, detailTty, sayTty } from "../ui/rocky.js";

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
