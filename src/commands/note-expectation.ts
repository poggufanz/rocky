import { mcpWriteDisabled, safeOpaqueIdentifier } from "../core/mcp-write-input.js";
import { LINK_WINDOW_MS } from "../core/memory-query.js";
import {
  cwdIdentityKey,
  loadMemoryChecked,
  MAX_EXPECTED_COMMAND_CODE_POINTS,
  windowCovered,
  type MemoryRecord,
} from "../core/memory-read.js";
import { boundRationaleExcerpt, recordRationale } from "../core/memory.js";
import { sanitizeTestimony } from "../core/redact.js";
import { resolveRockyPaths } from "../core/state-paths.js";

export const NOTE_EXPECTATION_STDIN_CAP_BYTES = 8 * 1024;
const MAX_TEXT_CODE_POINTS = 200;
const DEDUP_WINDOW_MS = 10 * 60 * 1_000;
const CAP_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_MCP_RATIONALES = 100;

export type NoteExpectationReason = "duplicate" | "cap" | "disabled" | "invalid_input" | "memory_unavailable";

export interface NoteExpectationReply {
  recorded: boolean;
  id?: string;
  reason?: NoteExpectationReason;
  linkedFailure: boolean;
}

interface NoteExpectationInput {
  text: string;
  command?: string;
  failureId?: string;
  agent: "claude-code" | "codex" | "generic";
}

function boundedString(value: unknown, maxCodePoints: number): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= maxCodePoints;
}

function parseInput(stdin: Buffer): NoteExpectationInput | undefined {
  if (stdin.byteLength > NOTE_EXPECTATION_STDIN_CAP_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stdin.toString("utf8"));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { text, command, failureId, agent } = value as Record<string, unknown>;
  if (!boundedString(text, MAX_TEXT_CODE_POINTS)
    || (command !== undefined && !boundedString(command, MAX_EXPECTED_COMMAND_CODE_POINTS))
    || (failureId !== undefined && (typeof failureId !== "string" || !safeOpaqueIdentifier(failureId)))
    || (agent !== "claude-code" && agent !== "codex" && agent !== "generic")) return undefined;
  return { text, command, failureId, agent };
}

function linkFailure(records: readonly MemoryRecord[], cwdKey: string, now: number, requestedId?: string): string | undefined {
  let newestUnresolved: { id: string; ts: number } | undefined;
  for (const record of records) {
    if (record.kind !== "failure" || record.ts < now - LINK_WINDOW_MS || record.ts > now
      || cwdIdentityKey(record.cwd, process.platform) !== cwdKey) continue;
    if (record.id === requestedId) return record.id;
    if (record.resolvedBy === undefined && (newestUnresolved === undefined || record.ts >= newestUnresolved.ts)) {
      newestUnresolved = record;
    }
  }
  return newestUnresolved?.id;
}

function decline(reason: NoteExpectationReason): string {
  const reply: NoteExpectationReply = { recorded: false, reason, linkedFailure: false };
  return JSON.stringify(reply);
}

export function noteExpectationHook(stdin: Buffer, opts: { now: number; cwd: string; env: NodeJS.ProcessEnv }): string {
  try {
    const { now, cwd, env } = opts;
    const paths = resolveRockyPaths(env, undefined, cwd);
    if (mcpWriteDisabled(env, paths.home)) return decline("disabled");

    const input = parseInput(stdin);
    if (input === undefined) return decline("invalid_input");
    const text = sanitizeTestimony(input.text);
    // Redaction markers can grow the input. Compare the bounded command that the writer keeps.
    const expectedCommand = input.command === undefined ? undefined
      : [...sanitizeTestimony(input.command)].slice(0, MAX_EXPECTED_COMMAND_CODE_POINTS).join("");
    if (text.length === 0 || expectedCommand?.length === 0) return decline("invalid_input");

    const { records, coverage } = loadMemoryChecked(paths.memory, now);
    if (!windowCovered(coverage, now, CAP_WINDOW_MS)) return decline("memory_unavailable");
    const cwdKey = cwdIdentityKey(cwd, process.platform);
    const failureId = linkFailure(records, cwdKey, now, input.failureId);
    const excerpt = boundRationaleExcerpt(text);

    // ponytail: Deduplication and cap checks run outside the memory lock, so
    // two concurrent calls can both pass. That is acceptable for advisory
    // records. If that changes, move the checks into withMemoryTransaction.
    let recentCount = 0;
    for (const record of records) {
      if (record.kind !== "rationale" || record.source !== "mcp") continue;
      if (record.ts >= now - DEDUP_WINDOW_MS && record.excerpt === excerpt
        && record.expectedCommand === expectedCommand && record.links?.failureId === failureId
        && cwdIdentityKey(record.cwd, process.platform) === cwdKey) return decline("duplicate");
      if (record.ts > now - CAP_WINDOW_MS) recentCount++;
    }
    if (recentCount >= MAX_MCP_RATIONALES) return decline("cap");

    const record = recordRationale({
      cwd,
      ts: now,
      agent: input.agent,
      rationale_fidelity: "raw",
      source: "mcp",
      text,
      ...(expectedCommand === undefined ? {} : { expectedCommand }),
      ...(failureId === undefined ? {} : { links: { failureId } }),
    }, paths);
    const reply: NoteExpectationReply = { recorded: true, id: record.id, linkedFailure: failureId !== undefined };
    return JSON.stringify(reply);
  } catch {
    return decline("memory_unavailable");
  }
}
