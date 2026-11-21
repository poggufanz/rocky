import { homedir } from "node:os";
import { canonicalPath } from "../core/memory-read.js";

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface StoredLabel {
  id: string;
  args?: Record<string, unknown>;
}

export interface StoredBlockSymbol {
  kind: string;
  name: string;
  container?: string | null;
  exported?: boolean;
  nth?: number;
}

export interface StoredBashInfo {
  cmd: string;
  candidates: number;
}

export interface StoredQuote {
  text: string;
  shared: boolean;
}

export interface StoredBlock {
  seq: number;
  path: string;
  symbol?: StoredBlockSymbol | null;
  labels: StoredLabel[];
  importance: string;
  via?: string;
  tool_use_ids?: string[];
  bash?: StoredBashInfo | null;
  before?: string | null;
  after?: string | null;
  recorded?: boolean;
  line?: number | null;
  added?: number | null;
  removed?: number | null;
  quote?: StoredQuote | null;
}

export interface StoredFlowStep {
  kind: string;
  text: string;
  ok: boolean;
  dur_ms: number;
  seqs: number[];
  exit_code?: number | null;
  error?: string | null;
  start_ms?: number;
  end_ms?: number;
  cwd?: string;
  tool_use_id?: string;
  desc?: string;
}

export interface StoredCoverage {
  state: string;
  reasons: string[];
}

export interface StoredSequence {
  pattern: "fix_after_fail";
  command: string;
  exit_code: number;
  edit_seqs: number[];
  error_names?: string | null;
}

