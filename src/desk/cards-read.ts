import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { gitRootFor } from "../core/compare-data.js";
import { NO_BLOCK_FLAG, NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "../core/fs-safety.js";
import { canonicalPath } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { cardsFilePath } from "../listening/cards-path.js";
import {
  expandTilde,
  isAbsOrTildeBlockPath,
  normalizeAbsForPlatform,
  normalizeRepoBlockPath,
  parseCardLine,
  type StoredBlock,
  type StoredCard,
  type StoredFlowStep,
} from "./cards-record.js";

const MAX_CARDS_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EXTRA_LOG_FILES = 64;
const MAX_TOTAL_CARDS_BYTES = 64 * 1024 * 1024;
const MAX_CARDS_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 5;

export type {
  StoredBashInfo,
  StoredBlock,
  StoredBlockSymbol,
  StoredCard,
  StoredCoverage,
  StoredFlowStep,
  StoredLabel,
  StoredQuote,
} from "./cards-record.js";

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

/** @internal Test-only signature for injecting `readSync` faults. */
export type CardsReadSyncHook = (
  fd: number,
  buffer: NodeJS.ArrayBufferView,
  offset: number,
  length: number,
  position: number | bigint | null,
) => number;

function emptyResult(coverage: CardsReadCoverage): CardsForFile {
  return { cards: [], matched: new Map(), coverage };
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
  bytesRead: number;
  hitBudget?: boolean;
}

interface MergedCardEntry {
  card: StoredCard;
  fromOwnRepo: boolean;
}

interface CoverageAccumulator {
  complete: boolean;
  skipped: number;
  reason?: CardsReadCoverage["reason"];
}

function addCoverage(acc: CoverageAccumulator, cov: CardsReadCoverage): void {
  if (!cov.complete) {
    acc.complete = false;
    if (acc.reason === undefined && cov.reason !== undefined) {
      acc.reason = cov.reason;
    }
  }
  acc.skipped += cov.skipped;
}

function mergeParsedCards(
  merged: Map<string, MergedCardEntry>,
  parsed: ReadonlyMap<string, StoredCard>,
  fromOwnRepo: boolean,
): void {
  for (const [cardId, card] of parsed) {
    const existing = merged.get(cardId);
    if (!existing || card.rev >= existing.card.rev) {
      merged.set(cardId, { card, fromOwnRepo });
    }
  }
}

function finalizeCoverage(acc: CoverageAccumulator): CardsReadCoverage {
  if (acc.complete && acc.skipped === 0) {
    return { complete: true, skipped: 0 };
  }
  return acc.reason !== undefined
    ? { complete: false, reason: acc.reason, skipped: acc.skipped }
    : { complete: false, skipped: acc.skipped };
}

function normalizeFileKey(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toLowerCase() : name;
}

function listExtraCardLogs(
  home: string,
  excludedNames: ReadonlySet<string>,
  platform: NodeJS.Platform,
): { status: "missing" | "non-regular" | "race" | "ready"; cardsDir: string; files: string[] } {
  const cardsDir = join(home, "desk", "cards");
  try {
    const stats = lstatSync(cardsDir, { bigint: true });
    if (!stats.isDirectory()) {
      return { status: "non-regular", cardsDir, files: [] };
    }
    const files = readdirSync(cardsDir)
      .filter((name) => name.endsWith(".jsonl") && !excludedNames.has(normalizeFileKey(name, platform)))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { status: "ready", cardsDir, files };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "missing", cardsDir, files: [] };
    }
    return { status: "race", cardsDir, files: [] };
  }
}

function parseJsonlLine(
  lineBuf: Buffer,
  cardsById: Map<string, StoredCard>,
): boolean {
  const line = parseCardLine(lineBuf);
  if (line.kind === "blank") return true;
  if (line.kind === "invalid") return false;
  const parsed = line.card;
  const existing = cardsById.get(parsed.card_id);
  if (!existing || parsed.rev >= existing.rev) {
    cardsById.set(parsed.card_id, parsed);
  }
  return true;
}

