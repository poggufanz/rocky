// src/commands/teach.ts
import { readFileSync, statSync } from "node:fs";
import { loadMemory } from "../core/memory-read.js";
import { teachLookup } from "../core/teach.js";
import { buildLadder, defaultTeachNeighbor, type LadderResult } from "../core/teach-ladder.js";
import { gapRungFor, renderLadderCard, renderLadderExpanded, renderWitnessCard } from "../core/teach-render.js";
import { redactSecretsAtBoundary } from "../core/redact.js";
import { block, detail, heading, say } from "../ui/rocky.js";
import { CliUsageError, reportCliUsage } from "./cli-args.js";

const EMPTY_STATE = "not heard why yet. agent explains when it writes. ask agent, rocky remembers, question";
const USAGE = "rocky teach <file>[:<line>] [--stdin] [--ladder] [--quiet]";
const SELECTION_PAD = 3;
const TEACH_STDIN_CAP_BYTES = 2 * 1024 * 1024;
const TEACH_READ_CAP_BYTES = 2 * 1024 * 1024;

export interface TeachDeps {
  say?: (line: string) => void;
  heading?: (line: string) => void;
  block?: (lines: string[]) => void;
  detail?: (line: string) => void;
}

interface TeachArgs {
  file: string;
  line?: number;
  stdin: boolean;
  ladder: boolean;
  quiet: boolean;
}

function parseTeachArgs(argv: readonly string[]): TeachArgs {
  let file: string | undefined;
  let line: number | undefined;
  let stdin = false;
  let ladder = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === "--stdin") {
      if (stdin) throw new CliUsageError("unexpected option: --stdin", USAGE);
      stdin = true;
      continue;
    }
    if (arg === "--ladder") {
      if (ladder) throw new CliUsageError("unexpected option: --ladder", USAGE);
      ladder = true;
      continue;
    }
    if (arg === "--quiet") {
      if (quiet) throw new CliUsageError("unexpected option: --quiet", USAGE);
      quiet = true;
      continue;
    }
    if (arg.startsWith("-")) throw new CliUsageError(`unexpected option: ${arg}`, USAGE);
    if (file !== undefined) throw new CliUsageError(`unexpected argument: ${arg}`, USAGE);
    file = arg;
  }
  if (file === undefined) throw new CliUsageError("teach needs a file", USAGE);
  const lineMatch = /^(.*):(\d+)$/.exec(file);
  if (lineMatch !== null) {
    file = lineMatch[1] ?? "";
    line = Number(lineMatch[2]);
    if (!Number.isSafeInteger(line) || line < 1) throw new CliUsageError("line must be at least 1", USAGE);
  }
  return { file, line, stdin, ladder, quiet };
}

/**
 * Read all of stdin for `teach --stdin`, bounded. A truncated or unreadable
 * stream is not fatal here — the snippet then simply matches less; the same
 * cap pattern the gate-event reader uses.
 */
async function readTeachStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.byteLength;
      if (total > TEACH_STDIN_CAP_BYTES) break;
      chunks.push(buffer);
    }
  } catch {
    // A stdin stream error must not throw out of teach.
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function teach(argv: readonly string[], deps: TeachDeps = {}): Promise<number> {
  const speak = deps.say ?? say;
  const printHeading = deps.heading ?? heading;
  const printBlock = deps.block ?? block;
  const printDetail = deps.detail ?? detail;

  let parsed: TeachArgs;
  try {
    parsed = parseTeachArgs(argv);
  } catch (error) {
    const code = reportCliUsage(error, speak, printDetail);
    if (code !== undefined) return code;
    throw error;
  }
  const { file, line, stdin, ladder, quiet } = parsed;

  let fileText: string;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > TEACH_READ_CAP_BYTES) throw new Error("bounded teach read miss");
    fileText = readFileSync(file, "utf8");
  } catch {
    if (!quiet) speak(EMPTY_STATE);
    return 0;
  }
  const lines = fileText.split(/\r?\n/);
  const total = lines.length;
  if (line !== undefined && line > total) {
    if (!quiet) speak(EMPTY_STATE);
    return 0;
  }

  let snippet: string | undefined;
  let startLine = 1;
  let endLine = total;
  let anchorStart = 1;
  let anchorEnd = total;
  if (stdin) {
    if (process.stdin.isTTY) {
      const code = reportCliUsage(new CliUsageError("--stdin needs piped input, not a terminal", USAGE), speak, printDetail);
      if (code !== undefined) return code;
    }
    snippet = await readTeachStdin();
  } else if (line !== undefined) {
    startLine = Math.max(1, line - SELECTION_PAD);
    endLine = Math.min(total, line + SELECTION_PAD);
    snippet = lines.slice(startLine - 1, endLine).join("\n");
    anchorStart = line;
    anchorEnd = line;
  }

  const records = loadMemory();
  const hit = teachLookup(records, { path: file, cwd: process.cwd(), ...(snippet === undefined ? {} : { snippet }) });

  let ladderResult: LadderResult | undefined;
  if (snippet !== undefined) {
    ladderResult = buildLadder({
      file,
      startLine: anchorStart,
      endLine: anchorEnd,
      fileText,
      readNeighbor: defaultTeachNeighbor(file),
      ...(hit !== undefined ? { git: () => undefined } : {}),
    });
  }

  if (hit !== undefined) {
    const gapRung = snippet === undefined ? undefined : gapRungFor(hit, ladderResult);
    const card = renderWitnessCard(hit, gapRung);
    printHeading(card.header);
    printBlock([...card.lines]);
    printDetail(card.evidence);
    return 0;
  }

  if (ladderResult !== undefined && ladderResult.rungs.length > 0) {
    const label = stdin ? "snippet from stdin" : `line ${line}`;
    const card = renderLadderCard(file, label, ladderResult);
    printHeading(card.header);
    printBlock(card.lines.map((l) => redactSecretsAtBoundary(l)));
    printDetail(card.evidence);
    if (ladder) printBlock(renderLadderExpanded(ladderResult).map((l) => redactSecretsAtBoundary(l)));
    return 0;
  }

  if (!quiet) speak(EMPTY_STATE);
  return 0;
}