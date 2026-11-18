import { test } from "node:test";
import assert from "node:assert/strict";
import { ageLabel, renderCardTeach, renderLadderCard, renderLadderExpanded, renderWitnessCard } from "../core/teach-render.js";
import type { ExplainRecord } from "../core/memory-read.js";
import type { TeachHit } from "../core/teach.js";
import type { CardTeachHit } from "../core/teach-cards.js";
import type { LadderResult } from "../core/teach-ladder.js";
import type { StoredBlock, StoredCard } from "../desk/cards-read.js";
import { validateOutputLine } from "../ui/phrases.js";

const WITNESS_HEADER = "Witnessed: an agent stated why, and rocky recorded it.";
const LADDER_HEADER = "Assembled from evidence, not witnessed.";

function explainRecord(overrides: Partial<ExplainRecord> = {}): ExplainRecord {
  return {
    kind: "explain",
    id: "e1",
    ts: Date.now() - 2 * 3_600_000 - 600_000,
    v: 1,
    cwd: "/work",
    path: "src/save.ts",
    source: "agent:claude-code",
    code: "callback because path computed inside helper",
    business: "reclaim keeps lock ownership",
    ...overrides,
  };
}

function witnessHit(overrides: Partial<ExplainRecord> = {}): TeachHit {
  return { record: explainRecord(overrides), match: "hash", score: 1 };
}

const LADDER: LadderResult = {
  rungs: [
    { source: "catalog", finding: "async because await used at line 4" },
    { source: "ast", finding: "inside syncAll; called with item" },
    { source: "def", finding: "callee persist defined at line 12" },
    { source: "comment", finding: 'nearest comment "No litter"' },
  ],
  stopReason: "evidence-exhausted",
  provenanceExhausted: false,
};

test("witness header is byte exact", () => {
  const card = renderWitnessCard(witnessHit());
  assert.equal(card.header, WITNESS_HEADER);
});

test("witness evidence line carries source and age", () => {
  const card = renderWitnessCard(witnessHit());
  assert.equal(card.evidence, "source: agent:claude-code · 2h ago · unknown");
});

test("witness body is code then business, no gap line without gap rung", () => {
  const card = renderWitnessCard(witnessHit());
  assert.deepEqual(card.lines, [
    "code: callback because path computed inside helper",
    "business: reclaim keeps lock ownership",
  ]);
  assert.equal(card.expandable, false);
});

test("witness gap rung renders on its own line with ast suffix", () => {
  const card = renderWitnessCard(witnessHit(), { source: "ast", finding: "inside saveAll; called with x" });
  assert.deepEqual(card.lines, [
    "code: callback because path computed inside helper",
    "business: reclaim keeps lock ownership",
    "form: inside saveAll; called with x · ast",
  ]);
});

test("witness gap catalog rung renders with catalog suffix", () => {
  const card = renderWitnessCard(witnessHit(), { source: "catalog", finding: "async because await used at line 4" });
  assert.equal(card.lines[2], "form: async because await used at line 4 · catalog");
});

test("ladder header is byte exact", () => {
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", LADDER);
  assert.equal(card.header, LADDER_HEADER);
});

test("ladder card leads with file · label title line", () => {
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", LADDER);
  assert.equal(card.lines[0], "memory.ts · reclaimTriplePath return");
});

test("ladder body is one reason line, findings joined in hop order", () => {
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", LADDER);
  assert.equal(
    card.lines[1],
    'reason: async because await used at line 4. inside syncAll; called with item. callee persist defined at line 12. nearest comment "No litter"',
  );
});

test("ladder evidence line lists exactly the sources used with comment quoted", () => {
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", LADDER);
  assert.equal(card.evidence, 'evidence: catalog · ast · def · comment "No litter" · evidence-exhausted');
});

test("ladder evidence deduplicates sources in hop order", () => {
  const ladder: LadderResult = {
    rungs: [
      { source: "def", finding: "callee persist defined at line 12" },
      { source: "ast", finding: "inside syncAll" },
      { source: "def", finding: "callee persist defined at line 12" },
      { source: "comment", finding: 'nearest comment "A"' },
      { source: "comment", finding: 'nearest comment "A"' },
    ],
    stopReason: "evidence-exhausted",
    provenanceExhausted: false,
  };
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", ladder);
  assert.equal(card.evidence, 'evidence: def · ast · comment "A" · evidence-exhausted');
});

test("ladder card is expandable when rungs exist", () => {
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", LADDER);
  assert.equal(card.expandable, true);
});

test("renderLadderExpanded is one line per rung, 1-based hop, two spaces", () => {
  assert.deepEqual(renderLadderExpanded(LADDER), [
    "why 1  async because await used at line 4 · catalog",
    "why 2  inside syncAll; called with item · ast",
    "why 3  callee persist defined at line 12 · def",
    'why 4  nearest comment "No litter" · comment',
  ]);
});

