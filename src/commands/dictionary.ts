import { Buffer } from "node:buffer";
import { dictionaryRankPortFromConfig, type DictionaryRankPort } from "../ai/dictionary-ai.js";
import { loadConfig } from "../core/config.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import { csConceptCounts, digestBuckets, queryDictionary, queryNotes, quizCandidates, rationalesForFile, type DictionaryHit, type NoteHit } from "../core/dictionary.js";
import { isCompleteMemoryCoverage, isOperationalMemoryRecord, loadMemoryChecked, sameCwd } from "../core/memory-read.js";
import { recordRationale } from "../core/memory.js";
import { LINK_WINDOW_MS, MAX_WHY_RECORDS, whyFile, whyFileEvidence, whyFilePathRelation } from "../core/memory-query.js";
import type { MemoryCoverage, MemoryRecord, RationaleLinks, RationaleRecord, RationaleSource } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { createTtyPromptPort } from "../setup/prompt.js";
import { truncateUtf8 } from "../mcp/privacy.js";
import { ago, detail, isVerbose, phrase, prompt as rockyPrompt, say } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";
import { formatGitDiffLines, resolveGitDiff, type GitDiffOptions, type GitDiffResult } from "../core/git-diff.js";
import { CliUsageError, parseNoArgs, parseQueryArgs, reportCliUsage } from "./cli-args.js";

const MAX_QUERY_DISPLAY_BYTES = 160;
const MAX_SUBJECT_DISPLAY_BYTES = 120;
const MAX_PATH_DISPLAY_BYTES = 180;
const MAX_PROVENANCE_PATH_BYTES = 96;
const MAX_INTENT_DISPLAY_BYTES = 128;
const MAX_OUTPUT_LINE_BYTES = 512;
const MAX_FILE_RATIONALES = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_USAGE = "Export takes --kind failure|fix|note|triple and --since 30d.";
const EXPORT_KINDS: ReadonlySet<MemoryRecord["kind"]> = new Set(["failure", "fix", "note", "triple"]);
// Default words for how far to trust one recorded change. "complete" only says
// the agent's changed-file list was whole within rocky's cap, as the agent
// reported it. It never says the agent's reason is right.
const FILES_COMPLETE_WORDS = "File list complete, as the agent reported.";
const FILES_INCOMPLETE_WORDS = "Some changed files may be missing.";
const NOTE_WORDS = "Your answer, recorded and not verified.";
// Default coverage disclosures for `why`; ROCKY_VERBOSE=1 keeps the status-word forms.
const SOME_PATH_MAY_BE_OMITTED_WORDS = "Some path may be omitted.";
const POSSIBLE_PATH_OMITTED_WORDS = "A possible path was omitted.";
const AMBIGUOUS_PATH_WORDS = "The path fits more than one file. No reason was picked.";
// Said when the memory read was incomplete: the answer cannot be confirmed either way.
const SEE_COVERAGE_LINE = "See the coverage line below.";
const COVERAGE_UNKNOWN_MATCH = `Memory coverage is incomplete, so it is not known whether anything matches. ${SEE_COVERAGE_LINE}`;
const QUIZ_NEEDS_TERMINAL = "Quiz needs an interactive terminal. Run rocky quiz from one.";

export interface DictionaryCommandDeps {
  load?: () => MemoryRecord[];
  coverage?: () => MemoryCoverage;
  say?: (line: string) => void;
  out?: (line: string) => void;
  rank?: DictionaryRankPort;
  now?: number;
  gitDiff?: (options: GitDiffOptions) => GitDiffResult | undefined;
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

function coverageLine(value: MemoryCoverage, recordCount: number): string {
  const words = describeMemoryCoverage(value, recordCount, { counts: false });
  if (!isVerbose() && words !== undefined) return words;
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
// stdout carries raw JSONL data; say/out remain the prefixed and supporting stderr sinks.
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
    speak("Memory coverage is incomplete. Nothing was exported, because a partial export could pass for a complete one.");
    support(coverageLine(scan, records().length));
    return 1;
  }
  const selected = records().filter((record) => (
    (kinds.size === 0 || kinds.has(record.kind))
    && (cutoff === undefined || record.ts >= cutoff)
  ));
  const stdout = deps.stdout ?? console.log;
  for (const record of selected) stdout(JSON.stringify(record));
  speak(`Exported ${selected.length} record${selected.length === 1 ? "" : "s"}.`);
  return 0;
}

