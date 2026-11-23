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
const WIN32_DRIVE_RE = /^[A-Za-z]:(?:[\\/]|$)/;
const UNICODE_WS_RE = /\s/u;
const HEREDOC_DELIMITER_RE = /^[A-Za-z0-9_.-]+$/;
const ARM_ORDER = ["none", "before", "after"];

const USAGE = [
  "Usage: node scripts/eval/evaluate.mjs --out <dir>",
  "",
  "Options:",
  "  --out <dir>   Batch output directory containing runs/<runId>/",
  "  -h, --help    Show this help message and exit",
].join("\n");

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
 * `turn` is the 1-based running count of distinct assistant `message.id` values
 * (in order of first appearance) up to and including the event holding the
 * tool_use; assistant events without an id count as their own message.
 * @param {readonly any[]} events
 * @returns {Array<{ turn: number, name: string, command: string, output: string, isError: boolean }>}
 */
export function toolCalls(events) {
  if (!Array.isArray(events)) return [];

  /** @type {Array<{ id: string, turn: number, name: string, command: string }>} */
  const uses = [];
  /** @type {Map<string, { output: string, isError: boolean }>} */
  const resultsById = new Map();
  /** @type {Set<string>} */
  const seenMessageIds = new Set();
  let assistantTurn = 0;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;

    if (event.type === "assistant") {
      const msgId = typeof event.message?.id === "string" && event.message.id.length > 0
        ? event.message.id
        : null;
      if (msgId === null) {
        assistantTurn += 1;
      } else if (!seenMessageIds.has(msgId)) {
        seenMessageIds.add(msgId);
        assistantTurn += 1;
      }
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

function isPipeSeparator(separator) {
  return separator === "|" || separator === "|&";
}

/**
 * Parse a shell command into top-level statements and the separator following
 * each statement, honouring shell-specific quoting, escaping, comments, and
 * line breaks in linear time. In Bash, heredoc delimiters are restricted to
 * `/^[A-Za-z0-9_.-]+$/` after removing whole-segment `'…'` / `"…"` quoting and
 * a leading `-` for `<<-`; any other delimiter form, or any heredoc inside a
 * command substitution (or arithmetic containing one), sets `unsupportedHeredoc`.
 * @param {string} command
 * @param {string} [shell]
 * @returns {{
 *   statements: Array<{ text: string, separator: ";" | "&&" | "||" | "|" | "|&" | "&" | "\n" | null }>,
 *   unsupportedHeredoc: boolean,
 * }}
 */
function parseStatements(command, shell = "Bash") {
  if (typeof command !== "string" || command.length === 0) {
    return { statements: [], unsupportedHeredoc: false };
  }

  const isPowerShell = typeof shell === "string" && shell.toLowerCase() === "powershell";
  const escapeChar = isPowerShell ? "`" : "\\";
  /** @type {Array<{ text: string, separator: ";" | "&&" | "||" | "|" | "|&" | "&" | "\n" | null }>} */
  const statements = [];
  /** @type {string[]} */
  const chunks = [];
  /** @type {Array<{ delimiter: string, stripTabs: boolean }>} */
  const pendingHeredocs = [];
  let arithDepth = 0;
  let arithHasCmdSub = false;
  let arithHasShift = false;
  let cmdSubDepth = 0;
  let inBacktick = false;
  let spanStart = 0;
  let quote = null;
  let atWordStart = true;
  let afterContinuationSep = false;

  const takeStatement = (endIdx) => {
    const raw = chunks.length === 0
      ? command.slice(spanStart, endIdx)
      : chunks.join("") + command.slice(spanStart, endIdx);
    chunks.length = 0;
    return raw.trim();
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== null) {
      if (isPowerShell) {
        if (quote === '"') {
          if (ch === "`" && i + 1 < command.length) {
            i += 1;
          } else if (ch === '"') {
            if (command[i + 1] === '"') {
              i += 1;
            } else {
              quote = null;
            }
          }
        } else if (ch === "'") {
          if (command[i + 1] === "'") {
            i += 1;
          } else {
            quote = null;
          }
        }
      } else if (quote === '"') {
        if (ch === "\\" && i + 1 < command.length) {
          i += 1;
        } else if (ch === '"') {
          quote = null;
        }
      } else if (ch === "'") {
        quote = null;
      }
      continue;
    }

    if (ch === escapeChar && i + 1 < command.length) {
      const next = command[i + 1];
      if (next === "\n" || next === "\r") {
        // Line continuation: drop escape + newline without splitting the statement.
        chunks.push(command.slice(spanStart, i));
        if (next === "\r" && command[i + 2] === "\n") {
          i += 2;
        } else {
          i += 1;
        }
        spanStart = i + 1;
        continue;
      }
      i += 1;
      atWordStart = false;
      afterContinuationSep = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      atWordStart = false;
      afterContinuationSep = false;
      continue;
    }
    if (isPowerShell && ch === "<" && command[i + 1] === "#") {
      chunks.push(command.slice(spanStart, i), " ");
      const closeIdx = command.indexOf("#>", i + 2);
      if (closeIdx === -1) {
        spanStart = command.length;
        break;
      }
      i = closeIdx + 1;
      spanStart = closeIdx + 2;
      atWordStart = true;
      continue;
    }
    if (!isPowerShell && ch === "`") {
      inBacktick = !inBacktick;
      if (arithDepth > 0) {
        if (arithHasShift) return { statements: [], unsupportedHeredoc: true };
        arithHasCmdSub = true;
      }
      atWordStart = false;
      afterContinuationSep = false;
      continue;
    }
    if (!isPowerShell && ch === "(") {
      if (i > 0 && command[i - 1] === "$" && command[i + 1] !== "(") {
        if (arithDepth > 0) {
          if (arithHasShift) return { statements: [], unsupportedHeredoc: true };
          arithHasCmdSub = true;
        }
        cmdSubDepth += 1;
      } else if (arithDepth === 0 && command[i + 1] === "(") {
        arithDepth = 2;
        arithHasCmdSub = false;
        arithHasShift = false;
        i += 1;
      } else if (arithDepth > 0 && !arithHasCmdSub) {
        arithDepth += 1;
      } else if (cmdSubDepth > 0) {
        cmdSubDepth += 1;
      } else if (arithDepth > 0) {
        arithDepth += 1;
      }
      atWordStart = true;
      afterContinuationSep = false;
      continue;
    }
    if (!isPowerShell && ch === ")") {
      if (arithDepth > 0 && !arithHasCmdSub) {
        arithDepth -= 1;
      } else if (cmdSubDepth > 0) {
        cmdSubDepth -= 1;
      } else if (arithDepth > 0) {
        arithDepth -= 1;
      }
      atWordStart = false;
      afterContinuationSep = false;
      continue;
    }
    if (!isPowerShell && ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        while (i + 1 < command.length && command[i + 1] === "<") {
          i += 1;
        }
        atWordStart = false;
        afterContinuationSep = false;
        continue;
      }
      if (arithDepth > 0 && !arithHasCmdSub && !inBacktick) {
        arithHasShift = true;
        i += 1;
        atWordStart = false;
        afterContinuationSep = false;
        continue;
      }
      if (cmdSubDepth > 0 || inBacktick || arithDepth > 0) {
        return { statements: [], unsupportedHeredoc: true };
      }
      let k = i + 2;
      const stripTabs = command[k] === "-";
      if (stripTabs) k += 1;
      while (k < command.length && (command[k] === " " || command[k] === "\t")) {
        k += 1;
      }
      let endD = k;
      let delim = "";
      let delimQuote = null;
      while (endD < command.length) {
        const c = command[endD];
        if (delimQuote === null) {
          if (/[\s();|&<>\r\n]/.test(c)) break;
          if (c === "'" || c === '"') {
            delimQuote = c;
            endD += 1;
            continue;
          }
          delim += c;
          endD += 1;
        } else if (c === "\r" || c === "\n") {
          break;
        } else if (c === delimQuote) {
          delimQuote = null;
          endD += 1;
        } else {
          delim += c;
          endD += 1;
        }
      }
      if (delimQuote !== null || !HEREDOC_DELIMITER_RE.test(delim)) {
        return { statements: [], unsupportedHeredoc: true };
      }
      pendingHeredocs.push({ delimiter: delim, stripTabs });
      i = endD - 1;
      atWordStart = false;
      afterContinuationSep = false;
      continue;
    }
    if (ch === "#" && atWordStart) {
      chunks.push(command.slice(spanStart, i));
      let j = i + 1;
      while (j < command.length && command[j] !== "\r" && command[j] !== "\n") {
        j += 1;
      }
      spanStart = j;
      i = j - 1;
      atWordStart = true;
      continue;
    }
    if (ch !== "\r" && ch !== "\n" && UNICODE_WS_RE.test(ch)) {
      atWordStart = true;
      continue;
    }
    if (ch === ";") {
      statements.push({ text: takeStatement(i), separator: ";" });
      spanStart = i + 1;
      atWordStart = true;
      afterContinuationSep = false;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        statements.push({ text: takeStatement(i), separator: "&&" });
        i += 1;
        spanStart = i + 1;
        atWordStart = true;
        afterContinuationSep = true;
        continue;
      }
      // Keep fd redirections like `2>&1` or `&>` inside the statement; split standalone `&`.
      const prev = i > 0 ? command[i - 1] : "";
      const next = command[i + 1] ?? "";
      if (prev !== ">" && prev !== "<" && next !== ">") {
        statements.push({ text: takeStatement(i), separator: "&" });
        spanStart = i + 1;
        atWordStart = true;
        afterContinuationSep = false;
      } else {
        atWordStart = false;
        afterContinuationSep = false;
      }
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") {
        statements.push({ text: takeStatement(i), separator: "||" });
        i += 1;
        spanStart = i + 1;
      } else if (!isPowerShell && command[i + 1] === "&") {
        statements.push({ text: takeStatement(i), separator: "|&" });
        i += 1;
        spanStart = i + 1;
      } else {
        statements.push({ text: takeStatement(i), separator: "|" });
        spanStart = i + 1;
      }
      atWordStart = true;
      afterContinuationSep = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      let nlEnd = ch === "\r" && command[i + 1] === "\n" ? i + 1 : i;
      const text = afterContinuationSep ? "" : takeStatement(i);
      if (afterContinuationSep) {
        chunks.length = 0;
      }
      if (pendingHeredocs.length > 0) {
        let cursor = nlEnd + 1;
        for (const { delimiter, stripTabs } of pendingHeredocs) {
          while (cursor <= command.length) {
            let lineEnd = cursor;
            while (lineEnd < command.length && command[lineEnd] !== "\r" && command[lineEnd] !== "\n") {
              lineEnd += 1;
            }
            const rawLine = command.slice(cursor, lineEnd);
            const candidate = stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
            const nextNlEnd =
              lineEnd < command.length && command[lineEnd] === "\r" && command[lineEnd + 1] === "\n"
                ? lineEnd + 1
                : lineEnd;
            nlEnd = nextNlEnd;
            cursor = nextNlEnd + 1;
            if (candidate === delimiter || lineEnd >= command.length) {
              break;
            }
          }
        }
        pendingHeredocs.length = 0;
      }
      if (!afterContinuationSep && text.length > 0) {
        statements.push({ text, separator: "\n" });
      }
      i = nlEnd;
      spanStart = i + 1;
      atWordStart = true;
      continue;
    }

    atWordStart = false;
    afterContinuationSep = false;
  }

  const tail = takeStatement(command.length);
  if (tail.length > 0) {
    statements.push({ text: tail, separator: null });
  }
  while (
    statements.length > 0
    && statements[statements.length - 1].text.length === 0
    && (statements[statements.length - 1].separator === ";"
      || statements[statements.length - 1].separator === "\n")
  ) {
    statements.pop();
  }
  if (
    statements.length > 0
    && (statements[statements.length - 1].separator === ";"
      || statements[statements.length - 1].separator === "\n")
  ) {
    statements[statements.length - 1].separator = null;
  }
  return { statements, unsupportedHeredoc: false };
}

