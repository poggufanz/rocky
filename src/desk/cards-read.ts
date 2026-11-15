import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { gitRootFor } from "../core/compare-data.js";
import { NO_BLOCK_FLAG, NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "../core/fs-safety.js";
import { canonicalPath } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { cardsFilePath } from "../listening/cards-path.js";

const MAX_CARDS_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CARDS_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 5;
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
  via?: "edit" | "bash";
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
}

export interface StoredCoverage {
  state: string;
  reasons: string[];
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
}

export interface CardsReadCoverage {
  complete: boolean;
  reason?: "file-size-cap" | "line-cap" | "read-race";
  skipped: number;
}

export interface CardsForFile {
  cards: StoredCard[];
  matched: Map<string, StoredBlock[]>;
  coverage: CardsReadCoverage;
}

export interface CardsForFileOptions {
  home?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  limit?: number;
}

function emptyResult(coverage: CardsReadCoverage): CardsForFile {
  return { cards: [], matched: new Map(), coverage };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
  if (value.via !== undefined && value.via !== "edit" && value.via !== "bash") return false;
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
  return (
    typeof value.kind === "string" &&
    typeof value.text === "string" &&
    typeof value.ok === "boolean" &&
    isSafeNonNegInt(value.dur_ms) &&
    Array.isArray(value.seqs) &&
    value.seqs.every(isSafeNonNegInt)
  );
}

function isValidCoverageField(value: unknown): value is StoredCoverage {
  if (!isPlainObject(value)) return false;
  return typeof value.state === "string" && isStringArray(value.reasons);
}

function validateCard(value: unknown): value is StoredCard {
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
  return true;
}

function expandTilde(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    const home = homedir().replace(/[\\/]+$/, "");
    return `${home}/${pathValue.slice(2)}`;
  }
  return pathValue;
}

function collapseDotSegments(rawPath: string): { prefix: string; segments: string[]; hadEscape: boolean } {
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

function normalizeAbsForPlatform(rawAbs: string, platform: NodeJS.Platform): string {
  const { prefix, segments } = collapseDotSegments(rawAbs);
  return canonicalPath(`${prefix}${segments.join("/")}`, { platform });
}

function normalizeRepoBlockPath(rawPath: string, platform: NodeJS.Platform): string | undefined {
  const { prefix, segments, hadEscape } = collapseDotSegments(rawPath);
  if (prefix !== "" || hadEscape || segments.length === 0) return undefined;
  const joined = segments.join("/");
  return platform === "win32" ? joined.toLowerCase() : joined;
}

function resolveInputPath(rawFile: string, cwd: string, platform: NodeJS.Platform): string {
  const expanded = expandTilde(rawFile);
  const looksWindowsAbs = /^[a-zA-Z]:[\\/]/.test(expanded) || expanded.startsWith("\\\\");
  if (looksWindowsAbs || isAbsolute(expanded)) {
    return expanded;
  }
  const normalizedRel = platform === "win32" ? expanded.replace(/\\/g, "/") : expanded;
  return resolve(cwd, normalizedRel);
}

function safeRealpath(target: string): string[] {
  const out: string[] = [];
  try {
    out.push(realpathSync(target));
  } catch {
    // Target may not exist on disk yet.
  }
  try {
    const native = realpathSync.native(target);
    if (!out.includes(native)) out.push(native);
  } catch {
    // Ignore missing/unreadable targets.
  }
  return out;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

interface RootSpelling {
  readonly logSpelling: string;
  readonly rawRoot: string;
}

function buildRootSpellings(rootRaw: string): RootSpelling[] {
  const candidates = [rootRaw, ...safeRealpath(rootRaw)];
  const spellings: RootSpelling[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const logSpelling = canonicalPath(candidate);
    if (logSpelling.length > 0 && !seen.has(logSpelling)) {
      seen.add(logSpelling);
      spellings.push({ logSpelling, rawRoot: candidate });
    }
  }
  return spellings;
}

function pickExistingLogPath(spellings: readonly RootSpelling[], home: string): {
  status: "missing" | "non-regular" | "race" | "ready";
  logPath?: string;
  selectedRoot?: string;
  lstat?: ReturnType<typeof lstatSync>;
} {
  for (const spelling of spellings) {
    const logPath = cardsFilePath(spelling.logSpelling, home);
    const probe = inspectLogPath(logPath);
    if (probe.status === "missing") continue;
    return { ...probe, logPath, selectedRoot: spelling.rawRoot };
  }
  return { status: "missing" };
}

function inspectLogPath(logPath: string): {
  status: "missing" | "non-regular" | "race" | "ready";
  lstat?: ReturnType<typeof lstatSync>;
} {
  try {
    const stats = lstatSync(logPath, { bigint: true });
    if (!stats.isFile()) {
      return { status: "non-regular" };
    }
    return { status: "ready", lstat: stats };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "missing" };
    }
    return { status: "race" };
  }
}

