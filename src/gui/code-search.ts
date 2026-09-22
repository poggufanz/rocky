/**
 * Live code search for the Main chat segment.
 *
 * The corpus is the launch root, and every candidate is re-resolved through
 * the caller's `confine()` boundary before any stat or read — a `..`-bearing,
 * absolute, or symlink-escaping candidate is a miss, never an error and never
 * a second try. One scan per code question: no index, no cross-request cache
 * (Q5); at most three retrieval rounds (Q12); every read bounded by a named
 * cap; oversize, unreadable, binary-ish, or vanished files are misses with a
 * disclosure line (the `defaultTeachNeighbor` fail-open discipline).
 *
 * This module never talks to a provider. The server assembles the prompt from
 * what it returns, redacts the joined pack once more, and makes the single
 * provider call through the `/api/ask` machinery.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

import { queryTokens, retrievalTokens, similarity } from "../core/fingerprint.js";
import { GIT_DIFF_MAX_BYTES, GIT_DIFF_TIMEOUT_MS } from "../core/git-diff.js";
import { redactSecretsAtBoundary } from "../core/redact.js";
import {
  calleeNames,
  collectImports,
  findDefinitionInText,
  isRelativeSpecifier,
  resolveRelativePath,
  type ImportLine,
} from "../core/teach-ladder.js";
import type { MemoryRecord } from "../core/memory-read.js";

/** Caps (spec §2.7): named, bounded, disclosed — never an unbounded loop. */
export const CODE_MAX_ROUNDS = 3;
export const CODE_MAX_CANDIDATE_FILES = 40;
export const CODE_MAX_EXCERPTS = 3;
export const CODE_EXCERPT_MAX_LINES = 40;
export const CODE_EXCERPT_PAD_LINES = 4;
export const CODE_PACK_CHARS = 6_000;
export const CODE_MAX_FILE_BYTES = 1024 * 1024;
export const CODE_MAX_FILE_LINES = 2_000;
export const CODE_ROUND_TIMEOUT_MS = 4_000;
export const CODE_TOTAL_TIMEOUT_MS = 15_000;
/** Round 2/3 read bounds: the hop pass and the literal grep stay inside them. */
const CODE_MAX_HOP_NAMES = 8;
const CODE_MAX_HOP_FILES = 12;
const CODE_MAX_WITNESS_FILES = 20;
const CODE_MAX_GREP_FILES = 20;
const CODE_WINDOWS_PER_FILE = 2;

/**
 * Disclosures (spec §2.9). Statements, no `?`, no emoji; never blank. A code
 * answer is either the model's grounded paragraph or a server-built line
 * naming the quotes, and a disclosure always says what was not checked.
 */
export const CODE_NO_MATCH = "code: no file in this root matched. memory answer stands alone.";
export const CODE_UNRANKED = "code scan unranked: file list unavailable, excerpts come from memory-named files only.";
export const CODE_ROUNDS_SPENT = "code budget spent after 3 rounds. files not read are not checked.";
export const CODE_PREFIX_EMPTY = "code: no query after the prefix. memory only, this answer.";
export const CODE_NO_MODEL = "no model configured: code quoting stays on this machine. excerpts shown, nothing sent.";
export const CODE_MODEL_LOCAL = "code: the picked model runs on this machine. excerpts shown, no model paragraph.";
export const CODE_EXCERPTS_ONLY = "code: quoted excerpts only, no model text on this pass.";
export const CODE_NOTHING_QUOTED = "code: nothing quoted this pass. memory answer stands alone.";
export const CODE_WAITING_LABEL = "Searching memory, reading code, evaluating with Jev";
export const CODE_TRUNCATED = (read: number, total: number): string =>
  `code scan truncated: read ${read} of ${total} files. not all checked.`;
export const CODE_ROUND_TIMEOUT = (round: number): string =>
  `code read timed out in round ${round}. answer uses what was read.`;
export const CODE_FILE_TOO_BIG = (path: string): string =>
  `code: ${path} too big to quote. not read.`;
export const CODE_FILE_LINES_CAPPED = (path: string): string =>
  `code: ${path} cut at ${CODE_MAX_FILE_LINES} lines. later lines not checked.`;
export const CODE_UNGROUNDED = (stripped: number): string =>
  `model claims not backed by quoted lines: ${stripped} stripped.`;