/**
 * Split a shell command into top-level statements and the separator following
 * each statement, honouring shell-specific quoting, escaping, comments, and
 * line breaks in linear time.
 * @param {string} command
 * @param {string} [shell]
 * @returns {Array<{ text: string, separator: ";" | "&&" | "||" | "|" | "|&" | "&" | "\n" | null }>}
 */
export function splitStatements(command, shell = "Bash") {
  return parseStatements(command, shell).statements;
}

function isCdStatement(statement, isPowerShell) {
  if (statement.length === 0 || statement[0] === "'" || statement[0] === '"') return false;
  const tokens = tokenizeShellStatement(statement, isPowerShell);
  return extractCdTarget(tokens, isPowerShell).isCd;
}

/**
 * Parse a shell command against target alias regexes using shell-specific
 * statement and pipeline splitting.
 * Returns `{ solo: boolean, conditional: boolean }` when it contains a target
 * run, or `null` otherwise:
 * - `solo`: true iff the target is the only statement (after `cd` prefixes and
 *   `rocky run` unwrapping) and is unpiped.
 * - `conditional`: true iff the target is behind `&&` after a non-`cd`
 *   statement or anywhere in an `||` chain (so target execution may be skipped).
 * @param {string} command
 * @param {readonly RegExp[]} aliasRegexes
 * @param {string} [toolName]
 * @returns {{ solo: boolean, conditional: boolean } | null}
 */
