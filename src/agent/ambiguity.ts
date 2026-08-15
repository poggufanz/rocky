import { Buffer } from "node:buffer";
import { loadConfig, type ConfigLoadResult } from "../core/config-read.js";
import { tokens } from "../core/fingerprint.js";
import { isCompleteMemoryCoverage, loadMemoryChecked, type MemoryRecord, type TripleRecord } from "../core/memory-read.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import { defaultQueueLabel } from "./annotate.js";
import { createOllamaClient, type OllamaClient } from "../ai/ollama.js";

const MAX_REFERENT_CHARS = 60;
const MAX_CANDIDATES = 20;
const MAX_CANDIDATE_CHARS = 512;
const MAX_INTENT_CHARS = 2_000;
const MAX_PAYLOAD_BYTES = 16 * 1024;

export const AMBIGUITY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    ambiguous: { type: "boolean" },
    referent: { type: "string" },
  },
  required: ["ambiguous", "referent"],
};

export interface AmbiguityDeps {
  paths?: RockyPaths;
  load?: () => MemoryRecord[];
  client?: OllamaClient;
  config?: ConfigLoadResult;
  queueLabel?: (line: string, paths: RockyPaths) => void;
}

interface PlainRecord {
  [key: string]: unknown;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => typeof key === "string");
  } catch {
    return false;
  }
}

function ownKeysAreExact(record: PlainRecord): boolean {
  try {
    const keys = Reflect.ownKeys(record);
    return keys.length === 2 && keys.every((key) => key === "ambiguous" || key === "referent");
  } catch {
    return false;
  }
}

function capCharacters(value: string, maximum: number): string {
  const characters = [...value];
  return characters.length <= maximum ? value : characters.slice(0, maximum).join("");
}

function hasUnsafeLineContent(value: string): boolean {
  if (value.includes("?")) return true;
  // Keep model output exact when it is ordinary text. Any terminal/control or
  // format character is rejected rather than normalized into a different claim.
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(value)) return true;
  // Reject both seven-bit and eight-bit ANSI/control strings, including an
  // incomplete escape sequence, without persisting or queuing any fragment.
  const stripped = value
    .replace(/\u001b(?:\][\s\S]*?(?:\u0007|\u001b\\)|P[\s\S]*?(?:\u0007|\u001b\\)|\^[\s\S]*?(?:\u0007|\u001b\\)|_[\s\S]*?(?:\u0007|\u001b\\)|X[\s\S]*?(?:\u0007|\u001b\\))/gu, "")
    .replace(/[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u009c|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[()][0-2A-Z0-9]/gu, "");
  return stripped !== value;
}

export function parseAmbiguityOutput(value: unknown): { ambiguous: boolean; referent: string } | undefined {
  try {
    if (!isPlainRecord(value) || !ownKeysAreExact(value)) return undefined;
    if (typeof value.ambiguous !== "boolean" || typeof value.referent !== "string") return undefined;
    const referent = capCharacters(value.referent.trim(), MAX_REFERENT_CHARS);
    if (hasUnsafeLineContent(referent)) return undefined;
    return { ambiguous: value.ambiguous, referent };
  } catch {
    return undefined;
  }
}

