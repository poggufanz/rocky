/**
 * Rocky's face and voice.
 *
 * Speech rules (from the book):
 *  - questions end with ", question" — never "?"
 *  - emphasis by repetition: "good good good", "bad bad"
 *  - no articles, short sentences, present tense
 *  - he is blind; he never says "I see". He hears, he remembers, he checks.
 */

import { writeFileSync } from "node:fs";
import { safeTerminalBlock, safeTerminalLine } from "./sanitize.js";

export { phrase, phraseForAct, phraseKeys, validateRockyPhrase, type PhraseKey } from "./phrases.js";

const useStdoutColor = process.stdout.isTTY && !process.env.NO_COLOR;
const useStderrColor = process.stderr.isTTY && !process.env.NO_COLOR;

const amberStdout = (s: string) => (useStdoutColor ? `\u001b[33m${s}\u001b[0m` : s);
const amberStderr = (s: string) => (useStderrColor ? `\u001b[33m${s}\u001b[0m` : s);
const dimStderr = (s: string) => (useStderrColor ? `\u001b[2m${s}\u001b[0m` : s);
const boldStderr = (s: string) => (useStderrColor ? `\u001b[1m${s}\u001b[0m` : s);

// ponytail: one active child stream; per-run boundary context if wrappers ever run concurrently.
let childStderrActive = false;
let childStderrLastByteWasLf = true;
let childStderrCommentaryStarted = false;
let childStderrReset: NodeJS.Immediate | undefined;

/** Begin tracking raw child stderr until the first Rocky-owned output. */
export function startChildStderr(): void {
  if (childStderrReset !== undefined) clearImmediate(childStderrReset);
  childStderrReset = undefined;
  childStderrActive = true;
  childStderrLastByteWasLf = true;
  childStderrCommentaryStarted = false;
}

/** Record the final raw byte without decoding or sanitizing the child stream. */
export function trackChildStderr(chunk: Uint8Array): void {
  if (childStderrActive && chunk.length > 0) {
    childStderrLastByteWasLf = chunk[chunk.length - 1] === 0x0a;
  }
}

/** Stop live tracking while retaining one pending boundary for post-exit output. */
export function finishChildStderr(): void {
  childStderrActive = false;
  if (childStderrReset !== undefined) clearImmediate(childStderrReset);
  childStderrReset = setImmediate(() => {
    childStderrReset = undefined;
    if (!childStderrActive && !childStderrCommentaryStarted) {
      childStderrLastByteWasLf = true;
    }
  });
  childStderrReset.unref();
}

function startsWithLf(chunk: string | Uint8Array): boolean {
  return typeof chunk === "string" ? chunk.charCodeAt(0) === 0x0a : chunk[0] === 0x0a;
}

/** Write Rocky-owned stderr, inserting at most one needed line separator. */
export function writeRockyStderr(chunk: string | Uint8Array): void {
  const boundaryPending = childStderrActive || childStderrReset !== undefined;
  if (boundaryPending && !childStderrCommentaryStarted) {
    childStderrCommentaryStarted = true;
    if (!childStderrLastByteWasLf && !startsWithLf(chunk)) process.stderr.write("\n");
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
 * Speak directly to the terminal from a background process (hook handlers
 * are spawned disowned with stderr discarded). No tty — no words; never throw.
 */
export function sayTty(msg: string): void {
  try {
    writeFileSync("/dev/tty", `[Rocky] ${safeTerminalLine(msg)}\n`);
  } catch {
    /* no tty (tests, CI, detached session) — Rocky stays silent */
  }
}

export function detailTty(msg: string): void {
  try {
    writeFileSync("/dev/tty", `    ${safeTerminalLine(msg)}\n`);
  } catch {
    /* silent */
  }
}
