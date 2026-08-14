import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { resolveRockyPaths } from "./state-paths.js";
import { commandIdentity, type FingerprintAlgorithmVersion } from "./fingerprint.js";

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

export function pathIdentityHash(value: string): string {
  return createHash("sha256").update(canonicalPath(value), "utf8").digest("hex").slice(0, 32);
}

export interface TripleRecord {
  kind: "triple";
  id: string;
  ts: number;
  cwd: string;
  schemaV: 1;
  agent: "claude-code" | "codex";
  origin: "agent-hook";
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

const ANSI_OR_OSC = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u009d[^\u009c]*(?:\u009c|$)|\u009b[0-?]*[ -/]*[@-~])/gu;

/** Shared canonical file identity. See README for platform case policy. */
export function canonicalPath(value: string): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(ANSI_OR_OSC, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060-\u206f\ufeff]/gu, "");
  const trimmed = cleaned.trim();
  if (!trimmed) return "";
  let normalized = trimmed.replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
  const absolute = normalized.startsWith("/");
  const segments = normalized.split("/").filter((segment) => segment !== ".");
  normalized = segments.join("/");
  if (absolute) normalized = `/${normalized}`;
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
export function boundTripleMechanism(mechanism: TripleRecord["mechanism"]): TripleRecord["mechanism"] {
  const source = (mechanism ?? {}) as unknown as Record<string, unknown>;
  const rawFiles = Array.isArray(source.files) ? source.files : [];
  let valid = Array.isArray(source.files);
  const byIdentity = new Map<string, TripleFile>();
  for (const value of rawFiles) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      valid = false;
      continue;
    }
    const raw = value as Record<string, unknown>;
    const path = typeof raw.path === "string" ? canonicalPath(raw.path) : "";
    const ephemeralIdentity = ephemeralTripleIdentities.get(value as object);
    const rawIdentityHash = raw.identityHash;
    const identityHash = typeof rawIdentityHash === "string" && /^[0-9a-f]{32}$/u.test(rawIdentityHash)
      ? rawIdentityHash
      : undefined;
    if (rawIdentityHash !== undefined && identityHash === undefined) valid = false;
    const plusMinus = Array.isArray(raw.plusMinus) && raw.plusMinus.length === 2
      ? raw.plusMinus
      : undefined;
    const plusMinusValid = plusMinus !== undefined
      && isSafeNonNegativeInteger(plusMinus[0]) && isSafeNonNegativeInteger(plusMinus[1]);
    if (!path || !plusMinusValid || !Array.isArray(raw.props) || !raw.props.every((prop) => typeof prop === "string")) {
      valid = false;
      continue;
    }
    const file: TripleFile = {
      path,
      plusMinus: plusMinusValid ? [plusMinus[0] as number, plusMinus[1] as number] : [0, 0],
      props: [...raw.props] as string[],
      ...(typeof raw.excerpt === "string" ? { excerpt: raw.excerpt } : {}),
      ...(raw.provenance === "tool-observed" || raw.provenance === "git-diff-inferred" || raw.provenance === "unknown"
        ? { provenance: raw.provenance }
        : {}),
      ...(identityHash === undefined ? {} : { identityHash }),
    };
    // Map.set replaces evidence without changing first-seen insertion order.
    byIdentity.set(identityHash ?? ephemeralIdentity ?? path, file);
  }
  const allFiles = [...byIdentity.values()];
  const files = allFiles.slice(0, MAX_TRIPLE_FILES);
  const declared = source.truncatedFiles;
  const added = addTruncatedFiles(isSafeNonNegativeInteger(declared) ? declared : 0, Math.max(0, allFiles.length - files.length));
  if (!isSafeNonNegativeInteger(declared)) valid = false;
  if (source.coverageStatus !== undefined && source.coverageStatus !== "complete" &&
      source.coverageStatus !== "truncated" && source.coverageStatus !== "unknown") valid = false;
  const truncatedFiles = added.value;
  const coverageStatus = normalizedCoverageStatus(
    source.coverageStatus as TripleRecord["mechanism"]["coverageStatus"], truncatedFiles, valid && added.valid, files,
  );
  return {
    ...(typeof source.head === "string" ? { head: source.head } : {}),
    files: files.map((file) => ({
      ...file,
      plusMinus: [...file.plusMinus] as [number, number],
      props: [...file.props],
    })),
    truncatedFiles,
    ...(source.baseline === "captured" || source.baseline === "unknown" ? { baseline: source.baseline } : {}),
    coverageStatus,
  };
}

export function boundTripleRecord(record: TripleRecord): TripleRecord {
  return { ...record, mechanism: boundTripleMechanism(record.mechanism) };
}

export type MemoryRecord = FailureRecord | FixRecord | AssociationRecord | NoteRecord | TripleRecord;

