import assert from "node:assert/strict";
import test from "node:test";
import { buildProblems, type ProblemEntry } from "../core/attempts.js";
import { joinAttemptCards, type CardJoin } from "../core/attempt-cards.js";
import { commandIdentity } from "../core/fingerprint.js";
import {
  MEMORY_FORMAT_VERSION,
  type FailureRecord,
  type FixRecord,
  type MemoryCoverage,
  type MemoryRecord,
  type RationaleRecord,
} from "../core/memory-read.js";
import { sanitizeTestimony } from "../core/redact.js";
import type { StoredBlock, StoredCard, StoredFlowStep } from "../desk/cards-record.js";

const T = 1_700_000_000_000;
const NOW = T + 120_000;

function completeCoverage(scanned = 2): MemoryCoverage {
  return {
    version: MEMORY_FORMAT_VERSION,
    scanned,
    skipped: 0,
    truncated: 0,
    bytesScanned: 100,
    bytesTotal: 100,
    complete: true,
  };
}

function makeFailure(overrides: Partial<FailureRecord> & { id: string; ts: number }): FailureRecord {
  const cmd = overrides.cmd ?? "npm test";
  const platform = overrides.platform ?? "linux";
  const id = commandIdentity(cmd, { platform });
  return {
    kind: "failure",
    cwd: "/app",
    cmd,
    exitCode: 1,
    fingerprint: "aaaa000000000001",
    fingerprintV: 2,
    signature: ["error: assertion failed"],
    excerpt: "Error: assertion failed",
    origin: "run",
    commandIdentity: id.value,
    identityV: 1,
    identityReliable: id.reliable,
    platform,
    ...overrides,
  };
}

function makeFix(overrides: Partial<FixRecord> & { id: string; ts: number }): FixRecord {
  const cmd = overrides.cmd ?? "npm test";
  const platform = overrides.platform ?? "linux";
  const id = commandIdentity(cmd, { platform });
  return {
    kind: "fix",
    cwd: "/app",
    cmd,
    failureIds: [],
    commandIdentity: id.value,
    identityV: 1,
    identityReliable: id.reliable,
    platform,
    ...overrides,
  };
}

function makeBlock(seq: number, path: string, overrides: Partial<StoredBlock> = {}): StoredBlock {
  return {
    seq,
    path,
    labels: [{ id: "body_changed" }],
    importance: "medium",
    ...overrides,
  };
}

function makeCmdStep(overrides: Partial<StoredFlowStep> = {}): StoredFlowStep {
  return {
    kind: "cmd",
    text: "npm test",
    ok: false,
    dur_ms: 1_000,
    seqs: [],
    exit_code: 1,
    start_ms: T - 1_000,
    end_ms: T,
    ...overrides,
  };
}

function makeEditStep(seqs: number[], startMs: number, endMs: number, overrides: Partial<StoredFlowStep> = {}): StoredFlowStep {
  return {
    kind: "edit",
    text: "edit",
    ok: true,
    dur_ms: Math.max(0, endMs - startMs),
    seqs,
    start_ms: startMs,
    end_ms: endMs,
    ...overrides,
  };
}

function makeCard(cardId: string, overrides: Partial<StoredCard> = {}): StoredCard {
  return {
    v: 1,
    card_id: cardId,
    rev: 1,
    root: "/app",
    session_id: "sess-1",
    agent_id: "",
    started_ms: T - 10_000,
    ended_ms: T + 90_000,
    prompt: "fix failing tests",
    blocks: [],
    flow: [],
    flow_more: 0,
    coverage: { state: "full", reasons: [] },
    ...overrides,
  };
}

function problemsFor(records: readonly MemoryRecord[]): ProblemEntry[] {
  return buildProblems(records, completeCoverage(records.length), { now: NOW, platform: "linux" }).entries;
}

function cardsJoin(cards: readonly StoredCard[], complete = true): () => CardJoin {
  return () => ({ cards, complete });
}