test("empty ladder yields no reason line and is not expandable", () => {
  const empty: LadderResult = { rungs: [], stopReason: "evidence-exhausted", provenanceExhausted: false };
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", empty);
  assert.deepEqual(card.lines, ["memory.ts · reclaimTriplePath return"]);
  assert.equal(card.evidence, "evidence:  · evidence-exhausted");
  assert.equal(card.expandable, false);
  assert.deepEqual(renderLadderExpanded(empty), []);
});

test("output is deterministic for identical input", () => {
  const hit = witnessHit();
  const a = renderWitnessCard(hit);
  const b = renderWitnessCard(hit);
  assert.deepEqual(a, b);
  const ladderA = renderLadderCard("memory.ts", "reclaimTriplePath return", LADDER);
  const ladderB = renderLadderCard("memory.ts", "reclaimTriplePath return", LADDER);
  assert.deepEqual(ladderA, ladderB);
  assert.deepEqual(renderLadderExpanded(LADDER), renderLadderExpanded(LADDER));
});

test("age floors at minute, hour, and day boundaries", () => {
  const now = 1_800_000_000_000;
  assert.equal(ageLabel(now - 30_000, now), "0m ago");
  assert.equal(ageLabel(now - 90_000, now), "1m ago");
  assert.equal(ageLabel(now - 2.9 * 3_600_000, now), "2h ago");
  assert.equal(ageLabel(now - 23 * 3_600_000, now), "23h ago");
  assert.equal(ageLabel(now - 86_400_000, now), "1d ago");
  assert.equal(ageLabel(now - 3 * 86_400_000, now), "3d ago");
});

test("ladder evidence appends stop reason", () => {
  const card = renderLadderCard("a.ts", "x", {
    rungs: [{ source: "git", finding: "first touched in abc1234: add x" }],
    stopReason: "evidence-exhausted",
    provenanceExhausted: false,
  });
  assert.match(card.evidence, /evidence-exhausted/);
});

test("exhausted provenance adds a disclosure line in english", () => {
  const disclosure = "No git history found for these lines. Other evidence stays above.";
  const card = renderLadderCard("a.ts", "x", {
    rungs: [{ source: "catalog", finding: "awaits a promise" }],
    stopReason: "evidence-exhausted",
    provenanceExhausted: true,
  });
  assert.ok(card.lines.includes(disclosure));
  assert.deepEqual(validateOutputLine(disclosure), []);
  assert.doesNotMatch(card.lines.join("\n"), /asal usul|di atas/);
});

test("witness card with zero pointers marks unknown", () => {
  const card = renderWitnessCard(witnessHit(), undefined);
  assert.match(card.evidence, /source: /);
});

const CAUSAL_WORDS = /\b(?:because|so that|in order to|to ensure|fixed|resolved)\b/i;

function makeCard(overrides: Partial<StoredCard> = {}): StoredCard {
  return {
    v: 1,
    card_id: "c1",
    rev: 1,
    root: "/work",
    started_ms: Date.UTC(2026, 10, 18, 9, 30, 0),
    ended_ms: Date.UTC(2026, 10, 18, 9, 35, 0),
    agent_type: "claude-code",
    prompt: "Add guard for empty token",
    blocks: [],
    ...overrides,
  };
}

const HASH_A = "0123456789abcdef".repeat(4);
const HASH_B = "fedcba9876543210".repeat(4);

function makeBlock(overrides: Partial<StoredBlock> = {}): StoredBlock {
  return {
    seq: 1,
    path: "src/auth.ts",
    symbol: { kind: "function", name: "verifyToken" },
    labels: [{ id: "guard_added" }, { id: "call_added", args: { name: "reject" } }],
    importance: "high",
    before: HASH_A,
    after: HASH_B,
    quote: { text: "Checking empty tokens upfront.", shared: true },
    ...overrides,
  };
}

function cardHit(
  overrides: {
    card?: Partial<StoredCard>;
    block?: Partial<StoredBlock>;
    match?: CardTeachHit["match"];
  } = {},
): CardTeachHit {
  const block = makeBlock(overrides.block);
  const card = makeCard({ blocks: [block], ...overrides.card });
  return {
    card,
    block,
    match: overrides.match ?? "symbol",
  };
}

test("renderCardTeach renders full hit with prompt, labels, quote, and match line", () => {
  const rendered = renderCardTeach(cardHit({ match: "symbol" }));
  assert.equal(rendered.header, "verifyToken, changed by claude-code on 2026-11-18 (from change card)");
  assert.deepEqual(rendered.lines, [
    'Asked: "Add guard for empty token"',
    "Changed: new guard, calls reject",
    'Agent said: "Checking empty tokens upfront."',
    "Matched by function name; code not compared.",
  ]);
  assert.equal(rendered.evidence, "Recorded, not verified.");
  assert.equal(rendered.expandable, false);
});

