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

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { fingerprint } from "../core/fingerprint.js";
import { CANCEL_CODES, runProcess, type ExecResult } from "../core/exec.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { loadMemory, recordWatchFailure, type MemoryRecord } from "../core/memory.js";
import { DEFAULT_WATCH_NOTIFY, loadConfig } from "../core/config-read.js";
import { formatDuration, notify as realNotify, spokenDuration, type NotifyInput } from "../core/notify.js";
import { watchLogName, writeWatchLog } from "../core/watch-log.js";
import { linkFixOnSuccess, speakFailureMemory } from "./run.js";
import { detail, phrase, say } from "../ui/rocky.js";
import { safeTerminalBlock, safeTerminalLine } from "../ui/sanitize.js";

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
export const WATCH_LABEL_POLL_MS = 1000;

const MAX_LABEL_FILE_BYTES = 64 * 1024;
const MAX_LABEL_LINES = 10;
const MAX_LABEL_CHARS = 400;
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
type WatchTimer = ReturnType<typeof setInterval>;

/** Return new non-empty labels in file order and remember them for this watch session. */
export function unseenLabels(seen: Set<string>, fileContent: string): string[] {
  const unseen: string[] = [];
  for (const line of fileContent.split(/\r\n|\n|\r/)) {
    if (line.length === 0 || seen.has(line)) continue;
    seen.add(line);
    unseen.push(line);
  }
  return unseen;
}

export interface WatchDependencies {
  notify: (input: NotifyInput) => void;
  /** Test seams; omitted callers retain the real read, timer, and persona behavior. */
  readLabels?: (path: string) => string;
  setInterval?: (callback: () => void, delayMs: number) => WatchTimer;
  clearInterval?: (timer: WatchTimer) => void;
  say?: (line: string) => void;
  labelPollMs?: number;
}

function defaultWatchDependencies(): WatchDependencies {
  return { notify: realNotify };
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort at this private read boundary.
  }
}

/** Read labels without following links, writing, or retaining an unbounded queue. */
function readLabelsFile(path: string): string {
  let initial;
  try {
    initial = lstatSync(path);
  } catch {
    return "";
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_LABEL_FILE_BYTES) return "";

  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size > MAX_LABEL_FILE_BYTES) return "";
    const bytes = Buffer.alloc(MAX_LABEL_FILE_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || count !== after.size || count > MAX_LABEL_FILE_BYTES) return "";

    const content = bytes.subarray(0, count).toString("utf8");
    // Labels are user-visible terminal text. Strip escape/control payloads
    // before splitting lines so a multi-line OSC cannot leak its payload.
    const sanitized = safeTerminalBlock(content.replace(/\r\n?/gu, "\n"))
      .replace(/[\u200b\u2060\ufeff]/gu, "");
    const lines = sanitized.split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-MAX_LABEL_LINES);
    return lines.map((line) => line.slice(0, MAX_LABEL_CHARS)).join("\n");
  } catch {
    return "";
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function unrefTimer(timer: WatchTimer): void {
  try {
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    // A polling timer is best effort and must never alter wrapped-command behavior.
  }
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
  linkFixOnSuccess(cmd, cwd, quiet);
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
      speakFailureMemory(memory, fingerprint(result.stderr, cmd, result.code), result.code, cwd);
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
  const seen = new Set<string>();
  const labelsPath = resolveRockyPaths().labels;
  const readLabels = dependencies.readLabels ?? readLabelsFile;
  const schedulePoll = dependencies.setInterval ?? setInterval;
  const cancelPoll = dependencies.clearInterval ?? clearInterval;
  const speakLabel = dependencies.say ?? say;
  let labelTimer: WatchTimer | undefined;
  let result: ExecResult;

  const pollLabels = (): void => {
    let content = "";
    try {
      content = readLabels(labelsPath);
    } catch {
      // Missing, unsafe, or unreadable labels are an empty queue for this tick.
      return;
    }
    try {
      for (const line of unseenLabels(seen, content)) speakLabel(safeTerminalLine(line));
    } catch {
      // Persona output is best effort and must not alter wrapped-command behavior.
    }
  };

  try {
    if (!quiet) {
      pollLabels();
      try {
        labelTimer = schedulePoll(pollLabels, dependencies.labelPollMs ?? WATCH_LABEL_POLL_MS);
        unrefTimer(labelTimer);
      } catch {
        // A polling setup failure must not prevent the command from running.
        labelTimer = undefined;
      }
    }
    result = await runProcess(cmd, {
      idleMs: WATCH_IDLE_MS,
      onIdle: quiet ? undefined : (elapsedMs: number) => say(idleLine(elapsedMs)),
    });
  } finally {
    if (labelTimer !== undefined) {
      try {
        cancelPoll(labelTimer);
      } catch {
        // Timer cleanup is best effort after the child has settled.
      }
    }
  }

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