test("exact tool_use_id match wins over fallback candidates", () => {
  const f1 = makeFailure({
    id: "f1",
    ts: T,
    origin: "agent",
    agent: { vendor: "claude-code", session: "sess-1", toolUseId: "tu1" },
    resolvedBy: "x1",
  });
  const x1 = makeFix({
    id: "x1",
    ts: T + 60_000,
    failureIds: ["f1"],
    agent: { vendor: "claude-code", session: "sess-1" },
  });
  const exactCard = makeCard("card-exact", {
    blocks: [makeBlock(1, "src/exact.ts")],
    flow: [
      makeCmdStep({ tool_use_id: "tu1", text: "different-cmd", exit_code: 2, start_ms: T - 50_000, end_ms: T - 49_000 }),
      makeEditStep([1], T + 10_000, T + 11_000),
    ],
  });
  const fallbackCard = makeCard("card-fallback", {
    flow: [makeCmdStep({ start_ms: T - 500, end_ms: T + 100 })],
  });
  const records: MemoryRecord[] = [f1, x1];
  const entries = problemsFor(records);

  const joined = joinAttemptCards(entries, records, cardsJoin([fallbackCard, exactCard]), { platform: "linux" });
  assert.equal(joined.matchedCardByFailureId.get("f1"), "card-exact");
  const attempt = joined.entries[0]!.attempts[0]!;
  assert.deepEqual(attempt.changes, {
    state: "observed",
    files: ["src/exact.ts"],
    more: 0,
    cardId: "card-exact",
    partial: false,
  });
});

test("exact tool_use_id deduplicates within one card and marks cross-card duplicate ambiguous", () => {
  const f1 = makeFailure({
    id: "f1",
    ts: T,
    origin: "agent",
    agent: { vendor: "claude-code", session: "sess-1", toolUseId: "tu1" },
    resolvedBy: "x1",
  });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const records: MemoryRecord[] = [f1, x1];
  const entries = problemsFor(records);

  const dupWithinCard = makeCard("card-1", {
    flow: [
      makeCmdStep({ tool_use_id: "tu1" }),
      makeCmdStep({ tool_use_id: "tu1" }),
    ],
  });
  const single = joinAttemptCards(entries, records, cardsJoin([dupWithinCard]), { platform: "linux" });
  assert.equal(single.matchedCardByFailureId.get("f1"), "card-1");

  const cardA = makeCard("card-a", { flow: [makeCmdStep({ tool_use_id: "tu1" })] });
  const cardB = makeCard("card-b", { flow: [makeCmdStep({ tool_use_id: "tu1" })] });
  const ambig = joinAttemptCards(entries, records, cardsJoin([cardA, cardB]), { platform: "linux" });
  assert.equal(ambig.matchedCardByFailureId.has("f1"), false);
  assert.deepEqual(ambig.entries[0]!.attempts[0]!.changes, { state: "unknown" });
});

test("exact lookup with zero matching tool_use_id falls through to fallback", () => {
  const f1 = makeFailure({
    id: "f1",
    ts: T,
    origin: "agent",
    agent: { vendor: "claude-code", session: "sess-1", toolUseId: "tu-missing" },
    resolvedBy: "x1",
  });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const card = makeCard("card-fb", { flow: [makeCmdStep({ tool_use_id: "tu-other" })] });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
  assert.equal(joined.matchedCardByFailureId.get("f1"), "card-fb");
});

