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

const FALLBACK_BROKEN_CASES: ReadonlyArray<{ name: string; failure?: Partial<FailureRecord>; card: StoredCard }> = [
  { name: "step kind is not cmd", card: makeCard("c1", { agent_id: "sub-1", flow: [makeCmdStep({ kind: "edit" })] }) },
  { name: "step ok is true", card: makeCard("c2", { agent_id: "sub-1", flow: [makeCmdStep({ ok: true })] }) },
  { name: "step exit_code differs", card: makeCard("c3", { agent_id: "sub-1", flow: [makeCmdStep({ exit_code: 2 })] }) },
  { name: "F.ts before start_ms - 1000", card: makeCard("c4", { agent_id: "sub-1", flow: [makeCmdStep({ start_ms: T + 1_001, end_ms: T + 2_000 })] }) },
  { name: "F.ts after end_ms + 5000", card: makeCard("c5", { agent_id: "sub-1", flow: [makeCmdStep({ start_ms: T - 7_000, end_ms: T - 5_001 })] }) },
  { name: "cwd differs via step.cwd", card: makeCard("c6", { agent_id: "sub-1", flow: [makeCmdStep({ cwd: "/other" })] }) },
  { name: "cwd differs via card.root fallback", card: makeCard("c7", { root: "/other", agent_id: "sub-1", flow: [makeCmdStep()] }) },
  { name: "command identity differs", card: makeCard("c8", { agent_id: "sub-1", flow: [makeCmdStep({ text: "npm run lint" })] }) },
  { name: "step command identity is unreliable", card: makeCard("c9", { agent_id: "sub-1", flow: [makeCmdStep({ text: "npm test | head" })] }) },
  { name: "failure identityReliable is false", failure: { identityReliable: false }, card: makeCard("c10", { agent_id: "sub-1", flow: [makeCmdStep()] }) },
  { name: "failure identityV is missing", failure: { identityV: undefined }, card: makeCard("c11", { agent_id: "sub-1", flow: [makeCmdStep()] }) },
  { name: "session_id differs when both sides stamped", card: makeCard("c12", { session_id: "sess-other", agent_id: "sub-1", flow: [makeCmdStep()] }) },
  { name: "agent_id differs when both sides non-empty", card: makeCard("c13", { session_id: "sess-1", agent_id: "sub-2", flow: [makeCmdStep()] }) },
];

for (const tc of FALLBACK_BROKEN_CASES) {
  test(`fallback rejects when ${tc.name}`, () => {
    const f1 = makeFailure({
      id: "f1",
      ts: T,
      origin: "run",
      agent: { vendor: "claude-code", session: "sess-1", agentId: "sub-1" },
      resolvedBy: "x1",
      ...tc.failure,
    });
    const x1 = makeFix({
      id: "x1",
      ts: T + 60_000,
      failureIds: ["f1"],
      agent: { vendor: "claude-code", session: "sess-1", agentId: "sub-1" },
    });
    const records: MemoryRecord[] = [f1, x1];
    const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([tc.card]), { platform: "linux" });
    assert.equal(joined.matchedCardByFailureId.has("f1"), false);
    assert.deepEqual(joined.entries[0]!.attempts[0]!.changes, { state: "unknown" });
  });
}

