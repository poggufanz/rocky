import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLine, unwrapRockyRun } from "../../dist/core/fingerprint.js";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const TASKS_DIR = join(EVAL_DIR, "tasks");
const MANIFEST_PATH = join(TASKS_DIR, "manifest.json");

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const ROCKY_LINE_RE = /^\s*rocky:/;
const ROCKY_INDENT_RE = /^ {4}/;
const NOTE_DELIVERED_RE = /rocky: Same error recorded \d+ times? before/;
const LEADING_CD_RE = /^\s*cd\s+(?:--\s+)?(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*/;
const ARM_ORDER = ["none", "before", "after"];

const USAGE = [
  "Usage: node scripts/eval/evaluate.mjs --out <dir>",
  "",
  "Options:",
  "  --out <dir>   Batch output directory containing runs/<runId>/",
  "  -h, --help    Show this help message and exit",
].join("\n");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractToolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Parse a JSONL string into event objects, skipping blank or malformed lines.
 * @param {string} text
 * @returns {any[]}
 */
export function parseJsonl(text) {
  const events = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Skip malformed lines so broken transcripts remain scoreable.
    }
  }
  return events;
}

/**
 * Extract paired Bash/PowerShell tool_use -> tool_result calls in emission order.
 * `turn` is the 1-based count of assistant message events up to and including the
 * event holding the tool_use.
 * @param {readonly any[]} events
 * @returns {Array<{ turn: number, name: string, command: string, output: string, isError: boolean }>}
 */
export function toolCalls(events) {
  if (!Array.isArray(events)) return [];

  /** @type {Array<{ id: string, turn: number, name: string, command: string }>} */
  const uses = [];
  /** @type {Map<string, { output: string, isError: boolean }>} */
  const resultsById = new Map();
  let assistantTurn = 0;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;

    if (event.type === "assistant") {
      assistantTurn += 1;
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
        if (!SHELL_TOOLS.has(block.name) || typeof block.id !== "string" || block.id.length === 0) continue;
        const command = typeof block.input?.command === "string" ? block.input.command : "";
        uses.push({ id: block.id, turn: assistantTurn, name: block.name, command });
      }
    } else if (event.type === "user") {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
        if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) continue;
        if (!resultsById.has(block.tool_use_id)) {
          resultsById.set(block.tool_use_id, {
            output: extractToolResultText(block.content),
            isError: Boolean(block.is_error),
          });
        }
      }
    }
  }

  /** @type {Array<{ turn: number, name: string, command: string, output: string, isError: boolean }>} */
  const paired = [];
  for (const use of uses) {
    const result = resultsById.get(use.id);
    if (!result) continue;
    paired.push({
      turn: use.turn,
      name: use.name,
      command: use.command,
      output: result.output,
      isError: result.isError,
    });
  }
  return paired;
}

/**
 * Drop lines matching `/^\s*rocky:/` and any indented (4+ spaces) continuation lines
 * directly following one.
 * @param {string} text
 * @returns {string}
 */
export function stripRockyLines(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const kept = [];
  let droppingIndented = false;

  for (const line of lines) {
    if (ROCKY_LINE_RE.test(line)) {
      droppingIndented = true;
      continue;
    }
    if (droppingIndented && ROCKY_INDENT_RE.test(line)) {
      continue;
    }
    droppingIndented = false;
    kept.push(line);
  }
  return kept.join("\n");
}

function stripLeadingCdSegments(command) {
  let current = command.trim();
  while (LEADING_CD_RE.test(current)) {
    current = current.replace(LEADING_CD_RE, "").trim();
  }
  return current;
}

/**
 * Parse a shell command against target alias regexes.
 * Returns `{ piped: boolean }` when it is a target run, or `null` otherwise.
 * @param {string} command
 * @param {readonly RegExp[]} aliasRegexes
 * @returns {{ piped: boolean } | null}
 */