export interface StoredCard {
  v: 1;
  card_id: string;
  rev: number;
  repo_id?: string;
  root: string;
  main_root?: string | null;
  branch?: string | null;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  parent_card_id?: string | null;
  started_ms: number;
  ended_ms: number | null;
  status?: string;
  prompt: string;
  prompt_truncated?: boolean;
  importance?: string;
  blocks: StoredBlock[];
  more_count?: number;
  flow?: StoredFlowStep[];
  flow_more?: number;
  outside_count?: number;
  coverage?: StoredCoverage;
  sequence?: StoredSequence | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSafeNonNegInt(value: unknown): value is number {
  return isSafeInt(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isValidLabel(value: unknown): value is StoredLabel {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (value.args !== undefined && !isPlainObject(value.args)) return false;
  return true;
}

function isValidSymbol(value: unknown): value is StoredBlockSymbol {
  if (!isPlainObject(value)) return false;
  if (typeof value.kind !== "string" || value.kind.length === 0) return false;
  if (typeof value.name !== "string") return false;
  if (value.container !== undefined && value.container !== null && typeof value.container !== "string") return false;
  if (value.exported !== undefined && typeof value.exported !== "boolean") return false;
  if (value.nth !== undefined && !isSafeNonNegInt(value.nth)) return false;
  return true;
}

function isValidBashInfo(value: unknown): value is StoredBashInfo {
  if (!isPlainObject(value)) return false;
  return typeof value.cmd === "string" && isSafeNonNegInt(value.candidates);
}

function isValidQuote(value: unknown): value is StoredQuote {
  if (!isPlainObject(value)) return false;
  return typeof value.text === "string" && typeof value.shared === "boolean";
}

function isValidBlock(value: unknown): value is StoredBlock {
  if (!isPlainObject(value)) return false;
  if (!isSafeNonNegInt(value.seq)) return false;
  if (typeof value.path !== "string" || value.path.length === 0) return false;
  if (!Array.isArray(value.labels) || !value.labels.every(isValidLabel)) return false;
  if (typeof value.importance !== "string") return false;
  if (value.symbol !== undefined && value.symbol !== null && !isValidSymbol(value.symbol)) return false;
  if (value.via !== undefined && typeof value.via !== "string") return false;
  if (value.tool_use_ids !== undefined && !isStringArray(value.tool_use_ids)) return false;
  if (value.bash !== undefined && value.bash !== null && !isValidBashInfo(value.bash)) return false;
  if (value.before !== undefined && value.before !== null && typeof value.before !== "string") return false;
  if (value.after !== undefined && value.after !== null && typeof value.after !== "string") return false;
  if (value.recorded !== undefined && typeof value.recorded !== "boolean") return false;
  if (value.line !== undefined && value.line !== null && !isSafeNonNegInt(value.line)) return false;
  if (value.added !== undefined && value.added !== null && !isSafeNonNegInt(value.added)) return false;
  if (value.removed !== undefined && value.removed !== null && !isSafeNonNegInt(value.removed)) return false;
  if (value.quote !== undefined && value.quote !== null && !isValidQuote(value.quote)) return false;
  return true;
}

function isValidFlowStep(value: unknown): value is StoredFlowStep {
  if (!isPlainObject(value)) return false;
  if (
    typeof value.kind !== "string" ||
    typeof value.text !== "string" ||
    typeof value.ok !== "boolean" ||
    !isSafeNonNegInt(value.dur_ms) ||
    !Array.isArray(value.seqs) ||
    !value.seqs.every(isSafeNonNegInt)
  ) {
    return false;
  }
  if (value.exit_code !== undefined && value.exit_code !== null && !isSafeInt(value.exit_code)) return false;
  if (value.error !== undefined && value.error !== null && typeof value.error !== "string") return false;
  if (value.start_ms !== undefined && !isSafeNonNegInt(value.start_ms)) delete value.start_ms;
  if (value.end_ms !== undefined && !isSafeNonNegInt(value.end_ms)) delete value.end_ms;
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0)) delete value.cwd;
  if (value.tool_use_id !== undefined && (typeof value.tool_use_id !== "string" || value.tool_use_id.length === 0)) {
    delete value.tool_use_id;
  }
  if (value.desc !== undefined && typeof value.desc !== "string") delete value.desc;
  return true;
}

function isValidCoverageField(value: unknown): value is StoredCoverage {
  if (!isPlainObject(value)) return false;
  return typeof value.state === "string" && isStringArray(value.reasons);
}

function isValidFixAfterFailSequence(value: Record<string, unknown>): boolean {
  if (typeof value.command !== "string") return false;
  if (!isSafeInt(value.exit_code)) return false;
  if (!Array.isArray(value.edit_seqs) || !value.edit_seqs.every(isSafeNonNegInt)) return false;
  if (value.error_names !== undefined && value.error_names !== null && typeof value.error_names !== "string") {
    return false;
  }
  return true;
}

export function validateCard(value: unknown): value is StoredCard {
  if (!isPlainObject(value)) return false;
  if (value.v !== 1) return false;
  if (typeof value.card_id !== "string" || value.card_id.length === 0) return false;
  if (!isSafeNonNegInt(value.rev)) return false;
  if (typeof value.root !== "string") return false;
  if (!isSafeNonNegInt(value.started_ms)) return false;
  if (value.ended_ms !== null && !isSafeNonNegInt(value.ended_ms)) return false;
  if (typeof value.prompt !== "string") return false;
  if (!Array.isArray(value.blocks) || !value.blocks.every(isValidBlock)) return false;

  if (value.repo_id !== undefined && typeof value.repo_id !== "string") return false;
  if (value.main_root !== undefined && value.main_root !== null && typeof value.main_root !== "string") return false;
  if (value.branch !== undefined && value.branch !== null && typeof value.branch !== "string") return false;
  if (value.session_id !== undefined && typeof value.session_id !== "string") return false;
  if (value.agent_id !== undefined && typeof value.agent_id !== "string") return false;
  if (value.agent_type !== undefined && typeof value.agent_type !== "string") return false;
  if (
    value.parent_card_id !== undefined &&
    value.parent_card_id !== null &&
    typeof value.parent_card_id !== "string"
  ) {
    return false;
  }
  if (value.status !== undefined && typeof value.status !== "string") return false;
  if (value.prompt_truncated !== undefined && typeof value.prompt_truncated !== "boolean") return false;
  if (value.importance !== undefined && typeof value.importance !== "string") return false;
  if (value.more_count !== undefined && !isSafeNonNegInt(value.more_count)) return false;
  if (value.flow !== undefined && (!Array.isArray(value.flow) || !value.flow.every(isValidFlowStep))) return false;
  if (value.flow_more !== undefined && !isSafeNonNegInt(value.flow_more)) return false;
  if (value.outside_count !== undefined && !isSafeNonNegInt(value.outside_count)) return false;
  if (value.coverage !== undefined && !isValidCoverageField(value.coverage)) return false;
  if (value.sequence !== undefined && value.sequence !== null) {
    if (!isPlainObject(value.sequence) || typeof value.sequence.pattern !== "string") return false;
    if (value.sequence.pattern !== "fix_after_fail") {
      delete value.sequence;
    } else if (!isValidFixAfterFailSequence(value.sequence)) {
      return false;
    }
  }
  return true;
}

export function expandTilde(pathValue: string, homeDir: string = homedir()): string {
  if (pathValue === "~") return homeDir;
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    const home = homeDir.replace(/[\\/]+$/, "");
    return `${home}/${pathValue.slice(2)}`;
  }
  return pathValue;
}

