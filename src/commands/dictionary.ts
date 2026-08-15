import { dictionaryRankPortFromConfig, type DictionaryRankPort } from "../ai/dictionary-ai.js";
import { loadConfig } from "../core/config.js";
import { digestBuckets, queryDictionary, quizCandidates, type DictionaryHit } from "../core/dictionary.js";
import { canonicalPath } from "../core/memory-read.js";
import { whyFile, whyFileEvidence } from "../core/memory-query.js";
import { loadMemory, type MemoryRecord } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { createTtyPromptPort } from "../setup/prompt.js";
import { truncateUtf8 } from "../mcp/privacy.js";
import { ago, detail, say } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";
import { parseNoArgs, parseQueryArgs, reportCliUsage } from "./cli-args.js";

const MAX_QUERY_DISPLAY_BYTES = 160;
const MAX_SUBJECT_DISPLAY_BYTES = 120;
const MAX_PATH_DISPLAY_BYTES = 180;
const MAX_INTENT_DISPLAY_BYTES = 128;
const MAX_OUTPUT_LINE_BYTES = 512;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_USAGE = "export takes --kind failure|fix|note|triple and --since 30d. try again, question";
const EXPORT_KINDS: ReadonlySet<MemoryRecord["kind"]> = new Set(["failure", "fix", "note", "triple"]);

export interface DictionaryCommandDeps {
  load?: () => MemoryRecord[];
  say?: (line: string) => void;
  out?: (line: string) => void;
  rank?: DictionaryRankPort;
}

interface Sinks {
  speak: (line: string) => void;
  support: (line: string) => void;
  records: () => MemoryRecord[];
}

function resolve(deps: DictionaryCommandDeps): Sinks {
  return { speak: deps.say ?? say, support: deps.out ?? detail, records: deps.load ?? loadMemory };
}

type ExportCommandDeps = DictionaryCommandDeps & {
  stdout?: (line: string) => void;
  now?: number;
};

function exportUsage(speak: (line: string) => void): number {
  speak(EXPORT_USAGE);
  return 2;
}

function exportSince(value: string, now: number): number | undefined {
  const daysMatch = /^(\d+)d$/.exec(value);
  if (daysMatch !== null) {
    const days = Number(daysMatch[1]);
    const span = days * DAY_MS;
    if (!Number.isSafeInteger(days) || !Number.isFinite(span)) return undefined;
    return now - span;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// `export` is reserved as a command name, so this function keeps the explicit suffix.
// stdout carries raw JSONL data; say/out remain persona and supporting stderr sinks.
export function exportCommand(argv: string[], deps: ExportCommandDeps = {}): number {
  const { speak, records } = resolve(deps);
  const now = deps.now ?? Date.now();
  const kinds = new Set<MemoryRecord["kind"]>();
  let cutoff: number | undefined;
  let hasSince = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--kind") {
      const value = argv[index + 1];
      if (value === undefined || !EXPORT_KINDS.has(value as MemoryRecord["kind"])) return exportUsage(speak);
      kinds.add(value as MemoryRecord["kind"]);
      index += 1;
      continue;
    }
    if (argument === "--since") {
      if (hasSince) return exportUsage(speak);
      const value = argv[index + 1];
      if (value === undefined) return exportUsage(speak);
      cutoff = exportSince(value, now);
      if (cutoff === undefined) return exportUsage(speak);
      hasSince = true;
      index += 1;
      continue;
    }
    return exportUsage(speak);
  }

  const selected = records().filter((record) => (
    (kinds.size === 0 || kinds.has(record.kind))
    && (cutoff === undefined || record.ts >= cutoff)
  ));
  const stdout = deps.stdout ?? console.log;
  for (const record of selected) stdout(JSON.stringify(record));
  speak(`${selected.length} record go out. memory is yours. always.`);
  return 0;
}

function terminalSafe(value: string, maximumBytes: number): string {
  const withoutControls = safeTerminalLine(value)
    .replace(/[\u200b\u2060\ufeff]/gu, " ")
    .replace(/[?？]/gu, " ");
  return truncateUtf8(withoutControls, maximumBytes).value;
}

