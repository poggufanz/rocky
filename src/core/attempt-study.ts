import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { ADVISORY_LOG_MAX_BYTES, exposureKeyHash, type ExposureRow } from "./attempt-note-state.js";
import type { Attempt, ProblemEntry } from "./attempts.js";
import type { MemoryCoverage, MemoryRecord } from "./memory-read.js";
import { NO_BLOCK_FLAG, NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "./fs-safety.js";
import {
  BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, Z90, clusterBootstrapDiff, mde, newcombeDiff,
  percentileNearestRank, type DiffInterval, type StudyCluster,
} from "./attempt-study-math.js";

export const STUDY_STOP_UNITS = 300;
export const STUDY_STOP_DAYS = 120;
export const STUDY_START_FILE = "attempt-study-start";

const DAY_MS = 86_400_000;
const EXPOSURE_LOG_MAX_READ_BYTES = ADVISORY_LOG_MAX_BYTES + 64 * 1024;
const LANES = ["run", "watch", "hookfail", "tool-result"] as const;
const HEX_16 = /^[0-9a-f]{16}$/iu;
const ISO_MARKER = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

type BoundedFile =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "ok"; bytes: Buffer };

function readBoundedFile(path: string, maxBytes: number): BoundedFile {
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return { state: "unreadable" };

  try {
    const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW_FLAG | NO_BLOCK_FLAG);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(before, opened) || opened.size > maxBytes) {
        return { state: "unreadable" };
      }

      // Read the descriptor's opening length. A concurrent append belongs to a later read.
      const bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (n === 0) return { state: "unreadable" };
        offset += n;
      }
      const after = lstatSync(path, { bigint: true });
      if (!sameFilesystemIdentity(opened, after) || after.size < opened.size || after.size > maxBytes) {
        return { state: "unreadable" };
      }
      return { state: "ok", bytes };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { state: "unreadable" };
  }
}

export type ExposureLogRead =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "ok"; rows: ExposureRow[]; malformed: number; logFull: boolean };

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isExposureRow(value: unknown): value is ExposureRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.v === 1 && Number.isFinite(row.ts)
    && (typeof row.session === "string" || row.session === null)
    && LANES.some((lane) => lane === row.lane)
    && (row.kind === "note" || row.kind === "skip")
    && (row.arm === "shown" || row.arm === "held" || row.arm === "unassigned" || row.arm === "human" || row.arm === null)
    && (row.key === null || (typeof row.key === "string" && HEX_16.test(row.key)))
    && typeof row.cwdHash === "string" && HEX_16.test(row.cwdHash)
    && (row.anchorFailureId === null || (typeof row.anchorFailureId === "string" && row.anchorFailureId.length <= 128))
    && nonnegativeNumber(row.latencyMs) && nonnegativeNumber(row.bytes)
    && typeof row.delivered === "boolean"
    && (row.reason === undefined || (typeof row.reason === "string" && row.reason.length <= 64));
}

export function readExposureLog(home: string): ExposureLogRead {
  const file = readBoundedFile(join(home, "advisories.jsonl"), EXPOSURE_LOG_MAX_READ_BYTES);
  if (file.state !== "ok") return file;
  const lines = file.bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const rows: ExposureRow[] = [];
  let malformed = 0;
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (isExposureRow(row)) rows.push(row);
    else malformed++;
  }
  return { state: "ok", rows, malformed, logFull: file.bytes.length >= ADVISORY_LOG_MAX_BYTES - 1024 };
}

export type StudyStart = { state: "absent" } | { state: "invalid" } | { state: "set"; ts: number };

export function readStudyStart(home: string, now: number): StudyStart {
  const file = readBoundedFile(join(home, STUDY_START_FILE), 256);
  if (file.state === "missing") return { state: "absent" };
  if (file.state === "unreadable") return { state: "invalid" };
  const text = file.bytes.toString("utf8").trim();
  const date = ISO_MARKER.exec(text)?.[1];
  if (date === undefined) return { state: "invalid" };
  const midnight = Date.parse(date);
  // Date.parse can normalize the 30th of February into March.
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
    return { state: "invalid" };
  }
  const ts = Date.parse(text);
  return Number.isFinite(ts) && ts <= now + 60_000 ? { state: "set", ts } : { state: "invalid" };
}