test("fallback accepts non-empty failure agentId when card.agent_id is empty", () => {
  const f1 = makeFailure({
    id: "f1",
    ts: T,
    origin: "run",
    agent: { vendor: "claude-code", session: "sess-1", agentId: "sub-1" },
    resolvedBy: "x1",
  });
  const x1 = makeFix({
    id: "x1",
    ts: T + 60_000,
    failureIds: ["f1"],
    agent: { vendor: "claude-code", session: "sess-1", agentId: "sub-1" },
  });
  const card = makeCard("c-ok", { session_id: "sess-1", agent_id: "", flow: [makeCmdStep()] });
  const records: MemoryRecord[] = [f1, x1];
  const ok = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
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

test("observed changes count escaping block paths in more for both slash spellings", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const card = makeCard("card-escape", {
    blocks: [
      makeBlock(1, "src/a.ts"),
      makeBlock(2, "../outside/private.ts"),
      makeBlock(3, "..\\outside\\secret.ts"),
      makeBlock(4, "a/../../outside/nested.ts"),
      makeBlock(5, "~/x.ts"),
    ],
    flow: [
      makeCmdStep({ start_ms: T - 500, end_ms: T }),
      makeEditStep([1, 2, 3, 4, 5], T + 10_000, T + 12_000),
    ],
  });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
  assert.deepEqual(joined.entries[0]!.attempts[0]!.changes, {
    state: "observed",
    files: ["src/a.ts"],
    more: 4,
    cardId: "card-escape",
    partial: false,
  });
});

test("observed changes emit only repo-relative normalized paths across drive, dot-prefix, tilde, and traversal inputs", () => {
  const outside = [
    "D:private.ts",
    "D:/outside/x.ts",
    "./D:/outside/x.ts",
    "./D:private.ts",
    "./~/x.ts",
    "~/x.ts",
    "/abs/x.ts",
    "../x.ts",
    "..\\x.ts",
    "src/../../x.ts",
    "~/../escaped.ts",
    "D:sub/../escaped.ts",
  ];
  const blocks = [
    makeBlock(1, "src/a.ts"),
    makeBlock(2, "./src/a.ts"),
    ...outside.map((p, i) => makeBlock(i + 3, p)),
  ];
  const seqs = blocks.map((b) => b.seq);

  for (const [platform, cwd] of [["linux", "/app"], ["win32", "C:/app"]] as const) {
    const f1 = makeFailure({ id: "f1", ts: T, cwd, platform, resolvedBy: "x1" });
    const x1 = makeFix({ id: "x1", ts: T + 60_000, cwd, platform, failureIds: ["f1"] });
    const card = makeCard(`card-proj-${platform}`, {
      root: cwd,
      blocks,
      flow: [
        makeCmdStep({ start_ms: T - 500, end_ms: T }),
        makeEditStep(seqs, T + 10_000, T + 12_000),
      ],
    });
    const records: MemoryRecord[] = [f1, x1];
    const entries = buildProblems(records, completeCoverage(records.length), { now: NOW, platform }).entries;
    const joined = joinAttemptCards(entries, records, cardsJoin([card]), { platform });
    assert.deepEqual(joined.entries[0]!.attempts[0]!.changes, {
      state: "observed",
      files: ["src/a.ts"],
      more: outside.length,
      cardId: `card-proj-${platform}`,
      partial: false,
    });
  }
});

function observedPartialFor(
  cards: readonly StoredCard[],
  opts: { complete?: boolean; fixTs?: number } = {},
): boolean {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: opts.fixTs ?? T + 60_000, failureIds: ["f1"] });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(
    problemsFor(records),
    records,
    cardsJoin(cards, opts.complete ?? true),
    { platform: "linux" },
  );
  const changes = joined.entries[0]!.attempts[0]!.changes;
  assert.equal(changes.state, "observed");
  return changes.partial;
}

function makeBasePartialCard(): StoredCard {
  return makeCard("card-base", {
    blocks: [makeBlock(1, "src/a.ts")],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
    ],
  });
}

test("partial is true when card join is incomplete", () => {
  assert.equal(observedPartialFor([makeBasePartialCard()], { complete: false }), true);
});

test("partial is true when an overlapping lane card has flow_more > 0", () => {
  const flowMoreCard = makeCard("card-more", { started_ms: T + 20_000, ended_ms: T + 40_000, flow_more: 2 });
  assert.equal(observedPartialFor([makeBasePartialCard(), flowMoreCard]), true);
});

test("partial is true when an overlapping lane card has partial coverage", () => {
  const partialCovCard = makeCard("card-cov", {
    started_ms: T + 20_000,
    ended_ms: T + 40_000,
    coverage: { state: "partial", reasons: ["daemon_gap"] },
  });
  assert.equal(observedPartialFor([makeBasePartialCard(), partialCovCard]), true);
});

test("partial is true when an in-range edit step has empty seqs", () => {
  const emptySeqsCard = makeCard("card-empty-seqs", {
    blocks: [makeBlock(1, "src/a.ts")],
    flow: [makeCmdStep({ start_ms: T - 1_000, end_ms: T }), makeEditStep([], T + 10_000, T + 11_000)],
  });
  assert.equal(observedPartialFor([emptySeqsCard]), true);
});

test("partial is true when an overlapping lane card has an edit missing start_ms", () => {
  const untimedEditCard = makeCard("card-untimed-edit", {
    started_ms: T + 20_000,
    ended_ms: T + 40_000,
    flow: [{ kind: "edit", text: "edit", ok: true, dur_ms: 100, seqs: [1] }],
  });
  assert.equal(observedPartialFor([makeBasePartialCard(), untimedEditCard]), true);
});

test("partial is false when an unfinished edit starts after the rerun or before the failure end", () => {
  const openCard = makeCard("card-open", {
    started_ms: T - 10_000,
    ended_ms: null,
    blocks: [makeBlock(1, "src/a.ts")],
    flow: [
      { kind: "edit", text: "edit", ok: true, dur_ms: 0, seqs: [], start_ms: T - 5_000 },
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
      { kind: "edit", text: "edit", ok: true, dur_ms: 0, seqs: [], start_ms: T + 21_000 },
    ],
  });
  assert.equal(observedPartialFor([openCard], { fixTs: T + 20_000 }), false);
});

test("partial is true when an unfinished edit starts inside the attempt interval", () => {
  const openCard = makeCard("card-open-in-range", {
    started_ms: T - 10_000,
    ended_ms: null,
    blocks: [makeBlock(1, "src/a.ts")],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      { kind: "edit", text: "edit", ok: true, dur_ms: 0, seqs: [], start_ms: T + 5_000 },
    ],
  });
  assert.equal(observedPartialFor([openCard], { fixTs: T + 20_000 }), true);
});