function readAndParseCardsLog(
  logPath: string,
  expectedLstat: ReturnType<typeof lstatSync>,
  remainingBudgetBytes: number,
  readBytes: CardsReadSyncHook = readSync,
): ParsedLogResult {
  const cardsById = new Map<string, StoredCard>();
  let fd: number;
  try {
    fd = openSync(logPath, constants.O_RDONLY | NO_FOLLOW_FLAG | NO_BLOCK_FLAG);
  } catch {
    return { cardsById, coverage: { complete: false, reason: "read-race", skipped: 0 }, bytesRead: 0 };
  }

  let sizeCapped = false;
  let lineCapped = false;
  let readRace = false;
  let skipped = 0;
  let totalReadFromFile = 0;

  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(expectedLstat, opened)) {
      return { cardsById, coverage: { complete: false, reason: "read-race", skipped: 0 }, bytesRead: totalReadFromFile };
    }

    const totalBytesBig = opened.size;
    const capBytesBig = BigInt(MAX_CARDS_FILE_BYTES);
    sizeCapped = totalBytesBig > capBytesBig;
    // Account for the 1-byte preceding-newline probe when tail-reading capped logs.
    const plannedReadBig = sizeCapped ? capBytesBig + 1n : totalBytesBig;
    if (plannedReadBig > BigInt(Math.max(0, remainingBudgetBytes))) {
      return {
        cardsById,
        coverage: { complete: false, reason: "file-size-cap", skipped: 0 },
        bytesRead: totalReadFromFile,
        hitBudget: true,
      };
    }

    let pos = sizeCapped ? totalBytesBig - capBytesBig : 0n;

    const readBuf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let skippingPartialFirstLine = false;
    if (sizeCapped) {
      const prevByte = Buffer.allocUnsafe(1);
      const prevBytesRead = readBytes(fd, prevByte, 0, 1, pos - 1n);
      if (prevBytesRead > 0) {
        totalReadFromFile += prevBytesRead;
      }
      if (prevBytesRead !== 1) {
        return {
          cardsById,
          coverage: { complete: false, reason: "read-race", skipped: 0 },
          bytesRead: totalReadFromFile,
        };
      }
      skippingPartialFirstLine = prevByte[0] !== 0x0a;
    }
    let droppingLongLine = false;
    let stoppedAtBudget = false;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;

    while (pos < totalBytesBig) {
      const remaining = totalBytesBig - pos;
      const budgetRemaining = Math.max(0, remainingBudgetBytes - totalReadFromFile);
      if (budgetRemaining === 0) {
        sizeCapped = true;
        stoppedAtBudget = true;
        break;
      }
      const chunkMax = Math.min(READ_CHUNK_BYTES, budgetRemaining);
      const toRead = remaining < BigInt(chunkMax) ? Number(remaining) : chunkMax;
      const bytesRead = readBytes(fd, readBuf, 0, toRead, pos);
      if (bytesRead <= 0) {
        readRace = true;
        break;
      }
      totalReadFromFile += bytesRead;
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

    if (!readRace && !stoppedAtBudget && !skippingPartialFirstLine && !droppingLongLine && pendingBytes > 0) {
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
      readRace = true;
    }
  } catch {
    readRace = true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort descriptor cleanup.
    }
  }

  const reason = readRace ? "read-race" : sizeCapped ? "file-size-cap" : lineCapped ? "line-cap" : undefined;
  const complete = !readRace && !sizeCapped && !lineCapped && skipped === 0;
  return {
    cardsById,
    coverage: reason ? { complete, reason, skipped } : { complete, skipped },
    bytesRead: totalReadFromFile,
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
  fromOwnRepo: boolean,
  repoTargetKeys: ReadonlySet<string>,
  absTargetKeys: ReadonlySet<string>,
  platform: NodeJS.Platform,
): boolean {
  if (isAbsOrTildeBlockPath(blockPath)) {
    const expanded = expandTilde(blockPath);
    return absTargetKeys.has(normalizeAbsForPlatform(expanded, platform));
  }

  if (!fromOwnRepo) {
    return false;
  }
  const normalized = normalizeRepoBlockPath(blockPath, platform);
  return normalized !== undefined && repoTargetKeys.has(normalized);
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
  return cardsForFileInternal(file, options, readSync);
}

/** @internal Test-only entry point for injecting `readSync` faults. */
export function cardsForFileForTest(
  file: string,
  options: CardsForFileOptions = {},
  readBytes: CardsReadSyncHook = readSync,
): CardsForFile {
  return cardsForFileInternal(file, options, readBytes);
}

