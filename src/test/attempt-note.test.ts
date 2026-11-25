import assert from "node:assert/strict";
import test from "node:test";
import { buildProblems } from "../core/attempts.js";
import type { CardJoin } from "../core/attempt-cards.js";
import {
  ATTEMPT_NOTE_MAX_ATTEMPTS,
  ATTEMPT_NOTE_MAX_BYTES,
  priorAttemptsNote,
  type CardsFor,
} from "../core/attempt-note.js";
import { commandIdentity } from "../core/fingerprint.js";
import {
  MEMORY_FORMAT_VERSION,
  type AssociationRecord,
  type FailureRecord,
  type FixRecord,
  type MemoryCoverage,
  type MemoryRecord,
  type RationaleRecord,
} from "../core/memory-read.js";
import type { StoredBlock, StoredCard, StoredFlowStep } from "../desk/cards-record.js";
import { causalWordViolations } from "./causal-words.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

const REF_DAY = Date.UTC(2026, 10, 12, 0, 0, 0); // 2026-11-12 UTC
const REF_NOW = Date.UTC(2026, 10, 15, 10, 0, 0); // 2026-11-15 10:00 UTC

function completeCoverage(scanned = 1): MemoryCoverage {
  return {
    version: MEMORY_FORMAT_VERSION,
    scanned,
    skipped: 0,
    truncated: 0,
    bytesScanned: 256,
    bytesTotal: 256,
    complete: true,
  };
}

function makeFailure(overrides: Partial<FailureRecord> & { id: string; ts: number }): FailureRecord {
  const cmd = overrides.cmd ?? "npm test";
  const platform = overrides.platform ?? "linux";
  const identity = commandIdentity(cmd, { platform });
  return {
    kind: "failure",
    cwd: "/app",
    cmd,
    exitCode: 1,
    fingerprint: "3f2a9c1e44d0b7a1",
    fingerprintV: 2,
    signature: ["typeerror: token undefined"],
    excerpt: "TypeError: token undefined",
    origin: "run",
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform,
    ...overrides,
  };
}

function makeFix(overrides: Partial<FixRecord> & { id: string; ts: number }): FixRecord {
  const cmd = overrides.cmd ?? "npm test";
  const platform = overrides.platform ?? "linux";
  const identity = commandIdentity(cmd, { platform });
  return {
    kind: "fix",
    cwd: "/app",
    cmd,
    failureIds: [],
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform,
    ...overrides,
  };
}

function makeAssociation(
  overrides: Partial<AssociationRecord> & { id: string; ts: number; candidateFailureIds: string[] },
): AssociationRecord {
  const cmd = overrides.cmd ?? "npm test -- auth";
  const platform = overrides.platform ?? "linux";
  return {
    kind: "association",
    cwd: "/app",
    cmd,
    links: overrides.candidateFailureIds.map((id) => ({ id, basis: "same-program-only" as const })),
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

function makeCmdStep(startMs: number, endMs: number, overrides: Partial<StoredFlowStep> = {}): StoredFlowStep {
  return {
    kind: "cmd",
    text: "npm test",
    ok: false,
    dur_ms: Math.max(0, endMs - startMs),
    seqs: [],
    exit_code: 1,
    start_ms: startMs,
    end_ms: endMs,
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
    started_ms: REF_DAY,
    ended_ms: REF_NOW,
    prompt: "debug auth test",
    blocks: [],
    flow: [],
    flow_more: 0,
    coverage: { state: "full", reasons: [] },
    ...overrides,
  };
}

function cardsReturning(cards: readonly StoredCard[], complete = true): CardsFor {
  return (): CardJoin => ({ cards, complete });
}

function buildReferenceScenario(fp = "3f2a9c1e44d0b7a1"): {
  records: MemoryRecord[];
  cards: StoredCard[];
} {
  const t1 = Date.UTC(2026, 10, 12, 13, 0, 0);
  const t2 = Date.UTC(2026, 10, 12, 13, 20, 0);
  const t3 = Date.UTC(2026, 10, 12, 13, 40, 0);
  const tOther = Date.UTC(2026, 10, 12, 13, 50, 0);
  const t4 = Date.UTC(2026, 10, 12, 13, 55, 0);
  const tPass = Date.UTC(2026, 10, 12, 14, 3, 0);

  const f1 = makeFailure({ id: "f1", ts: t1, fingerprint: fp });
  const f2 = makeFailure({ id: "f2", ts: t2, fingerprint: fp });
  const f3 = makeFailure({ id: "f3", ts: t3, fingerprint: fp });
  const fOther = makeFailure({ id: "f-other", ts: tOther, fingerprint: "bbbb000000000002" });
  const x1 = makeFix({ id: "x1", ts: tPass, failureIds: ["f4"] });
  const f4 = makeFailure({ id: "f4", ts: t4, fingerprint: fp, resolvedBy: x1.id });

  const card = makeCard("card-ref", {
    started_ms: t1 - 5_000,
    ended_ms: tPass + 5_000,
    blocks: [
      makeBlock(1, "src/auth.ts"),
      makeBlock(2, "src/auth.ts"),
      makeBlock(3, "src/session.ts"),
    ],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 60_000, t1 + 61_000),
      makeCmdStep(t2 - 500, t2),
      makeEditStep([2], t2 + 60_000, t2 + 61_000),
      makeCmdStep(t3 - 500, t3),
      makeCmdStep(t4 - 500, t4),
      makeEditStep([3], t4 + 60_000, t4 + 61_000),
    ],
  });

  return {
    records: [f1, f2, f3, fOther, f4, x1],
    cards: [card],
  };
}

