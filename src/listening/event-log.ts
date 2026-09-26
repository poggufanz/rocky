/**
 * Append-only listening event log: the durable truth (spec §7).
 * The graph/index is a rebuildable projection (graph-store.ts).
 * Separate from memory.jsonl/journal.jsonl. Write side only:
 * MCP must never import this module (see mcp-import-boundary.test.ts).
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type {
  EventEnvelope,
  HarnessId,
  ListeningEdge,
  ListeningNodeKind,
} from "./types.js";
import {
  isHarnessId,
  isV1LinkBasis,
  isV1NodeKind,
  PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO,
  PROPOSAL_MAX_FILE_VERSION_BYTES,
  PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO,
} from "./types.js";
import {
  eventsPath,
  hostEventsPath,
  listeningHome,
  objectsDir,
  repoDir,
} from "./store-paths.js";
import { isRepoCaptureAllowed } from "./repo-consent-read.js";
import { parseListeningEventLine } from "./event-codec.js";

export type AppendResult =
  | { ok: true; eventId: string }
  | { ok: false; reason: string };

export type ObjectResult =
  | { ok: true; ref: string; evicted: number }
  | { ok: false; reason: string };

/** Internal hard cap per event line. PROPOSAL-adjacent; fixed for durability. */
export const LISTENING_MAX_EVENT_BYTES = 64 * 1024;

function noFollowAppendFlags(): number {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  return constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow;
}

function ensureListeningDir(dir: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("listening store must be a real directory");
  }
}

/** Open for append, verifying the descriptor is a regular file (no-follow). */
function openAppendVerified(path: string): number {
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) return -1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return -1;
  }
  let fd = -1;
  try {
    fd = openSync(path, noFollowAppendFlags(), 0o600);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink()) {
      closeSync(fd);
      return -1;
    }
    return fd;
  } catch {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Descriptor already failed; nothing durable to protect.
      }
    }
    return -1;
  }
}

function appendLine(path: string, line: string): boolean {
  const encoded = Buffer.from(line, "utf8");
  let fd = -1;
  try {
    ensureListeningDir(join(path, ".."));
  } catch {
    return false;
  }
  fd = openAppendVerified(path);
  if (fd < 0) return false;
  try {
    let offset = 0;
    while (offset < encoded.byteLength) {
      const written = writeSync(fd, encoded, offset, encoded.byteLength - offset);
      if (written <= 0) return false;
      offset += written;
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Append already succeeded or failed; never leak the descriptor.
    }
  }
}

/** Line parsing lives in event-codec.ts so readers avoid this writer module. */

function hasCompleteTestClaim(e: EventEnvelope): boolean {
  return e.testClaim !== undefined
    && typeof e.testClaim.commandIdentity === "string"
    && e.testClaim.commandIdentity.length > 0
    && (e.testClaim.outcome === "pass" || e.testClaim.outcome === "fail")
    && typeof e.testClaim.testedVersion === "string"
    && e.testClaim.testedVersion.length > 0;
}

function validateEnvelope(e: EventEnvelope): string | undefined {
  if (e.v !== 1) return "bad-version";
  if (typeof e.eventId !== "string" || e.eventId.length === 0) return "bad-event-id";
  if (e.source !== "watcher" && e.source !== "adapter" && e.source !== "git" && e.source !== "hook") {
    return "bad-source";
  }
  if (typeof e.ts !== "number" || !Number.isSafeInteger(e.ts) || e.ts < 0) return "bad-ts";
  if (typeof e.adapterVersion !== "string" || e.adapterVersion.length === 0) return "bad-adapter-version";
  if (e.harnessId !== undefined && !isHarnessId(e.harnessId)) return "bad-harness-id";
  if (e.node !== undefined && !isV1NodeKind(e.node as ListeningNodeKind)) return "bad-node";
  if (e.edge !== undefined) {
    const edge = e.edge as ListeningEdge;
    if (!isV1LinkBasis(edge.basis)) return "forbidden-basis";
    if (typeof edge.kind !== "string" || typeof edge.from !== "string" || typeof edge.to !== "string") {
      return "bad-edge";
    }
  }
  if (e.node === "test_run" && !hasCompleteTestClaim(e)) return "test-claim-required";
  return undefined;
}

function existingNativeId(path: string, nativeId: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const parsed = parseListeningEventLine(line);
    if (parsed?.nativeId === nativeId) return parsed.eventId;
  }
  return undefined;
}

function compactEventFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (Buffer.byteLength(raw, "utf8") <= PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO) return;
  const lines = raw.split("\n").filter((line) => line.length > 0);
  let kept: string[] = [];
  let keptBytes = 0;
  let dropped = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bytes = Buffer.byteLength(lines[index], "utf8") + 1;
    if (keptBytes + bytes > PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO) {
      dropped = index + 1;
      break;
    }
    kept.unshift(lines[index]);
    keptBytes += bytes;
  }
  const tombstone = JSON.stringify({
    v: 1,
    eventId: `gap-${randomUUID()}`,
    source: "watcher",
    ts: Date.now(),
    adapterVersion: "listening-store/1",
    coverage: "partial",
    consent: { host: false, repo: true, rawTrace: false },
    redaction: { applied: false, truncated: false },
    refs: {},
    gapEvicted: dropped,
  });
  kept = [tombstone, ...kept];
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${kept.join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Compaction is best-effort; the uncompacted file stays readable.
  }
}