test("renderCardTeach uses fallback line when quote is missing", () => {
  const rendered = renderCardTeach(cardHit({ block: { quote: undefined } }));
  assert.equal(rendered.lines[2], "No agent words recorded for this edit.");
});

test("renderCardTeach appends code-not-compared notice for symbol, line, and file matches", () => {
  const symbolRendered = renderCardTeach(cardHit({ match: "symbol" }));
  assert.equal(
    symbolRendered.lines[symbolRendered.lines.length - 1],
    "Matched by function name; code not compared.",
  );

  const lineRendered = renderCardTeach(cardHit({ match: "line" }));
  assert.equal(
    lineRendered.lines[lineRendered.lines.length - 1],
    "Matched by line; code not compared.",
  );

  const fileRendered = renderCardTeach(cardHit({ match: "file" }));
  assert.equal(
    fileRendered.lines[fileRendered.lines.length - 1],
    "Matched by file; code not compared.",
  );
});

test("renderCardTeach omits the date when started_ms is out of range (MAX_SAFE_INTEGER) and never throws", () => {
  const maxSafeRendered = renderCardTeach(cardHit({ card: { started_ms: Number.MAX_SAFE_INTEGER } }));
  assert.equal(maxSafeRendered.header, "verifyToken, changed by claude-code (from change card)");

  const edgeDateRendered = renderCardTeach(cardHit({ card: { started_ms: 8.64e15 } }));
  assert.equal(edgeDateRendered.header, "verifyToken, changed by claude-code (from change card)");

  const nanRendered = renderCardTeach(cardHit({ card: { started_ms: Number.NaN } }));
  assert.equal(nanRendered.header, "verifyToken, changed by claude-code (from change card)");
});

test("renderCardTeach falls back to path and generic agent when symbol and agent_type are absent", () => {
  const rendered = renderCardTeach(
    cardHit({
      card: { agent_type: undefined },
      block: { symbol: undefined, labels: [{ id: "symbol_added" }] },
    }),
  );
  assert.ok(rendered.header.startsWith("src/auth.ts, changed by an agent on "));
  assert.equal(rendered.header, "src/auth.ts, changed by an agent on 2026-11-18 (from change card)");
  assert.equal(rendered.lines[1], "Changed: new file");
});

test("renderCardTeach omits Asked and Changed lines when prompt and labels are empty", () => {
  const rendered = renderCardTeach(
    cardHit({
      card: { prompt: "   " },
      block: { labels: [], quote: null },
      match: "line",
    }),
  );
  assert.deepEqual(rendered.lines, [
    "No agent words recorded for this edit.",
    "Matched by line; code not compared.",
  ]);
});

test("renderCardTeach rocky-written lines contain no causal words and pass output validation", () => {
  const cases: CardTeachHit[] = [
    cardHit({ match: "symbol" }),
    cardHit({ match: "line" }),
    cardHit({ match: "file" }),
    cardHit({
      card: { agent_type: undefined, prompt: "", started_ms: Number.MAX_SAFE_INTEGER },
      block: { symbol: undefined, labels: [], quote: undefined },
      match: "symbol",
    }),
  ];
  for (const hit of cases) {
    const rendered = renderCardTeach(hit);
    const rockyLines = [rendered.header, ...rendered.lines, rendered.evidence];
    for (const line of rockyLines) {
      assert.doesNotMatch(line, CAUSAL_WORDS);
      assert.deepEqual(validateOutputLine(line), []);
    }
  }
});

test("renderCardTeach adds Sequence line after Changed only when hit block seq is in edit_seqs", () => {
  const block1 = makeBlock({ seq: 1, path: "src/auth.ts" });
  const block2 = makeBlock({ seq: 2, path: "src/other.ts", symbol: null });
  const seq = {
    pattern: "fix_after_fail" as const,
    command: "npm test",
    exit_code: 1,
    edit_seqs: [1],
    error_names: "auth.ts",
  };

  const hitInSeq = renderCardTeach({
    card: makeCard({ blocks: [block1, block2], sequence: seq }),
    block: block1,
    match: "symbol",
  });
  assert.deepEqual(hitInSeq.lines, [
    'Asked: "Add guard for empty token"',
    "Changed: new guard, calls reject",
    "Sequence: `npm test` failed (exit 1). The error names auth.ts. Edited src/auth.ts \u203a verifyToken(). `npm test` passed.",
    'Agent said: "Checking empty tokens upfront."',
    "Matched by function name; code not compared.",
  ]);
  for (const line of [hitInSeq.header, ...hitInSeq.lines, hitInSeq.evidence]) {
    assert.doesNotMatch(line, CAUSAL_WORDS);
    assert.deepEqual(validateOutputLine(line), []);
  }

  const hitNotInSeq = renderCardTeach({
    card: makeCard({ blocks: [block1, block2], sequence: seq }),
    block: block2,
    match: "file",
  });
  assert.equal(hitNotInSeq.lines.some((line) => line.startsWith("Sequence:")), false);
});