export interface AttemptStudyInput {
  rows: readonly ExposureRow[];
  malformed: number;
  logFull: boolean;
  records: readonly MemoryRecord[];
  entries: readonly ProblemEntry[];
  coverage?: MemoryCoverage;
  start: StudyStart;
  now: number;
}

type Arm = StudyCluster["arm"];
type ByArm<T> = Record<Arm, T>;
type Lane = ExposureRow["lane"];
type Observed = NonNullable<Attempt["expectations"]>[number]["observed"];
type ExpectationCounts = Partial<Record<Observed, number>>;
type Excluded = {
  unassigned: number;
  human: number;
  noSession: number;
  noAnchor: number;
  duplicateAnchor: number;
  keyMismatch: number;
  armConflict: number;
  beforeStart: number;
  afterStop: number;
};

interface StudyCounts {
  v: 1;
  primaryUnits: number;
  arms: ByArm<{ episodes: number; primaryUnits: number; outOfTail: number }>;
  excluded: Excluded;
  skips: Record<string, number>;
  malformed: number;
  logFull: boolean;
  latency: Record<Lane, { n: number; p95: number | undefined }>;
  meanDeliveredBytes?: number;
  memoryCoverage?: Pick<MemoryCoverage, "complete" | "scanned" | "skipped" | "truncated" | "window" | "reason" | "oldestTs">;
}

interface StartedStudy extends StudyCounts {
  start: { state: "set"; iso: string };
  day: number;
}

type PrimaryCounts = { n: number; passed: number };
type RepeatCounts = { subset: number; repeats: number };
type Verdict = "on" | "off" | "inconclusive";

interface StoppedStudy extends StartedStudy {
  phase: "stopped";
  stopReason: "units" | "days";
  primary: ByArm<PrimaryCounts> & Partial<DiffInterval> & { mde?: number };
  secondary: Partial<DiffInterval> & { resamples: typeof BOOTSTRAP_RESAMPLES; clusters: ByArm<number> };
  sameFailure: ByArm<number | undefined>;
  repeatFileSet: ByArm<RepeatCounts>;
  expectations: ByArm<ExpectationCounts>;
  verdict: Verdict;
}

export type AttemptStudyReport =
  | (StudyCounts & { phase: "not-started"; start: Exclude<StudyStart, { state: "set" }>; day?: never })
  | (StartedStudy & { phase: "running" })
  | StoppedStudy;

type CandidateRow = ExposureRow & { kind: "note"; arm: Arm; session: string; anchorFailureId: string; key: string };
type Candidate = { row: CandidateRow; order: number };
type Anchor = { entry: ProblemEntry; attempt: Attempt; keyHash: string };
type Episode = Candidate & { anchor: Anchor | undefined };
type SessionEpisodes = { arm: Arm; episodes: Episode[] };
type Cutoff = { ts: number; order: number };

function afterCutoff(ts: number, order: number, cutoff: Cutoff): boolean {
  return ts > cutoff.ts || (ts === cutoff.ts && order > cutoff.order);
}

function isCandidate(row: ExposureRow): row is CandidateRow {
  return row.kind === "note" && (row.arm === "shown" || row.arm === "held")
    && row.session !== null && row.session.length > 0 && row.anchorFailureId !== null && row.key !== null;
}

export function anchorIds(rows: readonly ExposureRow[]): Set<string> {
  return new Set(rows.filter(isCandidate).map((row) => row.anchorFailureId));
}

function firstCandidates(rows: readonly ExposureRow[]): Candidate[] {
  const byAnchor = new Map<string, Candidate>();
  for (const [order, row] of rows.entries()) {
    if (!isCandidate(row)) continue;
    const prior = byAnchor.get(row.anchorFailureId);
    if (prior === undefined || row.ts < prior.row.ts) byAnchor.set(row.anchorFailureId, { row, order });
  }

  const sorted = [...byAnchor.values()].sort((a, b) => a.row.ts - b.row.ts || a.order - b.order);
  const keysBySession = new Map<string, Set<string>>();
  return sorted.filter(({ row }) => {
    let keys = keysBySession.get(row.session);
    if (keys === undefined) {
      keys = new Set();
      keysBySession.set(row.session, keys);
    }
    if (keys.has(row.key)) return false;
    keys.add(row.key);
    return true;
  });
}

