import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { expandTilde, isPathInside, parseCardLine, type StoredCard } from "../desk/cards-record.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { cardsFilePath } from "./cards-path.js";

/**
 * Remove a purged repo's change-card blocks from every other card log.
 *
 * Card logs are append-only JSONL files written by the daemon, one per repo
 * (plus `_none.jsonl`). A card that touched files in two repos lives in the log
 * of the repo it was recorded under, so purging one repo must also scrub its
 * blocks and the flow steps that name them out of the other logs.
 *
 * What is edited: blocks whose path lies inside a purged root spelling, flow
 * steps that only refer to those blocks or whose text names such a path.
 * Everything else is left alone: lines that do not parse or validate are kept
 * byte for byte, and a log with nothing to remove is never rewritten.
 *
 * What is not edited: the prompt and the quotes of surviving blocks. They
 * belong to the other session's turn, not to the purged repo.
 *
 * Concurrency: no lock is taken because the daemon is not changed. A log is
 * read whole, the replacement is written to a temp file beside it, and the log
 * is re-stat'ed (size and mtime) right before the rename. A changed log is
 * re-read, at most three times. The window between that re-stat and the rename
 * is a known race: a line the daemon appends inside it is lost.
 */

export interface ScrubResult {
  ok: boolean;
  logsChanged: number;
  blocksRemoved: number;
  cardsRemoved: number;
  freedBytes: number;
  incomplete: string[];
}

export interface ScrubOptions {
  /** Rocky home that holds `desk/cards`. Also the home that `~/` expands to when given. */
  home?: string;
  platform?: NodeJS.Platform;
  /** Test seam: runs after the temp file is written and before the log is re-stat'ed. */
  hooks?: { beforeReplace?: (path: string) => void };
}

const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_READ_ATTEMPTS = 3;
const MAX_RENAME_RETRIES = 3;
const RENAME_WAIT_MS = 50;
const NEWLINE = 0x0a;
const RETRYABLE_REPLACE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

interface ScrubContext {
  roots: readonly string[];
  normalizedRoots: readonly string[];
  platform: NodeJS.Platform;
  pathHome: string;
  hooks: ScrubOptions["hooks"];
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

interface LineOutcome {
  /** Bytes to write back for this line, terminator included; empty when dropped. */
  bytes: Buffer;
  changed: boolean;
  blocksRemoved: number;
  cardDropped: boolean;
}

type LogOutcome =
  | { kind: "untouched" }
  | { kind: "stale" }
  | { kind: "replaced"; blocksRemoved: number; cardsRemoved: number; freedBytes: number };

function fold(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

/** Path-like text form: forward slashes, `~/` expanded, runs of slashes collapsed, case folded on win32. */
function normalizeText(value: string, platform: NodeJS.Platform, home: string): string {
  const homeDir = home.replace(/[\\/]+$/, "");
  const expanded = value.replace(/~[\\/]/g, `${homeDir}/`);
  return fold(expanded.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), platform);
}

function normalizeRoot(root: string, platform: NodeJS.Platform, home: string): string {
  return normalizeText(expandTilde(root, home), platform, home).replace(/\/+$/, "");
}

function textNamesRoot(text: string, normalizedRoots: readonly string[], platform: NodeJS.Platform, home: string): boolean {
  const haystack = normalizeText(text, platform, home);
  for (const root of normalizedRoots) {
    if (root === "") continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(root, from);
      if (at < 0) break;
      const next = haystack[at + root.length];
      if (next === undefined || next === "/") return true;
      from = at + 1;
    }
  }
  return false;
}

function blockIsInside(blockPath: string, ctx: ScrubContext): boolean {
  return ctx.roots.some((root) => isPathInside(blockPath, root, { platform: ctx.platform, home: ctx.pathHome }));
}

function keepLine(bytes: Buffer): LineOutcome {
  return { bytes, changed: false, blocksRemoved: 0, cardDropped: false };
}

function scrubCard(card: StoredCard, original: Buffer, ctx: ScrubContext): LineOutcome {
  const dropped = new Set<number>();
  const kept = card.blocks.filter((block) => {
    if (!blockIsInside(block.path, ctx)) return true;
    dropped.add(block.seq);
    return false;
  });
  const removed = card.blocks.length - kept.length;
  if (removed === 0) return keepLine(original);
  if (kept.length === 0) {
    return { bytes: Buffer.alloc(0), changed: true, blocksRemoved: removed, cardDropped: true };
  }
  card.blocks = kept;
  if (card.flow !== undefined) {
    card.flow = card.flow.filter((step) => {
      if (step.seqs.length > 0 && step.seqs.every((seq) => dropped.has(seq))) return false;
      return !textNamesRoot(step.text, ctx.normalizedRoots, ctx.platform, ctx.pathHome);
    });
  }
  return { bytes: Buffer.from(`${JSON.stringify(card)}\n`, "utf8"), changed: true, blocksRemoved: removed, cardDropped: false };
}

function scrubLine(lineBytes: Buffer, terminated: boolean, ctx: ScrubContext): LineOutcome {
  const original = terminated ? Buffer.concat([lineBytes, Buffer.from([NEWLINE])]) : lineBytes;
  if (lineBytes.length > MAX_LINE_BYTES) return keepLine(original);
  const parsed = parseCardLine(lineBytes);
  if (parsed.kind !== "card") return keepLine(original);
  return scrubCard(parsed.card, original, ctx);
}

