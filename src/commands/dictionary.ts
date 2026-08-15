import { dictionaryRankPortFromConfig, type DictionaryRankPort } from "../ai/dictionary-ai.js";
import { loadConfig } from "../core/config.js";
import { digestBuckets, queryDictionary, queryNotes, quizCandidates, type DictionaryHit, type NoteHit } from "../core/dictionary.js";
import { canonicalPath, isCompleteMemoryCoverage, isOperationalMemoryRecord, loadMemoryChecked } from "../core/memory-read.js";
import { whyFile, whyFileEvidence } from "../core/memory-query.js";
import type { MemoryCoverage, MemoryRecord } from "../core/memory-read.js";
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
  coverage?: () => MemoryCoverage;
  say?: (line: string) => void;
  out?: (line: string) => void;
  rank?: DictionaryRankPort;
  now?: number;
}

interface Sinks {
  speak: (line: string) => void;
  support: (line: string) => void;
  records: () => MemoryRecord[];
  coverage: () => MemoryCoverage | undefined;
}

function resolve(deps: DictionaryCommandDeps): Sinks {
  if (deps.load !== undefined) {
    return {
      speak: deps.say ?? say,
      support: deps.out ?? detail,
      records: deps.load,
      coverage: deps.coverage ?? (() => undefined),
    };
  }
  let loaded: ReturnType<typeof loadMemoryChecked> | undefined;
  const loadOnce = (): ReturnType<typeof loadMemoryChecked> => loaded ??= loadMemoryChecked();
  return {
    speak: deps.say ?? say,
    support: deps.out ?? detail,
    // Keep argument/usage validation lazy: invalid commands must not touch
    // the memory file. All valid surfaces in one invocation share one load.
    records: () => loadOnce().records,
    coverage: deps.coverage ?? (() => loadOnce().coverage),
  };
}

function coverageIncomplete(value: MemoryCoverage | undefined): boolean {
  return value !== undefined && !isCompleteMemoryCoverage(value);
}