test("renders the reference sentence", () => {
  assert.equal(ATTEMPT_NOTE_MAX_BYTES, 600);
  assert.equal(ATTEMPT_NOTE_MAX_ATTEMPTS, 5);

  const fp = "3f2a9c1e44d0b7a1";
  const { records, cards } = buildReferenceScenario(fp);
  const coverage = completeCoverage(records.length);
  const expectedEntry = buildProblems(records, coverage, {
    now: REF_NOW,
    fingerprint: fp,
    cwd: "/app",
    platform: "linux",
  }).entries.find((entry) => entry.cwdScope === "here");
  assert.ok(expectedEntry);

  const note = priorAttemptsNote(
    records,
    coverage,
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning(cards), platform: "linux" },
  );

  const expectedText =
    `rocky: Same error recorded 4 times before in this directory (first 2026-11-12). ` +
    `After those runs: 2 reruns failed the same way, 1 failed with another error, 1 passed (2026-11-12 14:03). ` +
    `Files edited before the passing rerun: src/session.ts. ` +
    `Files edited before the same-way failures: src/auth.ts (2). ` +
    `Rocky records order, not cause. More: rocky attempts ${fp}`;

  assert.ok(note);
  assert.equal(note.key, expectedEntry.key);
  assert.equal(note.fingerprint, fp);
  assert.equal(note.text, expectedText);
  assert.equal(note.bytes, Buffer.byteLength(expectedText, "utf8"));
});

