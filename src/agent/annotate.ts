import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import { recordTripleOnce } from "../core/memory.js";
import type { TripleFile, TripleRecord } from "../core/memory.js";
import { loadConfig, type ConfigLoadResult } from "../core/config-read.js";
import { redactSecrets } from "../core/redact.js";
import { annotatePortFromConfig, parseAnnotateOutput, type AnnotatePort, type AnnotateOutput } from "../ai/annotate.js";
import {
  MAX_EXCERPT_CHARS,
  MAX_INTENT_CHARS,
  MAX_RATIONALE_CHARS,
  type AgentName,
} from "./schema.js";
import {
  acquireAnnotationLease,
  claimBatch,
  listOrphanBatches,
  listOrphanClaims,
  prepareClaim,
  readClaim,
  releaseAnnotationLease,
  removeClaim,
  type AnnotationLease,
  type BatchClaim,
} from "./spool.js";

export const MAX_TRIPLE_FILES = 8;

const MAX_LABEL_LINES = 10;
const MAX_LABEL_CHARS = 400;
const MAX_LABEL_FILE_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 1024;
const MAX_HEAD_CHARS = 256;
const MAX_CWD_CHARS = 4096;
const PROP_RE = /([a-zA-Z-]{2,})\s*:/g;
const ANSI_RE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

export interface AnnotateDeps {
  paths?: RockyPaths;
  now?: () => number;
  git?: (args: string[], cwd: string) => string | undefined;
  ai?: AnnotatePort;
  loadConfig?: (path: string) => ConfigLoadResult;
  queueLabel?: (line: string, paths: RockyPaths) => void;
  /** Internal recovery hooks keep claim and lease ownership in one transaction. */
  claim?: BatchClaim;
  lease?: AnnotationLease;
  afterPersist?: (record: TripleRecord, appended: boolean) => void;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort at this private boundary.
  }
}

function prefixUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let offset = 0;
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maximumBytes) break;
    used += bytes;
    offset += character.length;
  }
  return offset === value.length ? value : value.slice(0, offset);
}

function cleanText(value: string, maximum: number): string {
  const bounded = prefixUtf8(value, Math.max(1, maximum) * 4);
  const stripped = bounded
    .replace(ANSI_RE, "")
    .replace(BIDI_RE, "")
    .replace(CONTROL_RE, "");
  return redactSecrets(stripped).replace(/\s+/g, " ").trim().slice(0, maximum);
}