interface ParsedLogResult {
  cardsById: Map<string, StoredCard>;
  coverage: CardsReadCoverage;
}

function parseJsonlLine(
  lineBuf: Buffer,
  cardsById: Map<string, StoredCard>,
): boolean {
  const end = lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d ? lineBuf.length - 1 : lineBuf.length;
  let text: string;
  try {
    text = UTF8_FATAL_DECODER.decode(lineBuf.subarray(0, end));
  } catch {
    return false;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!validateCard(parsed)) return false;

  const existing = cardsById.get(parsed.card_id);
  if (!existing || parsed.rev >= existing.rev) {
    cardsById.set(parsed.card_id, parsed);
  }
  return true;
}

function readAndParseCardsLog(
  logPath: string,
  expectedLstat: ReturnType<typeof lstatSync>,
): ParsedLogResult | { earlyCoverage: CardsReadCoverage } {
  const cardsById = new Map<string, StoredCard>();
  let fd: number;
  try {
    fd = openSync(logPath, constants.O_RDONLY | NO_FOLLOW_FLAG | NO_BLOCK_FLAG);
  } catch {
    return { earlyCoverage: { complete: false, reason: "read-race", skipped: 0 } };
  }

  let sizeCapped = false;
  let lineCapped = false;
  let skipped = 0;

  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(expectedLstat, opened)) {
      return { earlyCoverage: { complete: false, reason: "read-race", skipped: 0 } };
    }

    const totalBytesBig = opened.size;
    const capBytesBig = BigInt(MAX_CARDS_FILE_BYTES);
    sizeCapped = totalBytesBig > capBytesBig;
    let pos = sizeCapped ? totalBytesBig - capBytesBig : 0n;

    const readBuf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let skippingPartialFirstLine = sizeCapped;
    let droppingLongLine = false;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;

    while (pos < totalBytesBig) {
      const remaining = totalBytesBig - pos;
      const toRead = remaining < BigInt(READ_CHUNK_BYTES) ? Number(remaining) : READ_CHUNK_BYTES;
      const bytesRead = readSync(fd, readBuf, 0, toRead, pos);
      if (bytesRead <= 0) {
        return { earlyCoverage: { complete: false, reason: "read-race", skipped: 0 } };
      }
      pos += BigInt(bytesRead);
      const chunk = readBuf.subarray(0, bytesRead);

      let cursor = 0;
      while (cursor < chunk.length) {
        const nl = chunk.indexOf(0x0a, cursor);
        if (nl === -1) {
          if (skippingPartialFirstLine || droppingLongLine) {
            cursor = chunk.length;
            continue;
          }
          const segLen = chunk.length - cursor;
          if (pendingBytes + segLen > MAX_CARDS_LINE_BYTES) {
            pendingChunks = [];
            pendingBytes = 0;
            droppingLongLine = true;
            lineCapped = true;
            skipped += 1;
          } else {
            pendingChunks.push(Buffer.from(chunk.subarray(cursor)));
            pendingBytes += segLen;
          }
          cursor = chunk.length;
          continue;
        }

        if (skippingPartialFirstLine) {
          skippingPartialFirstLine = false;
          cursor = nl + 1;
          continue;
        }
        if (droppingLongLine) {
          droppingLongLine = false;
          cursor = nl + 1;
          continue;
        }

        const segLen = nl - cursor;
        const lastByte =
          segLen > 0
            ? chunk[nl - 1]
            : pendingChunks.length > 0
              ? pendingChunks[pendingChunks.length - 1]![pendingChunks[pendingChunks.length - 1]!.length - 1]
              : undefined;
        const trimmedCrLen = pendingBytes + segLen - (lastByte === 0x0d ? 1 : 0);

        if (trimmedCrLen > MAX_CARDS_LINE_BYTES) {
          pendingChunks = [];
          pendingBytes = 0;
          lineCapped = true;
          skipped += 1;
        } else {
          const lineBuf =
            pendingChunks.length === 0
              ? chunk.subarray(cursor, nl)
              : Buffer.concat([...pendingChunks, chunk.subarray(cursor, nl)], pendingBytes + segLen);
          pendingChunks = [];
          pendingBytes = 0;
          if (!parseJsonlLine(lineBuf, cardsById)) {
            skipped += 1;
          }
        }
        cursor = nl + 1;
      }
    }

    if (!skippingPartialFirstLine && !droppingLongLine && pendingBytes > 0) {
      const lastChunk = pendingChunks[pendingChunks.length - 1]!;
      const trimmedCrLen = pendingBytes - (lastChunk[lastChunk.length - 1] === 0x0d ? 1 : 0);
      if (trimmedCrLen > MAX_CARDS_LINE_BYTES) {
        lineCapped = true;
        skipped += 1;
      } else {
        const lineBuf = pendingChunks.length === 1 ? pendingChunks[0]! : Buffer.concat(pendingChunks, pendingBytes);
        if (!parseJsonlLine(lineBuf, cardsById)) {
          skipped += 1;
        }
      }
    }

    const after = fstatSync(fd, { bigint: true });
    if (
      !regularDescriptorSafe(after) ||
      !sameFilesystemIdentity(opened, after) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      return { earlyCoverage: { complete: false, reason: "read-race", skipped: 0 } };
    }
  } catch {
    return { earlyCoverage: { complete: false, reason: "read-race", skipped: 0 } };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort descriptor cleanup.
    }
  }

  const reason = sizeCapped ? "file-size-cap" : lineCapped ? "line-cap" : undefined;
  const complete = !sizeCapped && !lineCapped && skipped === 0;
  return {
    cardsById,
    coverage: reason ? { complete, reason, skipped } : { complete, skipped },
  };
}

