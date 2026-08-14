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

/**
 * Stable hash for exact re-occurrence detection. When stderr carries no
 * signal at all, hashing "" would collapse every silent failure — any
 * command, any project — onto one constant fingerprint and fabricate
 * cross-command matches (observed live in dogfood data). Fall back to the
 * command fingerprint instead: same information content as a hook-heard
 * failure, and the `cmd:` prefix keeps the hash space disjoint by design.
 */
export function fingerprint(stderr: string, cmd: string, exitCode: number): string {
  const sig = signatureLines(stderr).join("\n");
  if (sig.length === 0) return commandFingerprint(cmd, exitCode);
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
/** `FOO=1 npm test` — an assignment prefix is not the program being run. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Programs that exist only to run another program. Their own name says nothing
 * about what failed, so `sudo systemctl restart nginx` must reduce to
 * `systemctl restart`, not `sudo systemctl` — otherwise `restart` and `status`
 * collapse into one signature and a read-only command gets graded a strong fix
 * for a failed restart.
 */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "time", "nohup", "nice", "exec"]);

export const COMMAND_IDENTITY_VERSION = 1 as const;

export interface CommandIdentity {
  value: string;
  reliable: boolean;
  version: typeof COMMAND_IDENTITY_VERSION;
  base: string;
  display: string;
}

interface TokenizedCommand { tokens: string[]; reliable: boolean; assignments?: string[] }

function basename(token: string): string {
  const segments = token.split(/[\\/]/);
  return segments[segments.length - 1] || token;
}

/** Recover argv-shaped tokens and refuse strong identity for shell expansion/composition. */
function tokenizeCommand(cmd: string): TokenizedCommand {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let reliable = true;
  let active = false;
  const push = (): void => {
    if (active) tokens.push(token);
    token = "";
    active = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]!;
    if (quote !== undefined) {
      if (char === quote) { quote = undefined; active = true; continue; }
      if (char === "\\" && quote === '"' && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) {
        token += cmd[++i]!;
        active = true;
        continue;
      }
      if (char === "`" || char === "$") reliable = false;
      token += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue; }
    if (/\s/u.test(char)) { push(); continue; }
    if ("|&;<>()\r\n`".includes(char) || char === "$" || char === "%") reliable = false;
    if (char === "\\" && (cmd[i + 1] === " " || cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      token += cmd[++i]!;
      active = true;
      continue;
    }
    token += char;
    active = true;
  }
  if (quote !== undefined) reliable = false;
  push();
  return { tokens, reliable };
}

function wrapperValueCount(wrapper: string, option: string): number | undefined {
  if (option.includes("=")) return 0;
  if ((wrapper === "sudo" || wrapper === "doas") &&
      new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from",
        "-R", "--chroot", "-D", "--chdir", "-r", "--role", "-t", "--type", "-U", "--other-user"]).has(option)) return 1;
  if (wrapper === "env" && new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]).has(option)) return 1;
  if (wrapper === "time" && new Set(["-f", "--format", "-o", "--output"]).has(option)) return 1;
  if (wrapper === "nice" && (option === "-n" || option === "--adjustment")) return 1;
  const noValue = new Set(["-i", "--ignore-environment", "-0", "--null", "-n", "--non-interactive",
    "-s", "--shell", "-V", "--version", "--help", "-v", "--verbose", "--quiet", "-q"]);
  return noValue.has(option) ? 0 : undefined;
}

function meaningfulParsedTokens(parsed: TokenizedCommand): TokenizedCommand {
  const tokens = parsed.tokens;
  const assignments: string[] = [];
  let start = 0;
  while (start < tokens.length) {
    const token = tokens[start];
    if (token === undefined) break;
    if (ENV_ASSIGNMENT.test(token)) { assignments.push(token); start++; continue; }
    const wrapper = basename(token);
    if (WRAPPERS.has(wrapper)) {
      start++;
      while (start < tokens.length) {
        const option = tokens[start]!;
        if (option === "--") { start++; break; }
        if (wrapper === "env" && ENV_ASSIGNMENT.test(option)) { assignments.push(option); start++; continue; }
        if (!option.startsWith("-") || option === "-") break;
        const values = wrapperValueCount(wrapper, option);
        if (values === undefined) parsed.reliable = false;
        start += 1 + (values ?? 0);
        if (start > tokens.length) parsed.reliable = false;
      }
      continue;
    }
    if (basename(token) === "rocky" && tokens[start + 1] === "run") { start += 2; continue; }
    break;
  }
  return { tokens: start < tokens.length ? tokens.slice(start) : tokens, reliable: parsed.reliable, assignments };
}

/** Drop assignment prefixes and wrapper programs to reach the real command. */
function meaningfulTokens(cmd: string): string[] {
  return meaningfulParsedTokens(tokenizeCommand(cmd.trim())).tokens;
}

export function commandBase(cmd: string): string {
  const first = meaningfulTokens(cmd)[0];
  return first ? basename(first) : "";
}

/** Versioned, conservative identity used only for memory attribution. */
export function commandIdentity(
  cmd: string,
  options: { platform?: NodeJS.Platform | "unknown" } = {},
): CommandIdentity {
  const parsed = meaningfulParsedTokens(tokenizeCommand(cmd.trim()));
  const first = parsed.tokens[0];
  if (first === undefined) {
    return { value: "[]", reliable: parsed.reliable, version: COMMAND_IDENTITY_VERSION, base: "", display: "" };
  }
  const base = basename(first);
  const identityBase = (options.platform ?? process.platform) === "win32" ? base.toLowerCase() : base;
  const normalized = [...(parsed.assignments ?? []).map((assignment) => `env:${assignment}`), identityBase, ...parsed.tokens.slice(1)];
  return {
    value: JSON.stringify(normalized),
    reliable: parsed.reliable,
    version: COMMAND_IDENTITY_VERSION,
    base: identityBase,
    display: normalized.join(" "),
  };
}

/** Human-readable normalized command shape, separate from causal identity. */
export function commandSignature(cmd: string): string {
  const tokens = meaningfulTokens(cmd);
  const first = tokens[0];
  if (first === undefined || first === "") return "";
  // Display preserves the complete normalized task/argument shape. Strong
  // causal matching uses the separate versioned identity above.
  return [basename(first), ...tokens.slice(1)].join(" ");
}