test("unique fallback matches run failure including rocky run unwrap and boundary window", () => {
  const f1 = makeFailure({ id: "f1", ts: T, origin: "run", resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const records: MemoryRecord[] = [f1, x1];
  const entries = problemsFor(records);

  const wrappedCard = makeCard("card-wrap", {
    flow: [makeCmdStep({ text: 'rocky run "npm test"', start_ms: T + 1_000, end_ms: T + 2_000 })],
  });
  const atStartEdge = joinAttemptCards(entries, records, cardsJoin([wrappedCard]), { platform: "linux" });
  assert.equal(atStartEdge.matchedCardByFailureId.get("f1"), "card-wrap");

  const endEdgeCard = makeCard("card-end", {
    flow: [makeCmdStep({ start_ms: T - 6_000, end_ms: T - 5_000 })],
  });
  const atEndEdge = joinAttemptCards(entries, records, cardsJoin([endEdgeCard]), { platform: "linux" });
  assert.equal(atEndEdge.matchedCardByFailureId.get("f1"), "card-end");
});

test("fallback fails when any single condition is broken", () => {
  const baseFailure = makeFailure({
    id: "f1",
    ts: T,
    origin: "run",
    agent: { vendor: "claude-code", session: "sess-1", agentId: "sub-1" },
    resolvedBy: "x1",
  });
  const baseFix = makeFix({
    id: "x1",
    ts: T + 60_000,
    failureIds: ["f1"],
    agent: { vendor: "claude-code", session: "sess-1", agentId: "sub-1" },
  });

  const cases: Array<{ name: string; failure?: Partial<FailureRecord>; card: StoredCard }> = [
    {
      name: "step kind is not cmd",
      card: makeCard("c1", { agent_id: "sub-1", flow: [makeCmdStep({ kind: "edit" })] }),
    },
    {
      name: "step ok is true",
      card: makeCard("c2", { agent_id: "sub-1", flow: [makeCmdStep({ ok: true })] }),
    },
    {
      name: "step exit_code differs",
      card: makeCard("c3", { agent_id: "sub-1", flow: [makeCmdStep({ exit_code: 2 })] }),
    },
    {
      name: "F.ts before start_ms - 1000",
      card: makeCard("c4", { agent_id: "sub-1", flow: [makeCmdStep({ start_ms: T + 1_001, end_ms: T + 2_000 })] }),
    },
    {
      name: "F.ts after end_ms + 5000",
      card: makeCard("c5", { agent_id: "sub-1", flow: [makeCmdStep({ start_ms: T - 7_000, end_ms: T - 5_001 })] }),
    },
    {
      name: "cwd differs via step.cwd",
      card: makeCard("c6", { agent_id: "sub-1", flow: [makeCmdStep({ cwd: "/other" })] }),
    },
    {
      name: "cwd differs via card.root fallback",
      card: makeCard("c7", { root: "/other", agent_id: "sub-1", flow: [makeCmdStep()] }),
    },
    {
      name: "command identity differs",
      card: makeCard("c8", { agent_id: "sub-1", flow: [makeCmdStep({ text: "npm run lint" })] }),
    },
    {
      name: "step command identity is unreliable",
      card: makeCard("c9", { agent_id: "sub-1", flow: [makeCmdStep({ text: "npm test | head" })] }),
    },
    {
      name: "failure identityReliable is false",
      failure: { identityReliable: false },
      card: makeCard("c10", { agent_id: "sub-1", flow: [makeCmdStep()] }),
    },
    {
      name: "failure identityV is missing",
      failure: { identityV: undefined },
      card: makeCard("c11", { agent_id: "sub-1", flow: [makeCmdStep()] }),
    },
    {
      name: "session_id differs when both sides stamped",
      card: makeCard("c12", { session_id: "sess-other", agent_id: "sub-1", flow: [makeCmdStep()] }),
    },
    {
      name: "agent_id differs when both sides non-empty",
      card: makeCard("c13", { session_id: "sess-1", agent_id: "sub-2", flow: [makeCmdStep()] }),
    },
  ];

  for (const tc of cases) {
    const f1: FailureRecord = { ...baseFailure, ...tc.failure };
    const records: MemoryRecord[] = [f1, baseFix];
    const entries = problemsFor(records);
    const joined = joinAttemptCards(entries, records, cardsJoin([tc.card]), { platform: "linux" });
    assert.equal(joined.matchedCardByFailureId.has("f1"), false, `expected no match for: ${tc.name}`);
    assert.deepEqual(joined.entries[0]!.attempts[0]!.changes, { state: "unknown" }, tc.name);
  }

  // Positive control: when card.agent_id is empty, non-empty F.agent.agentId does not reject.
  const openAgentCard = makeCard("c-ok", { session_id: "sess-1", agent_id: "", flow: [makeCmdStep()] });
  const records: MemoryRecord[] = [baseFailure, baseFix];
  const ok = joinAttemptCards(problemsFor(records), records, cardsJoin([openAgentCard]), { platform: "linux" });
  assert.equal(ok.matchedCardByFailureId.get("f1"), "c-ok");
});

test("ambiguous fallback leaves outcome unchanged, sets changes unknown, omits failure from map", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const r1: RationaleRecord = {
    kind: "rationale",
    id: "r1",
    ts: T + 5_000,
    v: 1,
    cwd: "/app",
    agent: "claude-code",
    rationale_fidelity: "summary",
    source: "notify",
    excerpt: "touched src/a.ts",
    files: ["src/a.ts"],
    links: { failureId: "f1" },
  };
  const card = makeCard("card-ambig", {
    blocks: [makeBlock(1, "src/a.ts")],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeCmdStep({ start_ms: T - 500, end_ms: T + 500 }),
      makeEditStep([1], T + 10_000, T + 11_000),
    ],
  });
  const records: MemoryRecord[] = [f1, x1, r1];
  const entries = problemsFor(records);
  assert.equal(entries[0]!.attempts[0]!.changes.state, "testimony");

  const joined = joinAttemptCards(entries, records, cardsJoin([card]), { platform: "linux" });
  const attempt = joined.entries[0]!.attempts[0]!;
  assert.equal(attempt.outcome, "passed");
  assert.deepEqual(joined.entries[0]!.counts, entries[0]!.counts);
  assert.deepEqual(attempt.changes, { state: "unknown" });
  assert.equal(joined.matchedCardByFailureId.has("f1"), false);
});

