import type { StoredBlock, StoredCard, StoredFlowStep } from "../desk/cards-record.js";
import type { Attempt, ProblemEntry } from "./attempts.js";
import { isAbsOrTildeBlockPath, isRepoRelativeBlockPath, normalizeRepoBlockPath } from "./block-paths.js";
import { COMMAND_IDENTITY_VERSION, commandIdentity, unwrapRockyRun } from "./fingerprint.js";
import { sameCwd, type FailureRecord, type MemoryRecord } from "./memory-read.js";
import { sanitizeTestimony } from "./redact.js";

export interface CardJoin { cards: readonly StoredCard[]; complete: boolean }
export interface CardJoinResult { entries: ProblemEntry[]; matchedCardByFailureId: Map<string, string> }

const JOIN_BEFORE_MS = 1_000;
const JOIN_AFTER_MS = 5_000;

interface StepRef { card: StoredCard; step: StoredFlowStep }

type MatchResult =
  | { status: "matched"; ref: StepRef }
  | { status: "ambiguous" }
  | { status: "none" };

interface IndexedStep extends StepRef {
  cardOrder: number;
  stepIndex: number;
}

function inWindow(ts: number, step: StoredFlowStep): boolean {
  if (step.start_ms === undefined || step.end_ms === undefined) return false;
  return ts >= step.start_ms - JOIN_BEFORE_MS && ts <= step.end_ms + JOIN_AFTER_MS;
}

function sameCardSession(agent: FailureRecord["agent"], card: StoredCard): boolean {
  if (agent === undefined) return true;
  if (agent.session.length > 0 && card.session_id !== undefined && card.session_id.length > 0) {
    if (agent.session !== card.session_id) return false;
  }
  if (
    agent.agentId !== undefined && agent.agentId.length > 0 &&
    card.agent_id !== undefined && card.agent_id.length > 0 &&
    agent.agentId !== card.agent_id
  ) {
    return false;
  }
  return true;
}

function sameLane(card: StoredCard, target: StoredCard): boolean {
  return (card.session_id ?? "") === (target.session_id ?? "")
    && (card.agent_id ?? "") === (target.agent_id ?? "");
}

function cardOverlapsRange(card: StoredCard, rangeStart: number, rangeEnd: number): boolean {
  return card.started_ms <= rangeEnd && (card.ended_ms === null || card.ended_ms >= rangeStart);
}

function reliableFailureIdentity(failure: FailureRecord): string | undefined {
  if (failure.identityReliable !== true) return undefined;
  if (failure.identityV !== COMMAND_IDENTITY_VERSION) return undefined;
  return failure.commandIdentity;
}

function stepCommandIdentity(step: StoredFlowStep, platform: NodeJS.Platform): string | undefined {
  const id = commandIdentity(unwrapRockyRun(step.text), { platform });
  return id.reliable ? id.value : undefined;
}

function compareStepsChronologically(a: IndexedStep, b: IndexedStep): number {
  return (a.step.start_ms! - b.step.start_ms!)
    || (a.step.end_ms! - b.step.end_ms!)
    || (a.cardOrder - b.cardOrder)
    || (a.stepIndex - b.stepIndex);
}

function chronologicalLaneCards(cards: readonly StoredCard[], target: StoredCard): StoredCard[] {
  return cards
    .filter((card) => sameLane(card, target))
    .sort((a, b) => a.started_ms - b.started_ms || (a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0));
}

