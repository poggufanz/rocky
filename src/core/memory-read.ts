import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { resolveRockyPaths } from "./state-paths.js";
import { commandIdentity, type FingerprintAlgorithmVersion } from "./fingerprint.js";
import { NO_BLOCK_FLAG, NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "./fs-safety.js";

export type FailureOrigin = "run" | "hook" | "watch";

export interface FailureRecord {
  kind: "failure";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  exitCode: number;
  fingerprint: string;
  /** Absent means a pre-v2 record; v1 is retained for explicit migrations. */
  fingerprintV?: FingerprintAlgorithmVersion;
  signature: string[];
  excerpt: string;
  origin?: FailureOrigin;
  resolvedBy?: string;
  commandIdentity?: string;
  identityV?: 1;
  identityReliable?: boolean;
  platform?: NodeJS.Platform;
}

export type LinkBasis = "identity" | "signature" | "program";
export type LinkConfidence = "confirmed" | "possible";
export interface FixLink { id: string; basis: LinkBasis; confidence?: LinkConfidence }

export interface FixRecord {
  kind: "fix";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  failureIds: string[];
  candidateFailureIds?: string[];
  links?: FixLink[];
  commandIdentity?: string;
  identityV?: 1;
  identityReliable?: boolean;
  platform?: NodeJS.Platform;
}

export interface AssociationRecord {
  kind: "association";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  candidateFailureIds: string[];
  links: FixLink[];
  commandIdentity?: string;
  identityV?: 1;
  identityReliable?: boolean;
  platform?: NodeJS.Platform;
}

export interface NoteRecord {
  kind: "note";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  file: string;
  line: number;
  subject: string;
  answer: string;
}

export interface TripleFile {
  path: string;
  plusMinus: [number, number];
  props: string[];
  excerpt?: string;
  provenance?: "tool-observed" | "git-diff-inferred" | "unknown";
  /** Internal collision discriminator; never projected as user evidence. */
  identityHash?: string;
}

const ephemeralTripleIdentities = new WeakMap<object, string>();

export function rememberTripleFileIdentity(file: TripleFile, identity: string): void {
  if (identity) ephemeralTripleIdentities.set(file, identity);
}

export function pathIdentityHash(value: string, options: CanonicalPathOptions = {}): string {
  const identity = options.canonical === true ? value : canonicalPath(value, options);
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
}

export interface TripleRecord {
  kind: "triple";
  id: string;
  ts: number;
  cwd: string;
  schemaV: 1;
  agent: "claude-code" | "codex";
  origin: "agent-hook";
  /** Origin platform keeps case-sensitive POSIX paths safe after reload. */
  platform?: NodeJS.Platform;
  intent?: { text: string };
  rationale?: { text: string; tags: string[]; source: "transcript" | "notify" };
  mechanism: {
    head?: string;
    files: TripleFile[];
    truncatedFiles: number;
    baseline?: "captured" | "unknown";
    coverageStatus?: "complete" | "truncated" | "unknown";
  };
}

/** Shared durable knowledge contract: only this many file witnesses survive. */
export const MAX_TRIPLE_FILES = 8;
/** Reject hostile nested file arrays before any per-entry traversal. */
const MAX_TRIPLE_INPUT_FILES = 256;
const KNOWN_PATH_PLATFORMS: ReadonlySet<string> = new Set([
  "aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32",
]);

export function isKnownPathPlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === "string" && KNOWN_PATH_PLATFORMS.has(value);
}

const ANSI_OR_OSC = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u009d[^\u009c]*(?:\u009c|$)|\u009b[0-?]*[ -/]*[@-~])/gu;
const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060-\u206f\ufeff]/u;

export interface CanonicalPathOptions {
  /** Unknown means preserve case; live records default to current platform. */
  platform?: NodeJS.Platform | "unknown";
  /** Resolve a relative spelling against known turn cwd for identity only. */
  cwd?: string;
  /** Hash an already canonical identity without reapplying reader platform policy. */
  canonical?: boolean;
}