function countLogRows(
  rows: readonly ExposureRow[], reportThrough: number, candidateOrders: ReadonlySet<number>, excluded: Excluded,
): Record<string, number> {
  const skips = new Map<string, number>();
  for (const [order, row] of rows.entries()) {
    if (row.ts > reportThrough) continue;
    if (row.kind === "skip") {
      const reason = row.reason ?? "unknown";
      skips.set(reason, (skips.get(reason) ?? 0) + 1);
    } else if (isCandidate(row)) {
      if (!candidateOrders.has(order)) excluded.duplicateAnchor++;
    } else if (row.arm === null || row.arm === "unassigned") {
      excluded.unassigned++;
    } else if (row.arm === "human") {
      excluded.human++;
    } else if (!row.session) {
      excluded.noSession++;
    } else {
      excluded.noAnchor++;
    }
  }
  return Object.fromEntries(skips);
}

function indexAnchors(entries: readonly ProblemEntry[]): Map<string, Anchor> {
  const anchors = new Map<string, Anchor>();
  for (const entry of entries) {
    const keyHash = exposureKeyHash(entry.key);
    for (const attempt of entry.attempts) {
      if (!anchors.has(attempt.failureId)) anchors.set(attempt.failureId, { entry, attempt, keyHash });
    }
  }
  return anchors;
}

function findUnitStop(episodes: readonly Episode[], through: number): Cutoff | undefined {
  const arms = new Map<string, Arm | null>();
  let units = 0;
  for (const { row, order } of episodes) {
    if (row.ts > through) break;
    const arm = arms.get(row.session);
    if (arm === undefined) {
      arms.set(row.session, row.arm);
      units++;
      if (units === STUDY_STOP_UNITS) return { ts: row.ts, order };
    } else if (arm !== null && arm !== row.arm) {
      arms.set(row.session, null);
      units--;
    }
  }
  return undefined;
}

function collectSessions(
  episodes: readonly Episode[], cutoff: Cutoff, counts: StudyCounts,
): SessionEpisodes[] {
  const sessions = new Map<string, SessionEpisodes>();
  for (const episode of episodes) {
    const { row } = episode;
    if (afterCutoff(row.ts, episode.order, cutoff)) break;
    const session = sessions.get(row.session);
    if (session === undefined) sessions.set(row.session, { arm: row.arm, episodes: [episode] });
    else session.episodes.push(episode);
  }

  const included: SessionEpisodes[] = [];
  for (const session of sessions.values()) {
    if (session.episodes.some(({ row }) => row.arm !== session.arm)) {
      counts.excluded.armConflict += session.episodes.length;
      continue;
    }
    const arm = counts.arms[session.arm];
    arm.primaryUnits++;
    for (const { anchor } of session.episodes) {
      if (anchor === undefined) arm.outOfTail++;
      else arm.episodes++;
    }
    included.push(session);
  }
  counts.primaryUnits = included.length;
  return included;
}

function countOperations(rows: readonly ExposureRow[], start: number, cutoff: Cutoff, counts: StudyCounts): void {
  const latency: Record<Lane, number[]> = { run: [], watch: [], hookfail: [], "tool-result": [] };
  let delivered = 0;
  let totalBytes = 0;
  let meanBytes = 0;
  for (const [order, row] of rows.entries()) {
    if (row.kind !== "note" || row.ts < start || afterCutoff(row.ts, order, cutoff)) continue;
    latency[row.lane].push(row.latencyMs);
    if (row.delivered) {
      delivered++;
      totalBytes += row.bytes;
      meanBytes += (row.bytes - meanBytes) / delivered;
    }
  }
  for (const lane of LANES) {
    const values = latency[lane];
    counts.latency[lane] = { n: values.length, p95: percentileNearestRank(values, 0.95) };
  }
  // Keep the mean finite even if a damaged log contains very large, finite byte counts.
  if (delivered > 0) counts.meanDeliveredBytes = Number.isFinite(totalBytes) ? totalBytes / delivered : meanBytes;
}