test("observed changes collect repo-relative files, count outside paths in more, respect range and lane", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const card1 = makeCard("card-1", {
    session_id: "sess-1",
    agent_id: "agent-a",
    started_ms: T - 10_000,
    ended_ms: T + 30_000,
    blocks: [
      makeBlock(1, "src/a.ts"),
      makeBlock(2, "~/x.ts"),
      makeBlock(3, "src/late.ts"),
    ],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1, 2], T + 5_000, T + 6_000),
      makeEditStep([3], T + 60_500, T + 61_000), // after outcomeTs -> excluded
    ],
  });
  const sameLaneCard2 = makeCard("card-2", {
    session_id: "sess-1",
    agent_id: "agent-a",
    started_ms: T + 31_000,
    ended_ms: T + 70_000,
    blocks: [
      makeBlock(1, "src/b.ts"),
      makeBlock(2, "src/a.ts"), // duplicate -> deduped
    ],
    flow: [makeEditStep([1, 2], T + 40_000, T + 41_000)],
  });
  const otherAgentCard = makeCard("card-other-agent", {
    session_id: "sess-1",
    agent_id: "agent-b",
    started_ms: T,
    ended_ms: T + 50_000,
    blocks: [makeBlock(1, "src/other.ts")],
    flow: [makeEditStep([1], T + 15_000, T + 16_000)],
  });
  const records: MemoryRecord[] = [f1, x1];
  const entries = problemsFor(records);

  // Pass cards newest-first (matching cardsForRoot order) to verify chronological first-seen order.
  const joined = joinAttemptCards(
    entries,
    records,
    cardsJoin([sameLaneCard2, otherAgentCard, card1]),
    { platform: "linux" },
  );
  assert.equal(joined.matchedCardByFailureId.get("f1"), "card-1");
  assert.deepEqual(joined.entries[0]!.attempts[0]!.changes, {
    state: "observed",
    files: ["src/a.ts", "src/b.ts"],
    more: 1,
    cardId: "card-1",
    partial: false,
  });
});

test("observed changes single-card exact shape with ~/x.ts counted in more", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const card = makeCard("card-single", {
    blocks: [makeBlock(1, "src/a.ts"), makeBlock(2, "~/x.ts")],
    flow: [
      makeCmdStep({ start_ms: T - 500, end_ms: T }),
      makeEditStep([1, 2], T + 10_000, T + 12_000),
    ],
  });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
  assert.deepEqual(joined.entries[0]!.attempts[0]!.changes, {
    state: "observed",
    files: ["src/a.ts"],
    more: 1,
    cardId: "card-single",
    partial: false,
  });
});