/**
 * The rules that ride every code prompt. The model has no tools, so the
 * excerpts are the only code it can see; a claim that would need code it was
 * not given does not exist.
 */
export const CODE_GROUNDING_RULES = [
  "You answer one code question about this repository. Rocky read the excerpts below at request time, and they are the only code you have.",
  "HARD STOP: you have no shell, no git, no database and no filesystem. NEVER claim you ran a command, opened another file, listed a directory, or inspected live data.",
  "Quote only lines that appear inside an excerpt. Cite them as path:line, using the label Rocky printed, and only for lines inside that excerpt's range. Never invent a file, a line number, a commit, or a teammate name.",
  "Keep the two tracks apart and do not merge them into one essay: CODE (what the quoted lines do) and MEMORY (what Rocky heard about them). Memory is a record of what happened, not proof of what the code means.",
  "If the excerpts do not answer the question, say which part you cannot support and stop there. A short honest answer beats a reconstruction.",
  "Answer in the language of the question, in at most four plain sentences. No markdown headings, no code fences, no bullet lists.",
].join("\n");

interface CodeWindow {
  startLine: number;
  endLine: number;
  score: number;
}

export interface CodeExcerpt {
  ref: string;
  path: string;
  startLine: number;
  endLine: number;
  lines: string;
  score: number;
}

export interface CodeTrace {
  mode: "ranked" | "unranked";
  filesScanned: number;
  filesTotal: number;
  rounds: number;
  roundsExhausted: boolean;
  truncated: boolean;
}

export type CodeAnswerStatus = "used" | "no-model" | "unavailable" | "timeout" | "skipped";

export interface CodeAnswer {
  text: string;
  model: string;
  status: CodeAnswerStatus;
  stripped: number;
  disclosure?: string;
}

export interface CodeEvidenceResult {
  evidence: CodeExcerpt[];
  trace: CodeTrace;
  disclosures: string[];
}

/** Every filesystem touch the scan needs, injectable so the loop is testable. */
export interface CodeScanIo {
  /** `git ls-files` for the root; `undefined` when the root is not a usable git tree. */
  lsFiles: (root: string) => string[] | undefined;
  statSize: (full: string) => number | undefined;
  readText: (full: string) => string | undefined;
}

