import { readFileSync } from "node:fs";
import { join } from "node:path";
import { polishBriefLines } from "../ai/brief-ai.js";
import { createOllamaClient } from "../ai/ollama.js";
import { composeBrief, parseGitLog, type BriefInvariantTouch, type BriefMemoryHit } from "../core/brief.js";
import { FALLBACK_WINDOW_MS, parseSinceDuration, readState, writeState } from "../core/brief-state.js";
import { loadConfig } from "../core/config-read.js";
import { matchesGlob, parseInvariants } from "../core/invariants.js";
import { recordBriefRun, recordInvariantTouch } from "../core/memory.js";
import { canonicalPath, loadMemoryChecked } from "../core/memory-read.js";
import { runGit } from "../core/exec.js";
import { CliUsageError, reportCliUsage } from "./cli-args.js";
import { detail, say } from "../ui/rocky.js";

const USAGE = "rocky brief [--since <git-ref|duration like 24h>] [--quiet] [--ai]";
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface BriefArgs {
  since?: string;
  quiet: boolean;
  ai: boolean;
}

export function parseBriefArgs(argv: readonly string[]): BriefArgs {
  let since: string | undefined;
  let quiet = false;
  let ai = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--quiet") { quiet = true; continue; }
    if (arg === "--ai") { ai = true; continue; }
    if (arg === "--since") {
      const value = argv[index + 1];
      if (value === undefined) throw new CliUsageError("--since needs value", USAGE);
      since = value;
      index += 1;
      continue;
    }
    throw new CliUsageError(`unexpected argument: ${arg}`, USAGE);
  }
  return { ...(since === undefined ? {} : { since }), quiet, ai };
}

interface ResolvedWindow {
  label: string;
  sinceTs: number;
  gitRange?: string;
}

function resolveWindow(since: string | undefined, now: number): ResolvedWindow {
  if (since === undefined) {
    const state = readState();
    const sinceTs = state.lastBriefTs ?? now - FALLBACK_WINDOW_MS;
    return { label: state.lastBriefTs === undefined ? "24h (first brief)" : "since last brief", sinceTs };
  }
  const durationMs = parseSinceDuration(since);
  if (durationMs !== undefined) {
    return { label: since, sinceTs: now - durationMs };
  }
  // Not a duration: treat as git ref, resolved by git itself in the log range.
  return { label: `since ${since}`, sinceTs: 0, gitRange: `${since}..HEAD` };
}

export async function briefCommand(argv: readonly string[] = [], cwd = process.cwd()): Promise<number> {
  let args: BriefArgs;
  try {
    args = parseBriefArgs(argv);
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
  const now = Date.now();
  const speak = (msg: string): void => { if (!args.quiet) say(msg); };

  const top = await runGit(["-C", cwd, "rev-parse", "--show-toplevel"], undefined, { timeoutMs: GIT_TIMEOUT_MS });
  if (top.code !== 0) {
    say("no git repo here. brief listens to git history. bad bad.");
    return 1;
  }
  const root = top.stdout.trim();
  const window = resolveWindow(args.since, now);

  const logArgs = window.gitRange === undefined
    ? ["-C", cwd, "log", `--since=${new Date(window.sinceTs).toISOString()}`, "--date-order", "--pretty=format:%H%x09%s", "--numstat"]
    : ["-C", cwd, "log", window.gitRange, "--date-order", "--pretty=format:%H%x09%s", "--numstat"];
  const log = await runGit(logArgs, undefined, { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_MAX_OUTPUT_BYTES });
  if (log.code !== 0) {
    say(`git does not answer me. bad bad. ${log.stderr.split("\n")[0] ?? ""}`);
    return 1;
  }
  const commits = parseGitLog(log.stdout);
  const changedPaths = [...new Set(commits.flatMap((commit) => commit.files.map((file) => file.path)))];

  // Memory hits: failures and fixes in window, from this repo. Both sides go
  // through canonicalPath so a POSIX-style git toplevel (forward slashes)
  // still matches process.cwd()-derived record.cwd (native separators on
  // Windows), and the prefix check is separator-bounded so a sibling repo
  // whose name merely starts with this root's name cannot match.
  const normalizedRoot = canonicalPath(root);
  let memoryHits: BriefMemoryHit[] = [];
  try {
    const loaded = loadMemoryChecked();
    memoryHits = loaded.records
      .filter((record): record is typeof record & { kind: "failure" | "fix" } =>
        (record.kind === "failure" || record.kind === "fix") && record.ts >= window.sinceTs && record.ts <= now)
      .filter((record) => {
        const normalizedCwd = canonicalPath(record.cwd);
        return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`);
      })
      .map((record) => ({
        kind: record.kind,
        ts: record.ts,
        cmd: record.cmd,
        ...(record.kind === "failure" ? { excerpt: record.excerpt.split("\n")[0] } : {}),
      }));
  } catch {
    speak("memory file does not open for me. brief continues from git only.");
  }

  // Invariant intersections.
  const invariantTouches: BriefInvariantTouch[] = [];
  try {
    const text = readFileSync(join(root, ".rocky", "invariants.md"), "utf8");
    const { notes } = parseInvariants(text);
    const seen = new Set<string>();
    for (const note of notes) {
      for (const path of changedPaths) {
        if (note.guardedBy.some((pattern) => matchesGlob(pattern, path))) {
          const key = `${note.invariant} ${path}`;
          if (!seen.has(key)) {
            seen.add(key);
            invariantTouches.push({ invariant: note.invariant, path });
          }
        }
      }
    }
  } catch {
    // No invariant file: block 4 is simply empty.
  }

  const lines = composeBrief({ windowLabel: window.label, commits, memoryHits, invariantTouches });
  let output = lines;
  if (args.ai) {
    const config = loadConfig();
    if (config.status === "valid" && config.config.ai.enabled) {
      output = await polishBriefLines(lines, createOllamaClient(), config.config.ai.model);
      if (output === lines) speak("model does not answer clean. I speak plain facts instead.");
    } else {
      speak("local AI not enabled. run rocky model use first, question");
    }
  }
  for (const line of output) console.log(line);

  for (const touch of invariantTouches) {
    recordInvariantTouch({ invariant: touch.invariant, path: touch.path, cwd: root });
  }
  recordBriefRun({ sinceTs: window.sinceTs, commits: commits.length, files: changedPaths.length, cwd: root });
  writeState({ v: 1, lastBriefTs: now });
  speak("brief done. you explain, I remember. good good.");
  return 0;
}