function subjectForTriple(triple: DictionaryHit["triple"]): string {
  const first = triple.mechanism.files[0];
  return terminalSafe(first ? first.props[0] ?? first.path : "something", MAX_SUBJECT_DISPLAY_BYTES);
}

function subject(hit: DictionaryHit): string {
  return subjectForTriple(hit.triple);
}

function shorten(text: string): string {
  const safe = terminalSafe(text, MAX_INTENT_DISPLAY_BYTES);
  return safe.length > 40 ? `${safe.slice(0, 37)}...` : safe;
}

function evidence(hits: DictionaryHit[], support: (line: string) => void): void {
  for (const hit of hits) {
    const first = hit.triple.mechanism.files[0];
    if (!first || !hit.triple.intent) continue;
    const line = `${shorten(hit.triple.intent.text)} -> ${subject(hit)}  (${terminalSafe(first.path, MAX_PATH_DISPLAY_BYTES)} +${first.plusMinus[0]} -${first.plusMinus[1]}, ${ago(hit.triple.ts)})`;
    support(terminalSafe(line, MAX_OUTPUT_LINE_BYTES));
  }
}

function fileForQuery(triple: DictionaryHit["triple"], query: string): DictionaryHit["triple"]["mechanism"]["files"][number] | undefined {
  const platform = triple.platform ?? "unknown";
  const normalized = canonicalPath(query, { platform, cwd: triple.cwd });
  const normalizedDisplay = canonicalPath(query, { platform });
  return triple.mechanism.files.find((file) => {
    const candidate = canonicalPath(file.path, { platform, cwd: triple.cwd });
    const candidateDisplay = canonicalPath(file.path, { platform });
    return candidate === normalized || candidateDisplay === normalizedDisplay
      || candidateDisplay.endsWith(`/${normalizedDisplay}`);
  });
}

function reorder(hits: readonly DictionaryHit[], rankedIds: readonly string[]): DictionaryHit[] | undefined {
  const result: DictionaryHit[] = [];
  const used = new Set<number>();
  for (const id of rankedIds) {
    for (let index = 0; index < hits.length; index += 1) {
      if (!used.has(index) && hits[index]?.triple.id === id) {
        used.add(index);
        result.push(hits[index] as DictionaryHit);
      }
    }
  }
  if (result.length === 0) return undefined;
  for (let index = 0; index < hits.length; index += 1) {
    if (!used.has(index)) result.push(hits[index] as DictionaryHit);
  }
  return result;
}

export async function what(argv: string[], deps: DictionaryCommandDeps = {}): Promise<number> {
  const { speak, support, records } = resolve(deps);
  let parsed;
  try {
    parsed = parseQueryArgs(argv, {
      allowAi: true,
      usage: "rocky what [--ai] [--] <query...>",
    });
  } catch (error) {
    const code = reportCliUsage(error, speak, support);
    if (code !== undefined) return code;
    throw error;
  }
  const { query, useAi } = parsed;
  if (!query) {
    speak('what needs word to look up. rocky what "naikin", question');
    return 2;
  }
  const hits = queryDictionary(records(), query);
  if (hits.length === 0) {
    speak(terminalSafe(`"${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}"... I not hear this before. I listen now.`, MAX_OUTPUT_LINE_BYTES));
    return 0;
  }
  let displayed = hits;
  if (useAi) {
    let rank = deps.rank;
    if (rank === undefined) {
      try {
        rank = dictionaryRankPortFromConfig(loadConfig(resolveRockyPaths().config));
      } catch {
        rank = undefined;
      }
    }
    if (rank === undefined) {
      speak("model sleeps. I use my own ears.");
    } else {
      let rankedIds: readonly string[] | undefined;
      try {
        rankedIds = await rank.run(query, hits, AbortSignal.timeout(10_000));
      } catch {
        rankedIds = undefined;
      }
      const ranked = Array.isArray(rankedIds) && rankedIds.every((id) => typeof id === "string")
        ? reorder(hits, rankedIds)
        : undefined;
      if (ranked === undefined) speak("model sleeps. I use my own ears.");
      else displayed = ranked;
    }
  }
  speak(terminalSafe(`you say "${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}". it is ${subject(displayed[0] as DictionaryHit)}. I think. check, question`, MAX_OUTPUT_LINE_BYTES));
  evidence(displayed, support);
  return 0;
}

