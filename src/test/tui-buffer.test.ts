import { test } from "node:test";
import assert from "node:assert/strict";
import { CellBuffer } from "../ui/tui/core/buffer.js";
import { stringWidth } from "../ui/tui/core/text.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("toLines yields h lines of exactly w cells at depth 1", () => {
  const b = new CellBuffer(10, 3);
  b.blitText(0, 1, "hello");
  const lines = b.toLines(1);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.equal(stringWidth(strip(l)), 10);
  assert.equal(strip(lines[1]), "hello     ");
});

test("blitText clips at every edge and reports cells written", () => {
  const b = new CellBuffer(6, 2);
  assert.equal(b.blitText(4, 0, "wide"), 2);      // right clip
  assert.equal(b.blitText(0, 5, "off"), 0);       // below
  assert.equal(b.blitText(-2, 1, "ab"), 0);       // left of origin: nothing lands
  const clip = { x: 0, y: 0, w: 3, h: 2 };
  assert.equal(b.blitText(1, 1, "abcdef", undefined, clip), 2);
});

test("a wide glyph consumes two cells and never splits at the edge", () => {
  const b = new CellBuffer(5, 1);
  b.blitText(0, 0, "✅ab");
  assert.equal(strip(b.toLines(1)[0]), "✅ab ");           // emoji + a + b + pad
  const edge = new CellBuffer(4, 1);
  edge.blitText(3, 0, "✅");                               // would straddle the edge
  assert.equal(strip(edge.toLines(1)[0]), "    ");             // dropped clean, not halved
});

test("run collapse emits identical visible text with fewer escapes", () => {
  const b = new CellBuffer(8, 1);
  b.blitText(0, 0, "aaaa", "accent");
  b.blitText(4, 0, "bbbb", "err");
  const line = b.toLines(24);
  assert.equal(strip(line[0]), "aaaabbbb");
  const escapes = (line[0].match(/\x1b\[38;2/g) ?? []).length;
  assert.equal(escapes, 2, "one SGR run per token run, not per cell");
});

test("fillRect fills target rectangle and respects buffer boundaries", () => {
  const b = new CellBuffer(6, 3);
  b.fillRect({ x: 1, y: 1, w: 4, h: 1 }, "#", "ok");
  const lines = b.toLines(1);
  assert.equal(lines[0], "      ");
  assert.equal(lines[1], " #### ");
  assert.equal(lines[2], "      ");
});

test("set ignores coordinates outside the buffer bounds", () => {
  const b = new CellBuffer(4, 2);
  b.set(-1, 0, "x");
  b.set(0, -1, "x");
  b.set(4, 0, "x");
  b.set(0, 2, "x");
  const lines = b.toLines(1);
  assert.deepEqual(lines, ["    ", "    "]);
});

test("inverse attribute applies reverse video escape sequences for depths > 1", () => {
  const b = new CellBuffer(4, 1);
  b.set(0, 0, "i", undefined, true);
  b.set(1, 0, "n", undefined, true);
  b.set(2, 0, "v", undefined, false);
  b.set(3, 0, " ", undefined, false);

  const line24 = b.toLines(24)[0];
  assert.ok(line24.includes("\x1b[7m"));
  assert.ok(line24.includes("\x1b[27m"));
  assert.equal(strip(line24), "inv ");

  // At depth 1, inverse should not inject escape codes
  const line1 = b.toLines(1)[0];
  assert.equal(line1, "inv ");
  assert.ok(!line1.includes("\x1b"));
});

test("blitText handles zero-width combining characters cleanly", () => {
  const b = new CellBuffer(5, 1);
  // U+0300 is a combining grave accent (zero width)
  const written = b.blitText(0, 0, "e\u0300f");
  assert.equal(written, 2);
  assert.equal(strip(b.toLines(1)[0]), "ef   ");
});

test("blitText partially shifts left-clipped characters", () => {
  const b = new CellBuffer(6, 1);
  // blitText starting at x = -2 with 4 characters "abcd" -> "ab" are at x=-2,-1; "cd" land at x=0,1
  const written = b.blitText(-2, 0, "abcd");
  assert.equal(written, 2);
  assert.equal(strip(b.toLines(1)[0]), "cd    ");
});