test("prior-attempts note never carries expectation text", () => {
  const failure = makeFailure({ id: "f1", ts: REF_NOW - 2 * MIN_MS });
  const rationale: RationaleRecord = {
    kind: "rationale",
    id: "r1",
    ts: REF_NOW - MIN_MS,
    v: 1,
    cwd: failure.cwd,
    agent: "generic",
    rationale_fidelity: "raw",
    source: "mcp",
    excerpt: "ZZ-EXPECT-MARKER",
    expectedCommand: "npm test",
    links: { failureId: failure.id },
  };
  const note = priorAttemptsNote(
    [failure, rationale],
    completeCoverage(2),
    { fingerprints: [failure.fingerprint], cwd: failure.cwd },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(note);
  assert.doesNotMatch(note.text, /ZZ-EXPECT-MARKER/u);
});

test("drops clauses without data", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const { records } = buildReferenceScenario(fp);
  const coverage = completeCoverage(records.length);

  // With cardsFor: undefined, file clauses are omitted.
  const withoutCards = priorAttemptsNote(
    records,
    coverage,
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(withoutCards);
  assert.equal(withoutCards.text.includes("Files edited"), false);
  assert.equal(
    withoutCards.text,
    `rocky: Same error recorded 4 times before in this directory (first 2026-11-12). ` +
      `After those runs: 2 reruns failed the same way, 1 failed with another error, 1 passed (2026-11-12 14:03). ` +
      `Rocky records order, not cause. More: rocky attempts ${fp}`,
  );

  // With no passed attempts, there is no passed (...) clause; no_later_run and unknown are never counted.
  const t1 = Date.UTC(2026, 10, 12, 10, 0, 0);
  const t2 = Date.UTC(2026, 10, 12, 10, 10, 0);
  const tUnlinked = Date.UTC(2026, 10, 12, 10, 20, 0);
  const t3 = Date.UTC(2026, 10, 12, 10, 30, 0);
  const noPassRecords: MemoryRecord[] = [
    makeFailure({ id: "np1", ts: t1, fingerprint: fp }),
    makeFailure({ id: "np2", ts: t2, fingerprint: fp }), // np1 -> same_failure, np2 -> unknown (unlinked-pass)
    makeFix({ id: "np-unlinked", ts: tUnlinked, failureIds: [] }),
    makeFailure({ id: "np3", ts: t3, fingerprint: fp }), // np3 -> no_later_run
  ];
  const noPassNote = priorAttemptsNote(
    noPassRecords,
    completeCoverage(noPassRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([]), platform: "linux" },
  );
  assert.ok(noPassNote);
  assert.equal(noPassNote.text.includes("passed"), false);
  assert.equal(noPassNote.text.includes("Files edited"), false);
  assert.equal(
    noPassNote.text,
    `rocky: Same error recorded 3 times before in this directory (first 2026-11-12). ` +
      `After those runs: 1 rerun failed the same way. ` +
      `Rocky records order, not cause. More: rocky attempts ${fp}`,
  );

  // Single prior attempt with no_later_run: singular "1 time before", no "After ..." clause.
  const singleRecord: MemoryRecord[] = [makeFailure({ id: "s1", ts: t1, fingerprint: fp })];
  const singleNote = priorAttemptsNote(
    singleRecord,
    completeCoverage(1),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(singleNote);
  assert.equal(
    singleNote.text,
    `rocky: Same error recorded 1 time before in this directory (first 2026-11-12). ` +
      `Rocky records order, not cause. More: rocky attempts ${fp}`,
  );
});

test("uses at most the 5 most recent attempts for counts", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const base = Date.UTC(2026, 10, 10, 9, 0, 0);
  // 7 prior attempts:
  // #1 (base+0m): different_failure (outside last 5)
  // #2 (base+10m): passed at base+12m (outside last 5)
  // #3..#6: same_failure (4 in last 5)
  // #7: no_later_run (1 in last 5, uncounted)
  const fixOld = makeFix({ id: "fix-old", ts: base + 12 * MIN_MS, failureIds: ["a2"] });
  const records: MemoryRecord[] = [
    makeFailure({ id: "a1", ts: base, fingerprint: fp }),
    makeFailure({ id: "a1-other", ts: base + 2 * MIN_MS, fingerprint: "cccc000000000003" }),
    makeFailure({ id: "a2", ts: base + 10 * MIN_MS, fingerprint: fp, resolvedBy: fixOld.id }),
    fixOld,
    makeFailure({ id: "a3", ts: base + 20 * MIN_MS, fingerprint: fp }),
    makeFailure({ id: "a4", ts: base + 30 * MIN_MS, fingerprint: fp }),
    makeFailure({ id: "a5", ts: base + 40 * MIN_MS, fingerprint: fp }),
    makeFailure({ id: "a6", ts: base + 50 * MIN_MS, fingerprint: fp }),
    makeFailure({ id: "a7", ts: base + 60 * MIN_MS, fingerprint: fp }),
  ];

  const note = priorAttemptsNote(
    records,
    completeCoverage(records.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );

  assert.ok(note);
  assert.equal(
    note.text,
    `rocky: Same error recorded 7 times before in this directory (first 2026-11-10). ` +
      `After the last 5 runs: 4 reruns failed the same way. ` +
      `Rocky records order, not cause. More: rocky attempts ${fp}`,
  );
});

test("ignores attempts older than 30 days and other directories", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const fpSecond = "4444555566667777";
  const oldTs = REF_NOW - 30 * DAY_MS - 1_000;
  const recentTs = REF_NOW - 2 * HOUR_MS;

  // Only >30 days in this dir -> undefined.
  const onlyOld = priorAttemptsNote(
    [makeFailure({ id: "old1", ts: oldTs, fingerprint: fp, cwd: "/app" })],
    completeCoverage(1),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.equal(onlyOld, undefined);

  // Only another directory -> undefined.
  const onlyElsewhere = priorAttemptsNote(
    [makeFailure({ id: "other1", ts: recentTs, fingerprint: fp, cwd: "/other" })],
    completeCoverage(1),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.equal(onlyElsewhere, undefined);

  // Mixed old + recent: old attempts are excluded from N and first date.
  const mixedRecords: MemoryRecord[] = [
    makeFailure({ id: "old1", ts: oldTs, fingerprint: fp, cwd: "/app" }),
    makeFailure({ id: "rec1", ts: recentTs, fingerprint: fp, cwd: "/app" }),
  ];
  const mixed = priorAttemptsNote(
    mixedRecords,
    completeCoverage(mixedRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(mixed);
  assert.match(mixed.text, /Same error recorded 1 time before in this directory \(first 2026-11-15\)\./);

  // First candidate only matches elsewhere; second candidate matches here.
  const fallbackRecords: MemoryRecord[] = [
    makeFailure({ id: "else1", ts: recentTs, fingerprint: fp, cwd: "/other" }),
    makeFailure({ id: "here1", ts: recentTs, fingerprint: fpSecond, cwd: "/app" }),
  ];
  const fallback = priorAttemptsNote(
    fallbackRecords,
    completeCoverage(fallbackRecords.length),
    { fingerprints: [fp, fpSecond], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(fallback);
  assert.equal(fallback.fingerprint, fpSecond);
  assert.ok(fallback.text.endsWith(`More: rocky attempts ${fpSecond}`));
});

test("not eligible when every prior attempt passed", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const t1 = REF_NOW - 4 * HOUR_MS;
  const x1 = makeFix({ id: "x1", ts: t1 + 5 * MIN_MS, failureIds: ["f1"] });
  const f1 = makeFailure({ id: "f1", ts: t1, fingerprint: fp, resolvedBy: x1.id });

  const t2 = REF_NOW - 2 * HOUR_MS;
  const x2 = makeFix({ id: "x2", ts: t2 + 5 * MIN_MS, failureIds: ["f2"] });
  const f2 = makeFailure({ id: "f2", ts: t2, fingerprint: fp, resolvedBy: x2.id });

  const allPassed = priorAttemptsNote(
    [f1, x1, f2, x2],
    completeCoverage(4),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.equal(allPassed, undefined);

  // Also ineligible when the only non-passed attempt is older than 30 days.
  const oldNonPassed = makeFailure({ id: "f-old", ts: REF_NOW - 31 * DAY_MS, fingerprint: fp });
  const onlyRecentPassed = priorAttemptsNote(
    [oldNonPassed, f2, x2],
    completeCoverage(3),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.equal(onlyRecentPassed, undefined);
});

test("stays within 600 ASCII bytes", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const base = REF_NOW - 10 * DAY_MS;
  const records: MemoryRecord[] = [];
  const blocks: StoredBlock[] = [];
  const flow: StoredFlowStep[] = [];
  let seq = 1;

  const longSegments = (tag: string, unicode: string): string =>
    `seg1/seg2/seg3/seg4/seg5/seg6/seg7/seg8/seg9/seg10/seg11/${unicode}-${tag}-very-long-component-name.ts`;

  // 40 attempts: 38 same_failure + 1 passed + 1 no_later_run, with many 12-segment non-ASCII paths.
  for (let i = 0; i < 40; i += 1) {
    const ts = base + i * 10 * MIN_MS;
    const id = `f-${i}`;
    if (i === 38) {
      const fixId = `x-${i}`;
      const passTs = ts + 5 * MIN_MS;
      records.push(makeFailure({ id, ts, fingerprint: fp, resolvedBy: fixId }));
      records.push(makeFix({ id: fixId, ts: passTs, failureIds: [id] }));
      flow.push(makeCmdStep(ts - 500, ts));
      const editSeqs: number[] = [];
      for (let j = 0; j < 5; j += 1) {
        blocks.push(makeBlock(seq, longSegments(`pass-${j}`, "café-日本語")));
        editSeqs.push(seq);
        seq += 1;
      }
      flow.push(makeEditStep(editSeqs, ts + 60_000, ts + 61_000));
    } else {
      records.push(makeFailure({ id, ts, fingerprint: fp }));
      flow.push(makeCmdStep(ts - 500, ts));
      const editSeqs: number[] = [];
      for (let j = 0; j < 5; j += 1) {
        blocks.push(makeBlock(seq, longSegments(`fail-${i}-${j}`, "über-λ")));
        editSeqs.push(seq);
        seq += 1;
      }
      flow.push(makeEditStep(editSeqs, ts + 60_000, ts + 61_000));
    }
  }

  const card = makeCard("card-huge", {
    started_ms: base - 10_000,
    ended_ms: REF_NOW,
    blocks,
    flow,
  });

  const note = priorAttemptsNote(
    records,
    completeCoverage(records.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([card]), platform: "linux" },
  );

  assert.ok(note);
  assert.ok(Buffer.byteLength(note.text, "utf8") <= ATTEMPT_NOTE_MAX_BYTES, `bytes=${note.bytes}`);
  assert.equal(note.bytes, Buffer.byteLength(note.text, "utf8"));
  assert.match(note.text, /^[\x20-\x7e]*$/);
  assert.ok(
    note.text.endsWith(`Rocky records order, not cause. More: rocky attempts ${fp}`),
    `unexpected ending: ${note.text}`,
  );
  assert.match(note.text, /Same error recorded 40 times before/);
  assert.match(note.text, /After the last 5 runs:/);

  // Verify non-ASCII path characters become '?' when paths fit within the budget.
  const tA = REF_NOW - 2 * HOUR_MS;
  const tB = REF_NOW - HOUR_MS;
  const smallRecords: MemoryRecord[] = [
    makeFailure({ id: "u1", ts: tA, fingerprint: fp }),
    makeFailure({ id: "u2", ts: tB, fingerprint: fp }),
  ];
  const unicodeCard = makeCard("card-unicode", {
    started_ms: tA - 5_000,
    ended_ms: tB + 5_000,
    blocks: [
      makeBlock(1, "src/café/a.ts"),
      makeBlock(2, "src/b.ts"),
      makeBlock(3, "src/c.ts"),
      makeBlock(4, "src/d.ts"),
    ],
    flow: [
      makeCmdStep(tA - 500, tA),
      makeEditStep([1, 2, 3, 4], tA + 10_000, tA + 11_000),
    ],
  });
  const unicodeNote = priorAttemptsNote(
    smallRecords,
    completeCoverage(2),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([unicodeCard]), platform: "linux" },
  );
  assert.ok(unicodeNote);
  assert.match(unicodeNote.text, /^[\x20-\x7e]*$/);
  assert.ok(unicodeNote.text.includes("src/caf?/a.ts"));
  // Capped at max 3 paths per clause.
  assert.equal(unicodeNote.text.includes("src/d.ts"), false);

  // Verify file clauses drop entries first, then whole clauses when single paths still exceed budget.
  const hugePath = `src/${"segment-".repeat(45)}file.ts`;
  const hugeCard = makeCard("card-drop-clause", {
    started_ms: tA - 5_000,
    ended_ms: tB + 5_000,
    blocks: [makeBlock(1, hugePath)],
    flow: [
      makeCmdStep(tA - 500, tA),
      makeEditStep([1], tA + 10_000, tA + 11_000),
    ],
  });
  const droppedClause = priorAttemptsNote(
    smallRecords,
    completeCoverage(2),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([hugeCard]), platform: "linux" },
  );
  assert.ok(droppedClause);
  assert.ok(droppedClause.bytes <= ATTEMPT_NOTE_MAX_BYTES);
  assert.equal(droppedClause.text.includes("Files edited"), false);
  assert.ok(droppedClause.text.endsWith(`Rocky records order, not cause. More: rocky attempts ${fp}`));
});

test("never includes stated text or expectations", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const t1 = REF_NOW - 2 * HOUR_MS;
  const t2 = REF_NOW - HOUR_MS;

  const f1 = makeFailure({ id: "f1", ts: t1, fingerprint: fp, excerpt: "SECRET_ERROR_TEXT" });
  const f2 = makeFailure({ id: "f2", ts: t2, fingerprint: fp, excerpt: "SECRET_ERROR_TEXT" });
  const rationale: RationaleRecord = {
    kind: "rationale",
    id: "r1",
    ts: t1 + 10_000,
    v: 1,
    cwd: "/app",
    agent: "claude-code",
    rationale_fidelity: "raw",
    source: "mcp",
    excerpt: "SECRET_STATED",
    expectedCommand: "SECRET_EXPECTATION",
    links: { failureId: "f1" },
    files: ["src/testimony-file.ts"],
  };

  const cardWithQuotes = makeCard("card-stated", {
    started_ms: t1 - 5_000,
    ended_ms: t2 + 5_000,
    blocks: [makeBlock(1, "src/observed.ts", { quote: { text: "SECRET_QUOTE", shared: false } })],
    flow: [
      makeCmdStep(t1 - 500, t1, { desc: "SECRET_DESC_1" }),
      makeEditStep([1], t1 + 10_000, t1 + 11_000),
      makeCmdStep(t2 - 500, t2, { desc: "SECRET_DESC_2" }),
    ],
  });

  const records: MemoryRecord[] = [f1, rationale, f2];
  const withCards = priorAttemptsNote(
    records,
    completeCoverage(records.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([cardWithQuotes]), platform: "linux" },
  );
  assert.ok(withCards);
  for (const forbidden of [
    "SECRET_STATED",
    "SECRET_EXPECTATION",
    "SECRET_QUOTE",
    "SECRET_DESC_1",
    "SECRET_DESC_2",
    "SECRET_ERROR_TEXT",
  ]) {
    assert.equal(withCards.text.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.ok(withCards.text.includes("src/observed.ts"));
  assert.equal(withCards.text.includes("src/testimony-file.ts"), false);

  // With cardsFor returning empty cards, testimony paths never enter the note and no file clause renders.
  const withTestimonyFiles = priorAttemptsNote(
    records,
    completeCoverage(records.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([]), platform: "linux" },
  );
  assert.ok(withTestimonyFiles);
  assert.equal(withTestimonyFiles.text.includes("SECRET_STATED"), false);
  assert.equal(withTestimonyFiles.text.includes("SECRET_EXPECTATION"), false);
  assert.equal(withTestimonyFiles.text.includes("src/testimony-file.ts"), false);
  assert.equal(withTestimonyFiles.text.includes("Files edited"), false);

  // With cardsFor: undefined, file clauses are omitted even when rationale files exist.
  const withoutCardsFor = priorAttemptsNote(
    records,
    completeCoverage(records.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(withoutCardsFor);
  assert.equal(withoutCardsFor.text.includes("Files edited"), false);
  assert.equal(withoutCardsFor.text.includes("src/testimony-file.ts"), false);
});

test("template strings have no causal words", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const variants: string[] = [];

  // 1. Full reference variant (plural times, 2 same_failure, 1 different_failure, 1 passed, both file clauses).
  const ref = buildReferenceScenario(fp);
  const refNote = priorAttemptsNote(
    ref.records,
    completeCoverage(ref.records.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning(ref.cards), platform: "linux" },
  );
  assert.ok(refNote);
  variants.push(refNote.text);

  // 2. Without file clauses.
  const noFilesNote = priorAttemptsNote(
    ref.records,
    completeCoverage(ref.records.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(noFilesNote);
  variants.push(noFilesNote.text);

  // 3. Singular attempt with no_later_run (no After clause).
  const t1 = REF_NOW - 4 * HOUR_MS;
  const singleNoLater = priorAttemptsNote(
    [makeFailure({ id: "v3-1", ts: t1, fingerprint: fp })],
    completeCoverage(1),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(singleNoLater);
  variants.push(singleNoLater.text);

  // 4. Singular attempt with different_failure.
  const singleDiff = priorAttemptsNote(
    [
      makeFailure({ id: "v4-1", ts: t1, fingerprint: fp }),
      makeFailure({ id: "v4-2", ts: t1 + MIN_MS, fingerprint: "dddd000000000004" }),
    ],
    completeCoverage(2),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(singleDiff);
  variants.push(singleDiff.text);

  // 5. Singular same-way failure with file clause and no passed clause.
  const singularSameCard = makeCard("card-v5", {
    started_ms: t1 - 5_000,
    ended_ms: t1 + 20 * MIN_MS,
    blocks: [makeBlock(1, "src/one.ts")],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 60_000, t1 + 61_000),
    ],
  });
  const singularSame = priorAttemptsNote(
    [
      makeFailure({ id: "v5-1", ts: t1, fingerprint: fp }),
      makeFailure({ id: "v5-2", ts: t1 + 10 * MIN_MS, fingerprint: fp }),
    ],
    completeCoverage(2),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([singularSameCard]), platform: "linux" },
  );
  assert.ok(singularSame);
  variants.push(singularSame.text);

  // 6. Multiple passed reruns with passing file clause (plural passing reruns) + one no_later_run.
  const fixA = makeFix({ id: "v6-xa", ts: t1 + 5 * MIN_MS, failureIds: ["v6-1"] });
  const fixB = makeFix({ id: "v6-xb", ts: t1 + 25 * MIN_MS, failureIds: ["v6-2"] });
  const multiPassCard = makeCard("card-v6", {
    started_ms: t1 - 5_000,
    ended_ms: t1 + 40 * MIN_MS,
    blocks: [makeBlock(1, "src/a.ts"), makeBlock(2, "src/b.ts")],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 60_000, t1 + 61_000),
      makeCmdStep(t1 + 20 * MIN_MS - 500, t1 + 20 * MIN_MS),
      makeEditStep([2], t1 + 21 * MIN_MS, t1 + 21 * MIN_MS + 1_000),
    ],
  });
  const multiPass = priorAttemptsNote(
    [
      makeFailure({ id: "v6-1", ts: t1, fingerprint: fp, resolvedBy: fixA.id }),
      fixA,
      makeFailure({ id: "v6-2", ts: t1 + 20 * MIN_MS, fingerprint: fp, resolvedBy: fixB.id }),
      fixB,
      makeFailure({ id: "v6-3", ts: t1 + 30 * MIN_MS, fingerprint: fp }),
    ],
    completeCoverage(5),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([multiPassCard]), platform: "linux" },
  );
  assert.ok(multiPass);
  variants.push(multiPass.text);

  // 7. Possible pass variant (singular and plural).
  const onePossiblePass = priorAttemptsNote(
    [
      makeFailure({ id: "v7-1", ts: t1, fingerprint: fp }),
      makeAssociation({ id: "v7-a1", ts: t1 + 5 * MIN_MS, candidateFailureIds: ["v7-1"] }),
    ],
    completeCoverage(2),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(onePossiblePass);
  variants.push(onePossiblePass.text);

  const twoPossiblePasses = priorAttemptsNote(
    [
      makeFailure({ id: "v7b-1", ts: t1, fingerprint: fp }),
      makeAssociation({ id: "v7b-a1", ts: t1 + 5 * MIN_MS, candidateFailureIds: ["v7b-1"] }),
      makeFailure({ id: "v7b-2", ts: t1 + 9 * HOUR_MS, fingerprint: fp }),
      makeAssociation({ id: "v7b-a2", ts: t1 + 9 * HOUR_MS + 5 * MIN_MS, candidateFailureIds: ["v7b-2"] }),
    ],
    completeCoverage(4),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW + 12 * HOUR_MS, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(twoPossiblePasses);
  variants.push(twoPossiblePasses.text);

  // 8. "After the last 5 runs:" variant (7 attempts).
  const sevenRecords: MemoryRecord[] = Array.from({ length: 7 }, (_, i) =>
    makeFailure({ id: `v8-${i}`, ts: t1 + i * 5 * MIN_MS, fingerprint: fp }),
  );
  const lastFive = priorAttemptsNote(
    sevenRecords,
    completeCoverage(sevenRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(lastFive);
  assert.match(lastFive.text, /After the last 5 runs:/);
  variants.push(lastFive.text);

  // 9. Incomplete-coverage (bounded tail) header variant.
  const tailCoverage: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    scanned: 10_000,
    skipped: 0,
    truncated: 1,
    bytesScanned: 100_000,
    bytesTotal: 200_000,
    complete: false,
    reason: "record-cap",
    window: "tail",
    startOffset: 100_000,
    oldestTs: t1 - HOUR_MS,
  };
  const partialHeader = priorAttemptsNote(
    ref.records,
    tailCoverage,
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning(ref.cards), platform: "linux" },
  );
  assert.ok(partialHeader);
  assert.match(partialHeader.text, /in the records read \(earliest read 2026-11-12\)\./);
  variants.push(partialHeader.text);

  assert.equal(variants.length, 10);
  assert.deepEqual(causalWordViolations(variants), []);
});

test("discloses incomplete coverage in the header while preserving complete coverage byte for byte", () => {
  const fp = "aaaa000000000014";
  const tailNow = 1_700_000_000_000; // 2023-11-14 22:13 UTC
  const tailTs = 1_699_999_940_000; // 2023-11-14 22:12 UTC
  const tailCoverage: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    scanned: 10_000,
    skipped: 0,
    truncated: 1,
    bytesScanned: 100_000,
    bytesTotal: 200_000,
    complete: false,
    reason: "record-cap",
    window: "tail",
    startOffset: 100_000,
    oldestTs: 1_699_990_000_000,
  };
  const tailRecord = makeFailure({
    id: "f1",
    ts: tailTs,
    fingerprint: fp,
    signature: ["error: tail entry"],
    excerpt: "Error: tail entry",
  });

  // Bounded-tail fixture (singular): header qualifies count and earliest read date.
  const tailNote = priorAttemptsNote(
    [tailRecord],
    tailCoverage,
    { fingerprints: [fp], cwd: "/app" },
    { now: tailNow, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(tailNote);
  assert.equal(
    tailNote.text,
    `rocky: Same error recorded 1 time before in this directory in the records read (earliest read 2023-11-14). ` +
      `Rocky records order, not cause. More: rocky attempts ${fp}`,
  );

  // Bounded-tail fixture (plural) and skipped-lines coverage also qualify the header.
  const refFp = "3f2a9c1e44d0b7a1";
  const { records, cards } = buildReferenceScenario(refFp);
  const skippedCoverage: MemoryCoverage = {
    ...completeCoverage(records.length),
    skipped: 2,
    complete: false,
  };
  const skippedNote = priorAttemptsNote(
    records,
    skippedCoverage,
    { fingerprints: [refFp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning(cards), platform: "linux" },
  );
  assert.ok(skippedNote);
  assert.equal(
    skippedNote.text,
    `rocky: Same error recorded 4 times before in this directory in the records read (earliest read 2026-11-12). ` +
      `After those runs: 2 reruns failed the same way, 1 failed with another error, 1 passed (2026-11-12 14:03). ` +
      `Files edited before the passing rerun: src/session.ts. ` +
      `Files edited before the same-way failures: src/auth.ts (2). ` +
      `Rocky records order, not cause. More: rocky attempts ${refFp}`,
  );

  // Complete coverage keeps the reference sentence byte for byte.
  const completeNote = priorAttemptsNote(
    records,
    completeCoverage(records.length),
    { fingerprints: [refFp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning(cards), platform: "linux" },
  );
  assert.ok(completeNote);
  assert.equal(
    completeNote.text,
    `rocky: Same error recorded 4 times before in this directory (first 2026-11-12). ` +
      `After those runs: 2 reruns failed the same way, 1 failed with another error, 1 passed (2026-11-12 14:03). ` +
      `Files edited before the passing rerun: src/session.ts. ` +
      `Files edited before the same-way failures: src/auth.ts (2). ` +
      `Rocky records order, not cause. More: rocky attempts ${refFp}`,
  );
});

test("counts distinct non-ASCII paths separately when ASCII renderings collide", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const t1 = REF_NOW - 3 * HOUR_MS;
  const t2 = REF_NOW - 2 * HOUR_MS;
  const t3 = REF_NOW - HOUR_MS;
  const t4 = REF_NOW - 30 * MIN_MS;

  // Two distinct paths (café vs cafè) share the ASCII display "src/caf?.ts": must not collapse to "(2)".
  const twoDistinctRecords: MemoryRecord[] = [
    makeFailure({ id: "c1", ts: t1, fingerprint: fp }),
    makeFailure({ id: "c2", ts: t2, fingerprint: fp }),
    makeFailure({ id: "c3", ts: t3, fingerprint: fp }),
  ];
  const collidingCard = makeCard("card-collide", {
    started_ms: t1 - 5_000,
    ended_ms: t3 + 5_000,
    blocks: [
      makeBlock(1, "src/café.ts"),
      makeBlock(2, "src/cafè.ts"),
    ],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 10_000, t1 + 11_000),
      makeCmdStep(t2 - 500, t2),
      makeEditStep([2], t2 + 10_000, t2 + 11_000),
      makeCmdStep(t3 - 500, t3),
    ],
  });
  const noteTwoDistinct = priorAttemptsNote(
    twoDistinctRecords,
    completeCoverage(twoDistinctRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([collidingCard]), platform: "linux" },
  );
  assert.ok(noteTwoDistinct);
  assert.match(noteTwoDistinct.text, /^[\x20-\x7e]*$/);
  assert.equal(noteTwoDistinct.text.includes("src/caf?.ts (2)"), false);
  assert.ok(
    noteTwoDistinct.text.includes("Files edited before the same-way failures: src/caf?.ts, src/caf?.ts."),
    `unexpected text: ${noteTwoDistinct.text}`,
  );

  // Repeated edits to café (x2) plus one edit to cafè (x1) keep separate counts: "(2)" and uncounted.
  const mixedRecords: MemoryRecord[] = [
    ...twoDistinctRecords,
    makeFailure({ id: "c4", ts: t4, fingerprint: fp }),
  ];
  const mixedCard = makeCard("card-collide-mixed", {
    started_ms: t1 - 5_000,
    ended_ms: t4 + 5_000,
    blocks: [
      makeBlock(1, "src/café.ts"),
      makeBlock(2, "src/cafè.ts"),
      makeBlock(3, "src/café.ts"),
    ],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 10_000, t1 + 11_000),
      makeCmdStep(t2 - 500, t2),
      makeEditStep([2], t2 + 10_000, t2 + 11_000),
      makeCmdStep(t3 - 500, t3),
      makeEditStep([3], t3 + 10_000, t3 + 11_000),
      makeCmdStep(t4 - 500, t4),
    ],
  });
  const noteMixed = priorAttemptsNote(
    mixedRecords,
    completeCoverage(mixedRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([mixedCard]), platform: "linux" },
  );
  assert.ok(noteMixed);
  assert.ok(
    noteMixed.text.includes("Files edited before the same-way failures: src/caf?.ts (2), src/caf?.ts."),
    `unexpected text: ${noteMixed.text}`,
  );
});

test("keeps paths differing by invisible controls separate instead of collapsing to (2)", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const t1 = REF_NOW - 3 * HOUR_MS;
  const t2 = REF_NOW - 2 * HOUR_MS;
  const t3 = REF_NOW - HOUR_MS;

  const sameWayRecords: MemoryRecord[] = [
    makeFailure({ id: "zw1", ts: t1, fingerprint: fp }),
    makeFailure({ id: "zw2", ts: t2, fingerprint: fp }),
    makeFailure({ id: "zw3", ts: t3, fingerprint: fp }),
  ];
  const sameWayCard = makeCard("card-zw-same", {
    started_ms: t1 - 5_000,
    ended_ms: t3 + 5_000,
    blocks: [
      makeBlock(1, "src/a.ts"),
      makeBlock(2, "src/a\u200b.ts"),
    ],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 10_000, t1 + 11_000),
      makeCmdStep(t2 - 500, t2),
      makeEditStep([2], t2 + 10_000, t2 + 11_000),
      makeCmdStep(t3 - 500, t3),
    ],
  });

  const sameWayNote = priorAttemptsNote(
    sameWayRecords,
    completeCoverage(sameWayRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([sameWayCard]), platform: "linux" },
  );
  assert.ok(sameWayNote);
  assert.match(sameWayNote.text, /^[\x20-\x7e]*$/);
  assert.equal(sameWayNote.text.includes("src/a.ts (2)"), false);
  assert.ok(
    sameWayNote.text.includes("Files edited before the same-way failures: src/a.ts, src/a.ts."),
    `unexpected text: ${sameWayNote.text}`,
  );

  // Passing-rerun clause also keys by raw path identity, not sanitized display text.
  const fix1 = makeFix({ id: "zw-x1", ts: t1 + 5 * MIN_MS, failureIds: ["zw-p1"] });
  const fix2 = makeFix({ id: "zw-x2", ts: t2 + 5 * MIN_MS, failureIds: ["zw-p2"] });
  const passRecords: MemoryRecord[] = [
    makeFailure({ id: "zw-p1", ts: t1, fingerprint: fp, resolvedBy: fix1.id }),
    fix1,
    makeFailure({ id: "zw-p2", ts: t2, fingerprint: fp, resolvedBy: fix2.id }),
    fix2,
    makeFailure({ id: "zw-p3", ts: t3, fingerprint: fp }),
  ];
  const passCard = makeCard("card-zw-pass", {
    started_ms: t1 - 5_000,
    ended_ms: t3 + 5_000,
    blocks: [
      makeBlock(1, "src/a.ts"),
      makeBlock(2, "src/a\u200b.ts"),
    ],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 10_000, t1 + 11_000),
      makeCmdStep(t2 - 500, t2),
      makeEditStep([2], t2 + 10_000, t2 + 11_000),
      makeCmdStep(t3 - 500, t3),
    ],
  });

  const passNote = priorAttemptsNote(
    passRecords,
    completeCoverage(passRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([passCard]), platform: "linux" },
  );
  assert.ok(passNote);
  assert.match(passNote.text, /^[\x20-\x7e]*$/);
  assert.equal(passNote.text.includes("src/a.ts (2)"), false);
  assert.ok(
    passNote.text.includes("Files edited before the passing reruns: src/a.ts, src/a.ts."),
    `unexpected text: ${passNote.text}`,
  );
});