function matchExactStep(failure: FailureRecord, cards: readonly StoredCard[]): MatchResult | undefined {
  const toolUseId = failure.origin === "agent" ? failure.agent?.toolUseId : undefined;
  if (toolUseId === undefined || toolUseId.length === 0) return undefined;

  const seen = new Set<string>();
  const matches: StepRef[] = [];
  for (const card of cards) {
    for (const step of card.flow ?? []) {
      if (step.kind !== "cmd" || step.tool_use_id !== toolUseId) continue;
      const key = `${card.card_id}\u0000${toolUseId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ card, step });
      if (matches.length > 1) return { status: "ambiguous" };
    }
  }
  return matches.length === 1 ? { status: "matched", ref: matches[0]! } : undefined;
}

function matchStep(
  failure: FailureRecord,
  cards: readonly StoredCard[],
  fallbackPlatform: NodeJS.Platform,
): MatchResult {
  const exact = matchExactStep(failure, cards);
  if (exact !== undefined) return exact;

  const failureIdentity = reliableFailureIdentity(failure);
  if (failureIdentity === undefined) return { status: "none" };
  const platform = failure.platform ?? fallbackPlatform;
  const candidates: StepRef[] = [];

  for (const card of cards) {
    if (!sameCardSession(failure.agent, card)) continue;
    for (const step of card.flow ?? []) {
      if (step.kind !== "cmd" || step.ok !== false || step.exit_code !== failure.exitCode) continue;
      if (!inWindow(failure.ts, step)) continue;
      if (!sameCwd(failure.cwd, step.cwd ?? card.root, platform)) continue;
      if (stepCommandIdentity(step, platform) !== failureIdentity) continue;
      candidates.push({ card, step });
      if (candidates.length > 1) return { status: "ambiguous" };
    }
  }
  return candidates.length === 1 ? { status: "matched", ref: candidates[0]! } : { status: "none" };
}

function laneEdits(
  laneCards: readonly StoredCard[],
  rangeStart: number,
  rangeEnd: number,
): { edits: IndexedStep[]; partial: boolean } {
  const edits: IndexedStep[] = [];
  let partial = false;

  for (let cardOrder = 0; cardOrder < laneCards.length; cardOrder += 1) {
    const card = laneCards[cardOrder]!;
    const overlaps = cardOverlapsRange(card, rangeStart, rangeEnd);
    if (overlaps && ((card.flow_more ?? 0) > 0 || card.coverage?.state === "partial")) {
      partial = true;
    }
    const flow = card.flow ?? [];
    for (let stepIndex = 0; stepIndex < flow.length; stepIndex += 1) {
      const step = flow[stepIndex]!;
      if (step.kind !== "edit") continue;
      if (step.start_ms === undefined) {
        if (overlaps) partial = true;
        continue;
      }
      if (step.start_ms < rangeStart || step.start_ms > rangeEnd) continue;
      if (step.end_ms === undefined) {
        if (overlaps) partial = true;
        continue;
      }
      if (step.end_ms <= rangeEnd) {
        if (step.seqs.length === 0) partial = true;
        edits.push({ card, step, cardOrder, stepIndex });
      }
    }
  }

  edits.sort(compareStepsChronologically);
  return { edits, partial };
}

function blocksBySeq(card: StoredCard, cache: Map<StoredCard, Map<number, StoredBlock>>): Map<number, StoredBlock> {
  let map = cache.get(card);
  if (map === undefined) {
    map = new Map<number, StoredBlock>();
    for (const block of card.blocks) map.set(block.seq, block);
    cache.set(card, map);
  }
  return map;
}

function projectRepoBlockPath(rawPath: string): string | undefined {
  if (isAbsOrTildeBlockPath(rawPath) || /^[A-Za-z]:/.test(rawPath)) return undefined;
  const normalized = normalizeRepoBlockPath(rawPath, "linux");
  return normalized !== undefined && isRepoRelativeBlockPath(normalized) ? normalized : undefined;
}

function observedChanges(
  matched: StepRef,
  failure: FailureRecord,
  outcomeTs: number,
  join: CardJoin,
  laneCards: readonly StoredCard[],
  blockCache: Map<StoredCard, Map<number, StoredBlock>>,
  platform: NodeJS.Platform,
): { changes: Attempt["changes"]; edits: IndexedStep[] } {
  const rangeStart = matched.step.end_ms ?? failure.ts;
  const { edits, partial: lanePartial } = laneEdits(laneCards, rangeStart, outcomeTs);
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const seenOutside = new Set<string>();

  for (const { card, step } of edits) {
    const map = blocksBySeq(card, blockCache);
    for (const seq of step.seqs) {
      const block = map.get(seq);
      if (block === undefined || block.path.length === 0) continue;
      const rel = projectRepoBlockPath(block.path);
      if (rel === undefined) {
        seenOutside.add(block.path);
      } else {
        const key = platform === "win32" ? rel.toLowerCase() : rel;
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          files.push(rel);
        }
      }
    }
  }

  return {
    changes: {
      state: "observed",
      files,
      more: seenOutside.size,
      cardId: matched.card.card_id,
      partial: !join.complete || lanePartial,
    },
    edits,
  };
}

function findRerunStep(
  matched: StepRef,
  failure: FailureRecord,
  outcomeTs: number,
  laneCards: readonly StoredCard[],
  platform: NodeJS.Platform,
): StepRef | undefined {
  const targetId = reliableFailureIdentity(failure) ?? stepCommandIdentity(matched.step, platform);
  if (targetId === undefined) return undefined;

  const matchedStepIndex = (matched.card.flow ?? []).indexOf(matched.step);
  const afterMs = matched.step.end_ms ?? failure.ts;
  const candidates: IndexedStep[] = [];

  for (let cardOrder = 0; cardOrder < laneCards.length; cardOrder += 1) {
    const card = laneCards[cardOrder]!;
    const sameCard = card.card_id === matched.card.card_id;
    const flow = card.flow ?? [];
    for (let stepIndex = 0; stepIndex < flow.length; stepIndex += 1) {
      const step = flow[stepIndex]!;
      if (step.kind !== "cmd") continue;
      if (sameCard && stepIndex <= matchedStepIndex) continue;
      if (!sameCard && (step.start_ms === undefined || step.start_ms < afterMs)) continue;
      if (!inWindow(outcomeTs, step)) continue;
      if (!sameCwd(failure.cwd, step.cwd ?? card.root, platform)) continue;
      if (stepCommandIdentity(step, platform) !== targetId) continue;
      candidates.push({ card, step, cardOrder, stepIndex });
    }
  }

  candidates.sort(compareStepsChronologically);
  return candidates[0];
}

function statedFromCards(
  attempt: Attempt,
  matched: StepRef,
  failure: FailureRecord,
  outcomeTs: number,
  laneCards: readonly StoredCard[],
  edits: readonly IndexedStep[],
  blockCache: Map<StoredCard, Map<number, StoredBlock>>,
  platform: NodeJS.Platform,
): Attempt["stated"] {
  if (attempt.stated?.source === "rationale") return { ...attempt.stated };

  const rerun = findRerunStep(matched, failure, outcomeTs, laneCards, platform);
  if (rerun !== undefined && rerun.step.desc !== undefined) {
    const text = sanitizeTestimony(rerun.step.desc);
    if (text.trim().length > 0) {
      return {
        text,
        source: "bash-description",
        recordId: `${rerun.card.card_id}#${rerun.step.tool_use_id ?? "step"}`,
      };
    }
  }

  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const { card, step } = edits[i]!;
    const map = blocksBySeq(card, blockCache);
    for (let j = step.seqs.length - 1; j >= 0; j -= 1) {
      const raw = map.get(step.seqs[j]!)?.quote?.text;
      if (raw === undefined) continue;
      const text = sanitizeTestimony(raw);
      if (text.trim().length > 0) {
        return { text, source: "card-quote", recordId: card.card_id };
      }
    }
  }

  return attempt.stated !== undefined ? { ...attempt.stated } : undefined;
}

