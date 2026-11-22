import { isAbsolute, win32 } from "node:path";
import { isSafeSessionId } from "./agent-session.js";
import type { AgentStamp } from "./memory-read.js";

export const TOOL_RESULT_STDIN_CAP_BYTES = 1024 * 1024;

export type RockyWrap = "plain" | "wrapped" | "undecidable";

export type ToolResultEvent =
  | { kind: "failure"; cmd: string; cwd: string; exitCode: number; body: string; agent: AgentStamp }
  | { kind: "pass"; cmd: string; cwd: string; agent: AgentStamp }
  | { kind: "skip"; reason: "interrupt" | "background" | "no-exit-header" | "wrapped" | "undecidable" };

const DECODER = new TextDecoder("utf-8");
const CONTROL_CHAR = /\p{Cc}/u;
const EXIT_CODE_HEADER = /^Exit code (-?\d+)$/;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const LEADING_CALL_OP = /^&[ \t]+/;
const LEADING_ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|()]*)[ \t]+/;
const LEADING_CD_PREFIX = /^cd[ \t]+(?:"[^"]*"|'[^']*'|[^\s;&|]+)[ \t]*(?:&&|;)[ \t]*/;

const DOUBLE_QUOTED_HEAD = /^"([^"]*)"(?:[ \t]+|$)/;
const SINGLE_QUOTED_HEAD = /^'([^']*)'(?:[ \t]+|$)/;
const UNQUOTED_HEAD = /^([^\s"'&|;()]+)(?:[ \t]+|$)/;

const ROCKY_BASENAMES = new Set(["rocky", "rocky.cmd", "rocky.ps1"]);
const ROCKY_SUBCOMMAND = /^(?:run|watch)(?=$|[\s;&|()])/;
const TOP_LEVEL_SHELL_OP = /&&|\|\||[;|(\r\n]/;
const ROCKY_IN_TEXT =
  /(?:^|[\s;&|()/\\])[rR][oO][cC][kK][yY](?:\.[cC][mM][dD]|\.[pP][sS]1)?[ \t]+(?:run|watch)(?=$|[\s;&|()])/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidCwd(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !CONTROL_CHAR.test(value) && isAbsolute(value);
}

function isRockyBinary(token: string): boolean {
  if (token.length === 0 || token.endsWith("/") || token.endsWith("\\")) return false;
  return ROCKY_BASENAMES.has(win32.basename(token).toLowerCase());
}

function blankQuotedSpans(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      if (ch === "'") {
        while (j < input.length && input[j] !== "'") j++;
      } else {
        while (j < input.length && input[j] !== '"') {
          if (input[j] === "\\" && j + 1 < input.length && (input[j + 1] === '"' || input[j + 1] === "\\")) {
            j += 2;
          } else {
            j++;
          }
        }
      }
      if (j < input.length) {
        out += " ".repeat(j - i + 1);
        i = j + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function stripLeadingPrefixes(input: string): string {
  let rest = input;
  for (;;) {
    const trimmed = rest.trimStart();
    const match =
      LEADING_CALL_OP.exec(trimmed) ??
      LEADING_ENV_ASSIGN.exec(trimmed) ??
      LEADING_CD_PREFIX.exec(trimmed);
    if (!match) return trimmed;
    rest = trimmed.slice(match[0].length);
  }
}

function extractHeadToken(input: string): { token: string; rest: string } | undefined {
  const match =
    DOUBLE_QUOTED_HEAD.exec(input) ??
    SINGLE_QUOTED_HEAD.exec(input) ??
    UNQUOTED_HEAD.exec(input);
  if (!match) return undefined;
  return { token: match[1], rest: input.slice(match[0].length) };
}

export function classifyRockyWrap(command: string): RockyWrap {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "plain";

  const stripped = stripLeadingPrefixes(trimmed);
  const head = extractHeadToken(stripped);
  if (head && isRockyBinary(head.token)) {
    const subMatch = ROCKY_SUBCOMMAND.exec(head.rest);
    if (subMatch) {
      const rest = head.rest.slice(subMatch[0].length);
      return TOP_LEVEL_SHELL_OP.test(blankQuotedSpans(rest)) ? "undecidable" : "wrapped";
    }
  }

  return ROCKY_IN_TEXT.test(blankQuotedSpans(trimmed)) ? "undecidable" : "plain";
}

export function parseExitCodeHeader(error: string): { exitCode: number; body: string } | undefined {
  const nl = error.indexOf("\n");
  const rawFirstLine = nl === -1 ? error : error.slice(0, nl);
  const body = nl === -1 ? "" : error.slice(nl + 1);
  const firstLine = (rawFirstLine.endsWith("\r") ? rawFirstLine.slice(0, -1) : rawFirstLine).trim();
  const match = EXIT_CODE_HEADER.exec(firstLine);
  if (!match) return undefined;

  const exitCode = Number(match[1]);
  if (!Number.isSafeInteger(exitCode) || exitCode === 0 || exitCode < INT32_MIN || exitCode > INT32_MAX) {
    return undefined;
  }
  return { exitCode, body };
}

export function parseToolResultPayload(stdin: Uint8Array): ToolResultEvent | undefined {
  if (stdin.byteLength > TOOL_RESULT_STDIN_CAP_BYTES) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(stdin));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const eventName = parsed.hook_event_name;
  if (eventName !== "PostToolUse" && eventName !== "PostToolUseFailure") return undefined;

  const toolName = parsed.tool_name;
  if (toolName !== "Bash" && toolName !== "PowerShell") return undefined;

  const toolInput = parsed.tool_input;
  if (!isRecord(toolInput)) return undefined;
  const cmd = toolInput.command;
  if (typeof cmd !== "string" || cmd.trim().length === 0) return undefined;

  if (!isValidCwd(parsed.cwd)) return undefined;
  const cwd = parsed.cwd;

  if (!isSafeSessionId(parsed.session_id)) return undefined;
  const agent: AgentStamp = { vendor: "claude-code", session: parsed.session_id };
  if (isSafeSessionId(parsed.agent_id)) agent.agentId = parsed.agent_id;
  if (isSafeSessionId(parsed.tool_use_id)) agent.toolUseId = parsed.tool_use_id;

  const wrap = classifyRockyWrap(cmd);
  if (wrap === "wrapped") return { kind: "skip", reason: "wrapped" };
  if (wrap === "undecidable") return { kind: "skip", reason: "undecidable" };

  if (eventName === "PostToolUseFailure") {
    if (parsed.is_interrupt === true) return { kind: "skip", reason: "interrupt" };
  } else if (isRecord(parsed.tool_response) && parsed.tool_response.interrupted === true) {
    return { kind: "skip", reason: "interrupt" };
  }

  if (toolInput.run_in_background === true) return { kind: "skip", reason: "background" };

  if (eventName === "PostToolUse") {
    return { kind: "pass", cmd, cwd, agent };
  }

  if (typeof parsed.error !== "string") return undefined;
  const header = parseExitCodeHeader(parsed.error);
  if (!header) return { kind: "skip", reason: "no-exit-header" };

  return {
    kind: "failure",
    cmd,
    cwd,
    exitCode: header.exitCode,
    body: header.body,
    agent,
  };
}