test("keeps paths differing by trailing non-breaking space separate instead of collapsing to (2)", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const t1 = REF_NOW - 3 * HOUR_MS;
  const t2 = REF_NOW - 2 * HOUR_MS;
  const t3 = REF_NOW - HOUR_MS;

  const sameWayRecords: MemoryRecord[] = [
    makeFailure({ id: "nbsp1", ts: t1, fingerprint: fp }),
    makeFailure({ id: "nbsp2", ts: t2, fingerprint: fp }),
    makeFailure({ id: "nbsp3", ts: t3, fingerprint: fp }),
  ];
  const sameWayCard = makeCard("card-nbsp-same", {
    started_ms: t1 - 5_000,
    ended_ms: t3 + 5_000,
    blocks: [
      makeBlock(1, "src/result.ts"),
      makeBlock(2, "src/result.ts\u00a0"),
    ],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 10_000, t1 + 11_000),
      makeCmdStep(t2 - 500, t2),
      makeEditStep([2], t2 + 10_000, t2 + 11_000),
      makeCmdStep(t3 - 500, t3),
    ],
  });

  const sameWayNote = priorAttemptsNote(
    sameWayRecords,
    completeCoverage(sameWayRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([sameWayCard]), platform: "linux" },
  );
  assert.ok(sameWayNote);
  assert.match(sameWayNote.text, /^[\x20-\x7e]*$/);
  assert.equal(sameWayNote.text.includes("(2)"), false);
  assert.ok(
    sameWayNote.text.includes("Files edited before the same-way failures: src/result.ts?, src/result.ts."),
    `unexpected text: ${sameWayNote.text}`,
  );

  // Passing-rerun clause also preserves both identities separately.
  const fix1 = makeFix({ id: "nbsp-x1", ts: t1 + 5 * MIN_MS, failureIds: ["nbsp-p1"] });
  const fix2 = makeFix({ id: "nbsp-x2", ts: t2 + 5 * MIN_MS, failureIds: ["nbsp-p2"] });
  const passRecords: MemoryRecord[] = [
    makeFailure({ id: "nbsp-p1", ts: t1, fingerprint: fp, resolvedBy: fix1.id }),
    fix1,
    makeFailure({ id: "nbsp-p2", ts: t2, fingerprint: fp, resolvedBy: fix2.id }),
    fix2,
    makeFailure({ id: "nbsp-p3", ts: t3, fingerprint: fp }),
  ];
  const passCard = makeCard("card-nbsp-pass", {
    started_ms: t1 - 5_000,
    ended_ms: t3 + 5_000,
    blocks: [
      makeBlock(1, "src/result.ts"),
      makeBlock(2, "src/result.ts\u00a0"),
    ],
    flow: [
      makeCmdStep(t1 - 500, t1),
      makeEditStep([1], t1 + 10_000, t1 + 11_000),
      makeCmdStep(t2 - 500, t2),
      makeEditStep([2], t2 + 10_000, t2 + 11_000),
      makeCmdStep(t3 - 500, t3),
    ],
  });

  const passNote = priorAttemptsNote(
    passRecords,
    completeCoverage(passRecords.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: REF_NOW, cardsFor: cardsReturning([passCard]), platform: "linux" },
  );
  assert.ok(passNote);
  assert.match(passNote.text, /^[\x20-\x7e]*$/);
  assert.equal(passNote.text.includes("(2)"), false);
  assert.ok(
    passNote.text.includes("Files edited before the passing reruns: src/result.ts?, src/result.ts."),
    `unexpected text: ${passNote.text}`,
  );
});

