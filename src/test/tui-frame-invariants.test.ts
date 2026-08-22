import { test } from "node:test";
import assert from "node:assert/strict";
import { Node, TextNode } from "../ui/tui/core/node.js";
import { renderToLines } from "../ui/tui/core/renderer.js";
import { stringWidth } from "../ui/tui/core/text.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("every frame is exactly rows × cols cells, emoji included, all depths", () => {
  for (const [cols, rows] of [[20, 5], [80, 24], [101, 31], [137, 40]] as const) {
    const root = new Node({ direction: "row" });
    const left = new Node({ grow: 2 });
    left.add(new TextNode("evidence ✅ heard ⚡ remembered 汉字 ".repeat(6), "accent"));
    const right = new Node({ grow: 3 });
    right.add(new TextNode("rationale:f73b8c24-5497-494d-af79-043c00ef1ef1 ".repeat(4), "muted"));
    root.add(left).add(right);
    for (const depth of [1, 4, 8, 24] as const) {
      const lines = renderToLines(root, cols, rows, depth);
      assert.equal(lines.length, rows);
      for (const l of lines) {
        assert.equal(stringWidth(strip(l)), cols, `cols=${cols} depth=${depth}`);
      }
    }
  }
});

test("no frame contains emoji from rocky's own strings", () => {
  // TextNodes above carry evidence text (emoji allowed). This asserts the
  // FRAME machinery itself injects none: an empty tree renders pure spaces.
  const lines = renderToLines(new Node(), 40, 10, 24).map(strip);
  for (const l of lines) assert.match(l, /^ *$/);
});