function relativeWithinRoot(
  fileAbs: string,
  rootAbs: string,
  platform: NodeJS.Platform,
): { inside: boolean; rel?: string } {
  const fileNorm = normalizeAbsForPlatform(fileAbs, platform);
  const rootNorm = normalizeAbsForPlatform(rootAbs, platform);
  if (fileNorm === rootNorm) {
    return { inside: true };
  }
  const prefix = rootNorm.endsWith("/") ? rootNorm : `${rootNorm}/`;
  if (fileNorm.startsWith(prefix)) {
    const rel = fileNorm.slice(prefix.length);
    return rel.length > 0 ? { inside: true, rel } : { inside: true };
  }
  return { inside: false };
}

function buildTargetKeysForRepo(
  absFile: string,
  selectedRoot: string,
  platform: NodeJS.Platform,
): Set<string> {
  const keys = new Set<string>();
  const ordinary = relativeWithinRoot(absFile, selectedRoot, platform);
  if (ordinary.inside) {
    if (ordinary.rel) keys.add(ordinary.rel);
    return keys;
  }

  for (const fileReal of safeRealpath(absFile)) {
    const fallback = relativeWithinRoot(fileReal, selectedRoot, platform);
    if (fallback.inside && fallback.rel) {
      keys.add(fallback.rel);
    }
  }
  return keys;
}

function buildTargetKeysForNone(absFile: string, platform: NodeJS.Platform): Set<string> {
  const keys = new Set<string>();
  for (const candidate of [absFile, ...safeRealpath(absFile)]) {
    keys.add(normalizeAbsForPlatform(candidate, platform));
  }
  return keys;
}

