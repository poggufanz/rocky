import { test } from "node:test";
import assert from "node:assert/strict";
import { Node, TextNode } from "../ui/tui/core/node.js";
import { renderToLines } from "../ui/tui/core/renderer.js";
import { stringWidth } from "../ui/tui/core/text.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderToLines returns exactly rows lines of exactly cols cells", () => {
  const root = new Node();
  root.add(new TextNode("hello"));
  const lines = renderToLines(root, 20, 5, 1);
  assert.equal(lines.length, 5);
  for (const l of lines) assert.equal(stringWidth(strip(l)), 20);
});

test("row container splits width via grow and records child rects", () => {
  const root = new Node({ direction: "row" });
  const a = new Node({ grow: 1 });
  const b = new Node({ grow: 1 });
  root.add(a).add(b);
  root.layout({ x: 0, y: 0, w: 21, h: 4 });
  assert.equal(a.rect.w + b.rect.w, 21);           // largest remainder: exact
  assert.equal(a.rect.h, 4);
  assert.equal(b.rect.x, a.rect.w);
});

test("column container stacks and TextNode wraps to its width", () => {
  const root = new Node({ direction: "column" });
  const t = new TextNode("append-only reader bounded never rewrite evidence");
  root.add(t);
  const lines = renderToLines(root, 12, 6, 1).map(strip);
  assert.ok(lines[0].trimEnd().length > 0);
  assert.ok(lines[1].trimEnd().length > 0, "long text wraps onto later rows");
  for (const l of lines) assert.ok(stringWidth(l) === 12);
});

test("fixed height wins over flex", () => {
  const root = new Node({ direction: "column" });
  const top = new Node({ height: 2 });
  const rest = new Node({ grow: 1 });
  root.add(top).add(rest);
  root.layout({ x: 0, y: 0, w: 10, h: 10 });
  assert.equal(top.rect.h, 2);
  assert.equal(rest.rect.h, 8);
});

test("gap separates children along container axis", () => {
  const root = new Node({ direction: "row", gap: 2 });
  const a = new Node({ grow: 1 });
  const b = new Node({ grow: 1 });
  root.add(a).add(b);
  root.layout({ x: 0, y: 0, w: 20, h: 5 });
  assert.equal(a.rect.w, 9);
  assert.equal(b.rect.w, 9);
  assert.equal(b.rect.x, 11); // 9 + gap 2
});

test("empty node paints nothing and lays out safely", () => {
  const empty = new Node();
  empty.layout({ x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(empty.rect, { x: 0, y: 0, w: 10, h: 10 });
  const lines = renderToLines(empty, 10, 2, 1);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(strip(l), "          ");
});

test("renderToLines applies theme tokens when color depth > 1", () => {
  const root = new Node();
  root.add(new TextNode("styled", "accent"));
  const lines = renderToLines(root, 10, 1, 24);
  assert.ok(lines[0].includes("\x1b[38;2;"));
  assert.equal(strip(lines[0]), "styled    ");
});

test("nested containers resolve hierarchy correctly", () => {
  const root = new Node({ direction: "column" });
  const row = new Node({ direction: "row", height: 2 });
  const col1 = new Node({ grow: 1 });
  const col2 = new Node({ grow: 1 });
  col1.add(new TextNode("left"));
  col2.add(new TextNode("right"));
  row.add(col1).add(col2);
  root.add(row);
  const lines = renderToLines(root, 20, 4, 1).map(strip);
  assert.ok(lines[0].startsWith("left"));
  assert.ok(lines[0].includes("right"));
});
