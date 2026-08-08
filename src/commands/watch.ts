/**
 * `rocky watch "<command>" [--quiet]`
 *
 * For the commands you walk away from: runs `cmd` exactly like `rocky run`
 * does — same streaming, same fingerprinting, same fix-linking, same
 * cross-directory admission — plus three things a long, unattended process
 * needs: a periodic idle line while stderr stays silent, a saved stderr tail
 * on failure (`~/.rocky/watch/`), and a notification (or a bell) when it's
 * done. `--quiet` keeps the recording but drops every persona line, every
 * idle line, and the notification — stderr gets plain facts only.
 */

import { fingerprint } from "../core/fingerprint.js";
import { runProcess, type ExecResult } from "../core/exec.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { loadMemory, recordWatchFailure, type MemoryRecord } from "../core/memory.js";
import { DEFAULT_WATCH_NOTIFY, loadConfig } from "../core/config-read.js";
import { formatDuration, notify as realNotify, spokenDuration, type NotifyInput } from "../core/notify.js";
import { watchLogName, writeWatchLog } from "../core/watch-log.js";
import { linkFixOnSuccess, speakFailureMemory } from "./run.js";
import { detail, phrase, say } from "../ui/rocky.js";

export interface ParsedWatch { quiet: boolean; cmd: string }

/**
 * Options are honoured wherever they appear, not only before the command.
 *
 * `rocky --help` documents `rocky watch "<command>" [--quiet]` — the trailing
 * form. Stopping option parsing at the first positional appended `--quiet` to
 * the command string instead, so `rocky watch "sleep 1" --quiet` really ran
 * `sleep 1 --quiet`: a wrapped exit 0 became 1 and a failure that never
 * happened entered memory. Rocky must never change the command he was handed.
 *
 * `--` still ends option parsing, so a command that genuinely needs a literal
 * `--flag` token stays expressible.
 */
export function parseWatchArgs(argv: readonly string[]): ParsedWatch {
  let quiet = false;
  let parsingOptions = true;
  const cmdParts: string[] = [];

  for (const token of argv) {
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && token === "--quiet") {
      quiet = true;
      continue;
    }
    if (parsingOptions && token.startsWith("--")) throw new Error(`unknown option: ${token}`);
    cmdParts.push(token);
  }

  return { quiet, cmd: cmdParts.join(" ") };
}

export const WATCH_IDLE_MS = 1000 * 60 * 10;

// Shell convention (spec §7): the user cancelled. Pass the code through as-is
// — no memory record, no log, no notification, no persona line.
const CANCEL_CODES = new Set([130, 143]);

export interface WatchDependencies {
  notify: (input: NotifyInput) => void;
}

function defaultWatchDependencies(): WatchDependencies {
  return { notify: realNotify };
}

/**
 * Equivalent of `run.ts`'s read guard, adapted for `--quiet`: reading still
 * always happens (fix-linking on success needs it regardless of quiet), but
 * the "I cannot read memory" disclosure is a persona line, so it's silenced.
 */
function readMemory(quiet: boolean): MemoryRecord[] | undefined {
  try {
    return loadMemory();
  } catch {
    if (!quiet) {
      say("memory file does not open for me. I answer from nothing.");
      detail(`    memory: ${resolveRockyPaths().memory}`);
    }
    return undefined;
  }
}

/** "still waiting. 10 minutes. waiting is easy for me" — composed because the duration varies. */
export function idleLine(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / 60000);
  return `still waiting. ${minutes} minute${minutes === 1 ? "" : "s"}. ${phrase("watch-idle-tail")}`;
}

/** "command finish. good good. 812 seconds." / "command dies. bad. 812 seconds." */
function outcomeLine(ok: boolean, durationMs: number): string {
  return `${phrase(ok ? "watch-ok" : "watch-fail")} ${spokenDuration(durationMs)}.`;
}

function notifyEnabled(): boolean {
  const loaded = loadConfig();
  if (loaded.status !== "valid") return DEFAULT_WATCH_NOTIFY;
  return loaded.config.watch?.notify ?? DEFAULT_WATCH_NOTIFY;
}

/** `--quiet`'s entire output: no persona, just the facts, written directly (not through `say`). */
function plainFacts(result: ExecResult, logPath: string | undefined): void {
  process.stderr.write(`duration: ${formatDuration(result.durationMs)}\n`);
  process.stderr.write(`exit: ${result.code}\n`);
  if (logPath !== undefined) process.stderr.write(`log: ${logPath}\n`);
}

function onWatchSuccess(cmd: string, cwd: string, quiet: boolean, result: ExecResult): void {
  if (!quiet) say(outcomeLine(true, result.durationMs));
  const memory = readMemory(quiet);
  if (memory !== undefined) linkFixOnSuccess(memory, cmd, cwd, quiet);
}

/**
 * Returns the log path writeWatchLog produced, or undefined when it
 * couldn't write. The log write always runs, even when recordWatchFailure
 * throws (e.g. memory.jsonl unreadable) — the watch log is independent of
 * memory and is the whole point of `watch` on failure, so a memory-write
 * failure must not cost it.
 */
function onWatchFailure(cmd: string, cwd: string, quiet: boolean, result: ExecResult): string | undefined {
  if (!quiet) {
    say(outcomeLine(false, result.durationMs));
    const memory = readMemory(false);
    if (memory !== undefined) {
      speakFailureMemory(memory, fingerprint(result.stderr), result.code, cwd);
    }
  }

  try {
    recordWatchFailure(cmd, result.code, result.stderr, cwd);
  } catch {
    if (!quiet) {
      say("I cannot write memory. this one I forget.");
      detail(`    memory: ${resolveRockyPaths().memory}`);
    }
  }

  const logPath = writeWatchLog(resolveRockyPaths().watchDir, watchLogName(Date.now(), cmd), result.tail);
  if (!quiet) {
    if (logPath !== undefined) {
      detail(`    log: ${logPath}`);
    } else {
      say(phrase("watch-log-unwritable"));
    }
  }
  return logPath;
}

export async function watch(
  argv: readonly string[],
  dependencies: WatchDependencies = defaultWatchDependencies(),
): Promise<number> {
  let parsed: ParsedWatch;
  try {
    parsed = parseWatchArgs(argv);
  } catch (error) {
    say("watch option is wrong. bad bad.");
    detail(error instanceof Error ? error.message : "unknown option");
    return 2;
  }

  const { quiet, cmd } = parsed;
  if (!cmd || cmd.trim().length === 0) {
    say("no command. give command, question");
    return 2;
  }

  const cwd = process.cwd();
  const result = await runProcess(cmd, {
    idleMs: WATCH_IDLE_MS,
    onIdle: quiet ? undefined : (elapsedMs: number) => say(idleLine(elapsedMs)),
  });

  if (CANCEL_CODES.has(result.code)) return result.code;

  // Memory/log bookkeeping must never change what the wrapped command did —
  // same contract as run.ts — so a storage failure is reported and swallowed.
  let logPath: string | undefined;
  try {
    if (result.code === 0) {
      onWatchSuccess(cmd, cwd, quiet, result);
    } else {
      logPath = onWatchFailure(cmd, cwd, quiet, result);
    }
  } catch {
    if (!quiet) {
      say("I cannot write memory. this one I forget.");
      detail(`    memory: ${resolveRockyPaths().memory}`);
    }
  }

  if (quiet) plainFacts(result, logPath);
  if (!quiet && notifyEnabled()) {
    dependencies.notify({ cmd, ok: result.code === 0, durationMs: result.durationMs });
  }

  return result.code;
}