function matchTargetCommand(command, aliasRegexes) {
  if (typeof command !== "string" || aliasRegexes.length === 0) return null;

  let rest = unwrapRockyRun(command.trim());
  rest = stripLeadingCdSegments(rest);
  rest = unwrapRockyRun(rest).trim();

  if (rest.length === 0 || /[\r\n]/.test(rest)) return null;

  let quote = null;
  let firstPipeIndex = -1;

  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < rest.length) {
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "\\" && i + 1 < rest.length) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ";") {
      return null;
    }
    if (ch === "&") {
      if (rest[i + 1] === "&") return null;
      // Allow fd redirections like `2>&1` or `&>`; reject standalone background `&`.
      const prev = i > 0 ? rest[i - 1] : "";
      const next = rest[i + 1] ?? "";
      if (prev !== ">" && prev !== "<" && next !== ">") {
        return null;
      }
      continue;
    }
    if (ch === "|") {
      if (rest[i + 1] === "|") return null;
      if (firstPipeIndex === -1) {
        firstPipeIndex = i;
      }
    }
  }

  const piped = firstPipeIndex !== -1;
  if (piped && rest.slice(firstPipeIndex + 1).trim().length === 0) {
    return null;
  }

  const beforePipe = (piped ? rest.slice(0, firstPipeIndex) : rest).trim();
  const targetPart = beforePipe.replace(/\s+2>&1$/, "").trim();
  if (targetPart.length === 0) return null;

  const unwrappedTarget = unwrapRockyRun(targetPart).trim();
  if (unwrappedTarget !== targetPart) {
    const inner = matchTargetCommand(unwrappedTarget, aliasRegexes);
    return inner ? { piped: piped || inner.piped } : null;
  }

  for (const regex of aliasRegexes) {
    if (regex.test(targetPart)) {
      return { piped };
    }
  }
  return null;
}

/**
 * Classify target runs among paired shell calls.
 * @param {readonly { turn: number, name: string, command: string, output: string, isError: boolean }[]} calls
 * @param {any} task
 * @returns {Array<{ turn: number, kind: "trap_fail" | "other_fail" | "pass" | "unknown" }>}
 */
export function classifyTargetRuns(calls, task) {
  if (!Array.isArray(calls) || !task) return [];

  const aliases = Array.isArray(task.target?.aliases) ? task.target.aliases : [];
  const aliasRegexes = aliases.map((pattern) => new RegExp(pattern));
  const normalizedTrap =
    typeof task.normalizedTrapLine === "string" && task.normalizedTrapLine.length > 0
      ? task.normalizedTrapLine
      : (typeof task.trapLine === "string" ? normalizeLine(task.trapLine) : "");

  /** @type {Array<{ turn: number, kind: "trap_fail" | "other_fail" | "pass" | "unknown" }>} */
  const classified = [];

  for (const call of calls) {
    const matched = matchTargetCommand(call.command, aliasRegexes);
    if (!matched) continue;

    const cleaned = stripRockyLines(call.output);
    const hasTrap =
      normalizedTrap.length > 0
      && cleaned.split(/\r?\n/).some((line) => normalizeLine(line) === normalizedTrap);

    /** @type {"trap_fail" | "other_fail" | "pass" | "unknown"} */
    let kind;
    if (hasTrap) {
      kind = "trap_fail";
    } else if (!matched.piped && call.isError === false) {
      kind = "pass";
    } else if (call.isError === true) {
      kind = "other_fail";
    } else {
      kind = "unknown";
    }
    classified.push({ turn: call.turn, kind });
  }

  return classified;
}

