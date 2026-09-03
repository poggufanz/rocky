import { spawnSync } from "node:child_process";
import { redactSecretsAtBoundary } from "./redact.js";

export const GIT_DIFF_TIMEOUT_MS = 5000;
export const GIT_DIFF_MAX_BYTES = 32768; // 32 KB

export interface GitDiffOptions {
  head?: string;
  ts?: number;
  file?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GitDiffResult {
  commit?: string;
  diff: string;
}

/** Check whether a candidate git ref / commit string is syntactically safe. */
function isValidGitRef(ref: unknown): ref is string {
  return typeof ref === "string"
    && ref.length > 0
    && ref.length <= 128
    && !ref.startsWith("-")
    && !/[\s\u0000-\u001f\u007f-\u009f]/.test(ref);
}

/** Extract clean unified diff patch lines from raw git output. */
function extractPatchText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  // Find where diff content starts (either "--- " or "diff --git ")
  const startIdx = lines.findIndex((line) => line.startsWith("--- ") || line.startsWith("diff --git "));
  if (startIdx === -1) {
    // If no standard header but lines start with @@ or +/-
    const hunkIdx = lines.findIndex((line) => line.startsWith("@@") || line.startsWith("+") || line.startsWith("-"));
    if (hunkIdx !== -1) {
      return lines.slice(hunkIdx).join("\n").trim();
    }
    return raw.trim();
  }
  return lines.slice(startIdx).join("\n").trim();
}

function runGitSafe(
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number; cwd?: string },
): { code: number; stdout: string; timedOut: boolean } {
  try {
    const result = spawnSync("git", args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: options.maxOutputBytes,
      timeout: options.timeoutMs,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    const timedOut = result.error !== undefined && (result.error as unknown as { code?: string }).code === "ETIMEDOUT";
    return {
      code: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout ?? "",
      timedOut,
    };
  } catch {
    return { code: 1, stdout: "", timedOut: false };
  }
}

/**
 * Resolves bounded, secret-redacted git diff for Rocky memory evidence (triples & rationale).
 *
 * Correlation strategies in priority order:
 * 1. Commit SHA/ref (`triple.mechanism.head`) -> `git diff-tree -p -U2 <head> -- <file>`
 * 2. Time-window lookup (`triple.ts`) -> `git log -n 1 --since="<ts - 60s>" --until="<ts + 60s>" -p -U2 -- <file>`
 * 3. Working-tree uncommitted changes -> `git diff -U2 HEAD -- <file>`
 *
 * Fails open with undefined on missing git, outside repo, error, or timeout without throwing.
 */
export function resolveGitDiff(options: GitDiffOptions): GitDiffResult | undefined {
  const timeoutMs = options.timeoutMs ?? GIT_DIFF_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_DIFF_MAX_BYTES;
  const cwd = options.cwd ?? process.cwd();
  const file = options.file;

  // 1. Commit SHA/ref
  const head = options.head;
  if (isValidGitRef(head)) {
    try {
      const args = ["diff-tree", "-p", "-U2", head, ...(file ? ["--", file] : [])];
      const result = runGitSafe(args, { timeoutMs, maxOutputBytes, cwd });
      if (result.code === 0 && !result.timedOut && result.stdout.trim().length > 0) {
        const patch = extractPatchText(result.stdout);
        if (patch.length > 0) {
          const redacted = redactSecretsAtBoundary(patch);
          const commit = head.length > 7 ? head.slice(0, 7) : head;
          return { commit, diff: redacted };
        }
      }
    } catch {
      // Fail open
    }
  }

  // 2. Time-window lookup
  const ts = options.ts;
  if (typeof ts === "number" && Number.isSafeInteger(ts) && ts > 0) {
    try {
      const since = new Date(Math.max(0, ts - 60_000)).toISOString();
      const until = new Date(ts + 60_000).toISOString();
      const args = ["log", "-n", "1", `--since=${since}`, `--until=${until}`, "-p", "-U2", ...(file ? ["--", file] : [])];
      const result = runGitSafe(args, { timeoutMs, maxOutputBytes, cwd });
      if (result.code === 0 && !result.timedOut && result.stdout.trim().length > 0) {
        const commitMatch = /^commit\s+([0-9a-fA-F]+)/m.exec(result.stdout);
        const commit = commitMatch ? commitMatch[1].slice(0, 7) : undefined;
        const patch = extractPatchText(result.stdout);
        if (patch.length > 0) {
          const redacted = redactSecretsAtBoundary(patch);
          return { commit, diff: redacted };
        }
      }
    } catch {
      // Fail open
    }
  }

  // 3. Working tree uncommitted changes
  try {
    const diffArgs = ["diff", "-U2", "HEAD", ...(file ? ["--", file] : [])];
    let result = runGitSafe(diffArgs, { timeoutMs, maxOutputBytes, cwd });
    if (result.code !== 0 && !result.timedOut) {
      result = runGitSafe(["diff", "-U2", ...(file ? ["--", file] : [])], { timeoutMs, maxOutputBytes, cwd });
    }
    if (result.code === 0 && !result.timedOut && result.stdout.trim().length > 0) {
      const patch = extractPatchText(result.stdout);
      if (patch.length > 0) {
        const redacted = redactSecretsAtBoundary(patch);
        return { commit: "uncommitted", diff: redacted };
      }
    }
  } catch {
    // Fail open
  }

  return undefined;
}

function firstShaFromOutput(stdout: string): string {
  const sha = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^[0-9a-fA-F]{4,128}$/.test(line));
  return sha ?? "";
}