function coverageLine(value: MemoryCoverage): string {
  return `memory coverage incomplete: version ${value.version}; scanned ${value.scanned}; skipped ${value.skipped}; truncated ${value.truncated}; bytes ${value.bytesScanned}/${value.bytesTotal}${value.reason === undefined ? "" : `; reason ${value.reason}`}`;
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
  const { speak, support, records, coverage } = resolve(deps);
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

  const scan = coverage();
  if (scan !== undefined && coverageIncomplete(scan)) {
    speak("memory coverage incomplete. export stops. no false file, question");
    support(coverageLine(scan));
    return 1;
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

function subjectForNote(note: NoteHit["note"]): string {
  return terminalSafe(note.subject || note.file || "your note", MAX_SUBJECT_DISPLAY_BYTES);
}

type LookupHit = DictionaryHit | NoteHit;

function subject(hit: LookupHit): string {
  return "triple" in hit ? subjectForTriple(hit.triple) : subjectForNote(hit.note);
}

function shorten(text: string): string {
  const safe = terminalSafe(text, MAX_INTENT_DISPLAY_BYTES);
  return safe.length > 40 ? `${safe.slice(0, 37)}...` : safe;
}

function tripleConfidence(triple: DictionaryHit["triple"]): { confidence: "confirmed" | "incomplete"; reason: string; coverage: string; files: string } {
  const complete = triple.mechanism.coverageStatus === "complete"
    && triple.mechanism.truncatedFiles === 0
    && triple.mechanism.baseline === "captured"
    && triple.mechanism.files.length > 0
    && triple.mechanism.files.every((file) => file.provenance === "tool-observed" || file.provenance === "git-diff-inferred");
  const first = triple.mechanism.files[0];
  const files = first === undefined ? "none" : `${triple.mechanism.files.length}; witness=${terminalSafe(first.path, 96)}`;
  return {
    confidence: complete ? "confirmed" : "incomplete",
    reason: complete ? "captured file coverage complete" : "file coverage incomplete; I do not know full change",
    coverage: complete ? "complete" : "incomplete",
    files,
  };
}

function noteConfidence(note: NoteHit["note"]): { confidence: "possible"; reason: string; coverage: string; files: string } {
  return {
    confidence: "possible",
    reason: "user comprehension note is remembered answer, not verified ground truth",
    coverage: "single-file note",
    files: terminalSafe(note.file, MAX_PATH_DISPLAY_BYTES),
  };
}

function evidenceLine(hit: LookupHit): string {
  if ("note" in hit) {
    const note = hit.note;
    const metadata = noteConfidence(note);
    return terminalSafe(`note ${note.id} ts=${note.ts} source=note file=${metadata.files} coverage=${metadata.coverage} confidence=${metadata.confidence} reason=${metadata.reason}; subject=${subjectForNote(note)} answer=${terminalSafe(note.answer, MAX_INTENT_DISPLAY_BYTES)}`, MAX_OUTPUT_LINE_BYTES);
  }
  const triple = hit.triple;
  const first = triple.mechanism.files[0];
  if (!first || !triple.intent) return "";
  const metadata = tripleConfidence(triple);
  return terminalSafe(`${shorten(triple.intent.text)} -> ${subjectForTriple(triple)}  (${terminalSafe(first.path, MAX_PATH_DISPLAY_BYTES)} +${first.plusMinus[0]} -${first.plusMinus[1]}, ${ago(triple.ts)}; id=${triple.id} ts=${triple.ts} source=${triple.origin} agent=${triple.agent} files=${metadata.files} coverage=${metadata.coverage} confidence=${metadata.confidence} reason=${metadata.reason})`, MAX_OUTPUT_LINE_BYTES);
}

function evidence(hits: LookupHit[], support: (line: string) => void): void {
  for (const hit of hits) {
    const line = evidenceLine(hit);
    if (line) support(line);
  }
}

function fileForQuery(triple: DictionaryHit["triple"], query: string): DictionaryHit["triple"]["mechanism"]["files"][number] | undefined {
  const platform = triple.platform ?? "unknown";
  const normalized = canonicalPath(query, { platform, cwd: triple.cwd });
  const normalizedDisplay = canonicalPath(query, { platform });
  const exact = triple.mechanism.files.find((file) => {
    const candidate = canonicalPath(file.path, { platform, cwd: triple.cwd });
    const candidateDisplay = canonicalPath(file.path, { platform });
    return candidate === normalized || candidateDisplay === normalizedDisplay;
  });
  if (exact !== undefined) return exact;
  return triple.mechanism.files.find((file) => {
    const candidateDisplay = canonicalPath(file.path, { platform });
    return normalizedDisplay.length > 0 && candidateDisplay.endsWith(`/${normalizedDisplay}`);
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

function copyRankHit(hit: DictionaryHit): DictionaryHit {
  const triple = hit.triple;
  return {
    score: hit.score,
    triple: {
      ...triple,
      ...(triple.intent === undefined ? {} : { intent: { ...triple.intent } }),
      ...(triple.rationale === undefined ? {} : { rationale: { ...triple.rationale, tags: [...triple.rationale.tags] } }),
      mechanism: {
        ...triple.mechanism,
        files: triple.mechanism.files.map((file) => ({
          ...file,
          plusMinus: [file.plusMinus[0], file.plusMinus[1]] as [number, number],
          props: [...file.props],
        })),
      },
    },
  };
}

function teachingHits(records: readonly MemoryRecord[], query: string, now: number): { triples: DictionaryHit[]; notes: NoteHit[]; all: LookupHit[] } {
  const triples = queryDictionary(records, query, 5, now);
  const notes = queryNotes(records, query, 5, now);
  const seen = new Set<string>();
  const all: LookupHit[] = [...triples, ...notes].filter((hit) => {
    const id = "triple" in hit ? hit.triple.id : hit.note.id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  all.sort((a, b) => b.score - a.score || ("triple" in b ? b.triple.ts : b.note.ts) - ("triple" in a ? a.triple.ts : a.note.ts)
    || ("triple" in a ? a.triple.id : a.note.id).localeCompare("triple" in b ? b.triple.id : b.note.id));
  return { triples, notes, all: all.slice(0, 5) };
}

function futureTeachingMatch(records: readonly MemoryRecord[], query: string, now: number): boolean {
  if (records.every((record) => isOperationalMemoryRecord(record, now))) return false;
  return queryDictionary(records, query, 5, Number.MAX_SAFE_INTEGER).length > 0
    || queryNotes(records, query, 5, Number.MAX_SAFE_INTEGER).length > 0;
}

export async function what(argv: string[], deps: DictionaryCommandDeps = {}): Promise<number> {
  const { speak, support, records, coverage } = resolve(deps);
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
  const scan = coverage();
  const memory = records();
  const now = deps.now ?? Date.now();
  const teaching = teachingHits(memory, query, now);
  if (teaching.all.length === 0) {
    if (scan !== undefined && coverageIncomplete(scan)) {
      speak("memory coverage incomplete. I not know. check, question");
      support(coverageLine(scan));
      return 0;
    }
    speak(terminalSafe(futureTeachingMatch(memory, query, now)
      ? `"${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}"... I not know yet. evidence future. check, question`
      : `"${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}"... I not hear this before. I listen now.`, MAX_OUTPUT_LINE_BYTES));
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan));
  let displayed = teaching.triples;
  if (useAi && teaching.triples.length > 0) {
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
        rankedIds = await rank.run(query, teaching.triples.map(copyRankHit), AbortSignal.timeout(10_000));
      } catch {
        rankedIds = undefined;
      }
      const ranked = Array.isArray(rankedIds) && rankedIds.every((id) => typeof id === "string")
        ? reorder(teaching.triples, rankedIds)
        : undefined;
      if (ranked === undefined) speak("model sleeps. I use my own ears.");
      else displayed = ranked;
    }
  }
  const shown: LookupHit[] = useAi && teaching.triples.length > 0
    ? [...displayed, ...teaching.notes].slice(0, 5)
    : teaching.all;
  speak(terminalSafe("triple" in (shown[0] as LookupHit)
    ? `you say "${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}". it is ${subject(shown[0] as LookupHit)}. I think. check, question`
    : `you say "${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}". your note says ${subject(shown[0] as LookupHit)}. I only hear. check, question`, MAX_OUTPUT_LINE_BYTES));
  evidence(shown, support);
  return 0;
}

export function how(argv: string[], deps: DictionaryCommandDeps = {}): number {
  const { speak, support, records, coverage } = resolve(deps);
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
  const scan = coverage();
  const memory = records();
  const now = deps.now ?? Date.now();
  const teaching = teachingHits(memory, query, now);
  if (teaching.all.length === 0) {
    if (scan !== undefined && coverageIncomplete(scan)) {
      speak("memory coverage incomplete. I not know. check, question");
      support(coverageLine(scan));
      return 0;
    }
    speak(terminalSafe(futureTeachingMatch(memory, query, now)
      ? `"${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}"... I not know yet. evidence future. check, question`
      : `"${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}"... no memory. you teach me when you work. good good.`, MAX_OUTPUT_LINE_BYTES));
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan));
  const safeQuery = terminalSafe(query, MAX_QUERY_DISPLAY_BYTES);
  const first = teaching.all[0] as LookupHit;
  speak(terminalSafe("triple" in first
    ? `last time you say "${safeQuery}", it become ${subject(first)}. maybe you mean ${subject(first)}, question`
    : `last time you say "${safeQuery}", your note says ${subject(first)}. I only hear, question`, MAX_OUTPUT_LINE_BYTES));
  evidence(teaching.all, support);
  return 0;
}

export function why(argv: string[], deps: DictionaryCommandDeps = {}): number {
  const { speak, support, records, coverage } = resolve(deps);
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
  const now = deps.now ?? Date.now();
  const scan = coverage();
  const memory = records();
  const evidenceResult = whyFileEvidence(memory, path, 5, now);
  // Legacy triples may contain an exact file witness without the newer
  // baseline/provenance proof. Keep that historical explanation visible, but
  // preserve conservative coverage disclosure and never claim completeness.
  const hits = evidenceResult.matches.length > 0
    ? evidenceResult.matches
    : evidenceResult.coverageIncomplete
      ? whyFile(memory, path, 5, now)
      : evidenceResult.matches;
  if (hits.length === 0) {
    if (evidenceResult.ambiguousPath) {
      speak(terminalSafe(`"${safePath}"... multiple possible paths. clarify, question`, MAX_OUTPUT_LINE_BYTES));
      support(terminalSafe(`coverage status: ${evidenceResult.coverage.status}; no silent rationale selection; confidence=incomplete reason=ambiguous path`, MAX_OUTPUT_LINE_BYTES));
      return 0;
    }
    if ((scan !== undefined && coverageIncomplete(scan)) || evidenceResult.coverageIncomplete || evidenceResult.possible.length > 0) {
      speak(terminalSafe(`"${safePath}"... I not know if agent touch. coverage incomplete.`, MAX_OUTPUT_LINE_BYTES));
      if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan));
      support(terminalSafe(`coverage status: ${evidenceResult.coverage.status}; possible path omitted.`, MAX_OUTPUT_LINE_BYTES));
      return 0;
    }
    speak(terminalSafe(`"${safePath}"... nobody touch this while I listen.`, MAX_OUTPUT_LINE_BYTES));
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan));
  if (evidenceResult.coverageIncomplete) {
    support(terminalSafe(`coverage status: ${evidenceResult.coverage.status}; some path may be omitted.`, MAX_OUTPUT_LINE_BYTES));
  }
  for (const triple of hits) {
    const selected = fileForQuery(triple, path);
    const where = selected
      ? `${terminalSafe(selected.path, MAX_PATH_DISPLAY_BYTES)} +${selected.plusMinus[0]} -${selected.plusMinus[1]}`
      : safePath;
    const rationale = triple.rationale ? terminalSafe(triple.rationale.text, MAX_INTENT_DISPLAY_BYTES).trim() : "";
    const metadata = tripleConfidence(triple);
    const provenance = terminalSafe(`id=${triple.id} ts=${triple.ts} source=${triple.origin} agent=${triple.agent} files=${metadata.files} coverage=${metadata.coverage} confidence=${metadata.confidence} reason=${metadata.reason}`, MAX_OUTPUT_LINE_BYTES);
    if (rationale) {
      speak(terminalSafe(`agent say: ${rationale}. I only hear. correct, question`, MAX_OUTPUT_LINE_BYTES));
      const tags = triple.rationale?.tags
        .map((tag) => terminalSafe(tag, MAX_INTENT_DISPLAY_BYTES))
        .filter(Boolean)
        .join(" ");
      support(terminalSafe(`  (${where}, ${ago(triple.ts)}${tags ? `, tags: ${tags}` : ""}; ${provenance})`, MAX_OUTPUT_LINE_BYTES));
    } else {
      speak(terminalSafe(`change happen. no reason I hear. (${where}, ${ago(triple.ts)}; ${provenance})`, MAX_OUTPUT_LINE_BYTES));
    }
  }
  return 0;
}