function readJsonOrNull(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readAdvisories(runDir) {
  if (!runDir) return [];
  const advisoriesPath = join(runDir, "rocky-home", "advisories.jsonl");
  if (!existsSync(advisoriesPath)) return [];
  try {
    return parseJsonl(readFileSync(advisoriesPath, "utf8"));
  } catch {
    return [];
  }
}

function hasNonEmptyRockyHomeDir(runDir) {
  if (!runDir) return false;
  const rockyHomeDir = join(runDir, "rocky-home");
  try {
    const stat = lstatSync(rockyHomeDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    return readdirSync(rockyHomeDir).length > 0;
  } catch {
    return false;
  }
}

function listFixOverlayPaths(task) {
  if (task?.kind !== "stale") return [];
  const fixture = task.fixture;
  const fixName = task.history?.fix;
  if (typeof fixture !== "string" || typeof fixName !== "string") return [];

  const overlayDir = join(TASKS_DIR, fixture, "patches", fixName);
  if (!existsSync(overlayDir)) return [];

  const relPaths = [];
  function walk(dir, prefix) {
    const entries = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of entries) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        walk(full, rel);
      } else if (stat.isFile()) {
        relPaths.push(rel);
      }
    }
  }
  walk(overlayDir, "");
  return relPaths;
}

function editPathMatchesOverlay(filePath, overlayPaths) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const rel of overlayPaths) {
    if (norm === rel || norm.endsWith(`/${rel}`)) return true;
  }
  return false;
}

function commandTouchesOverlay(command, overlayRegexes) {
  if (typeof command !== "string" || command.length === 0) return false;
  const norm = command.replace(/\\/g, "/");
  for (const regex of overlayRegexes) {
    if (regex.test(norm)) return true;
  }
  return false;
}

function extractEditFilePaths(toolUseBlock) {
  const paths = [];
  const input = toolUseBlock?.input;
  if (!input || typeof input !== "object") return paths;
  if (typeof input.file_path === "string") {
    paths.push(input.file_path);
  }
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object" && typeof edit.file_path === "string") {
        paths.push(edit.file_path);
      }
    }
  }
  return paths;
}

/**
 * Compute offline evaluation metrics for one run from its stream-json events,
 * task definition, and run directory (`run.json` and `rocky-home/advisories.jsonl`).
 * @param {readonly any[]} events
 * @param {any} task
 * @param {string | null | undefined} runDir
 * @returns {{
 *   repeatFailures: number | "no_attempt",
 *   turnsToPass: number | null,
 *   numTurns: number,
 *   wallMs: number,
 *   noteBytes: number,
 *   noteDelivered: boolean | null,
 *   staleRepeat: boolean | null,
 *   leak: string[],
 * }}
 */