function operationalText(value: string, maximum: number): string {
  return prefixUtf8(value, Math.max(1, maximum) * 4)
    .replace(ANSI_RE, "")
    .replace(BIDI_RE, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(CONTROL_RE, " ");
}

function safeLabel(value: string): string | undefined {
  const line = cleanText(value, MAX_LABEL_CHARS);
  return line.length === 0 ? undefined : line;
}

function ensureHomeDirectory(home: string): boolean {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const stats = lstatSync(home);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function readLabelLines(path: string): string[] | undefined {
  const initial = (() => {
    try {
      return lstatSync(path);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
    }
  })();
  if (initial === null) return undefined;
  if (initial === undefined) return [];
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_LABEL_FILE_BYTES) return undefined;

  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size > MAX_LABEL_FILE_BYTES) return undefined;
    const bytes = Buffer.alloc(MAX_LABEL_FILE_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || count !== after.size || count > MAX_LABEL_FILE_BYTES) return undefined;
    return bytes.subarray(0, count).toString("utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => safeLabel(line)).filter((line): line is string => line !== undefined);
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function writeLabelLines(path: string, lines: readonly string[]): void {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW, 0o600);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // File mode is best effort on platforms without chmod support.
    }
    const encoded = Buffer.from(lines.join("\n") + "\n", "utf8");
    if (encoded.byteLength > MAX_LABEL_FILE_BYTES) return;
    let offset = 0;
    while (offset < encoded.byteLength) {
      const written = writeSync(fd, encoded, offset, encoded.byteLength - offset);
      if (written <= 0) return;
      offset += written;
    }
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

export function defaultQueueLabel(line: string, paths: RockyPaths): void {
  try {
    if (!ensureHomeDirectory(paths.home)) return;
    const safe = safeLabel(line);
    if (!safe) return;
    const existing = readLabelLines(paths.labels);
    if (existing === undefined) return;
    writeLabelLines(paths.labels, [...existing, safe].slice(-MAX_LABEL_LINES));
  } catch {
    // Labels are best effort and never affect durable memory.
  }
}

function defaultGit(args: string[], cwd: string): string | undefined {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      shell: false,
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || (result.signal !== null && result.signal !== undefined)) return undefined;
    return typeof result.stdout === "string" ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function runGit(git: (args: string[], cwd: string) => string | undefined, args: string[], cwd: string): string | undefined {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

function parseNumstat(value: string | undefined): [number, number] {
  const match = value?.match(/^\s*(\d+)\t(\d+)(?:\t|$)/m);
  if (!match) return [0, 0];
  const added = Number(match[1]);
  const removed = Number(match[2]);
  return Number.isSafeInteger(added) && Number.isSafeInteger(removed) ? [added, removed] : [0, 0];
}

function propsFromExcerpt(excerpt: string | undefined): string[] {
  if (!excerpt) return [];
  const found = new Set<string>();
  for (const match of excerpt.matchAll(new RegExp(PROP_RE.source, "g"))) {
    const prop = match[1];
    if (prop !== undefined) found.add(prop);
    if (found.size >= 5) break;
  }
  return [...found].slice(0, 5);
}

export function degradedLabel(intent: string | undefined, files: readonly TripleFile[]): string | undefined {
  const cleanIntent = intent === undefined ? undefined : cleanText(intent, MAX_INTENT_CHARS);
  if (!cleanIntent || files.length === 0) return undefined;
  const first = files[0];
  if (!first) return undefined;
  const subject = cleanText(first.props[0] ?? first.path, 160);
  if (!subject) return undefined;
  const short = cleanIntent.length > 60 ? `${cleanIntent.slice(0, 57)}...` : cleanIntent;
  return safeLabel(`you say "${short}". it is ${subject}. I think. check, question`);
}

export async function annotateBatch(key: string, deps: AnnotateDeps = {}): Promise<TripleRecord | undefined> {
  const paths = deps.paths ?? resolveRockyPaths();
  const git = deps.git ?? defaultGit;
  const lease = deps.lease ?? acquireAnnotationLease(key, paths);
  if (!lease) return undefined;
  let claim: BatchClaim | undefined;
  try {
    claim = deps.claim === undefined ? claimBatch(key, paths) : prepareClaim(deps.claim, paths);
    if (!claim) return undefined;
    const events = readClaim(claim, paths);
    const agent: AgentName = events[0]?.agent ?? "claude-code";
    const batchEvents = events.filter((event) => event.agent === agent);
    const intentEvent = batchEvents.find((event) => event.kind === "intent");
    const byPath = new Map<string, { path: string; excerpt?: string }>();
    for (const event of batchEvents) {
      if (event.kind !== "mechanism") continue;
      const gitPath = operationalText(event.path, MAX_PATH_CHARS);
      const path = cleanText(event.path, MAX_PATH_CHARS);
      if (!path || !gitPath) continue;
      const excerpt = event.excerpt === undefined ? undefined : cleanText(event.excerpt, MAX_EXCERPT_CHARS) || undefined;
      byPath.set(gitPath, { path, excerpt });
    }
    if (byPath.size === 0) {
      removeClaim(claim, paths);
      return undefined;
    }

    let rationaleEvent: Extract<(typeof events)[number], { kind: "rationale" }> | undefined;
    let rationaleText: string | undefined;
    for (const event of batchEvents) {
      if (event.kind !== "rationale") continue;
      const text = cleanText(event.text, MAX_RATIONALE_CHARS);
      if (text) {
        rationaleEvent = event;
        rationaleText = text;
      }
    }

    const rawCwd = intentEvent?.kind === "intent" && intentEvent.cwd ? intentEvent.cwd : process.cwd();
    const operationalCwd = operationalText(rawCwd, MAX_CWD_CHARS);
    const gitCwd = operationalCwd.trim() ? operationalCwd : process.cwd();
    const cwd = cleanText(rawCwd, MAX_CWD_CHARS) || process.cwd();
    const headRaw = runGit(git, ["rev-parse", "HEAD"], gitCwd);
    const head = headRaw === undefined ? undefined : cleanText(headRaw, MAX_HEAD_CHARS) || undefined;
    const allMechanisms = [...byPath.entries()];
    const files: TripleFile[] = allMechanisms.slice(0, MAX_TRIPLE_FILES).map(([gitPath, value]) => {
      const excerpt = value?.excerpt;
      const numstat = runGit(git, ["diff", "--numstat", "--", gitPath], gitCwd);
      return {
        path: value.path,
        plusMinus: parseNumstat(numstat),
        props: propsFromExcerpt(excerpt),
        ...(excerpt === undefined ? {} : { excerpt }),
      };
    });

    const intentText = intentEvent?.kind === "intent" ? cleanText(intentEvent.text, MAX_INTENT_CHARS) || undefined : undefined;
    let port = deps.ai;
    if (port === undefined) {
      try {
        const readConfig = deps.loadConfig ?? loadConfig;
        port = annotatePortFromConfig(readConfig(paths.config));
      } catch {
        port = undefined;
      }
    }

    let aiOutput: AnnotateOutput | undefined;
    if (port !== undefined) {
      try {
        const input = {
          ...(intentText === undefined ? {} : { intent: intentText }),
          ...(rationaleText === undefined ? {} : { rationaleRaw: rationaleText }),
          files: files.map((file) => file.excerpt === undefined
            ? { path: file.path }
            : { path: file.path, excerpt: file.excerpt }),
        };
        const output = await port.run(input, AbortSignal.timeout(15_000));
        aiOutput = parseAnnotateOutput(output);
      } catch {
        aiOutput = undefined;
      }
    }

    const rationale = rationaleEvent && rationaleText
      ? {
        text: aiOutput?.summary ?? rationaleText,
        tags: aiOutput === undefined ? [] : [...aiOutput.tags],
        source: rationaleEvent.source,
      }
      : undefined;
    const now = deps.now?.();
    const ts = now !== undefined && Number.isFinite(now) ? now : undefined;
    const persisted = recordTripleOnce({
      ...(ts === undefined ? {} : { ts }),
      agent,
      cwd,
      ...(intentText === undefined ? {} : { intent: { text: intentText } }),
      ...(rationale === undefined ? {} : { rationale }),
      mechanism: {
        ...(head === undefined ? {} : { head }),
        files,
        truncatedFiles: Math.max(0, allMechanisms.length - MAX_TRIPLE_FILES),
      },
    }, `${claim.key}:${claim.id}`, paths);
    deps.afterPersist?.(persisted.record, persisted.appended);

    if (persisted.appended) {
      const label = aiOutput?.label ?? degradedLabel(intentText, files);
      if (label) {
        try {
          const enqueue = deps.queueLabel ?? defaultQueueLabel;
          const safe = safeLabel(label);
          if (safe) enqueue(safe, paths);
        } catch {
          // A broken label queue cannot turn a successful append into a retry.
        }
      }
    }
    removeClaim(claim, paths);
    return persisted.record;
  } finally {
    releaseAnnotationLease(lease, paths);
  }
}

export async function annotateCommand(key: string): Promise<number> {
  try {
    const paths = resolveRockyPaths();
    if (key) await annotateBatch(key, { paths });
    for (const claim of listOrphanClaims(Date.now(), paths)) {
      try {
        await annotateBatch(claim.key, { paths, claim });
      } catch {
        // One broken claim must not prevent the next eligible claim.
      }
    }
    for (const orphan of listOrphanBatches(Date.now(), paths)) {
      try { await annotateBatch(orphan, { paths }); } catch {
        // One broken orphan must not prevent the next eligible batch.
      }
    }
  } catch {
    // Hidden detached command is never allowed to affect the shell.
  }
  return 0;
}