function terminalSafe(value: string, maximumBytes: number): string {
  const withoutControls = safeTerminalLine(value)
    .replace(/[\u200b-\u200f\u2060-\u206f\ufeff]/gu, " ")
    .replace(/[?？]/gu, " ");
  return truncateUtf8(withoutControls.replace(/\uFF1F/gu, " "), maximumBytes).value;
}

/**
 * A rocky-authored question. The text is made terminal-safe first, which turns
 * every `?` in it into a space (recorded content never carries one into a line),
 * so the closing question mark is added afterwards and is the only one printed.
 */
function questionLine(text: string): string {
  return `${terminalSafe(text, MAX_OUTPUT_LINE_BYTES - 1)}?`;
}

function fullIdLines(value: string): string[] {
  const clean = safeTerminalLine(value)
    .replace(/[\u200b-\u200f\u2060-\u206f\ufeff]/gu, " ")
    .replace(/[?\uFF1F]/gu, " ");
  const lines: string[] = [];
  let current = "";
  for (const character of clean.replace(/\uFF1F/gu, " ")) {
    if (current && Buffer.byteLength(`${current}${character}`, "utf8") > MAX_OUTPUT_LINE_BYTES) {
      lines.push(current);
      current = "";
    }
    current += character;
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

interface ProvenanceFields {
  id: string;
  ts: number;
  source: string;
  agent?: string;
  fileLabel: "file" | "files";
  files: string;
  coverage: string;
  confidence: string;
  reason: string;
  /** The plain-words form of `reason`, what default output says instead of the labelled fields. */
  words: string;
  prefix?: string;
  bareId?: boolean;
}

/** Default provenance: who said it, then how far to trust it. No record id, time stamp, or label. */
function plainProvenanceLine(fields: ProvenanceFields): string {
  const agent = fields.agent === undefined ? "" : terminalSafe(fields.agent, 64).trim();
  return agent === "" ? fields.words : `by ${agent}. ${fields.words}`;
}

function provenanceLine(fields: ProvenanceFields, split = false): string {
  if (!isVerbose()) return plainProvenanceLine(fields);
  const id = split
    ? "id=split; full-id-next-line"
    : fields.bareId === true
      ? terminalSafe(fields.id, MAX_OUTPUT_LINE_BYTES)
      : `id=${terminalSafe(fields.id, MAX_OUTPUT_LINE_BYTES)}`;
  const agent = fields.agent === undefined ? "" : ` agent=${terminalSafe(fields.agent, 64)}`;
  return `${fields.prefix ?? ""}${id} ts=${fields.ts} source=${terminalSafe(fields.source, 64)}${agent} ${fields.fileLabel}=${terminalSafe(fields.files, MAX_PROVENANCE_PATH_BYTES)} coverage=${terminalSafe(fields.coverage, 32)} confidence=${terminalSafe(fields.confidence, 32)} reason=${terminalSafe(fields.reason, 180)}`;
}

/** Keep metadata labels together, then carry an exact bounded ID separately. */
function boundedProvenanceLines(fields: ProvenanceFields): string[] {
  const inline = provenanceLine(fields);
  if (Buffer.byteLength(inline, "utf8") <= MAX_OUTPUT_LINE_BYTES) return [terminalSafe(inline, MAX_OUTPUT_LINE_BYTES)];
  return [terminalSafe(provenanceLine(fields, true), MAX_OUTPUT_LINE_BYTES), ...fullIdLines(fields.id)];
}

function boundedDetailLines(content: string, fields: ProvenanceFields, suffix = ""): string[] {
  const inline = `${content} ${provenanceLine(fields)}${suffix}`;
  if (Buffer.byteLength(inline, "utf8") <= MAX_OUTPUT_LINE_BYTES) return [terminalSafe(inline, MAX_OUTPUT_LINE_BYTES)];
  return [terminalSafe(content, MAX_OUTPUT_LINE_BYTES), ...boundedProvenanceLines(fields)];
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

function tripleConfidence(triple: DictionaryHit["triple"]): { confidence: "confirmed" | "incomplete"; reason: string; words: string; coverage: string; files: string } {
  const complete = triple.mechanism.coverageStatus === "complete"
    && triple.mechanism.truncatedFiles === 0
    && triple.mechanism.baseline === "captured"
    && triple.mechanism.files.length > 0
    && triple.mechanism.files.every((file) => file.provenance === "tool-observed" || file.provenance === "git-diff-inferred");
  const first = triple.mechanism.files[0];
  const files = first === undefined ? "none" : `${triple.mechanism.files.length}; witness=${terminalSafe(first.path, 96)}`;
  return {
    confidence: complete ? "confirmed" : "incomplete",
    reason: complete ? "captured file coverage complete" : "file coverage incomplete; full change not recorded",
    words: complete ? FILES_COMPLETE_WORDS : FILES_INCOMPLETE_WORDS,
    coverage: complete ? "complete" : "incomplete",
    files,
  };
}

function noteConfidence(note: NoteHit["note"]): { confidence: "possible"; reason: string; words: string; coverage: string; files: string } {
  return {
    confidence: "possible",
    reason: "user comprehension note is a recorded answer, not verified ground truth",
    words: NOTE_WORDS,
    coverage: "single-file note",
    files: terminalSafe(note.file, MAX_PATH_DISPLAY_BYTES),
  };
}

function evidenceLines(hit: LookupHit): string[] {
  if ("note" in hit) {
    const note = hit.note;
    const metadata = noteConfidence(note);
    const subject = subjectForNote(note);
    const answer = terminalSafe(note.answer, MAX_INTENT_DISPLAY_BYTES);
    const provenance: ProvenanceFields = {
      id: note.id, ts: note.ts, source: "note", fileLabel: "file",
      files: metadata.files, coverage: metadata.coverage, confidence: metadata.confidence,
      reason: metadata.reason, words: metadata.words, prefix: "note ", bareId: true,
    };
    if (!isVerbose()) {
      const body = `note ${subject}: ${answer}  (${terminalSafe(note.file, MAX_PATH_DISPLAY_BYTES)}, ${ago(note.ts)};`;
      return boundedDetailLines(body, provenance, ")");
    }
    const line = `${provenanceLine(provenance)}; subject=${subject} answer=${answer}`;
    if (Buffer.byteLength(line, "utf8") <= MAX_OUTPUT_LINE_BYTES) return [terminalSafe(line, MAX_OUTPUT_LINE_BYTES)];
    const contentLine = `note subject=${subject} answer=${answer} file=${terminalSafe(note.file, MAX_PATH_DISPLAY_BYTES)}`;
    return [
      terminalSafe(contentLine, MAX_OUTPUT_LINE_BYTES),
      ...boundedProvenanceLines(provenance),
    ];
  }
  const triple = hit.triple;
  const first = triple.mechanism.files[0];
  if (!first || !triple.intent) return [];
  const metadata = tripleConfidence(triple);
  const body = `${shorten(triple.intent.text)} -> ${subjectForTriple(triple)}  (${terminalSafe(first.path, MAX_PATH_DISPLAY_BYTES)} +${first.plusMinus[0]} -${first.plusMinus[1]}, ${ago(triple.ts)};`;
  const provenance: ProvenanceFields = {
    id: triple.id, ts: triple.ts, source: triple.origin, agent: triple.agent, fileLabel: "files",
    files: metadata.files, coverage: metadata.coverage, confidence: metadata.confidence, reason: metadata.reason,
    words: metadata.words,
  };
  return boundedDetailLines(body, provenance, ")");
}

function evidence(hits: LookupHit[], support: (line: string) => void): void {
  for (const hit of hits) {
    for (const line of evidenceLines(hit)) support(line);
  }
}

function fileForQuery(triple: DictionaryHit["triple"], query: string): DictionaryHit["triple"]["mechanism"]["files"][number] | undefined {
  return whyFilePathRelation(triple, query).witness;
}

function reorder(hits: readonly DictionaryHit[], rankedIds: readonly string[]): DictionaryHit[] | undefined {
  const result: DictionaryHit[] = [];
  const known = new Set(hits.map((hit) => hit.triple.id));
  const seen = new Set<string>();
  for (const id of rankedIds) {
    if (!known.has(id) || seen.has(id)) return undefined;
    seen.add(id);
    const match = hits.find((hit) => hit.triple.id === id);
    if (match === undefined) return undefined;
    result.push(match);
  }
  if (result.length === 0) return undefined;
  for (const hit of hits) if (!seen.has(hit.triple.id)) result.push(hit);
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

function mergeRankedTeaching(base: readonly LookupHit[], ranked: readonly DictionaryHit[]): LookupHit[] {
  const allowed = new Set(base
    .filter((hit): hit is DictionaryHit => "triple" in hit)
    .map((hit) => hit.triple.id));
  const order = ranked.filter((hit) => allowed.has(hit.triple.id));
  let tripleIndex = 0;
  return base.map((hit) => {
    if (!("triple" in hit)) return hit;
    return order[tripleIndex++] ?? hit;
  });
}

function futureTeachingMatch(records: readonly MemoryRecord[], query: string, now: number): boolean {
  if (records.every((record) => isOperationalMemoryRecord(record, now))) return false;
  return queryDictionary(records, query, 5, Number.MAX_SAFE_INTEGER).length > 0
    || queryNotes(records, query, 5, Number.MAX_SAFE_INTEGER).length > 0;
}

/** The answer when a complete read finds no usable record for the query. */
function noMatchLine(memory: readonly MemoryRecord[], query: string, now: number): string {
  const quoted = terminalSafe(query, MAX_QUERY_DISPLAY_BYTES);
  const line = futureTeachingMatch(memory, query, now)
    ? `No match for "${quoted}" yet. Matching evidence is dated in the future, so it was not used.`
    : `No record matches "${quoted}".`;
  return terminalSafe(line, MAX_OUTPUT_LINE_BYTES);
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
    speak('Missing query. Example: rocky what "naikin".');
    return 2;
  }
  const scan = coverage();
  const memory = records();
  const now = deps.now ?? Date.now();
  const teaching = teachingHits(memory, query, now);
  if (teaching.all.length === 0) {
    if (scan !== undefined && coverageIncomplete(scan)) {
      speak(COVERAGE_UNKNOWN_MATCH);
      support(coverageLine(scan, memory.length));
      return 0;
    }
    speak(noMatchLine(memory, query, now));
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan, memory.length));
  let displayed = teaching.triples;
  let aiRanked = false;
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
      speak(phrase("ai-disabled"));
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
      // No answer at all and an answer that failed the checks are different facts.
      if (ranked === undefined) speak(phrase(Array.isArray(rankedIds) ? "ai-fallback" : "ai-unavailable"));
      else {
        displayed = ranked;
        aiRanked = true;
      }
    }
  }
  const shown: LookupHit[] = aiRanked ? mergeRankedTeaching(teaching.all, displayed) : teaching.all;
  const top = shown[0] as LookupHit;
  const quoted = terminalSafe(query, MAX_QUERY_DISPLAY_BYTES);
  speak(terminalSafe("triple" in top
    ? `Possible match for "${quoted}": a recorded intent became ${subject(top)}. Check the evidence.`
    : `Possible match for "${quoted}": your note says ${subject(top)}. It is recorded, not verified. Check the evidence.`, MAX_OUTPUT_LINE_BYTES));
  evidence(shown, support);
  return 0;
}