test("partial is true for each of the five partial conditions", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const records: MemoryRecord[] = [f1, x1];
  const entries = problemsFor(records);

  const baseCard = makeCard("card-base", {
    blocks: [makeBlock(1, "src/a.ts")],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
    ],
  });

  // 1. complete: false
  const incomplete = joinAttemptCards(entries, records, cardsJoin([baseCard], false), { platform: "linux" });
  assert.equal(incomplete.entries[0]!.attempts[0]!.changes.state, "observed");
  assert.equal((incomplete.entries[0]!.attempts[0]!.changes as { partial: boolean }).partial, true);

  // 2. overlapping lane card has flow_more > 0
  const flowMoreCard = makeCard("card-more", {
    started_ms: T + 20_000,
    ended_ms: T + 40_000,
    flow_more: 2,
  });
  const withFlowMore = joinAttemptCards(entries, records, cardsJoin([baseCard, flowMoreCard]), { platform: "linux" });
  assert.equal((withFlowMore.entries[0]!.attempts[0]!.changes as { partial: boolean }).partial, true);

  // 3. overlapping lane card has coverage.state === "partial"
  const partialCovCard = makeCard("card-cov", {
    started_ms: T + 20_000,
    ended_ms: T + 40_000,
    coverage: { state: "partial", reasons: ["daemon_gap"] },
  });
  const withPartialCov = joinAttemptCards(entries, records, cardsJoin([baseCard, partialCovCard]), { platform: "linux" });
  assert.equal((withPartialCov.entries[0]!.attempts[0]!.changes as { partial: boolean }).partial, true);

  // 4. edit step in range has empty seqs
  const emptySeqsCard = makeCard("card-empty-seqs", {
    blocks: [makeBlock(1, "src/a.ts")],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([], T + 10_000, T + 11_000),
    ],
  });
  const withEmptySeqs = joinAttemptCards(entries, records, cardsJoin([emptySeqsCard]), { platform: "linux" });
  assert.equal((withEmptySeqs.entries[0]!.attempts[0]!.changes as { partial: boolean }).partial, true);

  // 5. overlapping lane card has an edit step without start_ms
  const untimedEditCard = makeCard("card-untimed-edit", {
    started_ms: T + 20_000,
    ended_ms: T + 40_000,
    flow: [{ kind: "edit", text: "edit", ok: true, dur_ms: 100, seqs: [1] }],
  });
  const withUntimedEdit = joinAttemptCards(entries, records, cardsJoin([baseCard, untimedEditCard]), { platform: "linux" });
  assert.equal((withUntimedEdit.entries[0]!.attempts[0]!.changes as { partial: boolean }).partial, true);

  // Control: non-overlapping lane cards with flow_more/partial coverage do not trigger partial
  const earlierCard = makeCard("card-before", {
    started_ms: T - 30_000,
    ended_ms: T - 20_000,
    flow_more: 3,
    coverage: { state: "partial", reasons: ["daemon_gap"] },
  });
  const laterCard = makeCard("card-after", {
    started_ms: T + 70_000,
    ended_ms: T + 80_000,
    flow: [{ kind: "edit", text: "edit", ok: true, dur_ms: 100, seqs: [1] }],
  });
  const nonOverlapping = joinAttemptCards(entries, records, cardsJoin([baseCard, earlierCard, laterCard]), { platform: "linux" });
  assert.equal((nonOverlapping.entries[0]!.attempts[0]!.changes as { partial: boolean }).partial, false);
});

test("attempt without outcomeTs keeps previous changes while still recording matched card", () => {
  const f1 = makeFailure({ id: "f1", ts: T });
  const r1: RationaleRecord = {
    kind: "rationale",
    id: "r1",
    ts: T + 1_000,
    v: 1,
    cwd: "/app",
    agent: "claude-code",
    rationale_fidelity: "summary",
    source: "notify",
    excerpt: "will try fixing parser",
    files: ["src/parser.ts"],
    links: { failureId: "f1" },
  };
  const card = makeCard("card-no-rerun", {
    blocks: [makeBlock(1, "src/other.ts")],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 5_000, T + 6_000),
    ],
  });
  const records: MemoryRecord[] = [f1, r1];
  const entries = problemsFor(records);
  assert.equal(entries[0]!.attempts[0]!.outcomeTs, undefined);

  const joined = joinAttemptCards(entries, records, cardsJoin([card]), { platform: "linux" });
  assert.equal(joined.matchedCardByFailureId.get("f1"), "card-no-rerun");
  assert.deepEqual(joined.entries[0]!.attempts[0]!.changes, {
    state: "testimony",
    files: ["src/parser.ts"],
    rationaleId: "r1",
  });
});