/** Shared canonical file identity. See README for platform case policy. */
export function canonicalPath(value: string, options: CanonicalPathOptions = {}): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(ANSI_OR_OSC, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060-\u206f\ufeff]/gu, "");
  const trimmed = cleaned.trim();
  if (!trimmed) return "";
  const platform = options.platform ?? process.platform;
  const source = trimmed.replaceAll("\\", "/");
  // UNC syntax is a Windows identity, not a generic slash spelling.  An
  // explicit POSIX/Linux origin must collapse duplicate separators so a
  // reload on another platform cannot silently invent a UNC root.
  const hadUncPrefix = platform === "win32" && source.startsWith("//") && !/^\/{3,}/u.test(source);
  const normalized = source.replace(/\/{2,}/gu, "/");
  const driveAbsolute = /^[A-Za-z]:\//u.test(normalized);
  const driveRelative = /^[A-Za-z]:/u.test(normalized) && !driveAbsolute;
  const posixAbsolute = normalized.startsWith("/") && !hadUncPrefix;
  let prefix = "";
  let rest = normalized;
  if (hadUncPrefix && normalized.length > 1) {
    prefix = "//";
    rest = normalized.slice(1);
  } else if (hadUncPrefix) {
    prefix = "/";
    rest = "";
  } else if (driveAbsolute) {
    prefix = `${normalized.slice(0, 2)}/`;
    rest = normalized.slice(3);
  } else if (driveRelative) {
    prefix = normalized.slice(0, 2);
    rest = normalized.slice(2);
  } else if (posixAbsolute) {
    prefix = "/";
    rest = normalized.slice(1);
  }
  const segments = rest.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  let result = `${prefix}${segments.join("/")}`;
  if (prefix === "//" && segments.length === 0) result = "/";
  if (prefix === "/" && segments.length === 0) result = "/";
  if (prefix.endsWith("/") && segments.length === 0) result = prefix;
  if (prefix === "" && result.length === 0) return "";

  if (platform === "win32") result = result.toLowerCase();

  // Relative paths are compared against the turn cwd only when a caller asks
  // for an identity key. Keep display paths relative at the storage boundary.
  if (options.cwd !== undefined && prefix === "" && result.length > 0) {
    const cwd = canonicalPath(options.cwd, { platform });
    if (cwd.length > 0) {
      const joined = cwd.endsWith("/") ? `${cwd}${result}` : `${cwd}/${result}`;
      return canonicalPath(joined, { platform });
    }
  }
  return result;
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function addTruncatedFiles(declared: number, omitted: number): { value: number; valid: boolean } {
  if (!isSafeNonNegativeInteger(declared) || !isSafeNonNegativeInteger(omitted)) {
    return { value: 0, valid: false };
  }
  const total = declared + omitted;
  return Number.isSafeInteger(total)
    ? { value: total, valid: true }
    : { value: Number.MAX_SAFE_INTEGER, valid: false };
}

function normalizedCoverageStatus(
  declared: TripleRecord["mechanism"]["coverageStatus"],
  truncatedFiles: number,
  valid: boolean,
  files: readonly TripleFile[],
): TripleRecord["mechanism"]["coverageStatus"] {
  if (!valid) return "unknown";
  if (declared === "unknown") return "unknown";
  if (truncatedFiles > 0) return "truncated";
  // Historical triples had no coverage proof.  Keep that omission
  // conservative at every read/write boundary rather than upgrading it to a
  // complete turn merely because no truncation count was declared.
  if (declared !== "complete") return "unknown";
  return files.length === 0 ? "unknown" : "complete";
}

/**
 * Normalize a triple at every durable/read boundary.  Keeping this helper in
 * the record contract prevents writers, readers, and projections from drifting
 * into different file caps.
 */
export interface TriplePathIdentityContext {
  platform?: NodeJS.Platform | "unknown";
  cwd?: string;
}