function analyzeEpisode(
  anchor: Anchor, session: string, sessionByFailure: ReadonlyMap<string, string>,
  repeats: RepeatCounts, expectations: ExpectationCounts,
): { passed: boolean; sameFailure: number } {
  const priorSets = new Set<string>();
  const postSets: string[] = [];
  let passed = false;
  let sameFailure = 0;

  for (const attempt of anchor.entry.attempts) {
    if (attempt.ts < anchor.attempt.ts) {
      if (attempt.changes.state === "observed") priorSets.add([...attempt.changes.files].sort().join("\n"));
      continue;
    }
    if (attempt !== anchor.attempt && sessionByFailure.get(attempt.failureId) !== session) continue;
    if (attempt.outcome === "passed") passed = true;
    if (attempt.outcome === "same_failure") sameFailure++;
    if (attempt.changes.state === "observed") postSets.push([...attempt.changes.files].sort().join("\n"));
    for (const { observed } of attempt.expectations ?? []) {
      expectations[observed] = (expectations[observed] ?? 0) + 1;
    }
  }
  if (postSets.length > 0) {
    repeats.subset++;
    if (postSets.some((set) => priorSets.has(set))) repeats.repeats++;
  }
  return { passed, sameFailure };
}

type StudyOutcomes = Pick<StoppedStudy, "primary" | "secondary" | "sameFailure" | "repeatFileSet" | "expectations" | "verdict">;

function analyzeSessions(
  sessions: readonly SessionEpisodes[], records: readonly MemoryRecord[], arms: StudyCounts["arms"],
): StudyOutcomes {
  const sessionByFailure = new Map<string, string>();
  for (const record of records) {
    if (record.kind === "failure" && record.agent?.session !== undefined) {
      sessionByFailure.set(record.id, record.agent.session);
    }
  }
  const primary = {
    shown: { n: 0, passed: 0 },
    held: { n: 0, passed: 0 },
  };
  const repeatFileSet = { shown: { subset: 0, repeats: 0 }, held: { subset: 0, repeats: 0 } };
  const expectations: ByArm<ExpectationCounts> = { shown: {}, held: {} };
  const sameFailure = { shown: 0, held: 0 };
  const successes = { shown: 0, held: 0 };
  const clusterCounts = { shown: 0, held: 0 };
  const clusters: StudyCluster[] = [];
  for (const { arm, episodes } of sessions) {
    const cluster: StudyCluster = { arm, successes: 0, total: 0 };
    for (const [index, { row, anchor }] of episodes.entries()) {
      if (anchor === undefined) continue;
      const result = analyzeEpisode(anchor, row.session, sessionByFailure, repeatFileSet[arm], expectations[arm]);
      cluster.total++;
      if (result.passed) cluster.successes++;
      if (index === 0) {
        primary[arm].n++;
        if (result.passed) primary[arm].passed++;
      }
      sameFailure[arm] += result.sameFailure;
    }
    if (cluster.total === 0) continue;
    successes[arm] += cluster.successes;
    clusterCounts[arm]++;
    clusters.push(cluster);
  }
  const { shown, held } = primary;
  const interval = newcombeDiff(shown.passed, shown.n, held.passed, held.n, Z90);
  const pooled = (shown.passed + held.passed) / (shown.n + held.n);
  const detectable = interval === undefined ? undefined : mde(shown.n, held.n, pooled);
  const bootstrap = clusterBootstrapDiff(clusters, { resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED, level: 0.9 });
  const secondaryDiff = arms.shown.episodes > 0 && arms.held.episodes > 0
    ? successes.shown / arms.shown.episodes - successes.held / arms.held.episodes
    : undefined;
  let verdict: Verdict = "inconclusive";
  if (interval !== undefined) {
    if (interval.lower > 0) verdict = "on";
    else if (interval.upper < 0) verdict = "off";
  }
  return {
    primary: { ...primary, ...interval, ...(detectable === undefined ? {} : { mde: detectable }) },
    secondary: {
      ...bootstrap,
      ...(secondaryDiff === undefined ? {} : { diff: secondaryDiff }),
      resamples: BOOTSTRAP_RESAMPLES,
      clusters: clusterCounts,
    },
    sameFailure: {
      shown: arms.shown.episodes === 0 ? undefined : sameFailure.shown / arms.shown.episodes,
      held: arms.held.episodes === 0 ? undefined : sameFailure.held / arms.held.episodes,
    },
    repeatFileSet,
    expectations,
    verdict,
  };
}