export function how(argv: string[], deps: DictionaryCommandDeps = {}): number {
  const { speak, support, records } = resolve(deps);
  let query: string;
  try {
    query = parseQueryArgs(argv, {
      usage: "rocky how [--] <query...>",
    }).query;
  } catch (error) {
    const code = reportCliUsage(error, speak, support);
    if (code !== undefined) return code;
    throw error;
  }
  if (!query) {
    speak('how needs word to remember. rocky how "naikin", question');
    return 2;
  }
  const hits = queryDictionary(records(), query);
  if (hits.length === 0) {
    speak(terminalSafe(`"${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}"... no memory. you teach me when you work. good good.`, MAX_OUTPUT_LINE_BYTES));
    return 0;
  }
  const safeQuery = terminalSafe(query, MAX_QUERY_DISPLAY_BYTES);
  const safeSubject = subject(hits[0]);
  speak(terminalSafe(`last time you say "${safeQuery}", it become ${safeSubject}. maybe you mean ${safeSubject}, question`, MAX_OUTPUT_LINE_BYTES));
  evidence(hits, support);
  return 0;
}

export function why(argv: string[], deps: DictionaryCommandDeps = {}): number {
  const { speak, support, records } = resolve(deps);
  let path: string;
  try {
    path = parseQueryArgs(argv, {
      usage: "rocky why [--] <file>",
    }).query;
  } catch (error) {
    const code = reportCliUsage(error, speak, support);
    if (code !== undefined) return code;
    throw error;
  }
  if (!path) {
    speak("why needs file to remember. rocky why src/app.css, question");
    return 2;
  }
  const safePath = terminalSafe(path, MAX_PATH_DISPLAY_BYTES);
  const memory = records();
  const evidenceResult = whyFileEvidence(memory, path);
  // Legacy triples may contain an exact file witness without the newer
  // baseline/provenance proof. Keep that historical explanation visible, but
  // preserve conservative coverage disclosure and never claim completeness.
  const hits = evidenceResult.matches.length > 0
    ? evidenceResult.matches
    : evidenceResult.coverageIncomplete
      ? whyFile(memory, path)
      : evidenceResult.matches;
  if (hits.length === 0) {
    if (evidenceResult.coverageIncomplete || evidenceResult.possible.length > 0) {
      speak(terminalSafe(`"${safePath}"... I not know if agent touch. coverage incomplete.`, MAX_OUTPUT_LINE_BYTES));
      support(terminalSafe(`coverage status: ${evidenceResult.coverage.status}; possible path omitted.`, MAX_OUTPUT_LINE_BYTES));
      return 0;
    }
    speak(terminalSafe(`"${safePath}"... nobody touch this while I listen.`, MAX_OUTPUT_LINE_BYTES));
    return 0;
  }
  if (evidenceResult.coverageIncomplete) {
    support(terminalSafe(`coverage status: ${evidenceResult.coverage.status}; some path may be omitted.`, MAX_OUTPUT_LINE_BYTES));
  }
  for (const triple of hits) {
    const selected = fileForQuery(triple, path);
    const where = selected
      ? `${terminalSafe(selected.path, MAX_PATH_DISPLAY_BYTES)} +${selected.plusMinus[0]} -${selected.plusMinus[1]}`
      : safePath;
    const rationale = triple.rationale ? terminalSafe(triple.rationale.text, MAX_INTENT_DISPLAY_BYTES).trim() : "";
    if (rationale) {
      speak(terminalSafe(`agent say: ${rationale}. I only hear. correct, question`, MAX_OUTPUT_LINE_BYTES));
      const tags = triple.rationale?.tags
        .map((tag) => terminalSafe(tag, MAX_INTENT_DISPLAY_BYTES))
        .filter(Boolean)
        .join(" ");
      support(terminalSafe(`  (${where}, ${ago(triple.ts)}${tags ? `, tags: ${tags}` : ""})`, MAX_OUTPUT_LINE_BYTES));
    } else {
      speak(terminalSafe(`change happen. no reason I hear. (${where}, ${ago(triple.ts)})`, MAX_OUTPUT_LINE_BYTES));
    }
  }
  return 0;
}