export function collapseDotSegments(rawPath: string): { prefix: string; segments: string[]; hadEscape: boolean } {
  const forward = rawPath.replace(/\\/g, "/");
  let prefix = "";
  let rest = forward;

  const unc = forward.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/);
  if (unc) {
    prefix = `${unc[1]}/`;
    rest = unc[2] ?? "";
  } else {
    const drive = forward.match(/^([a-zA-Z]:)(?:\/(.*))?$/);
    if (drive) {
      prefix = `${drive[1]}/`;
      rest = drive[2] ?? "";
    } else if (forward.startsWith("/")) {
      prefix = "/";
      rest = forward.slice(1);
    }
  }

  const segments: string[] = [];
  let hadEscape = false;
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0) {
        segments.pop();
      } else {
        hadEscape = true;
      }
      continue;
    }
    segments.push(part);
  }
  return { prefix, segments, hadEscape };
}

export function normalizeAbsForPlatform(rawAbs: string, platform: NodeJS.Platform): string {
  const { prefix, segments } = collapseDotSegments(rawAbs);
  return canonicalPath(`${prefix}${segments.join("/")}`, { platform });
}

export function normalizeRepoBlockPath(rawPath: string, platform: NodeJS.Platform): string | undefined {
  const { prefix, segments, hadEscape } = collapseDotSegments(rawPath);
  if (prefix !== "" || hadEscape || segments.length === 0) return undefined;
  const joined = segments.join("/");
  return platform === "win32" ? joined.toLowerCase() : joined;
}

export function isAbsOrTildeBlockPath(blockPath: string): boolean {
  return (
    blockPath === "~" ||
    blockPath.startsWith("~/") ||
    blockPath.startsWith("~\\") ||
    /^[a-zA-Z]:[\\/]/.test(blockPath) ||
    blockPath.startsWith("/") ||
    blockPath.startsWith("\\")
  );
}

export type CardLine =
  | { kind: "blank" }
  | { kind: "card"; card: StoredCard }
  | { kind: "invalid" };

/** Parse one JSONL line (without its newline). Unparseable or invalid lines are "invalid". */
export function parseCardLine(lineBuf: Buffer): CardLine {
  const end = lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d ? lineBuf.length - 1 : lineBuf.length;
  let text: string;
  try {
    text = UTF8_FATAL_DECODER.decode(lineBuf.subarray(0, end));
  } catch {
    return { kind: "invalid" };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "blank" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid" };
  }
  if (!validateCard(parsed)) return { kind: "invalid" };
  return { kind: "card", card: parsed };
}

export interface PathInsideOptions {
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * Purely lexical absolute-path form used for containment checks. It keeps every
 * character of every segment (no trimming, no control-character stripping) and
 * applies only: backslash to slash, home expansion, duplicate separators, dot
 * segments, and case folding on win32. Returns undefined for relative paths and
 * for paths whose dot segments climb above their root.
 */
function lexicalAbsolute(value: string, platform: NodeJS.Platform, home: string): string | undefined {
  if (!isAbsOrTildeBlockPath(value)) return undefined;
  const forward = expandTilde(value, home).replace(/\\/g, "/");
  let prefix: string;
  let rest: string;
  const drive = forward.match(/^([a-zA-Z]:)(?:\/(.*))?$/);
  const unc = platform === "win32" ? forward.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/) : null;
  if (unc) {
    prefix = `//${unc[1]}/${unc[2]}/`;
    rest = unc[3] ?? "";
  } else if (drive) {
    prefix = `${drive[1]}/`;
    rest = drive[2] ?? "";
  } else if (forward.startsWith("/")) {
    prefix = "/";
    rest = forward.replace(/^\/+/, "");
  } else {
    return undefined;
  }
  const segments: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const joined = `${prefix}${segments.join("/")}`;
  return platform === "win32" ? joined.toLowerCase() : joined;
}

/**
 * True when `path` equals `root` or lies below it, compared by whole segments.
 * Only absolute or `~/` paths can be inside; `~/` expands against `home`.
 * Case-insensitive on win32 only. Ambiguous input fails closed (not inside).
 */
export function isPathInside(path: string, root: string, options: PathInsideOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const pathNorm = lexicalAbsolute(path, platform, home);
  const rootNorm = lexicalAbsolute(root, platform, home);
  if (pathNorm === undefined || rootNorm === undefined) return false;
  if (pathNorm === rootNorm) return true;
  const prefix = rootNorm.endsWith("/") ? rootNorm : `${rootNorm}/`;
  return pathNorm.startsWith(prefix);
}