function statStamp(path: string): FileStamp {
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Run a replace step, retrying a few times on Windows-style sharing errors. */
function withReplaceRetry(step: () => void): void {
  for (let retry = 0; ; retry += 1) {
    try {
      step();
      return;
    } catch (error) {
      const code = errorCode(error);
      if (retry >= MAX_RENAME_RETRIES || code === undefined || !RETRYABLE_REPLACE_CODES.has(code)) throw error;
      sleepSync(RENAME_WAIT_MS);
    }
  }
}

function writeTemp(logPath: string, content: Buffer): string {
  const tmpPath = `${logPath}.scrub-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < content.length) offset += writeSync(fd, content, offset, content.length - offset);
  } finally {
    closeSync(fd);
  }
  return tmpPath;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort: the temp file may never have been created.
  }
}

function hasContent(bytes: Buffer): boolean {
  return /\S/.test(bytes.toString("latin1"));
}

function scrubLogOnce(logPath: string, ctx: ScrubContext): LogOutcome {
  let before: FileStamp;
  let data: Buffer;
  try {
    before = statStamp(logPath);
    if (before.size > MAX_LOG_BYTES) throw Object.assign(new Error("log too large"), { code: "ETOOBIG" });
    data = readFileSync(logPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "untouched" };
    throw error;
  }
  const parts: Buffer[] = [];
  let changed = false;
  let blocksRemoved = 0;
  let cardsRemoved = 0;
  let start = 0;
  while (start < data.length) {
    const nl = data.indexOf(NEWLINE, start);
    const terminated = nl >= 0;
    const end = terminated ? nl : data.length;
    const outcome = scrubLine(data.subarray(start, end), terminated, ctx);
    parts.push(outcome.bytes);
    if (outcome.changed) changed = true;
    blocksRemoved += outcome.blocksRemoved;
    if (outcome.cardDropped) cardsRemoved += 1;
    start = end + 1;
  }
  if (!changed) return { kind: "untouched" };

  const output = Buffer.concat(parts);
  const deleteLog = !hasContent(output);
  const freedBytes = Math.max(0, data.length - (deleteLog ? 0 : output.length));
  let tmpPath: string | undefined;
  try {
    if (!deleteLog) tmpPath = writeTemp(logPath, output);
    ctx.hooks?.beforeReplace?.(logPath);
    let now: FileStamp | undefined;
    try {
      now = statStamp(logPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (now === undefined || !sameStamp(now, before) || data.length !== before.size) return { kind: "stale" };
    if (deleteLog) {
      withReplaceRetry(() => unlinkSync(logPath));
    } else {
      const source = tmpPath as string;
      withReplaceRetry(() => renameSync(source, logPath));
      tmpPath = undefined;
    }
    return { kind: "replaced", blocksRemoved, cardsRemoved, freedBytes };
  } finally {
    if (tmpPath !== undefined) removeQuietly(tmpPath);
  }
}

function ownLogNames(roots: readonly string[], home: string, platform: NodeJS.Platform): Set<string> {
  return new Set(roots.map((root) => fold(basename(cardsFilePath(root, home)), platform)));
}

export function scrubRepoCards(rootSpellings: readonly string[], options: ScrubOptions = {}): ScrubResult {
  const platform = options.platform ?? process.platform;
  const rockyHome = options.home ?? resolveRockyPaths().home;
  const pathHome = options.home ?? homedir();
  const ctx: ScrubContext = {
    roots: rootSpellings,
    normalizedRoots: rootSpellings.map((root) => normalizeRoot(root, platform, pathHome)),
    platform,
    pathHome,
    hooks: options.hooks,
  };
  const result: ScrubResult = { ok: true, logsChanged: 0, blocksRemoved: 0, cardsRemoved: 0, freedBytes: 0, incomplete: [] };
  const cardsDir = join(rockyHome, "desk", "cards");
  if (!existsSync(cardsDir)) return result;

  let names: string[];
  try {
    names = readdirSync(cardsDir).sort();
  } catch {
    return { ...result, ok: false };
  }
  const own = ownLogNames(rootSpellings, rockyHome, platform);
  for (const name of names) {
    if (!name.endsWith(".jsonl") || own.has(fold(name, platform))) continue;
    const logPath = join(cardsDir, name);
    try {
      if (!lstatSync(logPath).isFile()) {
        result.incomplete.push(logPath);
        continue;
      }
    } catch {
      result.incomplete.push(logPath);
      continue;
    }
    scrubLogWithRetry(logPath, ctx, result);
  }
  return result;
}

function scrubLogWithRetry(logPath: string, ctx: ScrubContext, result: ScrubResult): void {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    let outcome: LogOutcome;
    try {
      outcome = scrubLogOnce(logPath, ctx);
    } catch {
      result.incomplete.push(logPath);
      return;
    }
    if (outcome.kind === "stale") continue;
    if (outcome.kind === "replaced") {
      result.logsChanged += 1;
      result.blocksRemoved += outcome.blocksRemoved;
      result.cardsRemoved += outcome.cardsRemoved;
      result.freedBytes += outcome.freedBytes;
    }
    return;
  }
  result.incomplete.push(logPath);
}
