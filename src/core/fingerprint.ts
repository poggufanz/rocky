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

/**
 * Fingerprints are persisted, so changing normalization is a storage
 * migration even though the hash remains a compact string. Version two keeps
 * semantic status/code/port numbers and uses URL-first masking.
 */
export const FINGERPRINT_ALGORITHM_VERSION = 2 as const;
export const LEGACY_FINGERPRINT_ALGORITHM_VERSION = 1 as const;
export type FingerprintAlgorithmVersion =
  | typeof LEGACY_FINGERPRINT_ALGORITHM_VERSION
  | typeof FINGERPRINT_ALGORITHM_VERSION;

// Apostrophe is an RFC3986 pchar, so it can occur in userinfo, path, query,
// and fragment. Keep it in the opaque URL match; `maskUrls` removes only a
// terminal quote that is clearly surrounding punctuation.
const URL = /\bhttps?:\/\/[^\s<>"`]+/giu;
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\/)(?:[^\\/\s"'<>]+[\\/])*[^\\/\s"'<>]*/gu;
// `_` is an identifier character too. Treating it as a boundary would turn
// `cache_deadbeef` or `job_550e8400-e29b-41d4-a716-446655440000` into a
// masked value even though it is part of a stable application token.
const IDENTIFIER_BOUNDARY = "\\p{L}\\p{N}_";
const UUID = new RegExp(`(?<![${IDENTIFIER_BOUNDARY}])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![${IDENTIFIER_BOUNDARY}])`, "giu");
const DIGEST_WITH_ALGORITHM = new RegExp(`(?<![${IDENTIFIER_BOUNDARY}])(sha(?:-?1|-?256|-?512)\\s*[:=]\\s*)([0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})(?![${IDENTIFIER_BOUNDARY}])`, "giu");
const BARE_DIGEST = new RegExp(`(?<![${IDENTIFIER_BOUNDARY}])(?:[0-9a-f]{128}|[0-9a-f]{64}|[0-9a-f]{40})(?![${IDENTIFIER_BOUNDARY}])`, "giu");
const HEX_ADDRESS = new RegExp(`(?<![${IDENTIFIER_BOUNDARY}])0x[0-9a-f]+(?![${IDENTIFIER_BOUNDARY}])`, "giu");
const BARE_HEX = new RegExp(`(?<![${IDENTIFIER_BOUNDARY}])[0-9a-f]{7,40}(?![${IDENTIFIER_BOUNDARY}])`, "giu");
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const DIGEST_SHAPE = /(?:[0-9a-f]{128}|[0-9a-f]{64}|[0-9a-f]{40})/giu;
const ISO_TIMESTAMP = /(?<![\p{L}\p{N}_])\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}(?:[T ]\p{Nd}{2}:\p{Nd}{2}(?::\p{Nd}{2}(?:\.\p{Nd}+)?)?(?:Z|[+-]\p{Nd}{2}:?\p{Nd}{2})?)?(?![\p{L}\p{N}_])/gu;
const CLOCK_TIME = /(?<![\p{L}\p{N}_])\p{Nd}{1,2}:\p{Nd}{2}(?::\p{Nd}{2}(?:\.\p{Nd}+)?)?(?![\p{L}\p{N}_])/gu;
const NUMBER = /\p{Nd}+/gu;
const SOURCE_EXTENSION = /\.(?:c|cc|cfg|conf|cpp|cs|css|env|go|graphql|h|hpp|html|ini|java|js|jsx|json|kt|lock|log|lua|map|md|php|proto|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|txt|vue|wasm|xml|yaml|yml)$/iu;
const SOURCE_LOCATION = new RegExp(`${SOURCE_EXTENSION.source.slice(0, -1)}:\\d+$`, "iu");
const SOURCE_LOCATION_PREFIX = new RegExp(`(?:^|[^\\s])${SOURCE_EXTENSION.source.slice(0, -1)}:\\s*$`, "iu");
const SOURCE_LOCATION_CHAIN = new RegExp(`${SOURCE_EXTENSION.source.slice(0, -1)}:\\p{Nd}+(?:\\s*:\\s*\\p{Nd}+)*\\s*:?$`, "iu");
const VOLATILE_NUMBER_CHAIN = /(?:^|[^\p{L}\p{N}_])(?:pid|process(?:[-_ ]?id)?|worker|thread|line|index|attempt|timestamp|time|date|column|col|request(?:[-_ ]?id)?|job(?:[-_ ]?id)?|trace(?:[-_ ]?id)?|span(?:[-_ ]?id)?|session(?:[-_ ]?id)?)\s*[:=]?\s*\p{Nd}+(?:\s*[-:.,]\s*\p{Nd}+)*\s*[-:.,]?\s*$/iu;

const STOP_WORDS = new Set(["the", "a", "an", "at", "in", "on", "of", "to", "is", "was", "for", "and", "or"]);
const TOKEN = /<[^>\s]+>|#[\p{L}\p{N}_-]*|[\p{L}\p{N}\p{M}]+(?:[-_.][\p{L}\p{N}\p{M}]+)+|[\p{L}\p{N}\p{M}]+/gu;
// Most persisted command/signature evidence is ordinary ASCII command text.
// Keep this guard deliberately conservative: only lines that cannot contain
// paths, URLs, source locations, hashes, or punctuation-sensitive volatile
// labels may skip the full normalizer.
const SIMPLE_RETRIEVAL_LINE = /^[\p{L}\p{N}\s._-]+$/u;
const SIMPLE_RETRIEVAL_VOLATILE = /(?:^|[^\p{L}\p{N}_])(?:pid|process(?:[-_ ]?id)?|worker|thread|line|index|attempt|timestamp|time|date|column|col|request(?:[-_ ]?id)?|job(?:[-_ ]?id)?|trace(?:[-_ ]?id)?|span(?:[-_ ]?id)?|session(?:[-_ ]?id)?)\s*[-:=]?\s*\p{Nd}+/iu;
const SIMPLE_RETRIEVAL_HEX = /(?:^|[^\p{L}\p{N}_])[0-9a-f]{7,40}(?![\p{L}\p{N}_])/iu;
const SIMPLE_RETRIEVAL_DIGEST = /(?:^|[^\p{L}\p{N}_])(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})(?![\p{L}\p{N}_])/iu;
const SIMPLE_RETRIEVAL_ADDRESS = /(?:^|[^\p{L}\p{N}_])0x[0-9a-f]+(?![\p{L}\p{N}_])/iu;
const SIMPLE_RETRIEVAL_DATE = /(?:^|[^\p{L}\p{N}_])\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}(?![\p{L}\p{N}_])/u;
const SIMPLE_RETRIEVAL_UUID = /(?:^|[^\p{L}\p{N}_])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\p{N}_])/iu;