export function boundTripleMechanism(
  mechanism: TripleRecord["mechanism"],
  context: TriplePathIdentityContext = {},
): TripleRecord["mechanism"] {
  const source = (mechanism ?? {}) as unknown as Record<string, unknown>;
  const rawFiles = Array.isArray(source.files) ? source.files : [];
  let rawFilesLength = 0;
  let rawFilesShapeValid = true;
  try {
    rawFilesLength = rawFiles.length;
    if (!Number.isSafeInteger(rawFilesLength) || rawFilesLength < 0) rawFilesLength = 0;
  } catch {
    rawFilesLength = 0;
    rawFilesShapeValid = false;
  }
  const rawFilesTooLarge = rawFilesLength > MAX_TRIPLE_INPUT_FILES;
  const boundedRawFilesLength = Math.min(rawFilesLength, MAX_TRIPLE_INPUT_FILES);
  const rawFilesOmitted = rawFilesTooLarge ? rawFilesLength - boundedRawFilesLength : 0;
  const contextPlatform = context.platform;
  const contextPlatformValid = contextPlatform === undefined || contextPlatform === "unknown" || isKnownPathPlatform(contextPlatform);
  let valid = Array.isArray(source.files) && contextPlatformValid && rawFilesShapeValid && !rawFilesTooLarge;
  const byIdentity = new Map<string, TripleFile>();
  const hashPaths = new Map<string, string>();
  const ordinaryPathHashes = new Map<string, string | undefined>();
  const redactedDisplayHashes = new Map<string, string | undefined>();
  const platform = contextPlatform ?? process.platform;
  let hasBoundablePath = false;
  try {
    for (let index = 0; index < boundedRawFilesLength; index += 1) {
      const value = rawFiles[index];
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const candidate = (value as Record<string, unknown>).path;
      if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 1024) {
        hasBoundablePath = true;
        break;
      }
    }
  } catch {
    valid = false;
  }
  for (let fileIndex = 0; fileIndex < boundedRawFilesLength; fileIndex += 1) {
    const value = rawFiles[fileIndex];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      valid = false;
      continue;
    }
    const raw = value as Record<string, unknown>;
    if (typeof raw.path !== "string" || raw.path.length === 0) {
      valid = false;
      continue;
    }
    if (PATH_CONTROL.test(raw.path)) valid = false;
    // Keep one witness for a record made solely from hostile overlong paths,
    // but discard such entries when any ordinary bounded path is available.
    // Ingress adapters reject these paths; durable/reader boundaries retain
    // them only as explicit unknown evidence so they cannot claim completeness
    // or consume a slot ahead of valid paths.
    if (raw.path.length > 1024) {
      valid = false;
      if (hasBoundablePath) continue;
    }
    const path = canonicalPath(raw.path, { platform });
    const identityPath = canonicalPath(raw.path, { platform, cwd: context.cwd }) || path;
    const ephemeralIdentity = ephemeralTripleIdentities.get(value as object);
    const rawIdentityHash = raw.identityHash;
    const identityHash = typeof rawIdentityHash === "string" && /^[0-9a-f]{32}$/u.test(rawIdentityHash)
      ? rawIdentityHash
      : undefined;
    if (rawIdentityHash !== undefined && identityHash === undefined) valid = false;
    if (identityHash !== undefined) {
      const priorPath = hashPaths.get(identityHash);
      // A durable discriminator is only trustworthy once it identifies one
      // file. Keep distinct display paths instead of collapsing them, but
      // downgrade coverage whenever a forged/repeated hash is encountered.
      if (priorPath !== undefined && priorPath !== path) valid = false;
      else hashPaths.set(identityHash, path);
    }
    // A normal (non-redacted) display path is the authoritative durable
    // identity.  Conflicting valid hashes for that path are contradictory
    // evidence, not two files.  Hash-backed identity remains reserved for
    // redacted displays where two raw paths can intentionally project alike.
    const redactedDisplay = /\[redacted(?:[^\]]*)\]/iu.test(path);
    if (!redactedDisplay) {
      const priorHash = ordinaryPathHashes.get(identityPath);
      if (ordinaryPathHashes.has(identityPath) && priorHash !== identityHash) valid = false;
      else ordinaryPathHashes.set(identityPath, identityHash);
    } else {
      const priorHash = redactedDisplayHashes.get(path);
      // One redacted display may represent one raw file without a hash, or
      // several files only when each has a distinct valid discriminator.
      // Repeated absent/repeated hashes are ambiguous and cannot prove a
      // complete turn after durable reload.
      if (redactedDisplayHashes.has(path) && (priorHash === undefined || identityHash === undefined || priorHash === identityHash)) {
        valid = false;
      } else if (!redactedDisplayHashes.has(path)) {
        redactedDisplayHashes.set(path, identityHash);
      }
    }
    const plusMinus = Array.isArray(raw.plusMinus) && raw.plusMinus.length === 2
      ? raw.plusMinus
      : undefined;
    const plusMinusValid = plusMinus !== undefined
      && isSafeNonNegativeInteger(plusMinus[0]) && isSafeNonNegativeInteger(plusMinus[1]);
    const props = strings(raw.props);
    if (!path || !plusMinusValid || props === undefined) {
      valid = false;
      continue;
    }
    const file: TripleFile = {
      path,
      plusMinus: plusMinusValid ? [plusMinus[0] as number, plusMinus[1] as number] : [0, 0],
      props: props.slice(),
      ...(typeof raw.excerpt === "string" ? { excerpt: raw.excerpt } : {}),
      ...(raw.provenance === "tool-observed" || raw.provenance === "git-diff-inferred" || raw.provenance === "unknown"
        ? { provenance: raw.provenance }
        : {}),
    };
    // Keep the persisted discriminator available to identity-aware queries,
    // while keeping the historical in-memory record shape stable for callers
    // that inspect or export a bounded TripleFile.  The writer receives the
    // enumerable ingress object; normalized/reloaded records carry the same
    // value as a non-enumerable operational witness.
    if (identityHash !== undefined) {
      Object.defineProperty(file, "identityHash", {
        value: identityHash,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    // Namespace every discriminator and bind it to canonical display path.
    // This prevents a hash-shaped plain path from colliding with a hash key,
    // while preserving distinct redacted paths that share one hash.
    const key = !redactedDisplay
      ? `path:${identityPath}`
      : identityHash !== undefined
      ? `hash:${identityPath}\u0000${identityHash}`
      : ephemeralIdentity !== undefined
        ? `ephemeral:${identityPath}\u0000${canonicalPath(ephemeralIdentity, { platform, cwd: context.cwd })}`
      : `path:${identityPath}`;
    // Map.set replaces evidence without changing first-seen insertion order.
    byIdentity.set(key, file);
  }
  const allFiles = [...byIdentity.values()];
  const files = allFiles.slice(0, MAX_TRIPLE_FILES);
  const declared = source.truncatedFiles;
  const omittedFromBound = Math.max(0, allFiles.length - files.length);
  const firstOmission = addTruncatedFiles(isSafeNonNegativeInteger(declared) ? declared : 0, rawFilesOmitted);
  const added = addTruncatedFiles(firstOmission.value, omittedFromBound);
  if (!firstOmission.valid || !added.valid) valid = false;
  if (!isSafeNonNegativeInteger(declared)) valid = false;
  if (source.coverageStatus !== undefined && source.coverageStatus !== "complete" &&
      source.coverageStatus !== "truncated" && source.coverageStatus !== "unknown") valid = false;
  const truncatedFiles = added.value;
  const coverageStatus = normalizedCoverageStatus(
    source.coverageStatus as TripleRecord["mechanism"]["coverageStatus"], truncatedFiles, valid && added.valid, files,
  );
  return {
    ...(typeof source.head === "string" ? { head: source.head } : {}),
    files: files.map((file) => {
      const copy: TripleFile = {
        ...file,
        plusMinus: [...file.plusMinus] as [number, number],
        props: [...file.props],
      };
      if (file.identityHash !== undefined) {
        Object.defineProperty(copy, "identityHash", {
          value: file.identityHash,
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }
      return copy;
    }),
    truncatedFiles,
    ...(source.baseline === "captured" || source.baseline === "unknown" ? { baseline: source.baseline } : {}),
    coverageStatus,
  };
}

export function boundTripleRecord(record: TripleRecord): TripleRecord {
  const mechanism = boundTripleMechanism(record.mechanism, {
    platform: record.platform ?? "unknown",
    cwd: record.cwd,
  });
  // A legacy triple without origin platform cannot prove case-sensitive path
  // identity, even when its display spelling is relative to an absolute cwd.
  // Keep it readable, but downgrade completeness until a writer supplies the
  // origin marker.
  if (record.platform === undefined && mechanism.files.length > 0) {
    mechanism.coverageStatus = "unknown";
  }
  return {
    ...record,
    mechanism,
  };
}

export type MemoryRecord = FailureRecord | FixRecord | AssociationRecord | NoteRecord | TripleRecord;

export const MAX_MEMORY_LINE_BYTES = 1024 * 1024;
const MAX_RECORD_ARRAY_ITEMS = 256;
const MAX_RECORD_ITEM_CHARS = 16 * 1024;
const MAX_RECORD_ARRAY_BYTES = 64 * 1024;

/**
 * `complete` distinguishes an empty/valid memory file from a read that failed
 * before its contents could be trusted. Public readers keep their historical
 * fail-closed `[]` behavior; mutation transactions use this bit to avoid
 * deleting pending state from an incomplete snapshot.
 */
export interface MemoryLoadResult {
  records: MemoryRecord[];
  complete: boolean;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function strings(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || value.length > MAX_RECORD_ARRAY_ITEMS) return undefined;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    const output: string[] = [];
    let bytes = 0;
    for (let index = 0; index < length; index += 1) {
      const entry = value[index];
      if (typeof entry !== "string" || entry.length > MAX_RECORD_ITEM_CHARS) return undefined;
      const entryBytes = Buffer.byteLength(entry, "utf8");
      if (bytes + entryBytes > MAX_RECORD_ARRAY_BYTES) return undefined;
      bytes += entryBytes;
      output.push(entry);
    }
    return output;
  } catch {
    return undefined;
  }
}

function identityFields(record: Record<string, unknown>): Pick<FailureRecord, "commandIdentity" | "identityV" | "identityReliable" | "platform"> | undefined {
  if (record.commandIdentity === undefined && record.identityV === undefined &&
      record.identityReliable === undefined && record.platform === undefined) return {};
  if (typeof record.commandIdentity !== "string" || record.identityV !== 1 ||
      typeof record.identityReliable !== "boolean" || !isKnownPathPlatform(record.platform)) return undefined;
  return {
    commandIdentity: record.commandIdentity,
    identityV: 1,
    identityReliable: record.identityReliable,
    platform: record.platform as NodeJS.Platform,
  };
}

function fingerprintFields(record: Record<string, unknown>): Pick<FailureRecord, "fingerprintV"> | undefined {
  if (record.fingerprintV === undefined) return {};
  if (record.fingerprintV !== 1 && record.fingerprintV !== 2) return undefined;
  return { fingerprintV: record.fingerprintV as FingerprintAlgorithmVersion };
}

// A record's origin is defined but not one of the three known values — including when it
// isn't a string at all (a number, an object, null) — is read as "run" rather than
// discarding the whole record. Compatibility cost the spec accepts: an already-released
// v0.2.1 binary's parser only knows "run"/"hook" and still discards a "watch" record
// outright, so a v0.3 -> v0.2.1 downgrade loses those records. Accepted because the
// package is still beta; after v1, this kind of loosening must ship before any new
// origin value is introduced, not after.
function normalizeOrigin(origin: unknown): FailureOrigin | undefined {
  if (origin === undefined) return undefined;
  if (origin === "run" || origin === "hook" || origin === "watch") return origin;
  return "run";
}

export function parseMemoryRecord(value: unknown): MemoryRecord | undefined {
  try {
    return parseMemoryRecordUnsafe(value);
  } catch {
    return undefined;
  }
}

function parseMemoryRecordUnsafe(value: unknown): MemoryRecord | undefined {
  const record = objectValue(value);
  if (!record || typeof record.id !== "string" || record.id.length === 0 || record.id.length > 512 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(record.id) || !isSafeNonNegativeInteger(record.ts) ||
      typeof record.cwd !== "string") return undefined;
  if (record.kind === "failure") {
    const signature = strings(record.signature);
    const identity = identityFields(record);
    const fingerprintVersion = fingerprintFields(record);
    if (typeof record.exitCode !== "number" || !Number.isSafeInteger(record.exitCode) || typeof record.fingerprint !== "string" ||
        !signature || !identity || !fingerprintVersion || typeof record.excerpt !== "string" || typeof record.cmd !== "string") return undefined;
    const origin = normalizeOrigin(record.origin);
    return {
      kind: "failure", id: record.id, ts: Number(record.ts), cwd: record.cwd,
      cmd: record.cmd, exitCode: Number(record.exitCode), fingerprint: record.fingerprint,
      ...fingerprintVersion, signature, excerpt: record.excerpt,
      ...(origin === undefined ? {} : { origin }),
      ...identity,
    };
  }
  if (record.kind === "fix") {
    const failureIds = strings(record.failureIds);
    const candidateFailureIds = record.candidateFailureIds === undefined ? undefined : strings(record.candidateFailureIds);
    const identity = identityFields(record);
    if (!failureIds || !identity || (record.candidateFailureIds !== undefined && !candidateFailureIds) || typeof record.cmd !== "string") return undefined;
    let links: FixLink[] | undefined;
    if (record.links !== undefined) {
      links = parseFixLinks(record.links);
      if (!links) return undefined;
    }
    return {
      kind: "fix", id: record.id, ts: Number(record.ts), cwd: record.cwd, cmd: record.cmd, failureIds,
      ...(candidateFailureIds === undefined ? {} : { candidateFailureIds }),
      ...(links === undefined ? {} : { links }),
      ...identity,
    };
  }
  if (record.kind === "association") {
    const candidateFailureIds = strings(record.candidateFailureIds);
    const identity = identityFields(record);
    const links = parseFixLinks(record.links);
    if (!candidateFailureIds || !identity || !links || typeof record.cmd !== "string" ||
        links.some((link) => link.confidence !== "possible" || link.basis !== "program")) return undefined;
    return {
      kind: "association", id: record.id, ts: Number(record.ts), cwd: record.cwd, cmd: record.cmd,
      candidateFailureIds, links, ...identity,
    };
  }
  if (record.kind === "note") {
    if (typeof record.file !== "string" || typeof record.line !== "number" || !Number.isInteger(record.line) ||
        typeof record.subject !== "string" || typeof record.answer !== "string" || typeof record.cmd !== "string") return undefined;
    return {
      kind: "note", id: record.id, ts: Number(record.ts), cwd: record.cwd, cmd: record.cmd,
      file: record.file, line: Number(record.line), subject: record.subject, answer: record.answer,
    };
  }
  if (record.kind === "triple") return parseTripleRecord(record);
  return undefined;
}

function parseTripleRecord(record: Record<string, unknown>): TripleRecord | undefined {
  try {
    return parseTripleRecordUnsafe(record);
  } catch {
    return undefined;
  }
}

function parseTripleRecordUnsafe(record: Record<string, unknown>): TripleRecord | undefined {
  if (record.schemaV !== 1 || record.origin !== "agent-hook" ||
      (record.agent !== "claude-code" && record.agent !== "codex")) return undefined;

  const platform = record.platform === undefined ? undefined : record.platform;
  if (platform !== undefined && !isKnownPathPlatform(platform)) return undefined;

  const mechanism = objectValue(record.mechanism);
  if (!mechanism || !Array.isArray(mechanism.files) || mechanism.files.length > MAX_RECORD_ARRAY_ITEMS ||
      typeof mechanism.truncatedFiles !== "number" || !Number.isSafeInteger(mechanism.truncatedFiles) ||
      mechanism.truncatedFiles < 0 ||
      (mechanism.head !== undefined && typeof mechanism.head !== "string")) return undefined;

  const allFiles: TripleFile[] = [];
  const mechanismFilesLength = mechanism.files.length;
  for (let fileIndex = 0; fileIndex < mechanismFilesLength; fileIndex += 1) {
    const value = mechanism.files[fileIndex];
    const file = objectValue(value);
    const props = file ? strings(file.props) : undefined;
    if (!file || typeof file.path !== "string" || !Array.isArray(file.plusMinus) || file.plusMinus.length !== 2 ||
        !isSafeNonNegativeInteger(file.plusMinus[0]) ||
        !isSafeNonNegativeInteger(file.plusMinus[1]) ||
        props === undefined ||
        (file.excerpt !== undefined && typeof file.excerpt !== "string") ||
        (file.identityHash !== undefined && (typeof file.identityHash !== "string" || !/^[0-9a-f]{32}$/u.test(file.identityHash))) ||
        (file.provenance !== undefined && file.provenance !== "tool-observed" &&
          file.provenance !== "git-diff-inferred" && file.provenance !== "unknown")) return undefined;
    allFiles.push({
      path: file.path,
      plusMinus: [file.plusMinus[0], file.plusMinus[1]],
      props,
      ...(file.excerpt === undefined ? {} : { excerpt: file.excerpt }),
      ...(file.identityHash === undefined ? {} : { identityHash: file.identityHash }),
      ...(file.provenance === undefined ? {} : { provenance: file.provenance as TripleFile["provenance"] }),
    });
  }
  const baseline = mechanism.baseline === undefined ? undefined : mechanism.baseline;
  if (baseline !== undefined && baseline !== "captured" && baseline !== "unknown") return undefined;
  const coverageStatus = mechanism.coverageStatus === undefined ? undefined : mechanism.coverageStatus;
  if (coverageStatus !== undefined && coverageStatus !== "complete" && coverageStatus !== "truncated" && coverageStatus !== "unknown") return undefined;
  const bounded = boundTripleMechanism({
    ...(mechanism.head === undefined ? {} : { head: mechanism.head as string }),
    files: allFiles,
    truncatedFiles: mechanism.truncatedFiles,
    ...(baseline === undefined ? {} : { baseline }),
    ...(coverageStatus === undefined ? {} : { coverageStatus }),
  }, { platform: platform as NodeJS.Platform | undefined ?? "unknown", cwd: record.cwd as string });
  if (platform === undefined && bounded.files.length > 0) bounded.coverageStatus = "unknown";

  let intent: TripleRecord["intent"];
  if (record.intent !== undefined) {
    const value = objectValue(record.intent);
    if (!value || typeof value.text !== "string") return undefined;
    intent = { text: value.text };
  }

  let rationale: TripleRecord["rationale"];
  if (record.rationale !== undefined) {
    const value = objectValue(record.rationale);
    const tags = value ? strings(value.tags) : undefined;
    if (!value || typeof value.text !== "string" || !tags ||
        (value.source !== "transcript" && value.source !== "notify")) return undefined;
    rationale = { text: value.text, tags, source: value.source };
  }

  return {
    kind: "triple",
    id: record.id as string,
    ts: record.ts as number,
    cwd: record.cwd as string,
    schemaV: 1,
    agent: record.agent,
    origin: "agent-hook",
    ...(platform === undefined ? {} : { platform: platform as NodeJS.Platform }),
    ...(intent === undefined ? {} : { intent }),
    ...(rationale === undefined ? {} : { rationale }),
    mechanism: {
      ...(mechanism.head === undefined ? {} : { head: mechanism.head }),
      files: bounded.files,
      truncatedFiles: bounded.truncatedFiles,
      ...(baseline === undefined ? {} : { baseline }),
      coverageStatus: bounded.coverageStatus,
    },
  };
}

function parseFixLinks(value: unknown): FixLink[] | undefined {
  try {
    if (!Array.isArray(value) || value.length > MAX_RECORD_ARRAY_ITEMS) return undefined;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    const links: FixLink[] = [];
    let bytes = 0;
    for (let index = 0; index < length; index += 1) {
      const obj = objectValue(value[index]);
      if (!obj || typeof obj.id !== "string" || obj.id.length === 0 || obj.id.length > MAX_RECORD_ITEM_CHARS
          || /[\u0000-\u001f\u007f-\u009f]/u.test(obj.id) ||
          (obj.basis !== "identity" && obj.basis !== "signature" && obj.basis !== "program") ||
          (obj.confidence !== undefined && obj.confidence !== "confirmed" && obj.confidence !== "possible")) return undefined;
      const idBytes = Buffer.byteLength(obj.id, "utf8");
      if (bytes + idBytes > MAX_RECORD_ARRAY_BYTES) return undefined;
      bytes += idBytes;
      links.push({
        id: obj.id,
        basis: obj.basis,
        ...(obj.confidence === undefined ? {} : { confidence: obj.confidence }),
      });
    }
    return links;
  } catch {
    return undefined;
  }
}

function readFlags(): number {
  // POSIX provides both flags. Windows has no portable equivalent, so its
  // lstat/fstat type and identity checks below are the strongest available
  // protection there; a namespace race not observable through those checks is
  // a platform limitation of Node's descriptor API.
  return constants.O_RDONLY | NO_FOLLOW_FLAG | NO_BLOCK_FLAG;
}

export function loadMemoryChecked(path = resolveRockyPaths().memory, now = Date.now()): MemoryLoadResult {
  let descriptor: number | undefined;
  let listed: BigIntStats | undefined;
  let contents: string;
  try {
    listed = lstatSync(path, { bigint: true });
    if (!regularDescriptorSafe(listed) || !sameFilesystemIdentity(listed, listed)) return { records: [], complete: false };

    descriptor = openSync(path, readFlags());
    const opened = fstatSync(descriptor, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(listed, opened)) {
      return { records: [], complete: false };
    }

    contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    if (!regularDescriptorSafe(after) || !sameFilesystemIdentity(opened, after)
      || !sameFilesystemIdentity(listed, after)) {
      return { records: [], complete: false };
    }
  } catch {
    // Missing memory is a complete empty state; every other read failure is
    // incomplete and must be treated conservatively by mutation callers.
    // If the first lstat succeeded, a later open/read failure is a replacement
    // or I/O race even when a second lstat now reports ENOENT.
    if (listed !== undefined) return { records: [], complete: false };
    try {
      if (lstatSync(path, { bigint: true }).isFile()) return { records: [], complete: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], complete: true };
    }
    return { records: [], complete: false };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close must not expose memory-read details to callers.
      }
    }
  }

  const records: MemoryRecord[] = [];
  const seenIds = new Set<string>();
  for (const line of contents.split("\n")) {
    if (Buffer.byteLength(line, "utf8") > MAX_MEMORY_LINE_BYTES) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = parseMemoryRecord(JSON.parse(trimmed));
      // Append-only history can contain a repeated id after a crash or a
      // manual merge. First valid provenance wins; later duplicates are
      // retained only as inert bytes in the file, never in operational state.
      if (record && !seenIds.has(record.id)) {
        seenIds.add(record.id);
        records.push(record);
      }
    } catch {
      // a corrupt line never kills the memory; skip it
    }
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    if (record.kind !== "fix") continue;
    if (record.ts > now) continue;
    for (const failureId of record.failureIds) {
      const failure = byId.get(failureId);
      // Resolution is a one-way transition. Legacy duplicate fix lines stay
      // readable, but a later duplicate must not rewrite provenance or make
      // resolvedBy depend on append order beyond the first confirmed event.
      if (failure?.kind !== "failure" || failure.resolvedBy !== undefined || failure.ts > now || record.ts < failure.ts) continue;
      // Fix attribution is cwd-bound. Cross-directory recall still admits a
      // fix from elsewhere, but it must never mutate the failure's local
      // resolution state or clear a local pending marker.
      if (failure.cwd !== record.cwd) continue;
      const failureIdentity = failure.identityV === 1 && failure.commandIdentity !== undefined
        ? validateStoredIdentity(failure.cmd, failure.commandIdentity, failure.identityReliable, failure.platform)
        : commandIdentity(failure.cmd, { platform: failure.platform ?? "unknown" });
      const fixIdentity = record.identityV === 1 && record.commandIdentity !== undefined
        ? validateStoredIdentity(record.cmd, record.commandIdentity, record.identityReliable, record.platform)
        : commandIdentity(record.cmd, { platform: record.platform ?? "unknown" });
      // Old records remain readable, but legacy signature/program grades are
      // re-proved with v1 identity before they can count as resolved.
      if (failureIdentity.reliable && fixIdentity.reliable && failureIdentity.value === fixIdentity.value) {
        failure.resolvedBy = record.id;
      }
    }
  }
  return { records, complete: true };
}

/** Backward-compatible reader: malformed lines and unreadable files read as empty. */
export function loadMemory(path = resolveRockyPaths().memory, now = Date.now()): MemoryRecord[] {
  return loadMemoryChecked(path, now).records;
}

function validateStoredIdentity(
  cmd: string,
  value: string,
  reliable: boolean | undefined,
  platform: NodeJS.Platform | undefined,
): { value: string; reliable: boolean } {
  const derived = commandIdentity(cmd, { platform: platform ?? "unknown" });
  return { value, reliable: reliable === true && derived.reliable && value === derived.value };
}