function matchTargetCommand(command, aliasRegexes, toolName = "Bash") {
  if (typeof command !== "string" || aliasRegexes.length === 0) return null;

  const shell = toolName === "PowerShell" ? "PowerShell" : "Bash";
  const isPowerShell = shell === "PowerShell";
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;

  const unwrapped = unwrapRockyRun(trimmed).trim();
  if (unwrapped.length === 0) return null;

  const { statements, unsupportedHeredoc } = parseStatements(unwrapped, shell);
  if (unsupportedHeredoc || statements.length === 0) return null;
  if (statements[statements.length - 1].separator !== null) return null;

  for (let i = 0; i < statements.length; i += 1) {
    const stmt = statements[i];
    const prevSep = i > 0 ? statements[i - 1].separator : null;
    if (stmt.text.length === 0) {
      if (stmt.separator !== ";" && stmt.separator !== "\n") return null;
      if (prevSep !== null && prevSep !== ";" && prevSep !== "\n") return null;
    } else {
      const innerStmt = unwrapRockyRun(stmt.text.replace(/\s+2>&1$/, "").trim()).trim();
      if (innerStmt !== stmt.text && parseStatements(innerStmt, shell).unsupportedHeredoc) {
        return null;
      }
    }
  }

  let allLeadingAreCd = true;
  let hasNonCdInAndChain = false;
  let seenOrInList = false;
  let idx = 0;
  while (idx < statements.length) {
    if (statements[idx].text.length === 0) {
      idx += 1;
      continue;
    }
    const start = idx;
    while (idx < statements.length && isPipeSeparator(statements[idx].separator)) {
      if (statements[idx].text.length === 0 || idx + 1 >= statements.length || statements[idx + 1].text.length === 0) {
        return null;
      }
      idx += 1;
    }
    const end = idx;
    const afterSep = statements[end].separator;
    if (
      afterSep !== null
      && afterSep !== ";"
      && afterSep !== "&&"
      && afterSep !== "||"
      && afterSep !== "\n"
    ) {
      return null;
    }

    const piped = end > start;
    let hasTrailing = false;
    for (let j = end + 1; j < statements.length; j += 1) {
      if (statements[j].text.length > 0) {
        hasTrailing = true;
        break;
      }
    }
    let hasOrAheadInList = false;
    for (let j = end; j < statements.length; j += 1) {
      const sep = statements[j].separator;
      if (sep === "||") {
        hasOrAheadInList = true;
        break;
      }
      if (sep === null || sep === ";" || sep === "\n") {
        break;
      }
    }
    const inOrChain = seenOrInList || hasOrAheadInList;

    const targetPart = statements[start].text.replace(/\s+2>&1$/, "").trim();
    if (targetPart.length > 0) {
      const unwrappedTarget = unwrapRockyRun(targetPart).trim();
      if (unwrappedTarget !== targetPart) {
        const inner = matchTargetCommand(unwrappedTarget, aliasRegexes, toolName);
        if (inner) {
          return {
            solo: allLeadingAreCd && !piped && !hasTrailing && !inOrChain && inner.solo,
            conditional: hasNonCdInAndChain || inOrChain || inner.conditional,
          };
        }
      } else {
        for (const regex of aliasRegexes) {
          if (regex.test(targetPart)) {
            return {
              solo: allLeadingAreCd && !piped && !hasTrailing && !inOrChain,
              conditional: hasNonCdInAndChain || inOrChain,
            };
          }
        }
      }
    }

    const isSimpleCdPrefix = !piped && afterSep !== "||" && isCdStatement(statements[start].text, isPowerShell);
    if (!isSimpleCdPrefix) {
      allLeadingAreCd = false;
      if (afterSep === "&&") {
        hasNonCdInAndChain = true;
      }
    }
    if (afterSep === "||") {
      seenOrInList = true;
    } else if (afterSep === ";" || afterSep === "\n") {
      hasNonCdInAndChain = false;
      seenOrInList = false;
    }
    idx = end + 1;
  }
  return null;
}