function rangeInPattern(text: string, pattern: RegExp, start: number, end: number): boolean {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const matchStart = match.index ?? -1;
    if (matchStart >= 0 && start >= matchStart && end <= matchStart + match[0].length) return true;
  }
  return false;
}

function maskUrls(text: string): string {
  return text.replace(URL, (url, offset: number, whole: string) => {
    // RFC3986 permits punctuation such as `?`, `!`, `;`, and apostrophe in a
    // URL. Keep the complete match opaque. The one exception is a clearly
    // surrounding wrapper run immediately before the URL: peel matching
    // closers from the outside in, then retain ordinary sentence punctuation
    // outside. This handles nested `('[url]')` shapes without reopening tails.
    const before = whole.slice(0, offset);
    const wrappers: Record<string, string> = { "'": "'", "(": ")", "[": "]", "{": "}" };
    let openingStart = before.length;
    while (openingStart > 0 && wrappers[before[openingStart - 1]!] !== undefined) openingStart--;
    const openings = before.slice(openingStart);
    if (openings.length === 0) return "<url>";

    const sentencePunctuation = /[.!?,;:…]+$/u.exec(url)?.[0] ?? "";
    let core = sentencePunctuation.length > 0 ? url.slice(0, -sentencePunctuation.length) : url;
    let wrapperSuffix = "";
    for (const opening of openings) {
      const closing = wrappers[opening];
      if (closing === undefined || !core.endsWith(closing)) return "<url>";
      core = core.slice(0, -closing.length);
      wrapperSuffix = closing + wrapperSuffix;
    }
    return `<url>${wrapperSuffix}${sentencePunctuation}`;
  });
}