export function how(argv: string[], deps: DictionaryCommandDeps = {}): number {
  const { speak, support, records, coverage } = resolve(deps);
  let query: string;
  let showDiff = false;
  try {
    const parsed = parseQueryArgs(argv, {
      allowDiff: true,
      usage: "rocky how [--diff] [--] <query...>",
    });
    query = parsed.query;
    showDiff = parsed.diff;
  } catch (error) {
    const code = reportCliUsage(error, speak, support);
    if (code !== undefined) return code;
    throw error;
  }
  if (!query) {
    speak('Missing query. Example: rocky how "naikin".');
    return 2;
  }
  const scan = coverage();
  const memory = records();
  const now = deps.now ?? Date.now();
  const teaching = teachingHits(memory, query, now);
  if (teaching.all.length === 0) {
    if (scan !== undefined && coverageIncomplete(scan)) {
      speak(COVERAGE_UNKNOWN_MATCH);
      support(coverageLine(scan, memory.length));
      return 0;
    }
    speak(noMatchLine(memory, query, now));
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan, memory.length));
  const safeQuery = terminalSafe(query, MAX_QUERY_DISPLAY_BYTES);
  const first = teaching.all[0] as LookupHit;
  speak(terminalSafe("triple" in first
    ? `Last time you said "${safeQuery}", it became ${subject(first)}. You may mean ${subject(first)}.`
    : `Last time you said "${safeQuery}", your note says ${subject(first)}. It is recorded, not verified.`, MAX_OUTPUT_LINE_BYTES));
  const gitDiffFn = deps.gitDiff ?? resolveGitDiff;
  for (const hit of teaching.all) {
    for (const line of evidenceLines(hit)) support(line);
    if (showDiff && "triple" in hit) {
      const triple = hit.triple;
      const firstFile = triple.mechanism.files[0];
      let diffResult: GitDiffResult | undefined;
      try {
        diffResult = gitDiffFn({
          head: triple.mechanism.head,
          ts: triple.ts,
          file: firstFile?.path,
          cwd: triple.cwd,
        });
      } catch {
        diffResult = undefined;
      }
      for (const diffLine of formatGitDiffLines(diffResult)) {
        support(diffLine);
      }
    }
  }
  return 0;
}