export function buildAttemptStudy(input: AttemptStudyInput): AttemptStudyReport {
  const { rows, entries, records, coverage, start, now } = input;
  const counts: StudyCounts = {
    v: 1, primaryUnits: 0,
    arms: {
      shown: { episodes: 0, primaryUnits: 0, outOfTail: 0 },
      held: { episodes: 0, primaryUnits: 0, outOfTail: 0 },
    },
    excluded: {
      unassigned: 0, human: 0, noSession: 0, noAnchor: 0, duplicateAnchor: 0,
      keyMismatch: 0, armConflict: 0, beforeStart: 0, afterStop: 0,
    },
    skips: {}, malformed: input.malformed, logFull: input.logFull,
    latency: {
      run: { n: 0, p95: undefined }, watch: { n: 0, p95: undefined },
      hookfail: { n: 0, p95: undefined }, "tool-result": { n: 0, p95: undefined },
    },
  };
  if (coverage !== undefined) {
    const { complete, scanned, skipped, truncated, window, reason, oldestTs } = coverage;
    counts.memoryCoverage = { complete, scanned, skipped, truncated, window, reason, oldestTs };
  }

  const candidates = firstCandidates(rows);
  const startTs = start.state === "set" ? start.ts : -Infinity;
  const deadline = start.state === "set" ? start.ts + STUDY_STOP_DAYS * DAY_MS : Infinity;
  const anchors = indexAnchors(entries);
  const episodes = candidates.map((candidate) => ({ ...candidate, anchor: anchors.get(candidate.row.anchorFailureId) }));
  // Enrollment comes from the exposure log even after its memory evidence rolls out of the tail.
  const enrollment = episodes.filter(({ row, anchor }) =>
    row.ts >= startTs && (anchor === undefined || row.key === anchor.keyHash));
  const unitStop = start.state === "set" ? findUnitStop(enrollment, Math.min(deadline, now)) : undefined;
  const running = start.state === "set" && unitStop === undefined && now < deadline;
  // A stopped report can disclose later rows as afterStop. A running report ends at now.
  const reportThrough = running ? now : Infinity;
  const cutoff = unitStop ?? { ts: Math.min(reportThrough, deadline), order: Infinity };
  counts.skips = countLogRows(rows, reportThrough, new Set(candidates.map(({ order }) => order)), counts.excluded);

  for (const { row, order, anchor } of episodes) {
    if (row.ts > reportThrough) break;
    if (row.ts < startTs) counts.excluded.beforeStart++;
    else if (afterCutoff(row.ts, order, cutoff)) counts.excluded.afterStop++;
    else if (anchor !== undefined && row.key !== anchor.keyHash) counts.excluded.keyMismatch++;
  }
  const sessions = collectSessions(enrollment, cutoff, counts);
  countOperations(rows, startTs, cutoff, counts);
  if (start.state !== "set") return { ...counts, phase: "not-started", start };

  const day = Math.max(1, Math.min(STUDY_STOP_DAYS, Math.floor((cutoff.ts - start.ts) / DAY_MS) + 1));
  const started: StartedStudy = { ...counts, start: { state: "set", iso: new Date(start.ts).toISOString() }, day };
  if (running) return { ...started, phase: "running" };
  return {
    ...started,
    phase: "stopped",
    stopReason: unitStop === undefined ? "days" : "units",
    ...analyzeSessions(sessions, records, counts.arms),
  };
}

function percent(p: number): string {
  return (p * 100).toFixed(1);
}

function points(p: number): string {
  const value = percent(p);
  if (value === "-0.0") return "+0.0";
  return p < 0 ? value : `+${value}`;
}

function primaryRate({ n, passed }: PrimaryCounts): string {
  return n === 0 ? "" : ` (${percent(passed / n)}%)`;
}

function tallyText(tallies: Record<string, number | undefined>): string {
  return Object.entries(tallies).filter(([, n]) => n).map(([key, n]) => `${key} ${n}`).join(", ");
}

const DISPLAYABLE_SKIP_REASONS = new Set([
  "interrupt", "background", "no-exit-header", "wrapped", "undecidable", "lock_busy", "coverage", "hook-duplicate",
]);

function skipTallyText(skips: Record<string, number>): string {
  const tallies: Record<string, number> = {};
  let other = 0;
  for (const [reason, count] of Object.entries(skips)) {
    if (DISPLAYABLE_SKIP_REASONS.has(reason)) tallies[reason] = count;
    else other += count;
  }
  if (other > 0) tallies.other = other;
  return tallyText(tallies);
}

const VERDICT_TEXT: Record<Verdict, string> = {
  on: "Verdict: on. The note becomes default on.",
  off: "Verdict: off. The note stays off.",
  inconclusive: "Verdict: inconclusive. The note stays off; CLI and MCP stay.",
};