function blockMatches(
  blockPath: string,
  inRepo: boolean,
  targetKeys: ReadonlySet<string>,
  platform: NodeJS.Platform,
): boolean {
  if (inRepo) {
    const normalized = normalizeRepoBlockPath(blockPath, platform);
    return normalized !== undefined && targetKeys.has(normalized);
  }

  const expanded = expandTilde(blockPath);
  if (!/^[a-zA-Z]:[\\/]/.test(expanded) && !expanded.startsWith("/") && !expanded.startsWith("\\")) {
    return false;
  }
  return targetKeys.has(normalizeAbsForPlatform(expanded, platform));
}

function compareCards(left: StoredCard, right: StoredCard): number {
  const leftTime = left.ended_ms ?? left.started_ms;
  const rightTime = right.ended_ms ?? right.started_ms;
  if (rightTime !== leftTime) return rightTime - leftTime;
  if (left.card_id < right.card_id) return -1;
  if (left.card_id > right.card_id) return 1;
  return 0;
}

/** Read the latest change cards touching `file`, ordered newest first. */
export function cardsForFile(file: string, options: CardsForFileOptions = {}): CardsForFile {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? resolveRockyPaths().home;
  const limit =
    options.limit === undefined || Number.isNaN(options.limit)
      ? DEFAULT_LIMIT
      : Math.max(0, Math.floor(options.limit));

  if (file.trim().length === 0) {
    return emptyResult({ complete: true, skipped: 0 });
  }

  const absFile = resolveInputPath(file, cwd, platform);
  const rootRaw = gitRootFor(absFile, existsSync);
  const inRepo = rootRaw !== undefined;

  let logPath: string;
  let lstat: ReturnType<typeof lstatSync>;
  let selectedRoot: string | undefined;

  if (inRepo) {
    const spellings = buildRootSpellings(rootRaw);
    const pick = pickExistingLogPath(spellings, home);
    if (pick.status === "missing") return emptyResult({ complete: true, skipped: 0 });
    if (pick.status === "non-regular") return emptyResult({ complete: false, skipped: 0 });
    if (pick.status === "race" || !pick.logPath || !pick.lstat || !pick.selectedRoot) {
      return emptyResult({ complete: false, reason: "read-race", skipped: 0 });
    }
    logPath = pick.logPath;
    lstat = pick.lstat;
    selectedRoot = pick.selectedRoot;
  } else {
    logPath = join(home, "desk", "cards", "_none.jsonl");
    const probe = inspectLogPath(logPath);
    if (probe.status === "missing") return emptyResult({ complete: true, skipped: 0 });
    if (probe.status === "non-regular") return emptyResult({ complete: false, skipped: 0 });
    if (probe.status === "race" || !probe.lstat) {
      return emptyResult({ complete: false, reason: "read-race", skipped: 0 });
    }
    lstat = probe.lstat;
  }

  const parsed = readAndParseCardsLog(logPath, lstat);
  if ("earlyCoverage" in parsed) {
    return emptyResult(parsed.earlyCoverage);
  }

  const targetKeys =
    selectedRoot !== undefined
      ? buildTargetKeysForRepo(absFile, selectedRoot, platform)
      : buildTargetKeysForNone(absFile, platform);

  const candidates: Array<{ card: StoredCard; blocks: StoredBlock[] }> = [];
  if (targetKeys.size > 0 && limit > 0) {
    for (const card of parsed.cardsById.values()) {
      const matchingBlocks = card.blocks.filter((block) => blockMatches(block.path, inRepo, targetKeys, platform));
      if (matchingBlocks.length > 0) {
        candidates.push({ card, blocks: matchingBlocks });
      }
    }
  }

  candidates.sort((left, right) => compareCards(left.card, right.card));
  const selected = candidates.slice(0, limit);

  const cards: StoredCard[] = [];
  const matched = new Map<string, StoredBlock[]>();
  for (const item of selected) {
    cards.push(item.card);
    matched.set(item.card.card_id, item.blocks);
  }

  return { cards, matched, coverage: parsed.coverage };
}
