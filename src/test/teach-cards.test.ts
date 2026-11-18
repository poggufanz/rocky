import assert from "node:assert/strict";
import { test } from "node:test";
import { teachFromCards } from "../core/teach-cards.js";
import type { CardsForFile, StoredBlock, StoredCard } from "../desk/cards-read.js";

function makeBlock(seq: number, overrides: Partial<StoredBlock> = {}): StoredBlock {
  return {
    seq,
    path: "src/auth.ts",
    symbol: null,
    labels: [{ id: "body_changed" }],
    importance: "medium",
    via: "edit",
    before: null,
    after: null,
    recorded: true,
    line: null,
    added: null,
    removed: null,
    quote: null,
    ...overrides,
  };
}

function makeCard(
  cardId: string,
  startedMs: number,
  blocks: StoredBlock[],
  overrides: Partial<StoredCard> = {},
): StoredCard {
  return {
    v: 1,
    card_id: cardId,
    rev: 1,
    root: "C:/repo",
    started_ms: startedMs,
    ended_ms: startedMs + 100,
    prompt: "Update auth",
    blocks,
    ...overrides,
  };
}

function makeFound(cards: StoredCard[]): CardsForFile {
  const matched = new Map<string, StoredBlock[]>();
  for (const card of cards) {
    matched.set(card.card_id, card.blocks);
  }
  return {
    cards,
    matched,
    coverage: { complete: true, skipped: 0 },
  };
}

test("content match picks the most similar block", () => {
  const targetAfter = "export function verifySession(token: string) { return decodeJwt(token, publicKey); }";
  const otherAfter = "export function formatAuditRow(entry: AuditEntry) { return entry.id.trim(); }";
  const card = makeCard("c1", 10, [
    makeBlock(1, { after: otherAfter }),
    makeBlock(2, { after: targetAfter }),
  ]);
  const hit = teachFromCards(makeFound([card]), { snippet: targetAfter });
  assert.ok(hit);
  assert.equal(hit.match, "content");
  assert.equal(hit.block.seq, 2);
  assert.ok(hit.score >= 0.34);
});

test("content beats a newer symbol-only match", () => {
  const snippet = "export function validateToken(raw: string) { return verifySignature(raw, secretKey); }";
  const olderCard = makeCard("old", 100, [
    makeBlock(1, {
      after: snippet,
      symbol: { kind: "function", name: "otherHelper" },
    }),
  ]);
  const newerCard = makeCard("new", 200, [
    makeBlock(1, {
      after: null,
      symbol: { kind: "function", name: "validateToken" },
    }),
  ]);
  const hit = teachFromCards(makeFound([olderCard, newerCard]), { snippet });
  assert.ok(hit);
  assert.equal(hit.match, "content");
  assert.equal(hit.card.card_id, "old");
});

test("block without after is matched by symbol", () => {
  const card = makeCard("c1", 10, [
    makeBlock(1, {
      after: null,
      symbol: { kind: "function", name: "validateToken" },
    }),
  ]);
  const hit = teachFromCards(makeFound([card]), {
    snippet: "export function validateToken(input: string): boolean {\n  return input.length > 0;\n}",
  });
  assert.ok(hit);
  assert.equal(hit.match, "symbol");
  assert.equal(hit.score, 0);
  assert.equal(hit.block.seq, 1);
});

test("symbol name must be a whole identifier", () => {
  const card = makeCard("c1", 10, [
    makeBlock(1, {
      after: null,
      symbol: { kind: "function", name: "token" },
    }),
  ]);
  const hit = teachFromCards(makeFound([card]), {
    snippet: "export function validateToken(input: string): boolean { return true; }",
  });
  assert.equal(hit, undefined);
});

test("symbol name is regex-escaped before boundary matching", () => {
  const card = makeCard("c1", 10, [
    makeBlock(1, {
      after: null,
      symbol: { kind: "function", name: "foo.bar" },
    }),
  ]);
  const hit = teachFromCards(makeFound([card]), {
    snippet: "const value = fooXbar();",
  });
  assert.equal(hit, undefined);
});

test("line inside block range matches", () => {
  const card = makeCard("c1", 10, [
    makeBlock(1, { line: 40, added: 5 }),
  ]);
  const found = makeFound([card]);
  const hit = teachFromCards(found, { line: 44 });
  assert.ok(hit);
  assert.equal(hit.match, "line");
  assert.equal(hit.score, 0);
  assert.equal(hit.block.seq, 1);
  assert.equal(teachFromCards(found, { line: 45 }), undefined);
});

test("whole-file query returns newest block", () => {
  const c1 = makeCard("c1", 10, [makeBlock(1), makeBlock(3)]);
  const c2 = makeCard("c2", 30, [makeBlock(2), makeBlock(7)]);
  const c3 = makeCard("c3", 20, [makeBlock(9)]);
  const hit = teachFromCards(makeFound([c1, c2, c3]), {});
  assert.ok(hit);
  assert.equal(hit.match, "file");
  assert.equal(hit.score, 0);
  assert.equal(hit.card.card_id, "c2");
  assert.equal(hit.block.seq, 7);
});

test("newest card wins a tie", () => {
  const sharedAfter = "const parsed = parseSessionCookie(headerValue, signingSecret);";
  const c1 = makeCard("c1", 1, [makeBlock(1, { after: sharedAfter })]);
  const c2 = makeCard("c2", 2, [makeBlock(1, { after: sharedAfter })]);
  const hit = teachFromCards(makeFound([c1, c2]), { snippet: sharedAfter });
  assert.ok(hit);
  assert.equal(hit.match, "content");
  assert.equal(hit.card.card_id, "c2");
});

test("no blocks returns undefined", () => {
  const emptyFound: CardsForFile = {
    cards: [],
    matched: new Map(),
    coverage: { complete: true, skipped: 0 },
  };
  assert.equal(teachFromCards(emptyFound, { snippet: "const x = 1;" }), undefined);
  assert.equal(teachFromCards(emptyFound, { line: 10 }), undefined);
  assert.equal(teachFromCards(emptyFound, {}), undefined);
});

test("snippet miss falls back to line match and defaults missing added to 1", () => {
  const card = makeCard("c1", 10, [makeBlock(1, { line: 25, added: null, after: null })]);
  const found = makeFound([card]);
  const hit = teachFromCards(found, { snippet: "unrelated code", line: 25 });
  assert.ok(hit);
  assert.equal(hit.match, "line");
  assert.equal(teachFromCards(found, { snippet: "unrelated code", line: 26 }), undefined);
});

test("candidates come from found.matched rather than all card.blocks", () => {
  const matchedBlock = makeBlock(1, { after: null });
  const unmatchedBlock = makeBlock(9, { path: "src/other.ts", after: null });
  const card = makeCard("c1", 10, [matchedBlock, unmatchedBlock]);
  const found: CardsForFile = {
    cards: [card],
    matched: new Map([[card.card_id, [matchedBlock]]]),
    coverage: { complete: true, skipped: 0 },
  };
  const hit = teachFromCards(found, {});
  assert.ok(hit);
  assert.equal(hit.block.seq, 1);
});
