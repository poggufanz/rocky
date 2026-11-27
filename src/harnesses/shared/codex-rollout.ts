import type { NormalizedToolOutcome } from "../types.js";
import { field, type Fields } from "./field-extract.js";
import { exitCodeField, withExitEvidence } from "./tool-outcome.js";

// These envelopes belong to built-in Codex rollout results.
const EXEC_HEADER = /^(?:Chunk ID: [\w-]{1,64}\r?\n)?Wall time: \d+\.\d{4} seconds\r?\nProcess exited with code (-?\d{1,10})\r?\n(?:Original token count: \d+\r?\n)?Output:(?:\r?\n|$)/u;
const PATCH_HEADER = /^Exit code: 0\r?\nWall time: \d+(?:\.\d+)? seconds\r?\n(?:Total output lines: \d+\r?\n)?Output:\r?\n/u;
const PATCH_SUCCESS = /^Success\. Updated the following files:\r?\n[AMD] [^\r\n]+/u;

export function hasNoCodexNamespace(payload: Fields): boolean {
  const namespace = field(payload, "namespace");
  return namespace === undefined || namespace === "";
}

export function codexRolloutExit(
  outcome: NormalizedToolOutcome, payload: Fields, builtinExec: boolean,
): NormalizedToolOutcome {
  const structured = exitCodeField(payload);
  const normalized = withExitEvidence(outcome, structured);
  if (structured !== undefined || !builtinExec || outcome.output === undefined) return normalized;

  const header = EXEC_HEADER.exec(outcome.output);
  if (!header) return normalized;
  const exitCode = exitCodeField({ exit_code: Number(header[1]) });
  if (exitCode === undefined) return normalized;

  return {
    ...outcome, exitCode, exitCodeSource: "header", isError: exitCode !== 0,
    output: outcome.output.slice(header[0].length),
  };
}

export function isSuccessfulCodexPatch(payload: Fields, output: string | undefined): boolean {
  if (output === undefined || (exitCodeField(payload) ?? 0) !== 0
    || payload.success === false || payload.is_error === true) {
    return false;
  }
  const header = PATCH_HEADER.exec(output);
  return PATCH_SUCCESS.test(header ? output.slice(header[0].length) : output);
}