function enabledOllamaModel(result: ConfigLoadResult): string | undefined {
  try {
    if (result.status !== "valid") return undefined;
    const ai = result.config.ai;
    if (ai.enabled !== true) return undefined;
    return ai.provider === "ollama" && typeof ai.model === "string" && ai.model.trim().length > 0
      ? ai.model
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedText(value: string, maximum: number): string {
  return capCharacters(value, maximum);
}

function valueTokens(value: string, path = false): Set<string> {
  // fingerprint tokenization intentionally masks slash-prefixed paths. For
  // ambiguity evidence, split path separators first so a basename such as
  // "button.tsx" remains hearable without reading the file itself.
  return tokens(path ? value.replace(/[\\/]+/gu, " ") : value);
}

function tripleRecords(records: readonly MemoryRecord[]): TripleRecord[] {
  return records.filter((record): record is TripleRecord => record.kind === "triple");
}

function filesOf(record: TripleRecord): readonly { path: string; props: readonly string[] }[] {
  try {
    return record.mechanism.files;
  } catch {
    return [];
  }
}

function candidateValues(records: readonly MemoryRecord[], intentText: string): string[] {
  const intentTokens = tokens(intentText);
  if (intentTokens.size === 0) return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const record of tripleRecords(records)) {
    for (const file of filesOf(record)) {
      const values: readonly string[] = [file.path, ...file.props];
      for (const value of values) {
        if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
        let intersects = false;
        try {
          const candidateTokens = valueTokens(value, value.includes("/") || value.includes("\\"));
          for (const token of candidateTokens) {
            if (intentTokens.has(token)) {
              intersects = true;
              break;
            }
          }
        } catch {
          intersects = false;
        }
        if (!intersects) continue;
        const candidate = boundedText(value, MAX_CANDIDATE_CHARS);
        if (seen.has(candidate)) continue;
        seen.add(value);
        seen.add(candidate);
        candidates.push(candidate);
        if (candidates.length >= MAX_CANDIDATES) return candidates;
      }
    }
  }
  return candidates;
}

function ambiguityPrompt(intentText: string, candidates: readonly string[]): string {
  const quotedCandidates = candidates.map((candidate) => JSON.stringify(candidate));
  return [
    "intent text:",
    JSON.stringify(intentText),
    "known things I hear before:",
    ...quotedCandidates.map((candidate) => `- ${candidate}`),
    "instructions:",
    "mark ambiguous ONLY when one short referent in the text matches several known things;",
    "never guess what user means; referent = the ambiguous words only.",
    "return only JSON matching supplied schema.",
  ].join("\n");
}

function pathAndPropsTokens(path: string, props: readonly string[], referentTokens: Set<string>): boolean {
  try {
    const pathTokens = valueTokens(path, true);
    for (const token of pathTokens) if (referentTokens.has(token)) return true;
    for (const prop of props) {
      if (typeof prop !== "string") continue;
      const propTokens = valueTokens(prop);
      for (const token of propTokens) if (referentTokens.has(token)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function referentPlaces(records: readonly MemoryRecord[], referent: string): number {
  try {
    if (!Array.isArray(records) || typeof referent !== "string") return 0;
    const referentTokens = tokens(referent);
    if (referentTokens.size === 0) return 0;
    const places = new Set<string>();
    for (const record of tripleRecords(records)) {
      for (const file of filesOf(record)) {
        if (typeof file.path !== "string" || file.path.length === 0 || !Array.isArray(file.props)) continue;
        if (pathAndPropsTokens(file.path, file.props, referentTokens)) places.add(file.path);
      }
    }
    return places.size;
  } catch {
    return 0;
  }
}

export async function checkAmbiguity(intentText: string, deps: AmbiguityDeps = {}): Promise<string | undefined> {
  try {
    if (typeof intentText !== "string" || intentText.trim().length === 0) return undefined;
    const paths = deps.paths ?? resolveRockyPaths();
    const configured = deps.config ?? loadConfig(paths.config);
    const model = enabledOllamaModel(configured);
    if (model === undefined) return undefined;

    const boundedIntent = boundedText(intentText, MAX_INTENT_CHARS);
    const records = deps.load
      ? deps.load()
      : (() => {
        const loaded = loadMemoryChecked(paths.memory);
        return isCompleteMemoryCoverage(loaded.coverage) ? loaded.records : undefined;
      })();
    if (!Array.isArray(records)) return undefined;
    const candidates = candidateValues(records, boundedIntent);

    const client = deps.client ?? createOllamaClient();
    const signal = AbortSignal.timeout(10_000);
    const output = await client.generateStructured(
      model,
      ambiguityPrompt(boundedIntent, candidates),
      AMBIGUITY_SCHEMA,
      signal,
    );
    if (signal.aborted) return undefined;
    const parsed = parseAmbiguityOutput(output);
    if (!parsed?.ambiguous || parsed.referent.length === 0) return undefined;
    const places = referentPlaces(records, parsed.referent);
    if (places < 2) return undefined;
    const question = `you say "${parsed.referent}". I hear ${places} ${parsed.referent} before. which one, question`;
    if (hasUnsafeLineContent(question)) return undefined;
    if (question.includes("\n") || question.includes("\r") || Buffer.byteLength(question, "utf8") > 512) return undefined;
    const queue = deps.queueLabel ?? defaultQueueLabel;
    queue(question, paths);
    return question;
  } catch {
    return undefined;
  }
}

function decodePayload(payloadBase64: string): string | undefined {
  try {
    if (typeof payloadBase64 !== "string" || payloadBase64.length === 0) return undefined;
    if (payloadBase64.length > MAX_PAYLOAD_BYTES || !/^[A-Za-z0-9_-]+$/u.test(payloadBase64)) return undefined;
    if (payloadBase64.length % 4 === 1) return undefined;
    const bytes = Buffer.from(payloadBase64, "base64url");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PAYLOAD_BYTES) return undefined;
    if (bytes.toString("base64url") !== payloadBase64) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length === 0 || text.length > MAX_INTENT_CHARS) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

export async function ambiguityCommand(payloadBase64: string): Promise<number> {
  try {
    const text = decodePayload(payloadBase64);
    if (text !== undefined) await checkAmbiguity(text);
  } catch {
    // Hidden detached work is always best effort and never affects the shell.
  }
  return 0;
}
