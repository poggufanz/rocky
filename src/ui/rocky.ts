/**
 * Rocky's face and voice.
 *
 * Speech rules (from the book):
 *  - questions end with ", question" — never "?"
 *  - emphasis by repetition: "good good good", "bad bad"
 *  - no articles, short sentences, present tense
 *  - he is blind; he never says "I see". He hears, he remembers, he checks.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeTerminalBlock, safeTerminalLine } from "./sanitize.js";

export { phrase, phraseForAct, phraseKeys, validateRockyPhrase, type PhraseKey } from "./phrases.js";

const useStdoutColor = process.stdout.isTTY && !process.env.NO_COLOR;
const useStderrColor = process.stderr.isTTY && !process.env.NO_COLOR;

const amberStdout = (s: string) => (useStdoutColor ? `\u001b[33m${s}\u001b[0m` : s);
const amberStderr = (s: string) => (useStderrColor ? `\u001b[33m${s}\u001b[0m` : s);
const dimStderr = (s: string) => (useStderrColor ? `\u001b[2m${s}\u001b[0m` : s);
const boldStderr = (s: string) => (useStderrColor ? `\u001b[1m${s}\u001b[0m` : s);

let childStderrNeedsSeparator = false;

/** Record the final raw byte without decoding or sanitizing the child stream. */
export function trackChildStderr(chunk: Uint8Array): void {
  if (chunk.length > 0) childStderrNeedsSeparator = chunk[chunk.length - 1] !== 0x0a;
}

function startsWithLf(chunk: string | Uint8Array): boolean {
  return typeof chunk === "string" ? chunk.charCodeAt(0) === 0x0a : chunk[0] === 0x0a;
}

/** Write Rocky-owned stderr, inserting at most one needed line separator. */
export function writeRockyStderr(chunk: string | Uint8Array): void {
  if (childStderrNeedsSeparator) {
    childStderrNeedsSeparator = false;
    if (!startsWithLf(chunk)) process.stderr.write("\n");
  }
  process.stderr.write(chunk);
}

/**
 * Rocky, seen from the front: pentagonal carapace, five radial legs,
 * breathing slits on top, no face. He hangs from the ceiling of his
 * habitat tunnel, as Eridians do.
 */
const FACE = [
  "  ═╦═══════╦═ ",
  "   ║ ┌───┐ ║  ",
  "   ╲_││││││_╱  ",
  "   ╱ ╲▔▔▔╱ ╲  ",
  "  ╱ ╱ ╲_╱ ╲ ╲ ",
];

export function face(): string {
  return FACE.map((l) => amberStdout(l)).join("\n");
}

/** One Rocky line, prefixed. */
export function say(msg: string): void {
  writeRockyStderr(`${amberStderr("[Rocky]")} ${safeTerminalLine(msg)}\n`);
}

/** Rocky prompt text; readline writes it to the prompt port's stderr stream. */
export function prompt(msg: string): string {
  return `${amberStderr("[Rocky]")} ${safeTerminalLine(msg)} `;
}

/** Rocky line without trailing newline context — for multi-line blocks. */
export function block(lines: string[]): void {
  for (const l of lines) writeRockyStderr(`${amberStderr("♫")} ${safeTerminalLine(l)}\n`);
}

export function heading(msg: string): void {
  writeRockyStderr(`\n${boldStderr(safeTerminalLine(msg))}\n`);
}

export function detail(msg: string): void {
  writeRockyStderr(`${dimStderr(safeTerminalBlock(msg))}\n`);
}

/** "just now", "2 minutes", "6 hours", "3 days" — the bare span, no suffix. */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** "84 days ago", "3 hours ago", "just now" — Rocky counts precisely. */
export function ago(ts: number): string {
  const span = elapsed(Date.now() - ts);
  return span === "just now" ? span : `${span} ago`;
}

/**
 * Hook speech buffer.
 *
 * Hook handlers run as detached background processes with stdio discarded.
 * To avoid racing the shell prompt and polluting interactive consoles (such as
 * running tests or TUI applications), all hook speech is buffered in memory
 * when ROCKY_HOOK_SPEECH_FILE is set (which both Bash and PowerShell hooks do)
 * and published atomically via flushHookSpeech(). When ROCKY_HOOK_SPEECH_FILE
 * is unset, hook speech is discarded silently without touching the console device.
 */
let hookSpeechBuffer: string[] = [];

function speakTty(line: string): void {
  if (process.env.ROCKY_HOOK_SPEECH_FILE) {
    hookSpeechBuffer.push(line);
  }
}

/**
 * Speak directly to the terminal from a background process (hook handlers
 * are spawned disowned with stderr discarded). No tty — no words; never throw.
 */
export function sayTty(msg: string): void {
  speakTty(`[Rocky] ${safeTerminalLine(msg)}\n`);
}

export function detailTty(msg: string): void {
  speakTty(`    ${safeTerminalLine(msg)}\n`);
}

/**
 * Publishes whatever `sayTty`/`detailTty` buffered this process's lifetime —
 * called exactly once, at the very end of whichever hook handler ran
 * (`index.ts`'s `_hookfail`/`_hooksuccess` dispatch), regardless of which of
 * that handler's internal branches produced it. A no-op when nothing was
 * buffered (no env var set — the ordinary direct-write path never touches
 * this — or a handler that had nothing to say this time): never creates a
 * file speaking nothing, never leaves a stray empty file to clean up later.
 *
 * Write-then-rename into place, not an in-place write: `rocky-hook.ps1`'s
 * `prompt` only ever reads files matching the final, published name pattern
 * (`*.txt`), so a reader can never observe this write mid-flight — it either
 * finds the whole message or does not find the file yet. A failure here
 * (directory unmakeable, disk full, a raced delete) must never surface: a
 * detached handler's own bookkeeping breaking is never the user's problem,
 * the same contract every other fallible step in this handler already
 * keeps — losing one message silently is strictly better than a raw error
 * reaching a console this process no longer owns.
 */
export function flushHookSpeech(): void {
  const speechFile = process.env.ROCKY_HOOK_SPEECH_FILE;
  const lines = hookSpeechBuffer;
  hookSpeechBuffer = [];
  if (!speechFile || lines.length === 0) return;
  try {
    mkdirSync(dirname(speechFile), { recursive: true });
    const tempPath = `${speechFile}.${process.pid}.tmp`;
    writeFileSync(tempPath, lines.join(""), "utf8");
    renameSync(tempPath, speechFile);
  } catch {
    /* a lost message is better than a broken shell */
  }
}
