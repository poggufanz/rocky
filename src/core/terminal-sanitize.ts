import { stripVTControlCharacters } from "node:util";
import { replaceAnsiAndControls } from "./redact.js";

const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const LINE_SEPARATOR_RE = /[\u2028\u2029]/gu;
const ROCKY_PREFIX_RE = /^(\s*)\[rocky\]\p{Cf}*(?=\s|$)/iu;

/**
 * Remove terminal instructions from untrusted stored text without changing
 * ordinary printable Unicode. This is a presentation boundary only: memory,
 * raw exports, MCP payloads, and live child streams must not pass through it.
 */
function withoutTerminalInstructions(value: string): string {
  const vtStripped = stripVTControlCharacters(value);
  return replaceAnsiAndControls(vtStripped, "", "").replace(BIDI_CONTROL_RE, "");
}

/** Render untrusted text as exactly one physical terminal line. */
export function safeTerminalLine(value: string): string {
  return withoutTerminalInstructions(value)
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n")
    .replace(/\t/gu, "\\t")
    .replace(LINE_SEPARATOR_RE, (separator) => separator === "\u2028" ? "\\u2028" : "\\u2029");
}

/**
 * Render an untrusted excerpt while retaining only its LF-delimited structure.
 * Every resulting line is independently subject to the single-line boundary.
 */
export function safeTerminalBlock(value: string): string {
  return withoutTerminalInstructions(value)
    .split("\n")
    .map((line) => safeTerminalLine(line).replace(ROCKY_PREFIX_RE, "$1[remembered Rocky]"))
    .join("\n");
}
