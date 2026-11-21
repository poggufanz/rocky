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
import { expandTilde, isPathInside, parseCardLine, type StoredCard, type StoredFlowStep } from "../desk/cards-record.js";
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
 * steps that only refer to those blocks or whose text, error, cwd, or desc names such a path,
 * and card `sequence` when any `edit_seqs` entry belongs to a dropped block or
 * `sequence.command` / `sequence.error_names` names such a path.
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
  /** Plain-words reason per incomplete log path. */
  incompleteReasons: Record<string, string>;
}

export interface ScrubOptions {
  /** Rocky home that holds `desk/cards`. */
  rockyHome?: string;
  /** The home that `~/` expands to. Default: the OS home directory. */
  userHome?: string;
  platform?: NodeJS.Platform;
  /** Test seam: runs after the temp file is written and before the log is re-stat'ed. */
  hooks?: {
    beforeReplace?: (path: string) => void;
    /** Test seam: runs after a full pass over the logs (1) and after the re-scrub of restored logs (2). */
    afterPass?: (pass: 1 | 2) => void;
    /** Test seam: replaces the file operations used to write, replace and clean up. */
    fsOps?: Partial<ScrubFsOps>;
  };
}

export interface ScrubFsOps {
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  closeSync: typeof closeSync;
  unlinkSync: typeof unlinkSync;
  renameSync: typeof renameSync;
}

const REAL_FS_OPS: ScrubFsOps = { openSync, writeSync, closeSync, unlinkSync, renameSync };

const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_READ_ATTEMPTS = 3;
const MAX_RENAME_RETRIES = 3;
const RENAME_WAIT_MS = 50;
const NEWLINE = 0x0a;
const STALE_TEMP_MS = 10 * 60 * 1000;
const SCRUB_TEMP_PATTERN = /\.scrub-[^/\\]*\.tmp$/;
const OPAQUE_REASON = "A line in this log could not be read and may name the repo.";
const STUCK_REASON = "Blocks about the repo kept coming back after the scrub.";
const FAILED_REASON = "The log could not be scrubbed.";
const RETRYABLE_REPLACE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

interface ScrubContext {
  roots: readonly string[];
  normalizedRoots: readonly string[];
  platform: NodeJS.Platform;
  pathHome: string;
  /** Normalized card roots and main roots found in the logs (nested-repo markers). */
  knownRoots: Set<string>;
  /** Directory -> contains `.git` or is a known card root. */
  nestedCache: Map<string, boolean>;
  /** Raw-byte needles for lines kept verbatim, case folded on win32. */
  opaqueNeedles: readonly string[];
  hooks: ScrubOptions["hooks"];
  fsOps: ScrubFsOps;
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

const BOUNDARY_PREV = /[\s"'=(,;]/;

function isDriveColon(haystack: string, colonAt: number): boolean {
  if (haystack[colonAt] !== ":" || colonAt < 1 || !/[a-z]/i.test(haystack[colonAt - 1] ?? "")) return false;
  return colonAt < 2 || !/[a-z0-9_]/i.test(haystack[colonAt - 2] ?? "");
}

function startsAtBoundary(haystack: string, at: number, root: string): boolean {
  if (at === 0 || /^[a-z]:/i.test(root)) return true;
  const prev = haystack[at - 1] ?? "";
  if (BOUNDARY_PREV.test(prev)) return true;
  return prev === ":" && !isDriveColon(haystack, at - 1);
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
      if ((next === undefined || next === "/") && startsAtBoundary(haystack, at, root)) return true;
      from = at + 1;
    }
  }
  return false;
}