test("computes from the snapshot before the current failure", () => {
  const fp = "3f2a9c1e44d0b7a1";
  const t1 = REF_NOW - 30 * MIN_MS;
  const t2 = REF_NOW - 15 * MIN_MS;
  const tCurrent = REF_NOW;

  const snapshotBefore: readonly MemoryRecord[] = [
    makeFailure({ id: "p1", ts: t1, fingerprint: fp }),
    makeFailure({ id: "p2", ts: t2, fingerprint: fp }),
  ];
  const beforeJson = JSON.stringify(snapshotBefore);

  const noteBefore = priorAttemptsNote(
    snapshotBefore,
    completeCoverage(snapshotBefore.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: tCurrent, cardsFor: undefined, platform: "linux" },
  );

  assert.ok(noteBefore);
  assert.match(noteBefore.text, /Same error recorded 2 times before in this directory/);
  assert.equal(JSON.stringify(snapshotBefore), beforeJson);

  // Appending the current failure separately does not change the pre-append snapshot result.
  const currentFailure = makeFailure({ id: "p-current", ts: tCurrent, fingerprint: fp });
  const withCurrentAppended: readonly MemoryRecord[] = [...snapshotBefore, currentFailure];
  const noteFromBeforeAgain = priorAttemptsNote(
    snapshotBefore,
    completeCoverage(snapshotBefore.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: tCurrent, cardsFor: undefined, platform: "linux" },
  );
  assert.deepEqual(noteFromBeforeAgain, noteBefore);

  // Passing a post-append snapshot would count the current failure (proving N comes strictly from records).
  const noteIfPostAppend = priorAttemptsNote(
    withCurrentAppended,
    completeCoverage(withCurrentAppended.length),
    { fingerprints: [fp], cwd: "/app" },
    { now: tCurrent, cardsFor: undefined, platform: "linux" },
  );
  assert.ok(noteIfPostAppend);
  assert.match(noteIfPostAppend.text, /Same error recorded 3 times before in this directory/);
});