/** Bounded runner, modeled on `defaultDiffIo.lsFiles`: `shell: false`, 5s / 32 KB. */
export const defaultCodeScanIo: CodeScanIo = {
  lsFiles: (root) => {
    try {
      const out = execFileSync("git", ["-C", root, "ls-files"], {
        encoding: "utf8",
        timeout: GIT_DIFF_TIMEOUT_MS,
        maxBuffer: GIT_DIFF_MAX_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.split(/\r?\n/);
    } catch {
      return undefined;
    }
  },
  statSize: (full) => {
    try {
      const info = statSync(full);
      return info.isFile() ? info.size : undefined;
    } catch {
      return undefined;
    }
  },
  readText: (full) => {
    try {
      return readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
  },
};

export interface RepoScan {
  mode: "ranked" | "unranked";
  /** Scannable relative paths, ignore-listed and extension-filtered. */
  files: string[];
}

export interface CollectCodeEvidenceInput {
  root: string;
  query: string;
  /** The server's `confine(root, candidate)`: the only way a path is opened. */
  confine: (candidate: string) => string | undefined;
  /** Launch-root-relative paths Rocky's memory already names. */
  witnessed?: readonly string[];
  /** Tokens from this chat's memory hits: files memory names outrank raw matches. */
  priorTokens?: ReadonlySet<string>;
  io?: Partial<CodeScanIo>;
  now?: () => number;
}

export interface CodePromptInput {
  /** `TEACH_ENV` plus the on-disk teach spec: the shared preamble. */
  readonly preamble: string;
  readonly question: string;
  readonly memoryBlock: string;
  readonly jevBlock: string;
  readonly evidence: readonly CodeExcerpt[];
}

export type CodeQueryMode = "auto" | "code" | "memory";

export interface CodeQuerySplit {
  mode: CodeQueryMode;
  query: string;
  prefixEmpty: boolean;
}

/* ------------------------------------------------------------------ trigger */

const CODE_EXTENSIONS: Record<string, true> = {
  ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true, ".php": true,
  ".py": true, ".go": true, ".rs": true, ".java": true, ".rb": true, ".cs": true, ".c": true,
  ".h": true, ".cpp": true, ".hpp": true, ".sh": true, ".bash": true, ".sql": true, ".json": true,
  ".jsonl": true, ".md": true, ".yml": true, ".yaml": true, ".toml": true, ".ini": true,
  ".css": true, ".html": true,
};
const IGNORED_SEGMENTS: Record<string, true> = {
  ".git": true, node_modules: true, dist: true, build: true, vendor: true, coverage: true,
  ".test-dist": true, ".next": true, ".cache": true,
};
const LOCKFILES: Record<string, true> = {
  "package-lock.json": true, "pnpm-lock.yaml": true, "yarn.lock": true, "composer.lock": true,
  "cargo.lock": true, "poetry.lock": true, "bun.lockb": true, "gemfile.lock": true,
};
const GREP_STOP: Record<string, true> = {
  the: true, and: true, what: true, why: true, how: true, where: true, when: true, which: true,
  does: true, did: true, was: true, were: true, are: true, for: true, with: true, from: true,
  this: true, that: true, into: true, about: true, hear: true, heard: true, code: true,
  file: true, files: true, line: true, lines: true, rocky: true, memory: true, defined: true,
  definition: true, please: true, tell: true, show: true,
};

/** A path-ish run: a word character, a slash, and more path characters. */
const PATH_SIGNAL = /[\w.@-]+\/[\w./@-]+|[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|php|py|go|rs|java|rb|cs|c|h|cpp|hpp|sh|bash|sql|json|jsonl|md|yml|yaml|toml|ini|css|html)(?![\w])/i;
const POSITION_SIGNAL = /[\w./\\-]+:\d+(?:-\d+)?(?![\w])|[\w./\\-]+[Ll]\d+(?![\w])/;
const SYMBOL_SIGNAL = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Za-z_]\w*\s*\(|\b\w+(?:\.|::)\w+/;
const INTENT_SIGNAL = /\b(?:where is|defined|definition|implement|implemented|handler|caller|called|import|export|module|interface|function|method|class|parse|config|schema|test)\b/i;

/**
 * The two forced overrides, checked before any heuristic: `code:` forces the
 * scan on (and is stripped from the query, so neither the memory search nor
 * the model sees the prefix), `memory:` forces it off for a message that looks
 * code-ish.
 */
export function splitCodePrefix(message: string): CodeQuerySplit {
  const forcedOn = /^\s*code:\s*/i.exec(message);
  if (forcedOn !== null) {
    const query = message.slice(forcedOn[0].length).trim();
    return { mode: "code", query, prefixEmpty: query.length === 0 };
  }
  const forcedOff = /^\s*memory:\s*/i.exec(message);
  if (forcedOff !== null) {
    return { mode: "memory", query: message.slice(forcedOff[0].length).trim(), prefixEmpty: false };
  }
  return { mode: "auto", query: message.trim(), prefixEmpty: false };
}

/**
 * Spec §2.3's signal table. The intent words (`where is`, `defined`, `config`,
 * `schema`, …) fire only together with a path, position, or symbol token, so
 * `where is the config` stays memory-only while `where is loadConfig defined`
 * scans. A bare question word, a bare error string, and a bare command fire
 * nothing. A basename Rocky's memory already names counts as a code signal:
 * the user is asking for the code behind a file he was told about.
 */
export function isCodeQuery(message: string, witnessed: readonly string[] = []): boolean {
  const text = message.trim();
  if (text.length === 0) return false;
  const hasPath = PATH_SIGNAL.test(text);
  const hasPosition = POSITION_SIGNAL.test(text);
  const hasSymbol = SYMBOL_SIGNAL.test(text);
  if (INTENT_SIGNAL.test(text) && (hasPath || hasPosition || hasSymbol)) return true;
  if (hasPath || hasPosition || hasSymbol) return true;
  return namesWitnessedFile(text, witnessed);
}

function namesWitnessedFile(text: string, witnessed: readonly string[]): boolean {
  const lowered = text.toLowerCase();
  const boundary = (character: string | undefined): boolean =>
    character === undefined || !/[a-z0-9_.-]/.test(character);
  for (const path of witnessed) {
    const name = basename(path.replace(/\\/g, "/")).toLowerCase();
    if (name.length < 3) continue;
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(name, from);
      if (at === -1) break;
      if (boundary(lowered[at - 1]) && boundary(lowered[at + name.length])) return true;
      from = at + 1;
    }
  }
  return false;
}

/* --------------------------------------------------------------------- scan */

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * The list `git ls-files` gave, reduced to what a code question can use: no
 * absolute paths, no `..`, no ignored directory, no lockfile, and only the
 * extensions a reader can quote.
 */
export function candidatePaths(listed: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of listed) {
    const rel = normalizeRelPath(String(raw ?? ""));
    if (rel.length === 0 || rel.startsWith("/") || /^[A-Za-z]:\//.test(rel)) continue;
    const segments = rel.split("/");
    if (segments.some((segment) => segment === ".." || IGNORED_SEGMENTS[segment] === true)) continue;
    const name = segments[segments.length - 1] ?? "";
    if (LOCKFILES[name.toLowerCase()] === true || name.toLowerCase().endsWith(".lock")) continue;
    if (CODE_EXTENSIONS[extname(name).toLowerCase()] !== true) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** One live listing per chat: ranked when `ls-files` answered, unranked when not. */
export function scanRepoFiles(root: string, io: Partial<CodeScanIo> = {}): RepoScan {
  const merged: CodeScanIo = { ...defaultCodeScanIo, ...io };
  const listed = merged.lsFiles(root);
  if (listed === undefined) return { mode: "unranked", files: [] };
  return { mode: "ranked", files: candidatePaths(listed) };
}

/** `memory.ts` for `src/core/memory.ts`: the part a question usually names. */
function basenameNoExt(rel: string): string {
  const name = basename(rel);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function overlapCount(tokens: ReadonlySet<string>, bag: ReadonlySet<string>): number {
  let count = 0;
  for (const token of bag) if (tokens.has(token)) count += 1;
  return count;
}

/**
 * Path score: the basename outranks directory segments, and the memory prior
 * (Q11) decides ties — a file Rocky heard about, or whose name matches the
 * tokens of what he heard, outranks a file that only matches the raw question.
 */
function scorePath(
  rel: string,
  tokens: ReadonlySet<string>,
  prior: ReadonlySet<string>,
  witnessed: ReadonlySet<string>,
): number {
  const base = retrievalTokens(basenameNoExt(rel));
  const dirs = retrievalTokens(dirname(rel).replace(/\\/g, "/"));
  const all = new Set<string>([...base, ...dirs]);
  let score = 3 * overlapCount(tokens, base) + overlapCount(tokens, dirs) + 6 * similarity(prior, all);
  if (witnessed.has(rel)) score += 5;
  // A question names a longer token than the file usually does (`loadMemory`
  // against `memory.ts`): a contained name still counts, so round 1 reaches
  // the file the symbol belongs to instead of leaving it to the round-3 grep.
  for (const name of base) {
    if (name.length < 3) continue;
    for (const token of tokens) {
      if (token.length > name.length && token.includes(name)) {
        score += 2;
        break;
      }
    }
  }
  return score;
}

function lineScore(
  line: string,
  tokens: ReadonlySet<string>,
  baseTokens: ReadonlySet<string>,
  preferLine: number | undefined,
  index: number,
): number {
  const lowered = line.toLowerCase();
  let near = false;
  for (const token of tokens) if (lowered.includes(token)) { near = true; break; }
  if (!near) for (const token of baseTokens) if (lowered.includes(token)) { near = true; break; }
  if (!near) return 0;
  const bag = retrievalTokens(line);
  let score = 2 * overlapCount(tokens, bag) + 3 * overlapCount(baseTokens, bag);
  // A textual hit that shares no whole token is not a match: `unit` inside
  // `unit0` would otherwise make every numbered file score. The one exception
  // is the line the caller pointed at (a definition it already found).
  const onPrefer = preferLine !== undefined && Math.abs(index + 1 - preferLine) <= 2;
  if (score === 0 && !onPrefer) return 0;
  if (/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|public|private|protected|static)\b/.test(line)
    || /=>\s*\{?\s*$/.test(line)) score += 1;
  if (onPrefer) score += 6;
  return score;
}

function windowAround(totalLines: number, index: number): CodeWindow {
  const start = Math.max(0, Math.min(index - CODE_EXCERPT_PAD_LINES, totalLines - CODE_EXCERPT_MAX_LINES));
  const end = Math.min(totalLines, start + CODE_EXCERPT_MAX_LINES);
  return { startLine: start + 1, endLine: end, score: 0 };
}

function pickWindows(
  lines: readonly string[],
  tokens: ReadonlySet<string>,
  baseTokens: ReadonlySet<string>,
  preferLine: number | undefined,
  max: number,
): CodeWindow[] {
  const scored: { index: number; score: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const score = lineScore(lines[index] ?? "", tokens, baseTokens, preferLine, index);
    if (score > 0) scored.push({ index, score });
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const out: CodeWindow[] = [];
  for (const candidate of scored) {
    if (out.length >= max) break;
    const window = { ...windowAround(lines.length, candidate.index), score: candidate.score };
    if (out.some((kept) => kept.startLine <= window.endLine && window.startLine <= kept.endLine)) continue;
    out.push(window);
  }
  return out;
}

/** The symbols a question names, for the round-3 literal grep. */
function symbolTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const raw = match[0];
    if (raw.length < 3) continue;
    const lowered = raw.toLowerCase();
    if (GREP_STOP[lowered] === true) continue;
    out.add(lowered);
  }
  return out;
}

/** `path:line` hints a question types, so the named line is scored first. */
function positionHints(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of text.matchAll(/([\w./\\-]+):(\d+)(?:-\d+)?/g)) {
    const path = normalizeRelPath(match[1] ?? "");
    const line = Number(match[2]);
    if (path.length === 0 || !Number.isFinite(line) || line < 1) continue;
    if (!out.has(path)) out.set(path, Math.floor(line));
  }
  return out;
}

/** Same file, whether the citation is the full repo path or just the basename. */
function sameRepoPath(left: string, right: string): boolean {
  const a = normalizeRelPath(left).toLowerCase();
  const b = normalizeRelPath(right).toLowerCase();
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function neighborCandidates(specifier: string): string[] {
  const tries = [specifier];
  if (specifier.endsWith(".js")) tries.push(`${specifier.slice(0, -3)}.ts`, `${specifier.slice(0, -3)}.tsx`);
  if (specifier.endsWith(".jsx")) tries.push(`${specifier.slice(0, -4)}.tsx`);
  if (!/\.[A-Za-z0-9]+$/.test(specifier)) tries.push(`${specifier}.ts`, `${specifier}.js`, `${specifier}.php`);
  return tries;
}

/** Names worth one hop: what the excerpt calls, plus the imports it names. */
function hopNames(excerptText: string, imports: readonly ImportLine[]): string[] {
  const names: string[] = [];
  for (const name of calleeNames(excerptText)) if (!names.includes(name)) names.push(name);
  for (const imported of imports) {
    for (const name of imported.names) {
      if (excerptText.includes(name) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/* ------------------------------------------------------------------- search */

/**
 * One live scan, at most three rounds, then answer with whatever was read.
 * Round 1 walks the path-ranked candidates; round 2 takes one hop out of the
 * excerpts through the existing teach-ladder helpers; round 3 reads the
 * memory-witnessed files the earlier rounds missed and, when nothing matched
 * at all, greps the candidate list for the question's own symbols.
 */
export function collectCodeEvidence(input: CollectCodeEvidenceInput): CodeEvidenceResult {
  const io: CodeScanIo = { ...defaultCodeScanIo, ...(input.io ?? {}) };
  const now = input.now ?? ((): number => Date.now());
  const tokens = queryTokens(input.query);
  const hints = positionHints(input.query);
  const prior = input.priorTokens ?? new Set<string>();
  const witnessed: string[] = [];
  for (const path of input.witnessed ?? []) {
    const rel = normalizeRelPath(path);
    // Only a root-relative path can ever resolve through `confine`, so an
    // absolute or `..`-bearing memory path is not a candidate at all.
    if (rel.length === 0 || rel.startsWith("/") || /^[A-Za-z]:\//.test(rel)) continue;
    if (rel.split("/").some((segment) => segment === "..")) continue;
    if (!witnessed.includes(rel)) witnessed.push(rel);
  }
  const witnessedSet = new Set(witnessed);

  const disclosures: string[] = [];
  const note = (line: string): void => {
    if (!disclosures.includes(line)) disclosures.push(line);
  };
  const evidence: CodeExcerpt[] = [];
  const readCache = new Map<string, string[]>();
  const unreadable = new Set<string>();
  let sizeSkips = 0;
  let lineCaps = 0;

  const readFile = (rel: string): string[] | "too-big" | "miss" => {
    const cached = readCache.get(rel);
    if (cached !== undefined) return cached;
    if (unreadable.has(rel)) return "miss";
    const full = input.confine(rel);
    if (full === undefined) {
      unreadable.add(rel);
      return "miss";
    }
    const size = io.statSize(full);
    if (size === undefined) {
      unreadable.add(rel);
      return "miss";
    }
    if (size > CODE_MAX_FILE_BYTES) return "too-big";
    const text = io.readText(full);
    if (text === undefined || text.includes("\u0000")) {
      unreadable.add(rel);
      return "miss";
    }
    const all = text.split(/\r?\n/);
    if (all.length > CODE_MAX_FILE_LINES) {
      lineCaps += 1;
      note(CODE_FILE_LINES_CAPPED(rel));
    }
    const lines = all.slice(0, CODE_MAX_FILE_LINES);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    readCache.set(rel, lines);
    return lines;
  };

  const scanFile = (rel: string, lineTokens: ReadonlySet<string>, preferLine?: number): void => {
    if (evidence.length >= CODE_MAX_EXCERPTS) return;
    const lines = readFile(rel);
    if (lines === "too-big") {
      sizeSkips += 1;
      note(CODE_FILE_TOO_BIG(rel));
      return;
    }
    if (lines === "miss") return;
    const baseTokens = retrievalTokens(basenameNoExt(rel));
    for (const window of pickWindows(lines, lineTokens, baseTokens, preferLine, CODE_WINDOWS_PER_FILE)) {
      if (evidence.length >= CODE_MAX_EXCERPTS) break;
      const quoted = redactSecretsAtBoundary(lines.slice(window.startLine - 1, window.endLine).join("\n"));
      if (quoted.trim().length === 0) continue;
      evidence.push({
        ref: `${rel}:${window.startLine}-${window.endLine}`,
        path: rel,
        startLine: window.startLine,
        endLine: window.endLine,
        lines: quoted,
        score: window.score,
      });
    }
  };

  const preferFor = (rel: string): number | undefined => {
    for (const [path, line] of hints) if (sameRepoPath(rel, path)) return line;
    return undefined;
  };

  const scan = scanRepoFiles(input.root, io);
  const mode = scan.mode;
  /** Path-scored first (round 1 walks these), then the rest for the grep. */
  let ranked: string[];
  let candidates: string[];
  let filesTotal: number;
  let cutByCap = false;
  if (mode === "ranked") {
    filesTotal = scan.files.length;
    const scored = scan.files
      .map((rel) => ({ rel, score: scorePath(rel, tokens, prior, witnessedSet) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
    if (scored.length > CODE_MAX_CANDIDATE_FILES) cutByCap = true;
    ranked = scored.slice(0, CODE_MAX_CANDIDATE_FILES).map((candidate) => candidate.rel);
    const rankedSet = new Set(ranked);
    const rest = scan.files
      .filter((rel) => !rankedSet.has(rel))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (rest.length > CODE_MAX_CANDIDATE_FILES) cutByCap = true;
    candidates = [...ranked, ...rest.slice(0, CODE_MAX_CANDIDATE_FILES)];
  } else {
    note(CODE_UNRANKED);
    filesTotal = witnessed.length;
    if (witnessed.length > CODE_MAX_CANDIDATE_FILES) cutByCap = true;
    ranked = [...witnessed]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, CODE_MAX_CANDIDATE_FILES);
    candidates = [...ranked];
  }

  const totalDeadline = now() + CODE_TOTAL_TIMEOUT_MS;
  let rounds = 0;
  let aborted = false;

  const roundOne = (deadline: number): boolean => {
    for (const rel of ranked) {
      if (evidence.length >= CODE_MAX_EXCERPTS) return false;
      if (now() >= deadline) return true;
      scanFile(rel, tokens, preferFor(rel));
    }
    return false;
  };

  const roundTwo = (deadline: number): boolean => {
    let names = 0;
    let hops = 0;
    for (const excerpt of evidence) {
      if (names >= CODE_MAX_HOP_NAMES || hops >= CODE_MAX_HOP_FILES || evidence.length >= CODE_MAX_EXCERPTS) break;
      const fileLines = readCache.get(excerpt.path);
      if (fileLines === undefined) continue;
      const fileText = fileLines.join("\n");
      const imports = collectImports(fileText);
      for (const name of hopNames(excerpt.lines, imports)) {
        if (names >= CODE_MAX_HOP_NAMES || hops >= CODE_MAX_HOP_FILES || evidence.length >= CODE_MAX_EXCERPTS) break;
        names += 1;
        const imported = imports.find((entry) => entry.names.includes(name));
        if (imported === undefined || !isRelativeSpecifier(imported.specifier)) continue;
        const base = resolveRelativePath(excerpt.path, imported.specifier);
        for (const neighbor of neighborCandidates(base)) {
          if (hops >= CODE_MAX_HOP_FILES) break;
          if (readCache.has(neighbor) || unreadable.has(neighbor)) continue;
          if (now() >= deadline) return true;
          hops += 1;
          const lines = readFile(neighbor);
          if (lines === "too-big") {
            sizeSkips += 1;
            note(CODE_FILE_TOO_BIG(neighbor));
            break;
          }
          if (lines === "miss") continue;
          const found = findDefinitionInText(name, lines.join("\n"));
          if (found === undefined) break;
          scanFile(neighbor, tokens, found.line);
          break;
        }
      }
    }
    return false;
  };

  const roundThree = (deadline: number): boolean => {
    let reads = 0;
    for (const rel of witnessed) {
      if (evidence.length >= CODE_MAX_EXCERPTS || reads >= CODE_MAX_WITNESS_FILES) break;
      if (readCache.has(rel) || unreadable.has(rel)) continue;
      if (now() >= deadline) return true;
      reads += 1;
      scanFile(rel, tokens, preferFor(rel));
    }
    if (evidence.length > 0) return false;
    const symbols = symbolTokens(input.query);
    if (symbols.size === 0) return false;
    let greps = 0;
    for (const rel of candidates) {
      if (evidence.length >= CODE_MAX_EXCERPTS || greps >= CODE_MAX_GREP_FILES) break;
      if (readCache.has(rel) || unreadable.has(rel)) continue;
      if (now() >= deadline) return true;
      greps += 1;
      scanFile(rel, symbols, preferFor(rel));
    }
    return false;
  };

  let lastRoundProgress = false;
  if (candidates.length > 0) {
    for (let round = 1; round <= CODE_MAX_ROUNDS; round += 1) {
      if (evidence.length >= CODE_MAX_EXCERPTS) break;
      if (now() >= totalDeadline) {
        aborted = true;
        break;
      }
      rounds = round;
      const before = readCache.size + evidence.length;
      const deadline = Math.min(totalDeadline, now() + CODE_ROUND_TIMEOUT_MS);
      const timedOut = round === 1 ? roundOne(deadline) : round === 2 ? roundTwo(deadline) : roundThree(deadline);
      lastRoundProgress = readCache.size + evidence.length > before;
      if (timedOut) {
        note(CODE_ROUND_TIMEOUT(round));
        aborted = true;
        break;
      }
    }
  }

  // "Exhausted" means the round cap stopped a scan that still had somewhere to
  // go: a phase that read nothing new in its last round simply had nothing
  // left to check, and says nothing about a spent budget.
  let roundsExhausted = false;
  if (aborted) {
    roundsExhausted = true;
  } else if (rounds === CODE_MAX_ROUNDS && lastRoundProgress && evidence.length < CODE_MAX_EXCERPTS) {
    roundsExhausted = true;
    note(CODE_ROUNDS_SPENT);
  }

  const filesScanned = readCache.size;
  const truncated = aborted || cutByCap || sizeSkips > 0 || lineCaps > 0 || filesScanned < filesTotal;
  if (truncated && filesTotal > 0 && filesScanned < filesTotal) {
    note(CODE_TRUNCATED(filesScanned, filesTotal));
  }

  return {
    evidence: [...evidence].sort(
      (left, right) =>
        right.score - left.score ||
        left.startLine - right.startLine ||
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    ),
    trace: { mode, filesScanned, filesTotal, rounds, roundsExhausted, truncated },
    disclosures,
  };
}

/* ------------------------------------------------------------------- prompt */

/**
 * Q11's prompt: the shared teach preamble and rules, then the memory evidence
 * block, the Jev trace block, and the excerpt pack — the two context blocks
 * are always attached, even when empty, so the model cannot imply it looked at
 * something it was never given. The joined pack is redacted once more here, on
 * top of the per-excerpt redaction, before any of it may leave.
 */
export function buildCodePrompt(input: CodePromptInput): string {
  const blocks: string[] = [];
  let spent = 0;
  for (const excerpt of input.evidence) {
    const remaining = CODE_PACK_CHARS - spent;
    if (remaining < 200) break;
    const body = excerpt.lines.length > remaining ? excerpt.lines.slice(0, remaining) : excerpt.lines;
    const block = `=== ${excerpt.path}:${excerpt.startLine}-${excerpt.endLine} ===\n${body}`;
    blocks.push(block);
    spent += block.length + 2;
  }
  const pack = redactSecretsAtBoundary(blocks.join("\n\n"));
  const memory = input.memoryBlock.trim().length > 0 ? input.memoryBlock : "no memory evidence for this query";
  const jev = input.jevBlock.trim().length > 0 ? input.jevBlock : "no jev trace for this query";
  const code = pack.trim().length > 0 ? pack : "no code excerpt matched this query";
  return [
    input.preamble,
    CODE_GROUNDING_RULES,
    "MEMORY EVIDENCE (what Rocky heard; cite it as a record, never as proof of code):",
    memory,
    "JEV DECISION TRACE (the ranker's own reading of the memory; context, not code evidence):",
    jev,
    "CODE EXCERPTS (read live from the launch root at request time; the only code you may quote):",
    code,
    `USER QUESTION: ${input.question}`,
  ].join("\n\n");
}

const CITATION = /([\w./\\-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

/**
 * The code answer's citation gate, mirroring `validateRenderedClaims`: a line
 * that cites a `path:line` no excerpt holds is stripped whole and counted.
 * Suffix matching keeps a model that cites `memory.ts:120` for
 * `src/core/memory.ts:120` grounded; the line must still fall inside a quoted
 * window.
 */
export function validateCodeCitations(
  text: string,
  evidence: readonly CodeExcerpt[],
): { stripped: string; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    const citations = [...line.matchAll(CITATION)];
    if (citations.length === 0) {
      kept.push(line);
      continue;
    }
    const unbacked = citations.some((match) => {
      const path = match[1] ?? "";
      const start = Number(match[2]);
      const end = match[3] === undefined ? start : Number(match[3]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return true;
      return !evidence.some(
        (excerpt) =>
          sameRepoPath(excerpt.path, path) &&
          start >= excerpt.startLine &&
          end <= excerpt.endLine,
      );
    });
    if (unbacked) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { stripped: kept.join("\n"), dropped };
}

/* -------------------------------------------------------------------- prior */

/**
 * The token bag the memory hits contribute to ranking: the commands a failure
 * or fix carried, a triple's intent text and rationale tags, and the files a
 * triple covered. Candidates are ordered against what Rocky heard (Q11), not
 * against the raw question alone.
 */
export function memoryPriorTokens(
  records: readonly MemoryRecord[],
  hits: readonly { id: string; snippet: string; filesCovered?: readonly string[] }[],
): Set<string> {
  const byId = new Map<string, MemoryRecord>();
  for (const record of records) byId.set(record.id, record);
  const bag = new Set<string>();
  const add = (text: string): void => {
    for (const token of retrievalTokens(text)) bag.add(token);
  };
  for (const hit of hits) {
    add(hit.snippet);
    for (const file of hit.filesCovered ?? []) add(file);
    const record = byId.get(hit.id);
    if (record !== undefined && record.kind === "triple") {
      add(`${record.intent?.text ?? ""} ${(record.rationale?.tags ?? []).join(" ")}`);
    }
  }
  return bag;
}

/** The server-built line a fallback answer carries in place of model text. */
export function codeFallbackText(evidence: readonly CodeExcerpt[]): string {
  if (evidence.length === 0) return CODE_NOTHING_QUOTED;
  const files = new Set(evidence.map((excerpt) => excerpt.path)).size;
  const excerpts = evidence.length === 1 ? "excerpt" : "excerpts";
  const fileWord = files === 1 ? "file" : "files";
  return `code: quoted ${evidence.length} ${excerpts} from ${files} ${fileWord}. memory answer stands above.`;
}