// Target attribution rule:
// - A call whose only statement is the target (after `cd` prefixes and `rocky run`
//   unwrapping, unpiped) keeps exit-status classification (`trap_fail` on
//   normalized trap line, `pass` on zero status, `other_fail` on nonzero status).
// - Any other matched shape (leading non-`cd` statements, trailing statements,
//   pipes, `;`, `&&`, `||`, `rocky run "<chain>"`) is classified from output
//   evidence only using exact line equality (no normalization):
//   exact trap line -> `trap_fail`; exact accept line -> `pass`; neither -> `unknown`.
// - An `unknown` from a possibly-skipped target (behind `&&` after a non-`cd`
//   statement, or anywhere in an `||` chain) never moves a run off `no_attempt`.
function classifyTargetCalls(calls, task) {
  if (!Array.isArray(calls) || !task) return [];

  const aliases = Array.isArray(task.target?.aliases) ? task.target.aliases : [];
  const aliasRegexes = aliases.map((pattern) => new RegExp(pattern));
  const exactTrap = typeof task.trapLine === "string" ? task.trapLine : "";
  const normalizedTrap =
    typeof task.normalizedTrapLine === "string" && task.normalizedTrapLine.length > 0
      ? task.normalizedTrapLine
      : (exactTrap.length > 0 ? normalizeLine(exactTrap) : "");
  const acceptLine = typeof task.acceptLine === "string" ? task.acceptLine : "";

  /** @type {Array<{ turn: number, kind: "trap_fail" | "other_fail" | "pass" | "unknown", attempted: boolean }>} */
  const classified = [];

  for (const call of calls) {
    const matched = matchTargetCommand(call.command, aliasRegexes, call.name);
    if (!matched) continue;

    const cleaned = stripRockyLines(call.output);
    const lines = cleaned.split(/\r?\n/);
    const hasNormalizedTrap =
      normalizedTrap.length > 0
      && lines.some((line) => normalizeLine(line) === normalizedTrap);
    const hasExactTrap =
      exactTrap.length > 0
      && lines.some((line) => line === exactTrap);
    const hasAccept =
      acceptLine.length > 0
      && lines.some((line) => line === acceptLine);

    /** @type {"trap_fail" | "other_fail" | "pass" | "unknown"} */
    let kind;
    if (matched.solo) {
      if (hasNormalizedTrap) {
        kind = "trap_fail";
      } else if (call.isError === false) {
        kind = "pass";
      } else if (call.isError === true) {
        kind = "other_fail";
      } else {
        kind = "unknown";
      }
    } else if (hasExactTrap) {
      kind = "trap_fail";
    } else if (hasAccept) {
      kind = "pass";
    } else {
      kind = "unknown";
    }

    const attempted = !matched.conditional || hasExactTrap || hasAccept;
    classified.push({ turn: call.turn, kind, attempted });
  }

  return classified;
}