/** Durable repo-event append. Idempotent on nativeId; repo consent required. */
export function appendListeningEvent(
  repoRoot: string,
  e: EventEnvelope,
  obj?: { bytes: Uint8Array; kind: "snapshot" | "diff" },
  home?: string,
): AppendResult {
  if (!isRepoCaptureAllowed(repoRoot, home)) return { ok: false, reason: "repo-consent-required" };
  const invalid = validateEnvelope(e);
  if (invalid !== undefined) return { ok: false, reason: invalid };
  if (typeof repoRoot !== "string" || repoRoot.length === 0) return { ok: false, reason: "bad-repo-root" };
  const path = eventsPath(repoRoot, home);
  if (e.nativeId !== undefined) {
    const existing = existingNativeId(path, e.nativeId);
    if (existing !== undefined) return { ok: true, eventId: existing };
  }
  if (obj !== undefined) {
    const stored = storeListeningObject(repoRoot, obj.bytes, home);
    if (!stored.ok) return stored;
  }
  const line = `${JSON.stringify(e)}\n`;
  if (Buffer.byteLength(line, "utf8") > LISTENING_MAX_EVENT_BYTES) {
    return { ok: false, reason: "event-oversized" };
  }
  try {
    ensureListeningDir(repoDir(repoRoot, home));
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
  if (!appendLine(path, line)) return { ok: false, reason: "append-failed" };
  compactEventFile(path);
  return { ok: true, eventId: e.eventId };
}

/** Durable host-scoped event append (no repo store). Requires host consent flag. */
export function appendHostEvent(
  harnessId: HarnessId,
  e: EventEnvelope,
  home?: string,
  hostConsent = true,
): AppendResult {
  if (!isHarnessId(harnessId)) return { ok: false, reason: "bad-harness-id" };
  if (!hostConsent) return { ok: false, reason: "host-consent-required" };
  const invalid = validateEnvelope(e);
  if (invalid !== undefined) return { ok: false, reason: invalid };
  const path = hostEventsPath(harnessId, home);
  if (e.nativeId !== undefined) {
    const existing = existingNativeId(path, e.nativeId);
    if (existing !== undefined) return { ok: true, eventId: existing };
  }
  const line = `${JSON.stringify(e)}\n`;
  if (Buffer.byteLength(line, "utf8") > LISTENING_MAX_EVENT_BYTES) {
    return { ok: false, reason: "event-oversized" };
  }
  try {
    ensureListeningDir(join(listeningHome(home), "hosts"));
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
  if (!appendLine(path, line)) return { ok: false, reason: "append-failed" };
  return { ok: true, eventId: e.eventId };
}

/** Content-addressed redacted object store; oldest-first eviction with count. */
export function storeListeningObject(
  repoRoot: string,
  bytes: Uint8Array,
  home?: string,
): ObjectResult {
  if (!isRepoCaptureAllowed(repoRoot, home)) return { ok: false, reason: "repo-consent-required" };
  if (bytes.byteLength > PROPOSAL_MAX_FILE_VERSION_BYTES) return { ok: false, reason: "object-oversized" };
  const ref = createHash("sha256").update(bytes).digest("hex");
  const dir = objectsDir(repoRoot, home);
  try {
    ensureListeningDir(dir);
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
  const target = join(dir, ref);
  try {
    const existing = lstatSync(target);
    if (existing.isFile() && !existing.isSymbolicLink()) return { ok: true, ref, evicted: 0 };
    return { ok: false, reason: "object-path-blocked" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: "store-unavailable" };
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
  let total = bytes.byteLength;
  for (const name of names) {
    try {
      const stats = lstatSync(join(dir, name));
      if (stats.isFile() && !stats.isSymbolicLink()) total += stats.size;
    } catch {
      // Best-effort accounting; a raced entry is skipped, never trusted.
    }
  }
  let evicted = 0;
  if (total > PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO) {
    const entries: { name: string; mtime: number }[] = [];
    for (const name of names) {
      try {
        const stats = lstatSync(join(dir, name));
        if (stats.isFile() && !stats.isSymbolicLink()) entries.push({ name, mtime: stats.mtimeMs });
      } catch {
        // Raced away; ignore.
      }
    }
    entries.sort((left, right) => left.mtime - right.mtime);
    for (const entry of entries) {
      if (total <= PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO) break;
      try {
        const stats = lstatSync(join(dir, entry.name));
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        unlinkSync(join(dir, entry.name));
        total -= stats.size;
        evicted += 1;
      } catch {
        // Raced; stop claiming eviction for this entry.
      }
    }
  }
  try {
    const tmp = join(dir, `${ref}.${process.pid}.tmp`);
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    return { ok: false, reason: "object-write-failed" };
  }
  return { ok: true, ref, evicted };
}