test("stated prefers rationale, then rerun bash-description, then newest in-range card-quote, all sanitized", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const rawDesc = "Verify fix with token=ghp_123456789012345678901234567890123456\nline2";
  const rawQuote = "Use secret=AKIAIOSFODNN7EXAMPLE\tguard";

  // 1. rerun step desc -> bash-description
  const cardWithDesc = makeCard("card-desc", {
    blocks: [makeBlock(1, "src/a.ts", { quote: { text: rawQuote, shared: false } })],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
      makeCmdStep({
        ok: true,
        exit_code: 0,
        start_ms: T + 59_500,
        end_ms: T + 60_200,
        tool_use_id: "tu-rerun",
        desc: rawDesc,
      }),
    ],
  });
  const baseRecords: MemoryRecord[] = [f1, x1];
  const baseEntries = problemsFor(baseRecords);
  const fromDesc = joinAttemptCards(baseEntries, baseRecords, cardsJoin([cardWithDesc]), { platform: "linux" });
  assert.deepEqual(fromDesc.entries[0]!.attempts[0]!.stated, {
    text: sanitizeTestimony(rawDesc),
    source: "bash-description",
    recordId: "card-desc#tu-rerun",
  });

  // 1b. rerun step desc without tool_use_id falls back to #step
  const cardDescNoToolId = makeCard("card-desc-step", {
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeCmdStep({ ok: true, exit_code: 0, start_ms: T + 59_500, end_ms: T + 60_200, desc: "Re-run suite" }),
    ],
  });
  const fromDescNoId = joinAttemptCards(baseEntries, baseRecords, cardsJoin([cardDescNoToolId]), { platform: "linux" });
  assert.deepEqual(fromDescNoId.entries[0]!.attempts[0]!.stated, {
    text: "Re-run suite",
    source: "bash-description",
    recordId: "card-desc-step#step",
  });

  // 2. no desc -> newest in-range block quote -> card-quote
  const cardWithQuotes = makeCard("card-quote", {
    blocks: [
      makeBlock(1, "src/a.ts", { quote: { text: "older quote", shared: false } }),
      makeBlock(2, "src/b.ts", { quote: { text: rawQuote, shared: false } }),
    ],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
      makeEditStep([2], T + 20_000, T + 21_000),
      makeCmdStep({ ok: true, exit_code: 0, start_ms: T + 59_500, end_ms: T + 60_200 }),
    ],
  });
  const fromQuote = joinAttemptCards(baseEntries, baseRecords, cardsJoin([cardWithQuotes]), { platform: "linux" });
  assert.deepEqual(fromQuote.entries[0]!.attempts[0]!.stated, {
    text: sanitizeTestimony(rawQuote),
    source: "card-quote",
    recordId: "card-quote",
  });

  // 3. existing rationale stated is kept over both
  const r1: RationaleRecord = {
    kind: "rationale",
    id: "r1",
    ts: T + 5_000,
    v: 1,
    cwd: "/app",
    agent: "claude-code",
    rationale_fidelity: "summary",
    source: "notify",
    excerpt: "explicit rationale wins",
    links: { failureId: "f1" },
  };
  const withRationaleRecords: MemoryRecord[] = [f1, x1, r1];
  const withRationaleEntries = problemsFor(withRationaleRecords);
  const keptRationale = joinAttemptCards(
    withRationaleEntries,
    withRationaleRecords,
    cardsJoin([cardWithDesc]),
    { platform: "linux" },
  );
  assert.deepEqual(keptRationale.entries[0]!.attempts[0]!.stated, {
    text: "explicit rationale wins",
    source: "rationale",
    recordId: "r1",
  });
});

test("old cards without start_ms and end_ms never match fallback", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const oldCard = makeCard("card-old", {
    flow: [
      { kind: "cmd", text: "npm test", ok: false, dur_ms: 1_000, seqs: [], exit_code: 1 },
      { kind: "cmd", text: "npm test", ok: false, dur_ms: 1_000, seqs: [], exit_code: 1, start_ms: T - 1_000 },
      { kind: "cmd", text: "npm test", ok: false, dur_ms: 1_000, seqs: [], exit_code: 1, end_ms: T },
    ],
  });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([oldCard]), { platform: "linux" });
  assert.equal(joined.matchedCardByFailureId.has("f1"), false);
  assert.deepEqual(joined.entries[0]!.attempts[0]!.changes, { state: "unknown" });
});

test("input entries are not mutated and missing failure records are skipped", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const card = makeCard("card-immut", {
    blocks: [makeBlock(1, "src/a.ts", { quote: { text: "fixed null check", shared: false } })],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
    ],
  });
  const records: MemoryRecord[] = [f1, x1];
  const entries = problemsFor(records);
  const snapshot = structuredClone(entries);

  const joined = joinAttemptCards(entries, records, cardsJoin([card]), { platform: "linux" });
  assert.deepStrictEqual(entries, snapshot);
  assert.notEqual(joined.entries[0], entries[0]);
  assert.notEqual(joined.entries[0]!.attempts[0], entries[0]!.attempts[0]);

  const skipped = joinAttemptCards(entries, [], cardsJoin([card]), { platform: "linux" });
  assert.deepStrictEqual(entries, snapshot);
  assert.equal(skipped.matchedCardByFailureId.size, 0);
  assert.deepStrictEqual(skipped.entries, snapshot);
});