/**
 * Classify target runs among paired shell calls.
 * @param {readonly { turn: number, name: string, command: string, output: string, isError: boolean }[]} calls
 * @param {any} task
 * @returns {Array<{ turn: number, kind: "trap_fail" | "other_fail" | "pass" | "unknown" }>}
 */
export function classifyTargetRuns(calls, task) {
  return classifyTargetCalls(calls, task).map(({ turn, kind }) => ({ turn, kind }));
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

function extractTaskDir(events) {
  for (const event of events) {
    if (
      event
      && typeof event === "object"
      && event.type === "system"
      && event.subtype === "init"
      && typeof event.cwd === "string"
      && event.cwd.trim().length > 0
    ) {
      return event.cwd.trim();
    }
  }
  return null;
}

function isWin32StylePath(rawPath) {
  return WIN32_DRIVE_RE.test(rawPath) || rawPath.includes("\\");
}

function normalizePathSegments(segments, isAbsolute) {
  const out = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolute) {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  return out;
}

function isUncPrefix(slashed) {
  return slashed.startsWith("//") && slashed[2] !== "/";
}

function normalizeEvalPath(rawPath) {
  const win32 = isWin32StylePath(rawPath);
  const slashed = rawPath.replace(/\\/g, "/");
  if (WIN32_DRIVE_RE.test(slashed)) {
    const drive = slashed.slice(0, 2).toLowerCase();
    const segments = normalizePathSegments(slashed.slice(2).split("/"), true);
    return { normalized: `${drive}/${segments.join("/")}`, win32: true };
  }
  if (isUncPrefix(slashed)) {
    const segments = normalizePathSegments(slashed.slice(2).split("/"), true);
    return { normalized: `//${segments.join("/")}`, win32 };
  }
  if (slashed.startsWith("/")) {
    const segments = normalizePathSegments(slashed.split("/"), true);
    return { normalized: `/${segments.join("/")}`, win32 };
  }
  const segments = normalizePathSegments(slashed.split("/"), false);
  return { normalized: segments.length > 0 ? segments.join("/") : ".", win32 };
}

function resolveEvalPath(baseDir, candidate) {
  if (typeof candidate !== "string") return null;
  const raw = candidate.trim();
  if (raw.length === 0) return null;
  const slashed = raw.replace(/\\/g, "/");
  if (WIN32_DRIVE_RE.test(slashed) || isUncPrefix(slashed)) {
    return normalizeEvalPath(raw);
  }
  if (slashed.startsWith("/")) {
    const trimmedBase = typeof baseDir === "string" ? baseDir.trim() : "";
    if (WIN32_DRIVE_RE.test(trimmedBase)) {
      return normalizeEvalPath(`${trimmedBase.slice(0, 2)}${slashed}`);
    }
    return normalizeEvalPath(raw);
  }
  if (typeof baseDir === "string" && baseDir.length > 0) {
    const baseSlashed = baseDir.trim().replace(/\\/g, "/");
    if (baseSlashed.length > 0) {
      const joined = baseSlashed.endsWith("/")
        ? `${baseSlashed}${slashed}`
        : `${baseSlashed}/${slashed}`;
      const resolved = normalizeEvalPath(joined);
      return {
        normalized: resolved.normalized,
        win32: resolved.win32 || isWin32StylePath(baseDir) || isWin32StylePath(raw),
      };
    }
  }
  return normalizeEvalPath(raw);
}

function buildOverlayMatcher(taskDir, overlayPaths) {
  const taskDirIsWin32 = taskDir !== null && isWin32StylePath(taskDir);
  const exactTargets = new Set();
  const lowerTargets = new Set();

  for (const rel of overlayPaths) {
    const resolved = resolveEvalPath(taskDir, rel);
    if (!resolved) continue;
    exactTargets.add(resolved.normalized);
    lowerTargets.add(resolved.normalized.toLowerCase());
  }

  return {
    matches(candidate, baseDir = taskDir) {
      const resolved = resolveEvalPath(baseDir, candidate);
      if (!resolved) return false;
      if (taskDirIsWin32 || resolved.win32) {
        return lowerTargets.has(resolved.normalized.toLowerCase());
      }
      return exactTargets.has(resolved.normalized);
    },
  };
}

function tokenizeShellStatement(statement, isPowerShell) {
  const tokens = [];
  let current = "";
  let inToken = false;
  let quote = null;

  const flush = () => {
    if (inToken) {
      tokens.push(current);
      current = "";
      inToken = false;
    }
  };

  for (let i = 0; i < statement.length; i += 1) {
    const ch = statement[i];
    if (quote !== null) {
      if (isPowerShell) {
        if (quote === '"') {
          if (ch === "`" && i + 1 < statement.length) {
            current += statement[i + 1];
            i += 1;
          } else if (ch === '"') {
            if (statement[i + 1] === '"') {
              current += '"';
              i += 1;
            } else {
              quote = null;
            }
          } else {
            current += ch;
          }
        } else if (ch === "'") {
          if (statement[i + 1] === "'") {
            current += "'";
            i += 1;
          } else {
            quote = null;
          }
        } else {
          current += ch;
        }
      } else if (quote === '"') {
        if (ch === "\\" && i + 1 < statement.length && '"\\$`\n'.includes(statement[i + 1])) {
          current += statement[i + 1];
          i += 1;
        } else if (ch === '"') {
          quote = null;
        } else {
          current += ch;
        }
      } else if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch) || ch === "|" || ch === "<" || ch === ">") {
      flush();
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if ((isPowerShell ? ch === "`" : ch === "\\") && i + 1 < statement.length) {
      current += statement[i + 1];
      inToken = true;
      i += 1;
      continue;
    }
    current += ch;
    inToken = true;
  }
  flush();
  return tokens;
}

function extractCdTarget(tokens, isPowerShell) {
  if (tokens.length === 0) return { isCd: false, target: null };
  const head = tokens[0];
  if (isPowerShell) {
    const lower = head.toLowerCase();
    if (lower !== "cd" && lower !== "set-location" && lower !== "sl" && lower !== "chdir") {
      return { isCd: false, target: null };
    }
    for (let i = 1; i < tokens.length; i += 1) {
      const tok = tokens[i];
      const tokLower = tok.toLowerCase();
      if (tok === "--" || tokLower === "-path" || tokLower === "-literalpath") continue;
      const inlineMatch = /^-(?:path|literalpath):(.+)$/i.exec(tok);
      if (inlineMatch) return { isCd: true, target: inlineMatch[1] };
      if (tok.startsWith("-")) continue;
      return { isCd: true, target: tok };
    }
    return { isCd: true, target: null };
  }

  if (head !== "cd") return { isCd: false, target: null };
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "--" || tok === "-L" || tok === "-P" || tok === "-e" || tok === "-@") continue;
    return { isCd: true, target: tok };
  }
  return { isCd: true, target: null };
}