export function runMetrics(events, task, runDir) {
  const list = Array.isArray(events) ? events : [];
  const calls = toolCalls(list);
  const classified = classifyTargetRuns(calls, task);

  /** @type {number | "no_attempt"} */
  let repeatFailures;
  if (classified.length === 0) {
    repeatFailures = "no_attempt";
  } else {
    let seenFirstTrap = false;
    let repeats = 0;
    for (const run of classified) {
      if (run.kind === "pass") break;
      if (run.kind === "trap_fail") {
        if (seenFirstTrap) {
          repeats += 1;
        } else {
          seenFirstTrap = true;
        }
      }
    }
    repeatFailures = repeats;
  }

  const firstPass = classified.find((run) => run.kind === "pass");
  const turnsToPass = firstPass ? firstPass.turn : null;

  let lastResult = null;
  let hasMcpRockyUse = false;
  let hasRockyOutputLine = false;
  let hasTranscriptNote = false;
  let noteBytes = 0;

  const isStaleTask = task?.kind === "stale";
  const overlayPaths = isStaleTask ? listFixOverlayPaths(task) : [];
  const overlayRegexes = overlayPaths.map(
    (rel) => new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(rel)}(?![A-Za-z0-9_./-])`),
  );
  let touchedStaleOverlay = false;

  for (const event of list) {
    if (!event || typeof event !== "object") continue;

    if (event.type === "result") {
      lastResult = event;
    } else if (event.type === "assistant") {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
        if (typeof block.name === "string" && block.name.startsWith("mcp__rocky__")) {
          hasMcpRockyUse = true;
        }
        if (isStaleTask && !touchedStaleOverlay && overlayPaths.length > 0) {
          if (EDIT_TOOLS.has(block.name)) {
            for (const filePath of extractEditFilePaths(block)) {
              if (editPathMatchesOverlay(filePath, overlayPaths)) {
                touchedStaleOverlay = true;
                break;
              }
            }
          } else if (SHELL_TOOLS.has(block.name)) {
            const cmd = typeof block.input?.command === "string" ? block.input.command : "";
            if (commandTouchesOverlay(cmd, overlayRegexes)) {
              touchedStaleOverlay = true;
            }
          }
        }
      }
    } else if (event.type === "user") {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
        const text = extractToolResultText(block.content);
        if (text.length === 0) continue;
        if (NOTE_DELIVERED_RE.test(text)) {
          hasTranscriptNote = true;
        }
        for (const line of text.split(/\r?\n/)) {
          if (ROCKY_LINE_RE.test(line)) {
            hasRockyOutputLine = true;
            noteBytes += Buffer.byteLength(line, "utf8");
          }
        }
      }
    }
  }

  const numTurns = typeof lastResult?.num_turns === "number" ? lastResult.num_turns : 0;
  const wallMs = typeof lastResult?.duration_ms === "number" ? lastResult.duration_ms : 0;

  const runMeta = runDir ? readJsonOrNull(join(runDir, "run.json")) : null;
  const arm = typeof runMeta?.arm === "string" ? runMeta.arm : null;
  const advisories = readAdvisories(runDir);

  // Lane-2 (PostToolUseFailure additionalContext) note text is not emitted into Claude Code's
  // stream-json transcript, so count its UTF-8 bytes from delivered `tool-result` advisory rows.
  // Lane-1 (`run`) note lines appear in tool results and are already summed above.
  let hasAdvisoryNote = false;
  for (const row of advisories) {
    if (row?.kind === "note" && row?.arm === "shown" && row?.delivered === true) {
      hasAdvisoryNote = true;
      if (row.lane === "tool-result" && typeof row.bytes === "number" && Number.isFinite(row.bytes) && row.bytes > 0) {
        noteBytes += row.bytes;
      }
    }
  }

  const noteDelivered = arm === "after" ? (hasTranscriptNote || hasAdvisoryNote) : null;
  const staleRepeat = isStaleTask ? touchedStaleOverlay : null;

  /** @type {string[]} */
  const leak = [];
  if (arm === "none") {
    const noneHomeNonEmpty =
      (Array.isArray(runMeta?.noneRockyHomeEntries) && runMeta.noneRockyHomeEntries.length > 0)
      || hasNonEmptyRockyHomeDir(runDir);
    if (hasMcpRockyUse || hasRockyOutputLine || noneHomeNonEmpty) {
      leak.push("none-arm-rocky");
    }
  }
  if (runMeta?.invalid === "token_leak") {
    leak.push("token-in-transcript");
  }

  return {
    repeatFailures,
    turnsToPass,
    numTurns,
    wallMs,
    noteBytes,
    noteDelivered,
    staleRepeat,
    leak,
  };
}

function writeJsonAtomic(targetPath, data) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
  }
}

/**
 * Format one summary line per arm present in `metricsByRunId`.
 * @param {Record<string, any>} metricsByRunId
 * @returns {string[]}
 */
export function formatArmSummary(metricsByRunId) {
  const entries = Object.values(metricsByRunId);
  const armsPresent = new Set(entries.map((entry) => entry.arm).filter((arm) => typeof arm === "string"));
  const orderedArms = [
    ...ARM_ORDER.filter((arm) => armsPresent.has(arm)),
    ...Array.from(armsPresent).filter((arm) => !ARM_ORDER.includes(arm)).sort(),
  ];

  return orderedArms.map((arm) => {
    const armRuns = entries.filter((entry) => entry.arm === arm);
    const validRuns = armRuns.filter((entry) => entry.invalid === null);
    const solvedCount = validRuns.filter((entry) => entry.solved === true).length;
    let repeatSum = 0;
    let noAttemptCount = 0;
    for (const run of validRuns) {
      if (run.repeatFailures === "no_attempt") {
        noAttemptCount += 1;
      } else if (typeof run.repeatFailures === "number") {
        repeatSum += run.repeatFailures;
      }
    }
    const deliveredText =
      arm === "after"
        ? `${validRuns.filter((entry) => entry.noteDelivered === true).length}/${validRuns.length}`
        : "n/a";
    const leakCount = armRuns.filter((entry) => Array.isArray(entry.leak) && entry.leak.length > 0).length;

    return [
      `arm=${arm}`,
      `runs=${armRuns.length}`,
      `valid=${validRuns.length}`,
      `solved=${solvedCount}/${validRuns.length}`,
      `repeatFailures=${repeatSum}`,
      `noAttempt=${noAttemptCount}`,
      `noteDelivered=${deliveredText}`,
      `leaks=${leakCount}`,
    ].join(" ");
  });
}

/**
 * Evaluate all runs under `<outDir>/runs/`, write `<outDir>/metrics.json`,
 * and return the scored metrics and per-arm summary lines.
 * @param {string} outDir
 * @param {{ manifest?: any }} [options]
 */
export function evaluateBatch(outDir, options = {}) {
  const resolvedOut = resolve(outDir);
  const runsDir = join(resolvedOut, "runs");
  if (!existsSync(runsDir) || !lstatSync(runsDir).isDirectory()) {
    throw new Error(`Runs directory not found: ${runsDir}`);
  }

  const manifest = options.manifest ?? JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const taskById = new Map(
    (Array.isArray(manifest.tasks) ? manifest.tasks : []).map((task) => [task.id, task]),
  );

  const runDirNames = readdirSync(runsDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  /** @type {Record<string, any>} */
  const metrics = {};

  for (const dirName of runDirNames) {
    const runDir = join(runsDir, dirName);
    let stat;
    try {
      stat = lstatSync(runDir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;

    const runMeta = readJsonOrNull(join(runDir, "run.json"));
    if (!runMeta) continue;

    const runId = typeof runMeta.runId === "string" && runMeta.runId.length > 0 ? runMeta.runId : dirName;
    const task = taskById.get(runMeta.taskId) ?? null;
    const transcriptPath = join(runDir, "transcript.jsonl");
    const events = existsSync(transcriptPath)
      ? parseJsonl(readFileSync(transcriptPath, "utf8"))
      : [];

    const scored = runMetrics(events, task, runDir);
    metrics[runId] = {
      taskId: runMeta.taskId ?? null,
      arm: runMeta.arm ?? null,
      block: typeof runMeta.block === "number" ? runMeta.block : null,
      invalid: runMeta.invalid ?? null,
      solved: typeof runMeta.accept?.solved === "boolean" ? runMeta.accept.solved : null,
      ...scored,
    };
  }

  const metricsPath = join(resolvedOut, "metrics.json");
  writeJsonAtomic(metricsPath, metrics);
  const summaryLines = formatArmSummary(metrics);
  return { metricsPath, metrics, summaryLines };
}

function usageError(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { help: false, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      return opts;
    }
    if (arg === "--out") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        usageError("--out requires a value");
      }
      i += 1;
      opts.out = next;
    } else {
      usageError(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!opts.out) {
    usageError("--out <dir> is required");
  }
  const { summaryLines } = evaluateBatch(opts.out);
  for (const line of summaryLines) {
    process.stdout.write(`${line}\n`);
  }
}

export function isMainModule(
  argv1 = process.argv[1],
  metaUrl = import.meta.url,
  realpath = realpathSync.native,
) {
  if (!argv1) return false;
  try {
    return realpath(resolve(argv1)) === realpath(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