export const MAX_MEMORY_LINE_BYTES = 1024 * 1024;

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
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function identityFields(record: Record<string, unknown>): Pick<FailureRecord, "commandIdentity" | "identityV" | "identityReliable" | "platform"> | undefined {
  if (record.commandIdentity === undefined && record.identityV === undefined &&
      record.identityReliable === undefined && record.platform === undefined) return {};
  if (typeof record.commandIdentity !== "string" || record.identityV !== 1 ||
      typeof record.identityReliable !== "boolean" || typeof record.platform !== "string") return undefined;
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
  const record = objectValue(value);
  if (!record || typeof record.id !== "string" || typeof record.ts !== "number" || !Number.isFinite(record.ts) ||
      typeof record.cwd !== "string") return undefined;
  if (record.kind === "failure") {
    const signature = strings(record.signature);
    const identity = identityFields(record);
    const fingerprintVersion = fingerprintFields(record);
    if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode) || typeof record.fingerprint !== "string" ||
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
  if (record.schemaV !== 1 || record.origin !== "agent-hook" ||
      (record.agent !== "claude-code" && record.agent !== "codex")) return undefined;

  const mechanism = objectValue(record.mechanism);
  if (!mechanism || !Array.isArray(mechanism.files) ||
      typeof mechanism.truncatedFiles !== "number" || !Number.isSafeInteger(mechanism.truncatedFiles) ||
      mechanism.truncatedFiles < 0 ||
      (mechanism.head !== undefined && typeof mechanism.head !== "string")) return undefined;

  const allFiles: TripleFile[] = [];
  for (const value of mechanism.files) {
    const file = objectValue(value);
    if (!file || typeof file.path !== "string" || !Array.isArray(file.plusMinus) || file.plusMinus.length !== 2 ||
        !isSafeNonNegativeInteger(file.plusMinus[0]) ||
        !isSafeNonNegativeInteger(file.plusMinus[1]) ||
        !Array.isArray(file.props) || !file.props.every((prop) => typeof prop === "string") ||
        (file.excerpt !== undefined && typeof file.excerpt !== "string") ||
        (file.identityHash !== undefined && (typeof file.identityHash !== "string" || !/^[0-9a-f]{32}$/u.test(file.identityHash))) ||
        (file.provenance !== undefined && file.provenance !== "tool-observed" &&
          file.provenance !== "git-diff-inferred" && file.provenance !== "unknown")) return undefined;
    allFiles.push({
      path: file.path,
      plusMinus: [file.plusMinus[0], file.plusMinus[1]],
      props: [...file.props],
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
  });

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
  if (!Array.isArray(value)) return undefined;
  const links: FixLink[] = [];
  for (const entry of value) {
    const obj = objectValue(entry);
    if (!obj || typeof obj.id !== "string" ||
        (obj.basis !== "identity" && obj.basis !== "signature" && obj.basis !== "program") ||
        (obj.confidence !== undefined && obj.confidence !== "confirmed" && obj.confidence !== "possible")) return undefined;
    links.push({
      id: obj.id,
      basis: obj.basis,
      ...(obj.confidence === undefined ? {} : { confidence: obj.confidence }),
    });
  }
  return links;
}

function readFlags(): number {
  // POSIX provides both flags. Windows has no portable equivalent, so its
  // lstat/fstat type and identity checks below are the strongest available
  // protection there; a namespace race not observable through those checks is
  // a platform limitation of Node's descriptor API.
  const noFollow = process.platform === "win32" || !("O_NOFOLLOW" in constants)
    ? 0
    : constants.O_NOFOLLOW;
  const nonblock = process.platform === "win32" || !("O_NONBLOCK" in constants)
    ? 0
    : constants.O_NONBLOCK;
  return constants.O_RDONLY | noFollow | nonblock;
}

function sameFileIdentity(expected: Stats, opened: Stats): boolean {
  return expected.dev === opened.dev && expected.ino === opened.ino;
}

export function loadMemoryChecked(path = resolveRockyPaths().memory, now = Date.now()): MemoryLoadResult {
  let descriptor: number | undefined;
  let listed: Stats | undefined;
  let contents: string;
  try {
    listed = lstatSync(path);
    if (!listed.isFile() || listed.isSymbolicLink()) return { records: [], complete: false };

    descriptor = openSync(path, readFlags());
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.isSymbolicLink() || !sameFileIdentity(listed, opened)) {
      return { records: [], complete: false };
    }

    contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.isSymbolicLink() || !sameFileIdentity(opened, after)) {
      return { records: [], complete: false };
    }
  } catch {
    // Missing memory is a complete empty state; every other read failure is
    // incomplete and must be treated conservatively by mutation callers.
    // If the first lstat succeeded, a later open/read failure is a replacement
    // or I/O race even when a second lstat now reports ENOENT.
    if (listed !== undefined) return { records: [], complete: false };
    try {
      if (lstatSync(path).isFile()) return { records: [], complete: false };
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