export function digest(argv: string[], deps: DictionaryCommandDeps & { now?: number } = {}): number {
  const { speak, support, records, coverage } = resolve(deps);
  try {
    parseNoArgs(argv, "rocky digest");
  } catch (error) {
    const code = reportCliUsage(error, speak, support);
    if (code !== undefined) return code;
    throw error;
  }
  const now = deps.now ?? Date.now();
  const scan = coverage();
  const memory = records();
  const buckets = digestBuckets(memory, now);
  if (buckets.length === 0) {
    if (scan !== undefined && coverageIncomplete(scan)) {
      speak("memory coverage incomplete. I cannot say week is quiet, question");
      support(coverageLine(scan));
      return 0;
    }
    speak("quiet week. no intent I hear. quiet good good.");
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan));

  const counted = new Set<string>();
  const count = memory.filter((record) => (record.kind === "triple" || record.kind === "note")
    && !counted.has(record.id)
    && (counted.add(record.id), isOperationalMemoryRecord(record, now))
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
  const { speak, support, records, coverage } = resolve(deps);
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
  const scan = coverage();
  const memory = records();
  const candidates = quizCandidates(memory, now, 3);
  if (candidates.length === 0) {
    if (scan !== undefined && coverageIncomplete(scan)) {
      speak("memory coverage incomplete. I cannot say nothing old enough, question");
      support(coverageLine(scan));
      return 0;
    }
    const future = quizCandidates(memory, Number.MAX_SAFE_INTEGER, 3).filter((candidate) => candidate.ts > now);
    speak(future.length > 0
      ? "I not know future note yet. work more, come back, question"
      : "nothing old enough to ask. work more, come back, question");
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan));

  for (const candidate of candidates) {
    if (candidate.kind === "note") {
      const metadata = noteConfidence(candidate);
      const subject = subjectForNote(candidate);
      speak(terminalSafe(`your note "${subject}". what you understand, question`, MAX_OUTPUT_LINE_BYTES));
      await ask("your answer: ");
      speak(terminalSafe(`I remember your answer: ${terminalSafe(candidate.answer, MAX_INTENT_DISPLAY_BYTES)}. (id=${candidate.id} ts=${candidate.ts} source=note file=${metadata.files} coverage=${metadata.coverage} confidence=${metadata.confidence} reason=${metadata.reason})`, MAX_OUTPUT_LINE_BYTES));
      continue;
    }
    const intent = terminalSafe(candidate.intent?.text ?? "this change", MAX_INTENT_DISPLAY_BYTES);
    speak(terminalSafe(`you say "${intent}". what it become, question`, MAX_OUTPUT_LINE_BYTES));
    await ask("your answer: ");
    const first = candidate.mechanism.files[0];
    const path = terminalSafe(first?.path ?? "somewhere", MAX_PATH_DISPLAY_BYTES);
    const metadata = tripleConfidence(candidate);
    speak(terminalSafe(`I remember: ${subjectForTriple(candidate)}. (${path}, ${ago(candidate.ts)}; id=${candidate.id} ts=${candidate.ts} source=${candidate.origin} agent=${candidate.agent} files=${metadata.files} coverage=${metadata.coverage} confidence=${metadata.confidence} reason=${metadata.reason})`, MAX_OUTPUT_LINE_BYTES));
  }
  speak("you know better than me. good good.");
  return 0;
}