function cloneAttempt(attempt: Attempt): Attempt {
  const copy: Attempt = {
    ...attempt,
    changes: attempt.changes.state === "unknown"
      ? { state: "unknown" }
      : { ...attempt.changes, files: [...attempt.changes.files] },
  };
  if (attempt.session !== undefined) copy.session = { ...attempt.session };
  if (attempt.stated !== undefined) copy.stated = { ...attempt.stated };
  if (attempt.expectations !== undefined) copy.expectations = attempt.expectations.map((item) => ({ ...item }));
  return copy;
}

function joinSingleAttempt(
  attempt: Attempt,
  failure: FailureRecord | undefined,
  cardsFor: (cwd: string) => CardJoin,
  fallbackPlatform: NodeJS.Platform,
  matchedCardByFailureId: Map<string, string>,
): Attempt {
  const next = cloneAttempt(attempt);
  if (failure === undefined) return next;

  const join = cardsFor(failure.cwd);
  const matched = matchStep(failure, join.cards, fallbackPlatform);
  if (matched.status === "none") return next;
  if (matched.status === "ambiguous") {
    next.changes = { state: "unknown" };
    return next;
  }

  matchedCardByFailureId.set(failure.id, matched.ref.card.card_id);
  if (next.outcomeTs === undefined) return next;

  const platform = failure.platform ?? fallbackPlatform;
  const laneCards = chronologicalLaneCards(join.cards, matched.ref.card);
  const blockCache = new Map<StoredCard, Map<number, StoredBlock>>();
  const { changes, edits } = observedChanges(matched.ref, failure, next.outcomeTs, join, laneCards, blockCache, platform);
  next.changes = changes;

  const stated = statedFromCards(next, matched.ref, failure, next.outcomeTs, laneCards, edits, blockCache, platform);
  if (stated !== undefined) next.stated = stated;
  return next;
}

export function joinAttemptCards(
  entries: readonly ProblemEntry[],
  records: readonly MemoryRecord[],
  cardsFor: (cwd: string) => CardJoin,
  opts: { platform: NodeJS.Platform },
): CardJoinResult {
  const failuresById = new Map<string, FailureRecord>();
  for (const record of records) {
    if (record.kind === "failure" && !failuresById.has(record.id)) {
      failuresById.set(record.id, record);
    }
  }

  const matchedCardByFailureId = new Map<string, string>();
  const joinedEntries: ProblemEntry[] = entries.map((entry) => ({
    ...entry,
    family: [...entry.family],
    signature: [...entry.signature],
    counts: { ...entry.counts },
    attempts: entry.attempts.map((attempt) =>
      joinSingleAttempt(attempt, failuresById.get(attempt.failureId), cardsFor, opts.platform, matchedCardByFailureId),
    ),
  }));

  return { entries: joinedEntries, matchedCardByFailureId };
}
