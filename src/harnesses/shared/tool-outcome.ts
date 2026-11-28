import type { ParsedHookPayload } from "../../agent/adapters/claude-code.js";
import { classifyRockyWrap } from "../../core/tool-result.js";
import type { NormalizedToolOutcome } from "../types.js";
import { field, type Fields } from "./field-extract.js";

const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;

export function editOutcome(agent: ParsedHookPayload): NormalizedToolOutcome | undefined {
  if (agent?.action !== "append") return undefined;
  const edits = agent.events.flatMap((event) => event.kind === "mechanism"
    ? [{ path: event.path, excerpt: event.excerpt }]
    : []);
  if (edits.length === 0) return undefined;
  return {
    exitCodeSource: "unknown",
    edits,
    cwd: agent.coverageCwd,
    coveragePaths: agent.coveragePaths,
    coveragePathsComplete: agent.coveragePathsComplete,
    coverageDigest: agent.coverageDigest,
    truncatedFiles: agent.truncatedFiles,
  };
}

export function exitCodeField(raw: Fields | undefined): number | undefined {
  for (const key of ["exit_code", "exitCode"]) {
    const code = field(raw, key);
    if (typeof code === "number" && Number.isInteger(code) && code >= -2147483648 && code <= 2147483647) {
      return code;
    }
  }
  return undefined;
}

export function resultText(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_OUTPUT_LENGTH ? value : undefined;
}

export function withExitEvidence(
  outcome: NormalizedToolOutcome,
  structured: number | undefined,
  header?: NonNullable<NormalizedToolOutcome["errorExitHeader"]>,
): NormalizedToolOutcome {
  if (structured !== undefined) {
    return { ...outcome, exitCode: structured, exitCodeSource: "structured", isError: structured !== 0 };
  }
  if (header) {
    return { ...outcome, exitCode: header.exitCode, exitCodeSource: "header", output: header.body, isError: true };
  }
  return outcome;
}

export function withShellSkip(outcome: NormalizedToolOutcome): NormalizedToolOutcome {
  if (!outcome.command) return outcome;
  const wrap = classifyRockyWrap(outcome.command);
  if (wrap !== "plain") return { ...outcome, skipReason: wrap };
  if (outcome.interrupted) return { ...outcome, skipReason: "interrupt" };
  if (outcome.background) return { ...outcome, skipReason: "background" };
  if (outcome.exitCodeSource === "unknown") return { ...outcome, skipReason: "no-exit-header" };
  return outcome;
}