/**
 * Rationale evidence is unverified until labeled: raw agent thinking, an
 * agent's final reply, an agent self-reporting via `notify`, or the human
 * typing it themselves. Exported so brief and sessions label the same four
 * ways instead of re-deriving this text.
 */
export function rationaleSourceLabel(source: RationaleSource): string {
  switch (source) {
    case "log-thinking": return "captured from thinking";
    case "log-response": return "agent said in reply";
    case "notify": return "agent said";
    case "human": return "you said";
  }
}

function capitalizeFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Rationale records join `why` by link, not by guessing at excerpt text. */
function linkedRationales(memory: readonly MemoryRecord[], tripleId: string): RationaleRecord[] {
  return memory
    .filter((record): record is RationaleRecord => record.kind === "rationale" && record.links?.tripleId === tripleId)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * One stated reason: its excerpt, labelled by who said it, on the prefixed sink,
 * then the caller's evidence line on the support sink. Both pass through
 * `terminalSafe` here, because the excerpt is unverified and may carry anything.
 */
function sayRationale(
  speak: (line: string) => void,
  support: (line: string) => void,
  record: RationaleRecord,
  evidence: string,
): void {
  const excerpt = terminalSafe(record.excerpt, MAX_INTENT_DISPLAY_BYTES).trim();
  speak(terminalSafe(`${capitalizeFirst(rationaleSourceLabel(record.source))}: ${excerpt}`, MAX_OUTPUT_LINE_BYTES));
  support(terminalSafe(evidence, MAX_OUTPUT_LINE_BYTES));
}

/** When and by whom a stated reason was said. No record id. */
function reasonEvidence(record: RationaleRecord): string {
  return `  (${ago(record.ts)}, ${record.agent})`;
}

/** The evidence line of a reason linked to a printed change: id and fidelity only under ROCKY_VERBOSE. */
function linkedReasonEvidence(record: RationaleRecord): string {
  if (!isVerbose()) return reasonEvidence(record);
  return `  (rationale id=${record.id}, ${ago(record.ts)}, agent=${record.agent}, fidelity=${record.rationale_fidelity})`;
}

/** Stated reasons that name the queried file. `why` calls this last, after every disclosure line. */
function sayFileRationales(
  speak: (line: string) => void,
  support: (line: string) => void,
  reasons: readonly RationaleRecord[],
): void {
  for (const reason of reasons) sayRationale(speak, support, reason, reasonEvidence(reason));
}

/** Newest failure/fix in this cwd within the fix-linker's own window — same evidence basis, not a guess. */
function newestLinkTarget(memory: readonly MemoryRecord[], cwd: string, now: number): RationaleLinks | undefined {
  const cutoff = now - LINK_WINDOW_MS;
  let newest: Extract<MemoryRecord, { kind: "failure" | "fix" }> | undefined;
  for (const record of memory) {
    if (record.kind !== "failure" && record.kind !== "fix") continue;
    if (!sameCwd(record.cwd, cwd, process.platform) || record.ts > now || record.ts < cutoff) continue;
    if (newest === undefined || record.ts > newest.ts) newest = record;
  }
  if (newest === undefined) return undefined;
  return newest.kind === "failure" ? { failureId: newest.id } : { fixId: newest.id };
}

const WHY_ADD_USAGE = 'rocky why --add "<text>" [--files a.ts,b.ts]';

/**
 * `--files <csv>` may sit anywhere in the tail; every other word still joins
 * the reason text. The comma grammar is the notify lane's, but a missing, empty,
 * or flag-shaped value is a usage error here: that lane fails open, while a
 * person at a terminal must be told that no file would be named.
 */
function parseWhyAddArgs(args: readonly string[]): { text: string; files?: string[] } {
  const words: string[] = [];
  let files: string[] | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== "--files") {
      words.push(arg);
      continue;
    }
    if (files !== undefined) throw new CliUsageError("unexpected option: --files", WHY_ADD_USAGE);
    const value: string | undefined = args[i + 1];
    files = value === undefined || value.startsWith("--")
      ? []
      : value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (files.length === 0) throw new CliUsageError("--files needs a path", WHY_ADD_USAGE);
    i += 1;
  }
  return { text: words.join(" ").trim(), ...(files === undefined ? {} : { files }) };
}

