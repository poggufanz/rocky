import { test } from "node:test";
import assert from "node:assert/strict";
import { toLine, toBlock, panelRows, assertParity, type Card } from "../ui/tui/cards/card.js";

const fixture: Card = {
  kind: "why",
  accent: "why",
  subject: "src/core/memory.ts",
  meta: "heard 2",
  facts: ["src/core/memory.ts", "heard 2", "append-only, reader bounded", "5d ago"],
  lines: [
    { text: '"append-only, reader bounded"' },
    { text: "5d ago · claude-code", token: "muted", indent: 2 },
  ],
  actions: "[d] diff",
};

test("every density carries every declared fact", () => {
  assert.doesNotThrow(() => assertParity(fixture, 60));
});

test("a fact missing from one density is named in the failure", () => {
  const broken: Card = { ...fixture, lines: [fixture.lines[1]] }; // drops the quote line
  assert.throws(() => assertParity(broken, 60), /append-only.*block|panel/s);
});

test("toLine is a single voice line with subject and meta", () => {
  const line = toLine(fixture);
  assert.match(line, /^\[Rocky\] /);
  assert.ok(!line.includes("\n"));
  assert.ok(line.includes("src/core/memory.ts") && line.includes("heard 2"));
});

test("toBlock wraps but never loses a fact at narrow widths", () => {
  const joined = toBlock(fixture, 24).join("\n");
  for (const f of fixture.facts) {
    assert.ok(joined.replace(/\n\s*/g, " ").includes(f), `missing: ${f}`);
  }
});

test("card without meta or actions formats cleanly across densities", () => {
  const minimal: Card = {
    kind: "recall",
    accent: "accent",
    subject: "npm test",
    facts: ["npm test", "exit 1"],
    lines: [{ text: "exit 1" }],
  };

  const line = toLine(minimal);
  assert.equal(line, "[Rocky] recall npm test. exit 1");

  const block = toBlock(minimal, 40);
  assert.equal(block[0], "recall · npm test");
  assert.ok(block.some((b) => b.includes("exit 1")));

  const panel = panelRows(minimal, 40);
  assert.equal(panel[0].text, "HEADER recall npm test");
  assert.ok(panel.some((p) => p.text.includes("exit 1")));
  // No actions line, ending with empty line
  assert.equal(panel[panel.length - 1].text, "");

  assert.doesNotThrow(() => assertParity(minimal));
});

test("missing subject fact in line density fails parity assertion", () => {
  const missingSubject: Card = {
    kind: "recall",
    accent: "accent",
    subject: "custom-sub",
    facts: ["unrelated-subject-fact"],
    lines: [{ text: "body text" }],
  };
  // "unrelated-subject-fact" is neither subject nor meta, so line density skips it, but block/panel check it and fail
  assert.throws(
    () => assertParity(missingSubject, 60),
    /fact "unrelated-subject-fact" missing from block density/
  );
});

test("empty or whitespace lines in card are handled gracefully in toLine", () => {
  const cardWithEmptyLines: Card = {
    kind: "stats",
    accent: "accent",
    subject: "summary",
    facts: ["summary"],
    lines: [{ text: "   " }, { text: "first real line" }],
  };
  const line = toLine(cardWithEmptyLines);
  assert.equal(line, "[Rocky] stats summary. first real line");

  const allEmpty: Card = {
    kind: "stats",
    accent: "accent",
    subject: "summary",
    facts: ["summary"],
    lines: [{ text: "" }],
  };
  assert.equal(toLine(allEmpty), "[Rocky] stats summary.");
});

test("panelRows includes actions with muted token and ends with blank row", () => {
  const rows = panelRows(fixture, 80);
  const actionRow = rows.find((r) => r.text === "[d] diff");
  assert.ok(actionRow);
  assert.equal(actionRow?.token, "muted");
  assert.equal(rows[rows.length - 1].text, "");
});
