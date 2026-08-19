import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CanonicalRationaleEvent, LogAdapter } from "./types.js";
import { scanJsonlLines } from "./scan.js";

/** Never discover more than this many transcript files per repo. */
const MAX_DISCOVERED_FILES = 5;

/** Byte budget for probing the first line of a candidate transcript. */
const PROBE_BYTES = 64 * 1024;

/** Claude Code slugs a cwd by replacing path separators and `:` with `-`. */
function slugify(cwd: string): string {
  return cwd.replace(/[/\\:]/g, "-");
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
}

/**
 * Read and parse the first JSONL line of a file. Returns undefined when the
 * file cannot be opened, is empty, or the first line does not parse. Reads at
 * most PROBE_BYTES and never throws.
 */
function firstLineOf(logPath: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const buffer = Buffer.allocUnsafe(PROBE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, PROBE_BYTES, 0);
    if (bytesRead <= 0) return undefined;
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = head.indexOf("\n");
    const firstLine = (newline === -1 ? head : head.slice(0, newline)).trim();
    if (firstLine.length === 0) return undefined;
    return JSON.parse(firstLine);
  } catch {
    return undefined;
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
 * letters make slugs vary), any file whose first parsed record carries
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
          // transcript's own cwd instead.
          const first = firstLineOf(logPath);
          if (!isRecord(first) || first.cwd !== repoCwd) continue;
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
    if (obj.cwd !== repoCwd) return;
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
  return { events, nextOffset };
}

export const claudeCodeLogAdapter: LogAdapter = {
  agent: "claude-code",
  discover,
  scan,
};