function maskCommonVolatile(text: string): string {
  return maskUrls(text)
    .replace(ABSOLUTE_PATH, "<path>")
    .replace(UUID, "<hex>")
    .replace(DIGEST_WITH_ALGORITHM, "$1<hex>")
    .replace(BARE_DIGEST, "<hex>")
    .replace(HEX_ADDRESS, "<hex>")
    .replace(BARE_HEX, (match, offset: number, whole: string) =>
      whole.includes("-") && rangeInPattern(whole, UUID_SHAPE, offset, offset + match.length)
        ? match : "<hex>",
    )
    .replace(ISO_TIMESTAMP, "<time>")
    .replace(CLOCK_TIME, (match, offset: number, whole: string) => {
      // `host:9200` can look like `92:00` to a clock regex. A port is
      // semantic, so leave it for the semantic-number pass below.
      const before = whole.slice(0, offset);
      return isLikelyPort(before, offset) ? match : "<time>";
    });
}

function isLikelyPort(before: string, numberOffset: number): boolean {
  // Generic request/job/trace labels are deliberately treated as volatile
  // identifiers; they are indistinguishable from ports without a network
  // label. Explicit host/domain/service/port contexts retain the number.
  const prefix = before.slice(0, numberOffset).trimEnd();
  if (!prefix.endsWith(":")) return false;
  const host = prefix.slice(0, -1).trimEnd();
  const label = host.match(/[^\s]+$/u)?.[0] ?? host;
  const context = host.slice(0, Math.max(0, host.length - label.length)).trimEnd();
  if (label.endsWith("]")) return true;
  if (/\blocalhost$/iu.test(label) || /^127(?:\.\d{1,3}){3}$/u.test(label)) return true;
  // A numeric label before a colon is a clock (`12:34`) or a generic
  // numeric value, not a host/service. This also covers non-ASCII decimal
  // digits, which JavaScript's `\d` does not match.
  if (/^\p{Nd}+$/u.test(label)) return false;
  // A path/line prefix is not a port. Absolute paths have already become
  // `<path>`, while relative source locations commonly look like
  // `file.ts:41`; reject both those shapes before considering a host label.
  if (/[\\/]|<path>/iu.test(host)) return false;
  if (SOURCE_LOCATION.test(host)) return false;
  if (SOURCE_EXTENSION.test(label)) return false;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(label)) return false;
  if (label.includes(".")) return true;
  if (/(?:^|\s)(?:host|server|address|port|endpoint|service)$/iu.test(label)) return true;
  if (/\s/u.test(host) && !/(?:\bhost|server|address|connect|endpoint|port|service|refused|connection\s+refused)\b/iu.test(context)) return false;
  // A bare `service:9200` is still a port even without a nearby network
  // verb. The source-location exclusions above keep the common false
  // positive (`file.ts:41`) volatile.
  return true;
}

