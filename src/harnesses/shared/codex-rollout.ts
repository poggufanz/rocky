import { isAbsolute, resolve, win32 } from "node:path";
import type { NormalizedToolOutcome } from "../types.js";
import { field, type Fields } from "./field-extract.js";
import { exitCodeField, withExitEvidence } from "./tool-outcome.js";

// These envelopes belong to built-in Codex rollout results.
const EXEC_HEADER = /^(?:Chunk ID: [\w-]{1,64}\r?\n)?Wall time: \d+\.\d{4} seconds\r?\nProcess exited with code (-?\d{1,10})\r?\n(?:Original token count: \d+\r?\n)?Output:(?:\r?\n|$)/u;
const PATCH_HEADER = /^Exit code: 0\r?\nWall time: \d+(?:\.\d+)? seconds\r?\n(?:Total output lines: \d+\r?\n)?Output:\r?\n/u;
const PATCH_SUCCESS = /^Success\. Updated the following files:\r?\n[AMD] [^\r\n]+/u;

const EXTENDED_UNC_PREFIX = /^\\\\\?\\UNC\\(?=[^\\]+\\[^\\]+(?:\\|$))/iu;

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

export function resolveCodexPath(path: string, base: string | undefined): string | undefined {
  if (/\p{Cc}/u.test(path)) return undefined;
  const windows = process.platform === "win32";
  const root = windows ? win32.parse(path).root : "";
  if (isAbsolute(path) && root.length !== 1) return path;
  if (!base || !isAbsolute(base) || /\p{Cc}/u.test(base)) return undefined;
  if (!windows) return resolve(base, path);

  const baseRoot = win32.parse(base).root;
  if (baseRoot.length === 1) return undefined;
  if (root.length > 1) {
    // A drive-relative path requires a recorded cwd on that drive.
    if (root.toLowerCase() !== base.slice(0, 2).toLowerCase()) return undefined;
    return win32.join(base, path.slice(root.length));
  }

  const windowsBase = base.replaceAll("/", "\\");
  const prefix = EXTENDED_UNC_PREFIX.exec(windowsBase)?.[0];
  if (prefix) {
    // Resolve through ordinary UNC syntax so win32 treats server\share as the volume.
    const uncBase = "\\\\" + windowsBase.slice(prefix.length);
    return prefix + win32.resolve(uncBase, path).slice(2);
  }
  if (root.length === 1) return win32.join(baseRoot, path.slice(1));
  return win32.resolve(base, path);
}