test("partial is false for non-overlapping earlier or later cards with gaps", () => {
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
  assert.equal(observedPartialFor([makeBasePartialCard(), earlierCard, laterCard]), false);
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

const RAW_TEST_DESC = "Verify fix with token=ghp_123456789012345678901234567890123456\nline2";
const RAW_TEST_QUOTE = "Use secret=AKIAIOSFODNN7EXAMPLE\tguard";

test("stated uses sanitized rerun bash-description and tool_use_id", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const card = makeCard("card-desc", {
    blocks: [makeBlock(1, "src/a.ts", { quote: { text: RAW_TEST_QUOTE, shared: false } })],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
      makeCmdStep({
        ok: true,
        exit_code: 0,
        start_ms: T + 59_500,
        end_ms: T + 60_200,
        tool_use_id: "tu-rerun",
        desc: RAW_TEST_DESC,
      }),
    ],
  });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
  assert.deepEqual(joined.entries[0]!.attempts[0]!.stated, {
    text: sanitizeTestimony(RAW_TEST_DESC),
    source: "bash-description",
    recordId: "card-desc#tu-rerun",
  });
});

test("stated falls back to #step when rerun step omits tool_use_id", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const card = makeCard("card-desc-step", {
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeCmdStep({ ok: true, exit_code: 0, start_ms: T + 59_500, end_ms: T + 60_200, desc: "Re-run suite" }),
    ],
  });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
  assert.deepEqual(joined.entries[0]!.attempts[0]!.stated, {
    text: "Re-run suite",
    source: "bash-description",
    recordId: "card-desc-step#step",
  });
});

test("stated ignores same-identity rerun descriptions from another cwd", () => {
  const f1 = makeFailure({ id: "f1", ts: T, cwd: "/app", resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, cwd: "/app", failureIds: ["f1"] });
  const card = makeCard("card-cwd", {
    root: "/app",
    flow: [
      makeCmdStep({ cwd: "/app", start_ms: T - 1_000, end_ms: T }),
      makeCmdStep({
        cwd: "/app/nested",
        ok: true,
        exit_code: 0,
        start_ms: T + 59_000,
        end_ms: T + 59_500,
        tool_use_id: "tu-nested",
        desc: "Nested suite",
      }),
      makeCmdStep({
        cwd: "/app",
        ok: true,
        exit_code: 0,
        start_ms: T + 59_600,
        end_ms: T + 60_200,
        tool_use_id: "tu-root",
        desc: "Root suite",
      }),
    ],
  });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
  assert.deepEqual(joined.entries[0]!.attempts[0]!.stated, {
    text: "Root suite",
    source: "bash-description",
    recordId: "card-cwd#tu-root",
  });
});

test("stated falls back to newest sanitized in-range card-quote when rerun has no desc", () => {
  const f1 = makeFailure({ id: "f1", ts: T, resolvedBy: "x1" });
  const x1 = makeFix({ id: "x1", ts: T + 60_000, failureIds: ["f1"] });
  const card = makeCard("card-quote", {
    blocks: [
      makeBlock(1, "src/a.ts", { quote: { text: "older quote", shared: false } }),
      makeBlock(2, "src/b.ts", { quote: { text: RAW_TEST_QUOTE, shared: false } }),
    ],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
      makeEditStep([2], T + 20_000, T + 21_000),
      makeCmdStep({ ok: true, exit_code: 0, start_ms: T + 59_500, end_ms: T + 60_200 }),
    ],
  });
  const records: MemoryRecord[] = [f1, x1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
  assert.deepEqual(joined.entries[0]!.attempts[0]!.stated, {
    text: sanitizeTestimony(RAW_TEST_QUOTE),
    source: "card-quote",
    recordId: "card-quote",
  });
});

test("stated preserves existing rationale over bash-description and card-quote", () => {
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
    excerpt: "explicit rationale wins",
    links: { failureId: "f1" },
  };
  const card = makeCard("card-desc", {
    blocks: [makeBlock(1, "src/a.ts", { quote: { text: RAW_TEST_QUOTE, shared: false } })],
    flow: [
      makeCmdStep({ start_ms: T - 1_000, end_ms: T }),
      makeEditStep([1], T + 10_000, T + 11_000),
      makeCmdStep({ ok: true, exit_code: 0, start_ms: T + 59_500, end_ms: T + 60_200, desc: RAW_TEST_DESC }),
    ],
  });
  const records: MemoryRecord[] = [f1, x1, r1];
  const joined = joinAttemptCards(problemsFor(records), records, cardsJoin([card]), { platform: "linux" });
  assert.deepEqual(joined.entries[0]!.attempts[0]!.stated, {
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