function renderOutcomes(report: StoppedStudy): string[] {
  const { primary, secondary, sameFailure, repeatFileSet, expectations, verdict } = report;
  const { shown, held } = primary;
  const details = [
    `primary: shown ${shown.passed}/${shown.n} passed in session${primaryRate(shown)}. held ${held.passed}/${held.n}${primaryRate(held)}.`,
  ];
  if (primary.diff !== undefined && primary.lower !== undefined && primary.upper !== undefined) {
    details.push(`difference shown minus held: ${points(primary.diff)} points, 90% CI ${points(primary.lower)} to ${points(primary.upper)} (Newcombe).`);
  }
  if (primary.mde !== undefined) details.push(`minimum detectable effect at this size: ${percent(primary.mde)} points.`);
  details.push(VERDICT_TEXT[verdict], "A friction entry from the owner in the journal sets the note off whatever this verdict says.");
  if (secondary.diff !== undefined && secondary.lower !== undefined && secondary.upper !== undefined) {
    details.push(`secondary, all episodes: ${points(secondary.diff)} points, 90% CI ${points(secondary.lower)} to ${points(secondary.upper)} (session bootstrap, ${secondary.resamples} resamples).`);
  }
  const shownMean = sameFailure.shown === undefined
    ? "no shown episodes"
    : `shown ${sameFailure.shown.toFixed(1)} per episode`;
  const heldMean = sameFailure.held === undefined
    ? "no held episodes"
    : `held ${sameFailure.held.toFixed(1)}${sameFailure.shown === undefined ? " per episode" : ""}`;
  details.push(
    `same failure after the note: ${shownMean}, ${heldMean}.`,
    `repeated file set: shown ${repeatFileSet.shown.repeats} of ${repeatFileSet.shown.subset} episodes with observed edits, held ${repeatFileSet.held.repeats} of ${repeatFileSet.held.subset}.`,
    `expectations after the note: shown ${tallyText(expectations.shown) || "none"}; held ${tallyText(expectations.held) || "none"}.`,
    "Analyses beyond these are exploratory.",
  );
  return details;
}

export function renderAttemptStudyText(report: AttemptStudyReport, home: string): { head: string; details: string[] } {
  const { shown, held } = report.arms;
  let head: string;
  let details: string[];
  if (report.phase === "stopped") {
    const reason = report.stopReason === "units" ? `${STUDY_STOP_UNITS} primary units` : `day ${STUDY_STOP_DAYS}`;
    head = `Attempt study stopped (${reason}).`;
    details = renderOutcomes(report);
  } else {
    if (report.phase === "running") {
      head = `Attempt study running. Day ${report.day} of ${STUDY_STOP_DAYS}. ${report.primaryUnits} of ${STUDY_STOP_UNITS} primary units.`;
    } else {
      const marker = join(home, STUDY_START_FILE);
      head = report.start.state === "absent"
        ? `Attempt study not started. No start marker at ${marker}.`
        : `Attempt study not started. Start marker at ${marker} is invalid.`;
    }
    details = [
      `shown: ${shown.episodes} episodes, ${shown.primaryUnits} primary units. held: ${held.episodes} episodes, ${held.primaryUnits} primary units.`,
      "Outcome numbers stay hidden until the study stops.",
    ];
  }

  const excluded = tallyText(report.excluded);
  if (excluded.length > 0) details.push(`excluded: ${excluded}.`);
  if (shown.outOfTail > 0 || held.outOfTail > 0) {
    details.push(`missing from memory read: shown ${shown.outOfTail}, held ${held.outOfTail}. Outcome counts exclude these episodes.`);
  }
  const skips = skipTallyText(report.skips);
  if (skips.length > 0) details.push(`skips: ${skips}.`);
  if (report.malformed > 0) details.push(`malformed rows: ${report.malformed}.`);
  if (report.logFull) details.push("Exposure log is full. New rows are not written.");
  for (const lane of LANES) {
    const { p95 } = report.latency[lane];
    if (p95 !== undefined) details.push(`${lane} lane p95 ${p95} ms.`);
  }
  if (report.meanDeliveredBytes !== undefined) details.push(`mean note size ${Number(report.meanDeliveredBytes.toFixed(1))} bytes.`);
  return { head, details };
}