/**
 * Oldest commit after a point that touched a file. With a known base anchor
 * this is graph-based (`base..HEAD`, oldest first) because commits only point
 * at parents; without one it is a bounded time lookup that refuses to claim
 * the far future. Never throws: "" means "no attributable child".
 */
export function firstShaAfter(root: string, rel: string, opts: { base?: string; ts: number; capMs?: number }): string {
  const runOpts = { timeoutMs: GIT_DIFF_TIMEOUT_MS, maxOutputBytes: GIT_DIFF_MAX_BYTES, cwd: root };
  const base = opts.base;
  if (typeof base === "string" && base !== "unborn" && isValidGitRef(base)) {
    const res = runGitSafe(["log", "--reverse", "--format=%H", `${base}..HEAD`, "--", rel], runOpts);
    if (res.code !== 0 || res.timedOut) return "";
    return firstShaFromOutput(res.stdout);
  }
  if (typeof opts.ts !== "number" || !Number.isSafeInteger(opts.ts) || opts.ts <= 0) return "";
  const cap = typeof opts.capMs === "number" && Number.isSafeInteger(opts.capMs) && opts.capMs > 0
    ? opts.capMs
    : 8 * 60 * 60 * 1000;
  const since = new Date(opts.ts + 1000).toISOString();
  const until = new Date(opts.ts + cap).toISOString();
  const res = runGitSafe(
    ["log", "--reverse", "--format=%H", `--since=${since}`, `--until=${until}`, "--", rel],
    runOpts,
  );
  if (res.code !== 0 || res.timedOut) return "";
  return firstShaFromOutput(res.stdout);
}

/**
 * First commit that touched a line range of a file, via `git log --reverse -L`.
 * Returns the oldest commit plus its (secret-redacted) subject, or undefined on
 * any failure, empty output, or timeout -- it fails open and never throws.
 */
export function gitFirstTouch(
  file: string,
  startLine: number,
  endLine: number,
  cwd?: string,
): { commit: string; subject: string } | undefined {
  if (typeof file !== "string" || file.length === 0) return undefined;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    return undefined;
  }
  try {
    const result = runGitSafe(
      ["log", "--reverse", "-L", `${startLine},${endLine}:${file}`, "--format=%H%x09%s", "-s"],
      { timeoutMs: GIT_DIFF_TIMEOUT_MS, maxOutputBytes: GIT_DIFF_MAX_BYTES, cwd },
    );
    if (result.code !== 0 || result.timedOut) return undefined;
    const line = result.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (line === undefined) return undefined;
    const tab = line.indexOf("\t");
    if (tab === -1) return undefined;
    const commit = line.slice(0, tab).trim();
    const subject = redactSecretsAtBoundary(line.slice(tab + 1).trim());
    if (commit.length === 0 || subject.length === 0) return undefined;
    return { commit: commit.slice(0, 7), subject };
  } catch {
    return undefined;
  }
}

/** Format diff lines for CLI support sink (e.g. detail()). */
export function formatGitDiffLines(diffResult: GitDiffResult | undefined): string[] {
  if (diffResult === undefined || !diffResult.diff.trim()) {
    return ["  (git diff unavailable)"];
  }
  const lines: string[] = [];
  if (diffResult.commit && diffResult.commit !== "uncommitted") {
    lines.push(`  diff (commit ${diffResult.commit.slice(0, 7)}):`);
  } else if (diffResult.commit === "uncommitted") {
    lines.push("  diff (uncommitted):");
  } else {
    lines.push("  diff:");
  }

  const rawLines = diffResult.diff.split(/\r?\n/);
  // Match standard diff format starting with --- if present, or diff --git
  const firstHeaderIdx = rawLines.findIndex((l) => l.startsWith("--- "));
  const effectiveLines = firstHeaderIdx !== -1 ? rawLines.slice(firstHeaderIdx) : rawLines;

  for (const line of effectiveLines) {
    lines.push(`    ${redactSecretsAtBoundary(line)}`);
  }
  return lines;
}