// ponytail: Static shell token extraction is descriptive only; paths built by
// shell variables, command substitution, or globbing are not resolved and may be missed.
function commandTouchesOverlay(command, toolName, taskDir, overlayMatcher) {
  if (typeof command !== "string" || command.length === 0) return false;
  const isPowerShell = toolName === "PowerShell";
  const unwrapped = unwrapRockyRun(command.trim());
  const { statements, unsupportedHeredoc } = parseStatements(unwrapped, toolName);
  if (unsupportedHeredoc) return true;

  let effectiveDir = taskDir;
  let unknownCwd = false;

  for (let i = 0; i < statements.length; i += 1) {
    const { text: rawStmt, separator } = statements[i];
    const prevSeparator = i > 0 ? statements[i - 1].separator : null;
    if (rawStmt.length === 0) continue;
    const stmt = unwrapRockyRun(rawStmt);
    if (stmt !== rawStmt && parseStatements(stmt, toolName).unsupportedHeredoc) {
      return true;
    }
    const tokens = tokenizeShellStatement(stmt, isPowerShell);
    if (tokens.length === 0) continue;

    const cd = extractCdTarget(tokens, isPowerShell);
    if (cd.isCd) {
      const persistsDir = isPowerShell
        ? !isPipeSeparator(prevSeparator)
        : (!isPipeSeparator(prevSeparator) && !isPipeSeparator(separator));
      if (persistsDir) {
        if (cd.target === null) {
          effectiveDir = null;
          unknownCwd = true;
        } else {
          const nextDir = resolveEvalPath(unknownCwd ? null : effectiveDir, cd.target);
          effectiveDir = nextDir ? nextDir.normalized : null;
          unknownCwd = nextDir === null;
        }
      }
      continue;
    }

    for (const token of tokens) {
      const candidates = [token];
      const flagValue = /^--?[A-Za-z0-9_-]+[=:](.+)$/.exec(token);
      if (flagValue) {
        candidates.push(flagValue[1]);
      }
      for (const candidate of candidates) {
        const slashed = candidate.replace(/\\/g, "/");
        const isAbs = WIN32_DRIVE_RE.test(slashed) || slashed.startsWith("/");
        if (unknownCwd && !isAbs) continue;
        if (overlayMatcher.matches(candidate, effectiveDir)) {
          return true;
        }
      }
    }
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
  const classified = classifyTargetCalls(calls, task);
  const hasAttempt = classified.some((run) => run.attempted);

  /** @type {number | "no_attempt"} */
  let repeatFailures;
  if (!hasAttempt) {
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
  const taskDir = isStaleTask ? extractTaskDir(list) : null;
  const overlayPaths = isStaleTask ? listFixOverlayPaths(task) : [];
  const overlayMatcher = isStaleTask && overlayPaths.length > 0
    ? buildOverlayMatcher(taskDir, overlayPaths)
    : null;
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
        if (overlayMatcher && !touchedStaleOverlay) {
          if (EDIT_TOOLS.has(block.name)) {
            for (const filePath of extractEditFilePaths(block)) {
              if (overlayMatcher.matches(filePath, taskDir)) {
                touchedStaleOverlay = true;
                break;
              }
            }
          } else if (SHELL_TOOLS.has(block.name)) {
            const cmd = typeof block.input?.command === "string" ? block.input.command : "";
            if (commandTouchesOverlay(cmd, block.name, taskDir, overlayMatcher)) {
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
    if (dirName.endsWith(".next") || dirName.endsWith(".prev")) continue;
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
