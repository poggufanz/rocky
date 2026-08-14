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
import { resolveRockyPaths } from "./state-paths.js";
import { commandIdentity } from "./fingerprint.js";

export type FailureOrigin = "run" | "hook" | "watch";

export interface FailureRecord {
  kind: "failure";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  exitCode: number;
  fingerprint: string;
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
  mechanism: { head?: string; files: TripleFile[]; truncatedFiles: number };
}

export type MemoryRecord = FailureRecord | FixRecord | NoteRecord | TripleRecord;

export const MAX_MEMORY_LINE_BYTES = 1024 * 1024;

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
    if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode) || typeof record.fingerprint !== "string" ||
        !signature || !identity || typeof record.excerpt !== "string" || typeof record.cmd !== "string") return undefined;
    const origin = normalizeOrigin(record.origin);
    return {
      kind: "failure", id: record.id, ts: Number(record.ts), cwd: record.cwd,
      cmd: record.cmd, exitCode: Number(record.exitCode), fingerprint: record.fingerprint,
      signature, excerpt: record.excerpt,
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
      typeof mechanism.truncatedFiles !== "number" || !Number.isInteger(mechanism.truncatedFiles) ||
      mechanism.truncatedFiles < 0 ||
      (mechanism.head !== undefined && typeof mechanism.head !== "string")) return undefined;

  const files: TripleFile[] = [];
  for (const value of mechanism.files) {
    const file = objectValue(value);
    if (!file || typeof file.path !== "string" || !Array.isArray(file.plusMinus) || file.plusMinus.length !== 2 ||
        typeof file.plusMinus[0] !== "number" || !Number.isFinite(file.plusMinus[0]) ||
        typeof file.plusMinus[1] !== "number" || !Number.isFinite(file.plusMinus[1]) ||
        !Array.isArray(file.props) || !file.props.every((prop) => typeof prop === "string") ||
        (file.excerpt !== undefined && typeof file.excerpt !== "string")) return undefined;
    files.push({
      path: file.path,
      plusMinus: [file.plusMinus[0], file.plusMinus[1]],
      props: [...file.props],
      ...(file.excerpt === undefined ? {} : { excerpt: file.excerpt }),
    });
  }

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
      files,
      truncatedFiles: mechanism.truncatedFiles,
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

export function loadMemory(path = resolveRockyPaths().memory): MemoryRecord[] {
  let descriptor: number | undefined;
  let contents: string;
  try {
    const listed = lstatSync(path);
    if (!listed.isFile() || listed.isSymbolicLink()) return [];

    descriptor = openSync(path, readFlags());
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.isSymbolicLink() || !sameFileIdentity(listed, opened)) return [];

    contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.isSymbolicLink() || !sameFileIdentity(opened, after)) return [];
  } catch {
    return [];
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
  for (const line of contents.split("\n")) {
    if (Buffer.byteLength(line, "utf8") > MAX_MEMORY_LINE_BYTES) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = parseMemoryRecord(JSON.parse(trimmed));
      if (record) records.push(record);
    } catch {
      // a corrupt line never kills the memory; skip it
    }
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    if (record.kind !== "fix") continue;
    for (const failureId of record.failureIds) {
      const failure = byId.get(failureId);
      if (failure?.kind !== "failure") continue;
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
  return records;
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
