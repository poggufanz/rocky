/**
 * Error fingerprinting.
 *
 * Rocky "hears" errors, he doesn't read them. Two stack traces from the same
 * bug are never byte-identical (paths, line numbers, timestamps, memory
 * addresses all shift), so we normalize stderr down to the lines and tokens
 * that carry meaning, then hash that into a stable fingerprint.
 */

import { createHash } from "node:crypto";

/** Lines that usually carry the actual error meaning. */
const SIGNAL = /error|exception|fail|fatal|cannot|unable|not found|missing|denied|refused|invalid|unexpected|undefined|panic|traceback/i;

/** Strip ANSI escape sequences (colors, cursor movement). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Normalize one line: mask the volatile parts, keep the meaning. */
export function normalizeLine(line: string): string {
  return stripAnsi(line)
    .trim()
    // windows + posix absolute paths -> <path>
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+)+/g, "<path>")
    // urls -> <url>
    .replace(/https?:\/\/\S+/g, "<url>")
    // hex addresses / hashes -> <hex>
    .replace(/0x[0-9a-fA-F]+/g, "<hex>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
    // iso timestamps and clock times -> <time>
    .replace(/\d{4}-\d{2}-\d{2}[T ]?[\d:.]*Z?/g, "<time>")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "<time>")
    // remaining numbers (line numbers, ports, pids) -> #
    .replace(/\d+/g, "#")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Pick the lines that define this error. Prefer lines that look like errors;
 * fall back to the tail of stderr (where most tools print their conclusion).
 */
export function signatureLines(stderr: string): string[] {
  const lines = stripAnsi(stderr)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const signal = lines.filter((l) => SIGNAL.test(l));
  const chosen = signal.length > 0 ? signal.slice(0, 8) : lines.slice(-5);
  return chosen.map(normalizeLine).filter((l) => l.length > 0);
}

/** Stable hash for exact re-occurrence detection. */
export function fingerprint(stderr: string): string {
  const sig = signatureLines(stderr).join("\n");
  return createHash("sha1").update(sig).digest("hex").slice(0, 16);
}

/** Token bag for fuzzy matching (recall search, near-miss detection). */
export function tokens(text: string): Set<string> {
  const stop = new Set(["the", "a", "an", "at", "in", "on", "of", "to", "is", "was", "for", "and", "or"]);
  const bag = new Set<string>();
  for (const raw of normalizeLine(text).split(/[^a-z<>#_.-]+/)) {
    if (raw.length <= 2 || stop.has(raw)) continue;
    bag.add(raw);
    // "some-missing-package" also yields "some", "missing", "package"
    for (const part of raw.split(/[-_.]+/)) {
      if (part.length > 2 && !stop.has(part)) bag.add(part);
    }
  }
  return bag;
}

/** Jaccard similarity between two token bags. 0..1 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Shallow fingerprint for failures heard through the shell hook, where no
 * stderr is available: normalized command line + exit code. The "cmd:" prefix
 * keeps this hash space disjoint from stderr fingerprints.
 */
export function commandFingerprint(cmd: string, exitCode: number): string {
  const sig = `cmd:${normalizeLine(cmd)}:${exitCode}`;
  return createHash("sha1").update(sig).digest("hex").slice(0, 16);
}

/**
 * First whitespace-separated token, reduced to its basename when it looks
 * like a path. A regex split on both `/` and `\` (not node:path) so a
 * Windows-style path reduces correctly even when Rocky runs on Linux.
 */
export function commandBase(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  const segments = first.split(/[\\/]/);
  return segments[segments.length - 1] || first;
}

/**
 * Deterministic command signature used to grade fix links ("signature" vs
 * "program" basis). This is a command signature, not an error fingerprint:
 * no lowercasing, no number masking, flag case preserved (`-v` !== `-V`).
 */
export function commandSignature(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) return "";
  const rest = trimmed.split(/\s+/).slice(1);
  const base = commandBase(cmd);
  const firstNonFlag = rest.find((token) => !token.startsWith("-"));
  if (firstNonFlag !== undefined) return `${base} ${firstNonFlag}`;
  const flags = [...new Set(rest)].sort();
  return [base, ...flags].join(" ");
}
