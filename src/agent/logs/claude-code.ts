import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CanonicalRationaleEvent, LogAdapter } from "./types.js";
import { scanJsonlLines } from "./scan.js";

/** Never discover more than this many transcript files per repo. */
const MAX_DISCOVERED_FILES = 5;

/** Byte budget for probing the head of a candidate transcript. */
const PROBE_BYTES = 256 * 1024;

/** Never parse more than this many records while probing a transcript. */
const PROBE_MAX_LINES = 10;

/** Claude Code slugs a cwd by replacing path separators and `:` with `-`. */
function slugify(cwd: string): string {
  return cwd.replace(/[/\\:]/g, "-");
}

function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  // An empty override is treated as unset, never as a relative path.
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".claude");
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
}

/**
 * cwd equality: exact match everywhere, plus case-insensitive match on
 * Windows where drive-letter case varies (`c:\work` vs `C:\work`).
 */
function sameCwd(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  if (a === b) return true;
  return process.platform === "win32" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Probe the head of a candidate transcript: does any of its first few
 * parseable records carry `cwd` matching the repo? Transcripts can start
 * with a `summary` record (post-compaction, no `cwd`) or an oversized first
 * line, so looking only at line one misses real sessions. Reads at most
 * PROBE_BYTES, parses at most PROBE_MAX_LINES records, never throws.
 */
function probeHasCwd(logPath: string, repoCwd: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const buffer = Buffer.allocUnsafe(PROBE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, PROBE_BYTES, 0);
    if (bytesRead <= 0) return false;
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    let parsed = 0;
    for (const lineText of head.split("\n")) {
      if (parsed >= PROBE_MAX_LINES) break;
      const trimmed = lineText.trim();
      if (trimmed.length === 0) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        // Corrupt or boundary-truncated line: skipped, never fatal.
        continue;
      }
      parsed += 1;
      if (isRecord(obj) && sameCwd(obj.cwd, repoCwd)) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing more to do.
      }
    }
  }
}

/**
 * List transcript files for a repo under `<configDir>/projects/<slug>/`.
 * The directory slug matches most checkouts; when it misses (Windows drive
 * letters make slugs vary), any file whose head records carry
 * `cwd === repoCwd` is accepted instead. Sorted newest first, capped at
 * MAX_DISCOVERED_FILES. Never throws.
 */
function discover(repoCwd: string): string[] {
  try {
    const projectsDir = join(claudeConfigDir(), "projects");
    const slug = slugify(repoCwd);
    const found: { path: string; mtimeMs: number }[] = [];
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; // skip sidecar files
      const dirPath = join(projectsDir, entry.name);
      const slugMatch = entry.name === slug;
      let files: string[];
      try {
        files = readdirSync(dirPath);
      } catch {
        continue; // unreadable dir is skipped, never fatal
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const logPath = join(dirPath, file);
        let mtimeMs: number;
        try {
          const stat = statSync(logPath);
          if (!stat.isFile()) continue;
          mtimeMs = stat.mtimeMs;
        } catch {
          continue;
        }
        if (!slugMatch) {
          // Slug heuristic missed this dir; confirm ownership by the
          // transcript's own cwd records instead.
          if (!probeHasCwd(logPath, repoCwd)) continue;
        }
        found.push({ path: logPath, mtimeMs });
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found.slice(0, MAX_DISCOVERED_FILES).map((f) => f.path);
  } catch {
    return [];
  }
}

/**
 * Scan a transcript, emitting one event per `thinking` entry (raw fidelity)
 * and — only for turns with no thinking entry — one per `text` reply entry
 * (summary fidelity). Only assistant records whose `cwd` matches the repo are
 * considered; malformed records are skipped silently. Never throws.
 */
function scan(repoCwd: string, logPath: string, fromOffset: number, maxBytes: number): { events: CanonicalRationaleEvent[]; nextOffset: number } {
  const events: CanonicalRationaleEvent[] = [];
  const nextOffset = scanJsonlLines(logPath, fromOffset, maxBytes, (obj) => {
    if (!isRecord(obj)) return;
    if (!sameCwd(obj.cwd, repoCwd)) return;
    if (obj.type !== "assistant") return;
    const message = obj.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    const content = message.content.filter(isRecord);
    const hasThinking = content.some((entry) => entry.type === "thinking" && typeof entry.thinking === "string" && entry.thinking.length > 0);
    const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : "";
    const turnRef = typeof obj.uuid === "string" ? obj.uuid : "";
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
    for (const entry of content) {
      if (entry.type === "thinking" && typeof entry.thinking === "string" && entry.thinking.length > 0) {
        events.push({
          agent: "claude-code",
          sessionId,
          turnRef,
          ts: Number.isNaN(ts) ? 0 : ts,
          cwd: repoCwd,
          text: entry.thinking,
          fidelity: "raw",
          source: "log-thinking",
          logPath,
        });
      } else if (!hasThinking && entry.type === "text" && typeof entry.text === "string" && entry.text.length > 0) {
        events.push({
          agent: "claude-code",
          sessionId,
          turnRef,
          ts: Number.isNaN(ts) ? 0 : ts,
          cwd: repoCwd,
          text: entry.text,
          fidelity: "summary",
          source: "log-response",
          logPath,
        });
      }
      // tool_use and other entry types carry no rationale text; skipped.
    }
  });
  if (nextOffset === fromOffset && fromOffset > 0 && events.length > 0) {
    // scanJsonlLines hit its outer-catch error path: the offset did not
    // advance, so these events would be re-emitted on the next scan from the
    // same offset. Dedupe-by-offset is the caller's contract, so drop them.
    // Normal EOF at fromOffset collects zero events and is unaffected.
    return { events: [], nextOffset: fromOffset };
  }
  return { events, nextOffset };
}

export const claudeCodeLogAdapter: LogAdapter = {
  agent: "claude-code",
  discover,
  scan,
};
