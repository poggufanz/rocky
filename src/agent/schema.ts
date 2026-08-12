import { createHash } from "node:crypto";

export type AgentName = "claude-code" | "codex";

export interface IntentEvent {
  v: 1;
  agent: AgentName;
  kind: "intent";
  ts: number;
  cwd?: string;
  text: string;
}

export interface MechanismEvent {
  v: 1;
  agent: AgentName;
  kind: "mechanism";
  ts: number;
  tool: string;
  path: string;
  excerpt?: string;
}

export interface RationaleEvent {
  v: 1;
  agent: AgentName;
  kind: "rationale";
  ts: number;
  source: "transcript" | "notify";
  text: string;
}

export type AgentEvent = IntentEvent | MechanismEvent | RationaleEvent;

export const MAX_INTENT_CHARS = 2000;
export const MAX_RATIONALE_CHARS = 2000;
export const MAX_EXCERPT_CHARS = 400;

const MAX_BATCH_KEY_CHARS = 120;
const AGENTS: ReadonlySet<string> = new Set(["claude-code", "codex"]);
const FILENAME_SAFE = /^[A-Za-z0-9_-]+$/;

function str(value: unknown, cap: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, cap) : undefined;
}

export function parseAgentEvent(value: unknown): AgentEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (typeof record.agent !== "string" || !AGENTS.has(record.agent)) return undefined;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return undefined;
  const agent = record.agent as AgentName;
  const ts = record.ts;

  switch (record.kind) {
    case "intent": {
      const text = str(record.text, MAX_INTENT_CHARS);
      if (!text) return undefined;
      const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
      return { v: 1, agent, kind: "intent", ts, ...(cwd ? { cwd } : {}), text };
    }
    case "mechanism": {
      const path = str(record.path, 1024);
      const tool = str(record.tool, 64);
      if (!path || !tool) return undefined;
      const excerpt = str(record.excerpt, MAX_EXCERPT_CHARS);
      return { v: 1, agent, kind: "mechanism", ts, tool, path, ...(excerpt ? { excerpt } : {}) };
    }
    case "rationale": {
      const text = str(record.text, MAX_RATIONALE_CHARS);
      if (!text) return undefined;
      const source = record.source === "notify"
        ? "notify"
        : record.source === "transcript"
          ? "transcript"
          : undefined;
      if (!source) return undefined;
      return { v: 1, agent, kind: "rationale", ts, source, text };
    }
    default:
      return undefined;
  }
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function keyDigest(agent: AgentName, session: string, turn: string): string {
  // Hash a structured value, not the display form.  Joining with hyphens would
  // make (session: "a-b", turn: "c") collide with (session: "a", turn: "b-c").
  return createHash("sha256")
    .update(JSON.stringify([agent, session, turn]), "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function batchKey(agent: AgentName, session: string, turn: string): string {
  const raw = `${agent}-${session}-${turn}`;
  const componentsAreUnambiguous = session.length > 0 && turn.length > 0
    && !session.includes("-") && !turn.includes("-");
  if (componentsAreUnambiguous && raw.length <= MAX_BATCH_KEY_CHARS && FILENAME_SAFE.test(raw)) return raw;

  const prefix = `${sanitizeKeyPart(agent)}-`;
  const suffix = `-${keyDigest(agent, session, turn)}`;
  const body = sanitizeKeyPart(`${session}-${turn}`);
  const available = Math.max(0, MAX_BATCH_KEY_CHARS - prefix.length - suffix.length);
  return `${prefix}${body.slice(0, available)}${suffix}`;
}