function hasGitEntry(dir: string): boolean {
  try {
    lstatSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** A directory is a nested repo when it has a `.git` entry now or is the root of a known card. A failed stat means no. */
function isNestedRepoDir(dir: string, ctx: ScrubContext): boolean {
  const cached = ctx.nestedCache.get(dir);
  if (cached !== undefined) return cached;
  const nested = ctx.knownRoots.has(dir) || hasGitEntry(dir);
  ctx.nestedCache.set(dir, nested);
  return nested;
}

/** True when a directory strictly below the purged root, up to the block's parent, is a nested repo. */
function underNestedRepo(blockPath: string, rootNorm: string, ctx: ScrubContext): boolean {
  const norm = normalizeText(blockPath, ctx.platform, ctx.pathHome);
  for (let at = norm.indexOf("/", rootNorm.length + 1); at >= 0; at = norm.indexOf("/", at + 1)) {
    const dir = norm.slice(0, at);
    if (dir.length > rootNorm.length && isNestedRepoDir(dir, ctx)) return true;
  }
  return false;
}

function blockIsInside(blockPath: string, ctx: ScrubContext): boolean {
  return ctx.roots.some((root, index) => {
    if (!isPathInside(blockPath, root, { platform: ctx.platform, home: ctx.pathHome })) return false;
    return !underNestedRepo(blockPath, ctx.normalizedRoots[index] ?? "", ctx);
  });
}

function keepLine(bytes: Buffer): LineOutcome {
  return { bytes, changed: false, blocksRemoved: 0, cardDropped: false };
}

function sequenceShouldDrop(card: StoredCard, dropped: ReadonlySet<number>, ctx: ScrubContext): boolean {
  const seq = card.sequence;
  if (seq === undefined || seq === null) return false;
  if (seq.edit_seqs.some((editSeq) => dropped.has(editSeq))) return true;
  if (textNamesRoot(seq.command, ctx.normalizedRoots, ctx.platform, ctx.pathHome)) return true;
  if (typeof seq.error_names === "string" && textNamesRoot(seq.error_names, ctx.normalizedRoots, ctx.platform, ctx.pathHome)) {
    return true;
  }
  return false;
}

function stepNamesRoot(step: StoredFlowStep, ctx: ScrubContext): boolean {
  const { normalizedRoots, platform, pathHome } = ctx;
  if (textNamesRoot(step.text, normalizedRoots, platform, pathHome)) return true;
  if (typeof step.error === "string" && textNamesRoot(step.error, normalizedRoots, platform, pathHome)) {
    return true;
  }
  const extra = step as { cwd?: unknown; desc?: unknown };
  if (typeof extra.cwd === "string" && textNamesRoot(extra.cwd, normalizedRoots, platform, pathHome)) {
    return true;
  }
  if (typeof extra.desc === "string" && textNamesRoot(extra.desc, normalizedRoots, platform, pathHome)) {
    return true;
  }
  return false;
}

function scrubCard(card: StoredCard, original: Buffer, ctx: ScrubContext): LineOutcome {
  const dropped = new Set<number>();
  const kept = card.blocks.filter((block) => {
    if (!blockIsInside(block.path, ctx)) return true;
    dropped.add(block.seq);
    return false;
  });
  const removed = card.blocks.length - kept.length;
  const dropSequence = sequenceShouldDrop(card, dropped, ctx);
  if (removed === 0 && !dropSequence) return keepLine(original);
  if (kept.length === 0 && removed > 0) {
    return { bytes: Buffer.alloc(0), changed: true, blocksRemoved: removed, cardDropped: true };
  }
  card.blocks = kept;
  if (removed > 0 && card.flow !== undefined) {
    card.flow = card.flow.filter((step) => {
      if (step.seqs.length > 0 && step.seqs.every((seq) => dropped.has(seq))) return false;
      return !stepNamesRoot(step, ctx);
    });
  }
  if (dropSequence) {
    delete card.sequence;
  }
  return { bytes: Buffer.from(`${JSON.stringify(card)}\n`, "utf8"), changed: true, blocksRemoved: removed, cardDropped: false };
}

function namesRootRaw(bytes: Buffer, ctx: ScrubContext): boolean {
  const text = fold(bytes.toString("utf8"), ctx.platform);
  return ctx.opaqueNeedles.some((needle) => needle !== "" && text.includes(needle));
}

function scrubLine(lineBytes: Buffer, terminated: boolean, ctx: ScrubContext, state: LogState): LineOutcome {
  const original = terminated ? Buffer.concat([lineBytes, Buffer.from([NEWLINE])]) : lineBytes;
  const parsed = lineBytes.length > MAX_LINE_BYTES ? undefined : parseCardLine(lineBytes);
  if (parsed === undefined || parsed.kind !== "card") {
    if (namesRootRaw(lineBytes, ctx)) state.opaqueMentions = true;
    return keepLine(original);
  }
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

function stampOrUndefined(path: string): FileStamp | undefined {
  try {
    return statStamp(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function isUnchanged(path: string, before: FileStamp): boolean {
  const now = stampOrUndefined(path);
  return now !== undefined && sameStamp(now, before);
}

/**
 * Run a replace step, retrying a few times on Windows-style sharing errors.
 * The log is re-stat'ed after every wait, so a retry never acts on a stale snapshot:
 * returns "stale" when the log changed and the caller must read it again.
 */
function replaceWithRetry(step: () => void, logPath: string, before: FileStamp): "done" | "stale" {
  for (let retry = 0; ; retry += 1) {
    try {
      step();
      return "done";
    } catch (error) {
      const code = errorCode(error);
      if (retry >= MAX_RENAME_RETRIES || code === undefined || !RETRYABLE_REPLACE_CODES.has(code)) throw error;
      sleepSync(RENAME_WAIT_MS);
      if (!isUnchanged(logPath, before)) return "stale";
    }
  }
}

function tempName(logPath: string): string {
  return `${logPath}.scrub-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
}

/** Create the temp file and write it. `onCreated` hands over ownership of the name as soon as it exists. */
function writeTemp(tmpPath: string, content: Buffer, ops: ScrubFsOps, onCreated: () => void): void {
  const fd = ops.openSync(tmpPath, "wx", 0o600);
  onCreated();
  try {
    let offset = 0;
    while (offset < content.length) offset += ops.writeSync(fd, content, offset, content.length - offset);
  } finally {
    ops.closeSync(fd);
  }
}

/** Remove a temp file, retrying transient errors. Returns false when it may still exist. */
function removeTemp(path: string, ops: ScrubFsOps): boolean {
  for (let retry = 0; ; retry += 1) {
    try {
      ops.unlinkSync(path);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return true;
      if (retry >= MAX_RENAME_RETRIES || code === undefined || !RETRYABLE_REPLACE_CODES.has(code)) return false;
      sleepSync(RENAME_WAIT_MS);
    }
  }
}

/** A log is empty only when every kept line has zero bytes; opaque lines are never judged by content. */
function hasContent(bytes: Buffer): boolean {
  return bytes.some((byte) => byte !== NEWLINE);
}

interface LogState {
  /** Set when a temp file could not be removed and may still hold superseded data. */
  leakedTemp: boolean;
  /** Set when a line kept verbatim contains a root spelling, for the latest read. */
  opaqueMentions: boolean;
}

function scrubLogOnce(logPath: string, ctx: ScrubContext, state: LogState): LogOutcome {
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
  state.opaqueMentions = false;
  const parts: Buffer[] = [];
  let changed = false;
  let blocksRemoved = 0;
  let cardsRemoved = 0;
  let start = 0;
  while (start < data.length) {
    const nl = data.indexOf(NEWLINE, start);
    const terminated = nl >= 0;
    const end = terminated ? nl : data.length;
    const outcome = scrubLine(data.subarray(start, end), terminated, ctx, state);
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
    if (!deleteLog) {
      const name = tempName(logPath);
      writeTemp(name, output, ctx.fsOps, () => {
        tmpPath = name;
      });
    }
    ctx.hooks?.beforeReplace?.(logPath);
    if (!isUnchanged(logPath, before) || data.length !== before.size) return { kind: "stale" };
    let replaced: "done" | "stale";
    if (deleteLog) {
      replaced = replaceWithRetry(() => ctx.fsOps.unlinkSync(logPath), logPath, before);
    } else {
      const source = tmpPath as string;
      replaced = replaceWithRetry(() => ctx.fsOps.renameSync(source, logPath), logPath, before);
      if (replaced === "done") tmpPath = undefined;
    }
    if (replaced === "stale") return { kind: "stale" };
    return { kind: "replaced", blocksRemoved, cardsRemoved, freedBytes };
  } finally {
    if (tmpPath !== undefined && !removeTemp(tmpPath, ctx.fsOps)) state.leakedTemp = true;
  }
}

function ownLogNames(roots: readonly string[], home: string, platform: NodeJS.Platform): Set<string> {
  return new Set(roots.map((root) => fold(basename(cardsFilePath(root, home)), platform)));
}

function opaqueNeedles(roots: readonly string[], platform: NodeJS.Platform): string[] {
  const needles = new Set<string>();
  for (const root of roots) {
    const trimmed = root.replace(/[\\/]+$/, "");
    needles.add(trimmed);
    needles.add(trimmed.replace(/\\/g, "/"));
    needles.add(JSON.stringify(trimmed).slice(1, -1));
  }
  return [...needles].filter((needle) => needle !== "").map((needle) => fold(needle, platform));
}

/** Delete scrub temp files left behind by an interrupted run. Regular files only. */
function sweepStaleTemps(cardsDir: string, names: readonly string[]): void {
  const cutoff = Date.now() - STALE_TEMP_MS;
  for (const name of names) {
    if (!SCRUB_TEMP_PATTERN.test(name)) continue;
    const path = join(cardsDir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && stat.mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // A temp file that cannot be removed now is swept by a later run.
    }
  }
}

function forEachCardLine(logPath: string, visit: (card: StoredCard) => boolean | void): void {
  const data = readFileSync(logPath);
  let start = 0;
  while (start < data.length) {
    const nl = data.indexOf(NEWLINE, start);
    const end = nl >= 0 ? nl : data.length;
    if (end - start <= MAX_LINE_BYTES) {
      const parsed = parseCardLine(data.subarray(start, end));
      if (parsed.kind === "card" && visit(parsed.card) === true) return;
    }
    start = end + 1;
  }
}

/** First pass: remember every card root so a directory that other cards treat as a repo counts as nested. */
function collectKnownRoots(cardsDir: string, logNames: readonly string[], ctx: ScrubContext): void {
  for (const name of logNames) {
    const path = join(cardsDir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_LOG_BYTES) continue;
      forEachCardLine(path, (card) => {
        for (const root of [card.root, card.main_root]) {
          if (typeof root !== "string" || root === "") continue;
          ctx.knownRoots.add(normalizeRoot(root, ctx.platform, ctx.pathHome));
        }
      });
    } catch {
      // An unreadable log adds no markers; the scrub pass reports it.
    }
  }
}

/** True when a card still names the purged root via blocks inside it or a sequence referencing it. */
function cardStillNamesRoot(card: StoredCard, ctx: ScrubContext): boolean {
  const dropped = new Set<number>();
  for (const block of card.blocks) {
    if (blockIsInside(block.path, ctx)) dropped.add(block.seq);
  }
  return dropped.size > 0 || sequenceShouldDrop(card, dropped, ctx);
}

/** True when any card in the log still names the purged root, or the log cannot be checked. */
function logStillNamesRoot(logPath: string, ctx: ScrubContext): boolean {
  try {
    let present = false;
    forEachCardLine(logPath, (card) => {
      present = cardStillNamesRoot(card, ctx);
      return present;
    });
    return present;
  } catch (error) {
    return errorCode(error) !== "ENOENT";
  }
}

function addIncomplete(result: ScrubResult, path: string, reason: string): void {
  if (!result.incomplete.includes(path)) result.incomplete.push(path);
  if (result.incompleteReasons[path] === undefined) result.incompleteReasons[path] = reason;
}

export function scrubRepoCards(rootSpellings: readonly string[], options: ScrubOptions = {}): ScrubResult {
  const platform = options.platform ?? process.platform;
  const rockyHome = options.rockyHome ?? resolveRockyPaths().home;
  const pathHome = options.userHome ?? homedir();
  const ctx: ScrubContext = {
    roots: rootSpellings,
    normalizedRoots: rootSpellings.map((root) => normalizeRoot(root, platform, pathHome)),
    platform,
    pathHome,
    knownRoots: new Set<string>(),
    nestedCache: new Map<string, boolean>(),
    opaqueNeedles: opaqueNeedles(rootSpellings, platform),
    hooks: options.hooks,
    fsOps: { ...REAL_FS_OPS, ...options.hooks?.fsOps },
  };
  const result: ScrubResult = {
    ok: true,
    logsChanged: 0,
    blocksRemoved: 0,
    cardsRemoved: 0,
    freedBytes: 0,
    incomplete: [],
    incompleteReasons: {},
  };
  const cardsDir = join(rockyHome, "desk", "cards");
  if (!existsSync(cardsDir)) return result;

  let names: string[];
  try {
    names = readdirSync(cardsDir).sort();
  } catch {
    return { ...result, ok: false };
  }
  sweepStaleTemps(cardsDir, names);
  const own = ownLogNames(rootSpellings, rockyHome, platform);
  const logNames = names.filter((name) => name.endsWith(".jsonl") && !own.has(fold(name, platform)));
  collectKnownRoots(cardsDir, logNames, ctx);

  const changed = new Set<string>();
  for (const name of logNames) {
    const logPath = join(cardsDir, name);
    try {
      if (!lstatSync(logPath).isFile()) {
        addIncomplete(result, logPath, FAILED_REASON);
        continue;
      }
    } catch {
      addIncomplete(result, logPath, FAILED_REASON);
      continue;
    }
    if (scrubLogWithRetry(logPath, ctx, result)) changed.add(logPath);
  }
  verifyChangedLogs(changed, ctx, result);
  result.logsChanged = changed.size;
  return result;
}

/**
 * A daemon rotation (read, write a temp file, rename) can put pre-scrub content
 * back. Re-read each changed log once, scrub once more if purged data came back,
 * and report the log if it is still there.
 */
function verifyChangedLogs(changed: ReadonlySet<string>, ctx: ScrubContext, result: ScrubResult): void {
  ctx.hooks?.afterPass?.(1);
  const restored = [...changed].filter((path) => logStillNamesRoot(path, ctx));
  if (restored.length === 0) return;
  for (const path of restored) scrubLogWithRetry(path, ctx, result);
  ctx.hooks?.afterPass?.(2);
  for (const path of restored) {
    if (logStillNamesRoot(path, ctx)) addIncomplete(result, path, STUCK_REASON);
  }
}

/** Returns true when the log was rewritten or deleted. */
function scrubLogWithRetry(logPath: string, ctx: ScrubContext, result: ScrubResult): boolean {
  const state: LogState = { leakedTemp: false, opaqueMentions: false };
  const attempt = runScrubAttempts(logPath, ctx, result, state);
  // A temp that could not be removed may hold superseded data: never report that as clean.
  if (!attempt.finished || state.leakedTemp) addIncomplete(result, logPath, FAILED_REASON);
  else if (state.opaqueMentions) addIncomplete(result, logPath, OPAQUE_REASON);
  return attempt.replaced;
}

/** `finished` is false when the log could not be scrubbed completely. */
function runScrubAttempts(
  logPath: string,
  ctx: ScrubContext,
  result: ScrubResult,
  state: LogState,
): { finished: boolean; replaced: boolean } {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    let outcome: LogOutcome;
    try {
      outcome = scrubLogOnce(logPath, ctx, state);
    } catch {
      return { finished: false, replaced: false };
    }
    if (outcome.kind === "stale") continue;
    if (outcome.kind === "replaced") {
      result.blocksRemoved += outcome.blocksRemoved;
      result.cardsRemoved += outcome.cardsRemoved;
      result.freedBytes += outcome.freedBytes;
      return { finished: true, replaced: true };
    }
    return { finished: true, replaced: false };
  }
  return { finished: false, replaced: false };
}
