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
 * The console device path a background process can still write to once its
 * own stdio is gone. POSIX (Linux/macOS/WSL, and Git-Bash-on-Windows when
 * Node itself is a POSIX build) keeps `/dev/tty`. Native Windows Node has no
 * such path — `writeFileSync("/dev/tty", ...)` fails with ENOENT there (it
 * gets parsed as a relative `dev\tty`, not a device) — so every hook-handler
 * TTY line was silently swallowed on native Windows before this fix, which
 * the PowerShell hook (Task 4) exposed: without it, `hookFail`/`hookSuccess`
 * would install correctly and record memory correctly, but never actually
 * speak to the user.
 *
 * The bare reserved name `CON` looked like the obvious equivalent but is
 * unsafe: `writeFileSync("CON", ...)` was proven empirically (task-4-report,
 * both with a console attached and fully detached/console-less, matching how
 * hook handlers actually run) to create an ordinary 20-30 byte file literally
 * named `CON` in the current working directory instead of reaching the
 * console — Node's long-path handling defeats Win32's classic reserved-name
 * interception for a bare relative path. `\\.\CON`, the explicit Win32 device
 * namespace form, bypasses filename parsing entirely and goes straight to the
 * device object: proven empirically, same two scenarios, to never create a
 * stray file and never throw. That is the only form used here.
 */
function ttyDevicePath(): string {
  return process.platform === "win32" ? "\\\\.\\CON" : "/dev/tty";
}

/**
 * Speak directly to the terminal from a background process (hook handlers
 * are spawned disowned with stderr discarded). No tty — no words; never throw.
 */
export function sayTty(msg: string): void {
  try {
    writeFileSync(ttyDevicePath(), `[Rocky] ${safeTerminalLine(msg)}\n`);
  } catch {
    /* no tty (tests, CI, detached session) — Rocky stays silent */
  }
}

export function detailTty(msg: string): void {
  try {
    writeFileSync(ttyDevicePath(), `    ${safeTerminalLine(msg)}\n`);
  } catch {
    /* silent */
  }
}