export function digest(argv: string[], deps: DictionaryCommandDeps & { now?: number } = {}): number {
  const { speak, support, records } = resolve(deps);
  try {
    parseNoArgs(argv, "rocky digest");
  } catch (error) {
    const code = reportCliUsage(error, speak, support);
    if (code !== undefined) return code;
    throw error;
  }
  const now = deps.now ?? Date.now();
  const memory = records();
  const buckets = digestBuckets(memory, now);
  if (buckets.length === 0) {
    speak("quiet week. no intent I hear. quiet good good.");
    return 0;
  }

  const count = memory.filter((record) => record.kind === "triple"
    && record.ts <= now
    && now - record.ts <= WEEK_MS).length;
  const top = buckets[0];
  const headline = top && top.count >= 3
    ? `${count} intent this week. ${terminalSafe(top.tag, MAX_INTENT_DISPLAY_BYTES)} again and again. pattern, question`
    : `${count} intent this week. I remember all.`;
  speak(terminalSafe(headline, MAX_OUTPUT_LINE_BYTES));
  for (const bucket of buckets) {
    const tag = terminalSafe(bucket.tag, MAX_INTENT_DISPLAY_BYTES);
    const examples = bucket.examples.slice(0, 3)
      .map((example) => terminalSafe(example, MAX_INTENT_DISPLAY_BYTES))
      .join("; ");
    support(terminalSafe(`${tag}: ${bucket.count}  (${examples})`, MAX_OUTPUT_LINE_BYTES));
  }
  return 0;
}

export async function quiz(
  argv: string[],
  deps: DictionaryCommandDeps & {
    ask?: (msg: string) => Promise<string | undefined>;
    now?: number;
  } = {},
): Promise<number> {
  const { speak, support, records } = resolve(deps);
  try {
    parseNoArgs(argv, "rocky quiz");
  } catch (error) {
    const code = reportCliUsage(error, speak, support);
    if (code !== undefined) return code;
    throw error;
  }
  let ask = deps.ask;
  if (ask === undefined) {
    if (process.stdin.isTTY !== true) {
      speak("quiz needs terminal with you in it. later, question");
      return 0;
    }
    const port = createTtyPromptPort();
    if (port === undefined) {
      speak("quiz needs terminal with you in it. later, question");
      return 0;
    }
    ask = (message) => port.ask(message);
  }

  const now = deps.now ?? Date.now();
  const candidates = quizCandidates(records(), now, 3);
  if (candidates.length === 0) {
    speak("nothing old enough to ask. work more, come back, question");
    return 0;
  }

  for (const candidate of candidates) {
    const intent = terminalSafe(candidate.intent?.text ?? "this change", MAX_INTENT_DISPLAY_BYTES);
    speak(terminalSafe(`you say "${intent}". what it become, question`, MAX_OUTPUT_LINE_BYTES));
    await ask("your answer: ");
    const first = candidate.mechanism.files[0];
    const path = terminalSafe(first?.path ?? "somewhere", MAX_PATH_DISPLAY_BYTES);
    speak(terminalSafe(`I remember: ${subjectForTriple(candidate)}. (${path}, ${ago(candidate.ts)})`, MAX_OUTPUT_LINE_BYTES));
  }
  speak("you know better than me. good good.");
  return 0;
}