function isVolatileNumberContext(line: string, offset: number): boolean {
  const before = line.slice(0, offset);
  if (/(?:^|[^\p{L}\p{N}_])(?:pid|process(?:[-_ ]?id)?|worker|thread|line|index|attempt|timestamp|time|date|column|col|request(?:[-_ ]?id)?|job(?:[-_ ]?id)?|trace(?:[-_ ]?id)?|span(?:[-_ ]?id)?|session(?:[-_ ]?id)?)\s*[:=]?\s*$/iu.test(before)) return true;
  // A source location's column (`file.ts:41:7`) is volatile too. The first
  // number is identified by its extension prefix; later numbers are covered
  // by the chained-location form below.
  if (SOURCE_LOCATION_PREFIX.test(before)) return true;
  if (SOURCE_LOCATION_CHAIN.test(before)) return true;
  return VOLATILE_NUMBER_CHAIN.test(before);
}

function isSemanticNumber(line: string, offset: number, end: number): boolean {
  const before = line.slice(0, offset);
  const context = before.slice(-72);
  const number = line.slice(offset, end);
  // These labels describe run-to-run volatility even when their value is
  // adjacent to a colon (which otherwise resembles `host:port`).
  if (isVolatileNumberContext(line, offset)) return false;
  if (/(?:^|[^\p{L}\p{N}_])sha-?$/iu.test(before)) return true;
  if (/^\p{Nd}{3}$/u.test(number) &&
      /\b(?:http|status|response)\b/iu.test(context) &&
      !/\b(?:pid|line|process|worker|attempt)\b[^\d]*$/iu.test(context)) return true;
  if (/(?:\b(?:http(?:\/[0-9.]+)?|status[\s_-]*code|response(?:\s+status)?|error[\s_-]*code|exit[\s_-]*code|errno|sqlstate|code|port(?:\s+(?:number|id))?)\s*[:=]?\s*)$/iu.test(context)) {
    return true;
  }
  if (/\bsqlstate\b(?:\s*[:=]?\s*[A-Za-z0-9_-]+)+$/iu.test(context)) return true;

  // Preserve explicit identifier-shaped codes such as E123 and ERR_42 while
  // leaving ordinary version/PID suffixes volatile. Capture the identifier
  // immediately before the digits instead of including its `code:` label.
  const tokenPrefix = before.match(/(?:^|[^\p{L}\p{N}_])([\p{L}][\p{L}\p{N}_-]*)$/u)?.[1] ?? "";
  if (/^(?:e|err|error|errno|code|status)[_-]?[\p{L}\p{N}]*$/iu.test(tokenPrefix)) return true;

  return isLikelyPort(before, offset) || /\bport\s*[:=]?\s*$/iu.test(context);
}

type NumberRole = "fingerprint" | "retrieval" | "query";

function maskNumbers(text: string, role: NumberRole): string {
  const mayContainUuid = text.includes("-");
  const mayContainDigest = text.length >= 40;
  return text.replace(NUMBER, (match, offset: number, whole: string) =>
    isSemanticNumber(whole, offset, offset + match.length) ||
      // Retrieval and query evidence retain an otherwise unlabeled number so
      // a bare `404` or `9200` query can find its semantic record. Explicit
      // volatile labels remain masked in every representation.
      (role !== "fingerprint" && !isVolatileNumberContext(whole, offset)) ||
      (mayContainUuid && rangeInPattern(whole, UUID_SHAPE, offset, offset + match.length)) ||
      (mayContainDigest && rangeInPattern(whole, DIGEST_SHAPE, offset, offset + match.length))
      ? match : "#",
  );
}

function normalizeWithNumbers(line: string, role: NumberRole): string {
  const prepared = maskCommonVolatile(stripAnsi(line).normalize("NFC").trim());
  const normalized = maskNumbers(prepared, role);
  return normalized.replace(/\s+/gu, " ").toLowerCase();
}

/** Strip ANSI escape sequences (colors, cursor movement). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Normalize one line: mask the volatile parts, keep the meaning. */
export function normalizeLine(line: string): string {
  return normalizeWithNumbers(line, "fingerprint");
}