/**
 * Usage errors throw `CliUsageError` before memory is read or written; the
 * `index.ts` call site reports them with exit 2.
 */
function whyAdd(args: readonly string[], speak: (line: string) => void, records: () => MemoryRecord[], now: number): number {
  const { text, files } = parseWhyAddArgs(args);
  if (!text) {
    speak('Missing reason text. Example: rocky why --add "some reason".');
    return 1;
  }
  const cwd = process.cwd();
  // Named files scope the reason by themselves. Recency alone is a guess, so it
  // links only when no file was named.
  const links = files === undefined ? newestLinkTarget(records(), cwd, now) : undefined;
  const stored = recordRationale({
    cwd, agent: "human", rationale_fidelity: "summary", source: "human", text,
    ...(links === undefined ? {} : { links }),
    ...(files === undefined ? {} : { files }),
  });
  // The bounding rules can drop a legitimate path (`app/(auth)/page.tsx`), so
  // this line states only what was kept, never that a path was bad.
  speak(files !== undefined && stored.files === undefined
    ? "Reason recorded. No file was kept."
    : "Reason recorded as stated by you.");
  return 0;
}

export function why(argv: string[], deps: DictionaryCommandDeps = {}): number {
  const { speak, support, records, coverage } = resolve(deps);
  if (argv[0] === "--add") {
    return whyAdd(argv.slice(1), speak, records, deps.now ?? Date.now());
  }
  let path: string;
  let showDiff = false;
  try {
    const parsed = parseQueryArgs(argv, {
      allowDiff: true,
      usage: "rocky why [--diff] [--] <file>",
    });
    path = parsed.query;
    showDiff = parsed.diff;
  } catch (error) {
    const code = reportCliUsage(error, speak, support);
    if (code !== undefined) return code;
    throw error;
  }
  if (!path) {
    speak("Missing file. Example: rocky why src/app.css.");
    return 2;
  }
  const safePath = terminalSafe(path, MAX_PATH_DISPLAY_BYTES);
  const now = deps.now ?? Date.now();
  const scan = coverage();
  const memory = records();
  const evidenceResult = whyFileEvidence(memory, path, 5, now);
  // Disclosures that name the reader's coverage status are verbose-only text; the
  // default says the same fact without the status word.
  const coverageStatus = evidenceResult.coverage.status;
  // The one line for "the reader may have missed a path", shared by the empty and the non-empty answer.
  const someMayBeOmittedLine = terminalSafe(isVerbose()
    ? `coverage status: ${coverageStatus}; some path may be omitted.`
    : SOME_PATH_MAY_BE_OMITTED_WORDS, MAX_OUTPUT_LINE_BYTES);
  // Legacy triples may contain an exact file witness without the newer
  // baseline/provenance proof. Keep that historical explanation visible, but
  // preserve conservative coverage disclosure and never claim completeness.
  const hits = evidenceResult.matches.length > 0
    ? evidenceResult.matches
    : evidenceResult.coverageIncomplete
      ? whyFile(memory, path, 5, now)
      : evidenceResult.matches;
  // Reasons the human or an agent stated for exactly this file (`--files`). They
  // are spoken last, so no disclosure line below can be pushed out by one.
  const fileRationales = rationalesForFile(memory, path, process.cwd(), now, MAX_FILE_RATIONALES);
  if (hits.length === 0) {
    if (evidenceResult.ambiguousPath) {
      speak(terminalSafe(`"${safePath}" matches more than one path. Clarify which path you mean.`, MAX_OUTPUT_LINE_BYTES));
      support(terminalSafe(isVerbose()
        ? `coverage status: ${coverageStatus}; no silent rationale selection; confidence=incomplete reason=ambiguous path`
        : AMBIGUOUS_PATH_WORDS, MAX_OUTPUT_LINE_BYTES));
      return 0;
    }
    const scanIncomplete = scan !== undefined && coverageIncomplete(scan);
    const pathMayBeOmitted = evidenceResult.possible.length > 0;
    // The reader examines only its first MAX_WHY_RECORDS records, yet the loader's scan can
    // hold more: a whole scan does not mean the reader examined everything.
    const readerBounded = memory.length > MAX_WHY_RECORDS;
    if (scanIncomplete || pathMayBeOmitted || readerBounded) {
      speak(terminalSafe(`Coverage is incomplete, so it is not known whether an agent touched "${safePath}".`, MAX_OUTPUT_LINE_BYTES));
      if (scanIncomplete) support(coverageLine(scan, memory.length));
      if (pathMayBeOmitted) {
        support(terminalSafe(isVerbose()
          ? `coverage status: ${coverageStatus}; possible path omitted.`
          : POSSIBLE_PATH_OMITTED_WORDS, MAX_OUTPUT_LINE_BYTES));
      }
      if (readerBounded) support(someMayBeOmittedLine);
    } else {
      // The reader marks empty evidence incomplete by construction, so a whole scan, a reader that
      // examined every record, and no record that might hide this path still leave one fact: no
      // record names the file. Say that and no more, and not even that when a stated reason does.
      if (fileRationales.length === 0) {
        speak(terminalSafe(`No record names "${safePath}". It is not known whether an agent touched it.`, MAX_OUTPUT_LINE_BYTES));
      }
    }
    sayFileRationales(speak, support, fileRationales);
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan, memory.length));
  if (evidenceResult.coverageIncomplete) support(someMayBeOmittedLine);
  const gitDiffFn = deps.gitDiff ?? resolveGitDiff;
  for (const triple of hits) {
    const selected = fileForQuery(triple, path);
    const where = selected
      ? `${terminalSafe(selected.path, MAX_PATH_DISPLAY_BYTES)} +${selected.plusMinus[0]} -${selected.plusMinus[1]}`
      : safePath;
    const rationale = triple.rationale ? terminalSafe(triple.rationale.text, MAX_INTENT_DISPLAY_BYTES).trim() : "";
    const metadata = tripleConfidence(triple);
    const provenance: ProvenanceFields = {
      id: triple.id, ts: triple.ts, source: triple.origin, agent: triple.agent, fileLabel: "files",
      files: metadata.files, coverage: metadata.coverage, confidence: metadata.confidence, reason: metadata.reason,
      words: metadata.words,
    };
    if (rationale) {
      speak(terminalSafe(`Agent said: ${rationale}. Recorded, not verified.`, MAX_OUTPUT_LINE_BYTES));
      const tags = triple.rationale?.tags
        .map((tag) => terminalSafe(tag, MAX_INTENT_DISPLAY_BYTES))
        .filter(Boolean)
        .join(" ");
      for (const line of boundedDetailLines(`  (${where}, ${ago(triple.ts)}${tags ? `, tags: ${tags}` : ""};`, provenance, ")")) support(line);
    } else {
      speak(terminalSafe("Change recorded. No reason recorded for this change.", MAX_OUTPUT_LINE_BYTES));
      for (const line of boundedDetailLines(`  (${where}, ${ago(triple.ts)};`, provenance, ")")) support(line);
    }
    for (const rationaleRecord of linkedRationales(memory, triple.id)) {
      sayRationale(speak, support, rationaleRecord, linkedReasonEvidence(rationaleRecord));
    }
    if (showDiff) {
      let diffResult: GitDiffResult | undefined;
      try {
        diffResult = gitDiffFn({
          head: triple.mechanism.head,
          ts: triple.ts,
          file: selected ? selected.path : path,
          cwd: triple.cwd,
        });
      } catch {
        diffResult = undefined;
      }
      for (const diffLine of formatGitDiffLines(diffResult)) {
        support(diffLine);
      }
    }
  }
  sayFileRationales(speak, support, fileRationales);
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
      speak(`Memory coverage is incomplete, so it is not known whether the week was quiet. ${SEE_COVERAGE_LINE}`);
      support(coverageLine(scan, memory.length));
      return 0;
    }
    speak("No intents recorded this week.");
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan, memory.length));

  const counted = new Set<string>();
  const count = memory.filter((record) => (record.kind === "triple" || record.kind === "note")
    && !counted.has(record.id)
    && (counted.add(record.id), isOperationalMemoryRecord(record, now))
    && now - record.ts <= WEEK_MS).length;
  const top = buckets[0];
  const intents = `${count} intent${count === 1 ? "" : "s"} this week.`;
  const headline = top && top.count >= 3
    ? `${intents} "${terminalSafe(top.tag, MAX_INTENT_DISPLAY_BYTES)}" appears in ${top.count} of them.`
    : intents;
  speak(terminalSafe(headline, MAX_OUTPUT_LINE_BYTES));
  for (const bucket of buckets) {
    const tag = terminalSafe(bucket.tag, MAX_INTENT_DISPLAY_BYTES);
    const examples = bucket.examples.slice(0, 3)
      .map((example) => terminalSafe(example, MAX_INTENT_DISPLAY_BYTES))
      .join("; ");
    support(terminalSafe(`${tag}: ${bucket.count}  (${examples})`, MAX_OUTPUT_LINE_BYTES));
  }
  const csCounts = csConceptCounts(memory, now);
  if (csCounts.size > 0) {
    const top = [...csCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] as [string, number];
    support(`cs pattern: ${top[0]} x${top[1]} this week. Full explanation in rocky dash.`);
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
      speak(QUIZ_NEEDS_TERMINAL);
      return 0;
    }
    const port = createTtyPromptPort();
    if (port === undefined) {
      speak(QUIZ_NEEDS_TERMINAL);
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
      speak(`Memory coverage is incomplete, so it is not known whether anything is old enough to ask about. ${SEE_COVERAGE_LINE}`);
      support(coverageLine(scan, memory.length));
      return 0;
    }
    const future = quizCandidates(memory, Number.MAX_SAFE_INTEGER, 3).filter((candidate) => candidate.ts > now);
    speak(future.length > 0
      ? "The only candidates are dated in the future, so none were used. Come back later."
      : "Nothing is old enough to ask about yet. Come back later.");
    return 0;
  }
  if (scan !== undefined && coverageIncomplete(scan)) support(coverageLine(scan, memory.length));

  const answerPrompt = rockyPrompt(phrase("check-answer"));
  for (const candidate of candidates) {
    if (candidate.kind === "note") {
      const metadata = noteConfidence(candidate);
      const subject = subjectForNote(candidate);
      speak(questionLine(`Your note "${subject}". What do you understand about it`));
      await ask(answerPrompt);
      const recorded = `Your recorded answer: ${terminalSafe(candidate.answer, MAX_INTENT_DISPLAY_BYTES)}.`;
      speak(terminalSafe(isVerbose() ? `${recorded} confidence=${metadata.confidence}` : `${recorded} Not verified.`, MAX_OUTPUT_LINE_BYTES));
      const provenance: ProvenanceFields = {
        id: candidate.id, ts: candidate.ts, source: "note", fileLabel: "file", files: metadata.files,
        coverage: metadata.coverage, confidence: metadata.confidence, reason: metadata.reason, words: metadata.words,
      };
      for (const line of boundedProvenanceLines(provenance)) support(line);
      continue;
    }
    const intent = terminalSafe(candidate.intent?.text ?? "this change", MAX_INTENT_DISPLAY_BYTES);
    speak(questionLine(`You said "${intent}". What did it become`));
    await ask(answerPrompt);
    const first = candidate.mechanism.files[0];
    const path = terminalSafe(first?.path ?? "somewhere", MAX_PATH_DISPLAY_BYTES);
    const metadata = tripleConfidence(candidate);
    speak(terminalSafe(`Recorded: it became ${subjectForTriple(candidate)}.`, MAX_OUTPUT_LINE_BYTES));
    const provenance: ProvenanceFields = {
      id: candidate.id, ts: candidate.ts, source: candidate.origin, agent: candidate.agent, fileLabel: "files",
      files: metadata.files, coverage: metadata.coverage, confidence: metadata.confidence, reason: metadata.reason,
      words: metadata.words,
    };
    for (const line of boundedDetailLines(`  (${path} +${first?.plusMinus[0] ?? 0} -${first?.plusMinus[1] ?? 0}, ${ago(candidate.ts)};`, provenance, ")")) support(line);
  }
  speak("Quiz finished.");
  return 0;
}