function cardsForFileInternal(
  file: string,
  options: CardsForFileOptions,
  readBytes: CardsReadSyncHook,
): CardsForFile {
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

  const merged = new Map<string, MergedCardEntry>();
  const covAcc: CoverageAccumulator = { complete: true, skipped: 0 };
  const excludedNames = new Set<string>();
  let totalBytesRead = 0;
  let selectedRoot: string | undefined;

  if (inRepo) {
    const spellings = buildRootSpellings(rootRaw);
    const pick = pickExistingLogPath(spellings, home);
    if (pick.logPath) {
      excludedNames.add(normalizeFileKey(basename(pick.logPath), platform));
    }
    if (pick.status === "non-regular") {
      addCoverage(covAcc, { complete: false, skipped: 0 });
    } else if (pick.status === "race") {
      addCoverage(covAcc, { complete: false, reason: "read-race", skipped: 0 });
    } else if (pick.status === "ready") {
      if (!pick.logPath || !pick.lstat || !pick.selectedRoot) {
        addCoverage(covAcc, { complete: false, reason: "read-race", skipped: 0 });
      } else {
        selectedRoot = pick.selectedRoot;
        const parsed = readAndParseCardsLog(pick.logPath, pick.lstat, MAX_TOTAL_CARDS_BYTES - totalBytesRead, readBytes);
        totalBytesRead += parsed.bytesRead;
        mergeParsedCards(merged, parsed.cardsById, true);
        addCoverage(covAcc, parsed.coverage);
      }
    }
  } else {
    const nonePath = join(home, "desk", "cards", "_none.jsonl");
    const probe = inspectLogPath(nonePath);
    if (probe.status !== "missing") {
      excludedNames.add(normalizeFileKey("_none.jsonl", platform));
    }
    if (probe.status === "non-regular") {
      addCoverage(covAcc, { complete: false, skipped: 0 });
    } else if (probe.status === "race") {
      addCoverage(covAcc, { complete: false, reason: "read-race", skipped: 0 });
    } else if (probe.status === "ready") {
      if (!probe.lstat) {
        addCoverage(covAcc, { complete: false, reason: "read-race", skipped: 0 });
      } else {
        const parsed = readAndParseCardsLog(nonePath, probe.lstat, MAX_TOTAL_CARDS_BYTES - totalBytesRead, readBytes);
        totalBytesRead += parsed.bytesRead;
        mergeParsedCards(merged, parsed.cardsById, false);
        addCoverage(covAcc, parsed.coverage);
      }
    }
  }

  const listing = listExtraCardLogs(home, excludedNames, platform);
  if (listing.status === "non-regular") {
    addCoverage(covAcc, { complete: false, skipped: 0 });
  } else if (listing.status === "race") {
    addCoverage(covAcc, { complete: false, reason: "read-race", skipped: 0 });
  } else if (listing.status === "ready") {
    let extraScanned = 0;
    for (const name of listing.files) {
      if (extraScanned >= MAX_EXTRA_LOG_FILES) {
        addCoverage(covAcc, { complete: false, reason: "file-size-cap", skipped: 0 });
        break;
      }
      const extraPath = join(listing.cardsDir, name);
      const probe = inspectLogPath(extraPath);
      if (probe.status === "missing") continue;
      extraScanned += 1;
      if (probe.status === "non-regular") {
        addCoverage(covAcc, { complete: false, skipped: 0 });
        continue;
      }
      if (probe.status === "race" || !probe.lstat) {
        addCoverage(covAcc, { complete: false, reason: "read-race", skipped: 0 });
        continue;
      }
      if (totalBytesRead >= MAX_TOTAL_CARDS_BYTES) {
        addCoverage(covAcc, { complete: false, reason: "file-size-cap", skipped: 0 });
        break;
      }
      const parsed = readAndParseCardsLog(extraPath, probe.lstat, MAX_TOTAL_CARDS_BYTES - totalBytesRead, readBytes);
      totalBytesRead += parsed.bytesRead;
      if (parsed.hitBudget) {
        addCoverage(covAcc, { complete: false, reason: "file-size-cap", skipped: 0 });
        break;
      }
      mergeParsedCards(merged, parsed.cardsById, false);
      addCoverage(covAcc, parsed.coverage);
    }
  }

  const absTargetKeys = buildTargetKeysForNone(absFile, platform);
  const repoTargetKeys =
    selectedRoot !== undefined ? buildTargetKeysForRepo(absFile, selectedRoot, platform) : new Set<string>();

  const candidates: Array<{ card: StoredCard; blocks: StoredBlock[] }> = [];
  if (limit > 0 && (absTargetKeys.size > 0 || repoTargetKeys.size > 0)) {
    for (const entry of merged.values()) {
      const matchingBlocks = entry.card.blocks.filter((block) =>
        blockMatches(block.path, entry.fromOwnRepo, repoTargetKeys, absTargetKeys, platform),
      );
      if (matchingBlocks.length > 0) {
        candidates.push({ card: entry.card, blocks: matchingBlocks });
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

  return { cards, matched, coverage: finalizeCoverage(covAcc) };
}

export interface CardsForRoot {
  cards: StoredCard[];
  complete: boolean;
}

/** False when `<home>/desk/tool-text-off` exists. */
export function toolTextAllowed(home: string): boolean {
  return !existsSync(join(home, "desk", "tool-text-off"));
}

function stripBlockToolText(block: StoredBlock): StoredBlock {
  const copy = { ...block };
  delete copy.quote;
  return copy;
}

function stripStepToolText(step: StoredFlowStep): StoredFlowStep {
  const copy = { ...step };
  delete copy.desc;
  return copy;
}

function stripCardToolText(card: StoredCard): StoredCard {
  const copy: StoredCard = {
    ...card,
    blocks: card.blocks.map(stripBlockToolText),
  };
  if (card.flow !== undefined) {
    copy.flow = card.flow.map(stripStepToolText);
  }
  return copy;
}

function readProbedLog(
  logPath: string | undefined,
  status: "missing" | "non-regular" | "race" | "ready",
  lstat: ReturnType<typeof lstatSync> | undefined,
  covAcc: CoverageAccumulator,
): Map<string, StoredCard> {
  if (status === "missing") return new Map();
  if (status === "non-regular") {
    addCoverage(covAcc, { complete: false, skipped: 0 });
    return new Map();
  }
  if (status === "race" || !logPath || !lstat) {
    addCoverage(covAcc, { complete: false, reason: "read-race", skipped: 0 });
    return new Map();
  }
  const parsed = readAndParseCardsLog(logPath, lstat, MAX_TOTAL_CARDS_BYTES);
  addCoverage(covAcc, parsed.coverage);
  return parsed.cardsById;
}

/** @internal Resolve the git root for a directory `cwd` without trimming or collapsing Windows drive roots. */
export function resolveGitRootForCwd(
  cwd: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (cwd.length === 0) return undefined;
  const resolvedCwd = resolve(cwd);
  const rootRaw = gitRootFor(join(resolvedCwd, "_"), exists);
  if (rootRaw === undefined) return undefined;
  return /^[a-zA-Z]:$/.test(rootRaw) ? `${rootRaw}/` : rootRaw;
}

/** Cards logged for the repo that contains `cwd` (or `_none.jsonl` outside a repo). */
export function cardsForRoot(cwd: string, options: { home: string; toolText: boolean }): CardsForRoot {
  const rootRaw = resolveGitRootForCwd(cwd, existsSync);
  const covAcc: CoverageAccumulator = { complete: true, skipped: 0 };
  let cardsById: Map<string, StoredCard>;
  if (rootRaw !== undefined) {
    const pick = pickExistingLogPath(buildRootSpellings(rootRaw), options.home);
    cardsById = readProbedLog(pick.logPath, pick.status, pick.lstat, covAcc);
  } else {
    const nonePath = join(options.home, "desk", "cards", "_none.jsonl");
    const probe = inspectLogPath(nonePath);
    cardsById = readProbedLog(nonePath, probe.status, probe.lstat, covAcc);
  }
  const ordered = [...cardsById.values()].sort(compareCards);
  const cards = options.toolText ? ordered : ordered.map(stripCardToolText);
  return { cards, complete: finalizeCoverage(covAcc).complete };
}

/** Highest revision of `cardId` across all card logs, bounded like `cardsForFile`. */
export function findCardById(cardId: string, options: { home: string; toolText: boolean }): StoredCard | undefined {
  if (cardId.length === 0) return undefined;
  const listing = listExtraCardLogs(options.home, new Set(), process.platform);
  if (listing.status !== "ready") return undefined;

  let scanned = 0;
  let totalBytesRead = 0;
  let best: StoredCard | undefined;
  for (const name of listing.files) {
    if (scanned >= MAX_EXTRA_LOG_FILES) break;
    const logPath = join(listing.cardsDir, name);
    const probe = inspectLogPath(logPath);
    if (probe.status === "missing") continue;
    scanned += 1;
    if (probe.status !== "ready" || !probe.lstat) continue;
    if (totalBytesRead >= MAX_TOTAL_CARDS_BYTES) break;
    const parsed = readAndParseCardsLog(logPath, probe.lstat, MAX_TOTAL_CARDS_BYTES - totalBytesRead);
    totalBytesRead += parsed.bytesRead;
    if (parsed.hitBudget) break;
    const found = parsed.cardsById.get(cardId);
    if (found && (!best || found.rev >= best.rev)) {
      best = found;
    }
  }
  if (best === undefined) return undefined;
  return options.toolText ? best : stripCardToolText(best);
}