/** Retrieval text retains semantic numeric evidence while masking volatile numbers. */
export function normalizeRetrievalLine(line: string): string {
  if (SIMPLE_RETRIEVAL_LINE.test(line) && !SIMPLE_RETRIEVAL_VOLATILE.test(line) &&
      !SIMPLE_RETRIEVAL_HEX.test(line) && !SIMPLE_RETRIEVAL_DIGEST.test(line) &&
      !SIMPLE_RETRIEVAL_ADDRESS.test(line) && !SIMPLE_RETRIEVAL_DATE.test(line) &&
      !SIMPLE_RETRIEVAL_UUID.test(line)) {
    return line.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
  }
  return normalizeWithNumbers(line, "retrieval");
}

/** Query evidence keeps semantic numeric literals, including unlabeled ones. */
export function queryTokens(text: string): Set<string> {
  return tokenBag(normalizeWithNumbers(text, "query"));
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
  return hashFingerprint(sig);
}

function hashFingerprint(signature: string): string {
  return createHash("sha1")
    .update(`fingerprint-v${FINGERPRINT_ALGORITHM_VERSION}\n${signature}`)
    .digest("hex")
    .slice(0, 16);
}

/** Hash a signature that is already normalized and persisted on a record. */
export function fingerprintSignature(signature: readonly string[], cmd: string, exitCode: number): string {
  const normalized = signature.join("\n");
  return normalized.length === 0 ? commandFingerprint(cmd, exitCode) : hashFingerprint(normalized);
}

/** Token bag for recurrence stability. Volatile numbers are already masked. */
export function fingerprintTokens(text: string): Set<string> {
  return tokenBag(normalizeLine(text));
}

/** Token bag for semantic recall. Numbers such as ports/statuses remain exact. */
export function retrievalTokens(text: string): Set<string> {
  return tokenBag(normalizeRetrievalLine(text));
}

/** Fill one caller-owned token bag, avoiding one hash table allocation per
 * record in bounded recall scans. The caller may clear/reuse it between
 * records; no reference is retained by this module. */
export function fillRetrievalTokens(text: string, target: Set<string>): void {
  target.clear();
  fillTokenBag(normalizeRetrievalLine(text), target);
}

function tokenBag(text: string): Set<string> {
  const bag = new Set<string>();
  fillTokenBag(text, bag);
  return bag;
}

function fillTokenBag(text: string, bag: Set<string>): void {
  for (const match of text.normalize("NFC").toLowerCase().matchAll(TOKEN)) {
    const raw = match[0];
    if (raw === undefined) continue;
    addToken(raw, bag);
  }
}

function addToken(raw: string, bag: Set<string>): void {
  addTokenBase(raw, bag);
  const special = raw.startsWith("<") || raw.startsWith("#");
  if (!special && /[-_.]/u.test(raw)) {
    for (const part of raw.split(/[-_.]+/u)) {
      if (part.length > 2 && !STOP_WORDS.has(part)) bag.add(part);
    }
  }
}

function addTokenBase(raw: string, bag: Set<string>): void {
  const special = raw.startsWith("<") || raw.startsWith("#");
  const ascii = /^[\x00-\x7F]+$/u.test(raw);
  const numeric = /^\d+$/u.test(raw);
  if (!special && ascii && raw.length <= 2 && !numeric) return;
  if (!special && STOP_WORDS.has(raw)) return;
  bag.add(raw);
}

/** Backward-compatible name used by recall, dictionary, and agent surfaces. */
export function tokens(text: string): Set<string> {
  return retrievalTokens(text);
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
  return hashFingerprint(sig);
}

/** Exact v1 normalization retained only for migration lookup. */
function legacyNormalizeLine(line: string): string {
  return stripAnsi(line)
    .trim()
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+)+/g, "<path>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/0x[0-9a-fA-F]+/g, "<hex>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]?[\d:.]*Z?/g, "<time>")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "<time>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function legacySignatureLines(stderr: string): string[] {
  const lines = stripAnsi(stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const signal = lines.filter((line) => SIGNAL.test(line));
  const chosen = signal.length > 0 ? signal.slice(0, 8) : lines.slice(-5);
  return chosen.map(legacyNormalizeLine).filter((line) => line.length > 0);
}

