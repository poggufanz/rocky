import { test } from "node:test";
import assert from "node:assert/strict";
import { ageLabel, renderLadderCard, renderLadderExpanded, renderWitnessCard } from "../core/teach-render.js";
import type { ExplainRecord } from "../core/memory-read.js";
import type { TeachHit } from "../core/teach.js";
import type { LadderResult } from "../core/teach-ladder.js";

const WITNESS_HEADER = "rocky heard this. agent say why, rocky remember";
const LADDER_HEADER = "rocky not hear this. assembled from evidence, not witnessed";

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
};

test("witness header is byte exact", () => {
  const card = renderWitnessCard(witnessHit());
  assert.equal(card.header, WITNESS_HEADER);
});

test("witness evidence line carries source and age", () => {
  const card = renderWitnessCard(witnessHit());
  assert.equal(card.evidence, "source: agent:claude-code · 2h ago");
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
  assert.equal(card.evidence, 'evidence: catalog · ast · def · comment "No litter"');
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
  };
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", ladder);
  assert.equal(card.evidence, 'evidence: def · ast · comment "A"');
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
  const empty: LadderResult = { rungs: [], stopReason: "evidence-exhausted" };
  const card = renderLadderCard("memory.ts", "reclaimTriplePath return", empty);
  assert.deepEqual(card.lines, ["memory.ts · reclaimTriplePath return"]);
  assert.equal(card.evidence, "evidence: ");
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