function legacyCommandFingerprint(cmd: string, exitCode: number): string {
  const sig = `cmd:${legacyNormalizeLine(cmd)}:${exitCode}`;
  return createHash("sha1").update(sig).digest("hex").slice(0, 16);
}

/** Hash a legacy signature that is already normalized and persisted. */
export function legacyFingerprintSignature(signature: readonly string[], cmd: string, exitCode: number): string {
  const normalized = signature.join("\n");
  return normalized.length === 0
    ? legacyCommandFingerprint(cmd, exitCode)
    : createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/** v1 fingerprint used to find records written before the v2 migration. */
export function legacyFingerprint(stderr: string, cmd: string, exitCode: number): string {
  const sig = legacySignatureLines(stderr).join("\n");
  if (sig.length === 0) return legacyCommandFingerprint(cmd, exitCode);
  return createHash("sha1").update(sig).digest("hex").slice(0, 16);
}

/** Current and legacy hashes, ordered newest first for dual lookup. */
export function fingerprintCandidates(stderr: string, cmd: string, exitCode: number): string[] {
  const current = fingerprint(stderr, cmd, exitCode);
  const legacy = legacyFingerprint(stderr, cmd, exitCode);
  return current === legacy ? [current] : [current, legacy];
}

/** Current and legacy command-only hashes for shell-hook failures. */
export function commandFingerprintCandidates(cmd: string, exitCode: number): string[] {
  const current = commandFingerprint(cmd, exitCode);
  const legacy = legacyCommandFingerprint(cmd, exitCode);
  return current === legacy ? [current] : [current, legacy];
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

interface TokenizedCommand {
  tokens: string[];
  reliable: boolean;
  assignments?: string[];
  wrapperEffects?: string[];
}

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
      if (char === "`" || char === "$" || char === "%" || char === "!") reliable = false;
      token += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue; }
    if (/\s/u.test(char)) { push(); continue; }
    if ("|&;<>()\r\n`*?[]{}~".includes(char) || char === "$" || char === "%" || char === "!") reliable = false;
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
  const wrapperEffects: string[] = [];
  let start = 0;
  while (start < tokens.length) {
    const token = tokens[start];
    if (token === undefined) break;
    if (ENV_ASSIGNMENT.test(token)) { assignments.push(token); start++; continue; }
    const wrapper = basename(token);
    if (WRAPPERS.has(wrapper)) {
      wrapperEffects.push(`wrapper:${wrapper}`);
      start++;
      while (start < tokens.length) {
        const option = tokens[start]!;
        if (option === "--") { start++; break; }
        if (wrapper === "env" && ENV_ASSIGNMENT.test(option)) { assignments.push(option); start++; continue; }
        if (!option.startsWith("-") || option === "-") break;
        const values = wrapperValueCount(wrapper, option);
        if (values === undefined) parsed.reliable = false;
        wrapperEffects.push(`wrapper-arg:${option}`);
        for (let offset = 1; offset <= (values ?? 0); offset++) {
          const value = tokens[start + offset];
          if (value === undefined) parsed.reliable = false;
          else wrapperEffects.push(`wrapper-arg:${value}`);
        }
        start += 1 + (values ?? 0);
        if (start > tokens.length) parsed.reliable = false;
      }
      continue;
    }
    if (basename(token) === "rocky" && tokens[start + 1] === "run") { start += 2; continue; }
    break;
  }
  return {
    tokens: start < tokens.length ? tokens.slice(start) : tokens,
    reliable: parsed.reliable,
    assignments,
    wrapperEffects,
  };
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
  const normalized = [
    ...(parsed.assignments ?? []).map((assignment) => `env:${assignment}`),
    ...(parsed.wrapperEffects ?? []),
    identityBase,
    ...parsed.tokens.slice(1),
  ];
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
