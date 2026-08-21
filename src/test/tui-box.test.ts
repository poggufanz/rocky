import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBox } from "../ui/tui/box.js";
import { stringWidth } from "../ui/tui/width.js";

test("box is exactly width x height with unicode borders and titled top", () => {
  const out = renderBox({ title: "records", lines: ["a", "b"], width: 14, height: 5, ascii: false });
  assert.equal(out.length, 5);
  for (const line of out) {
    assert.equal(stringWidth(line), 14);
  }
  assert.ok(out[0].startsWith("╭") && out[0].endsWith("╮"));
  assert.ok(out[0].includes("records"));
  assert.ok(out[4].startsWith("╰") && out[4].endsWith("╯"));
  assert.equal(out[1], "│a" + " ".repeat(11) + "│");
  assert.equal(out[2], "│b" + " ".repeat(11) + "│");
  assert.equal(out[3], "│" + " ".repeat(12) + "│");
});

test("ascii mode uses +-| borders only", () => {
  const out = renderBox({ title: "t", lines: [], width: 8, height: 3, ascii: true });
  assert.equal(out.length, 3);
  for (const line of out) {
    assert.equal(stringWidth(line), 8);
  }
  assert.ok(out[0].startsWith("+") && out[0].includes("-"));
  assert.ok(out[1].startsWith("|") && out[1].endsWith("|"));
  assert.ok(out[2].startsWith("+") && out[2].endsWith("+"));
  for (const line of out) {
    assert.match(line, /^[+\-|t ]*$/);
  }
});

test("interior lines are truncated with ellipsis and extra lines dropped", () => {
  const out = renderBox({ title: "", lines: ["0123456789ABC", "x", "y", "z"], width: 10, height: 4, ascii: false });
  assert.equal(out.length, 4);
  for (const line of out) {
    assert.equal(stringWidth(line), 10);
  }
  assert.ok(out[1].includes("…"));
  assert.equal(out[1], "│0123456…│");
  assert.equal(out[2], "│x       │");
  assert.equal(out[3], "╰────────╯");
  assert.ok(!out.join("").includes("z"), "line beyond height dropped");
});

test("edge cases: height <= 0 returns empty array", () => {
  assert.deepEqual(renderBox({ title: "test", lines: ["a"], width: 10, height: 0, ascii: false }), []);
  assert.deepEqual(renderBox({ title: "test", lines: ["a"], width: 10, height: -1, ascii: false }), []);
});

test("edge cases: height 1 and height 2", () => {
  const h1 = renderBox({ title: "test", lines: ["a"], width: 10, height: 1, ascii: false });
  assert.equal(h1.length, 1);
  assert.equal(stringWidth(h1[0]), 10);

  const h2 = renderBox({ title: "test", lines: ["a"], width: 10, height: 2, ascii: false });
  assert.equal(h2.length, 2);
  assert.equal(stringWidth(h2[0]), 10);
  assert.equal(stringWidth(h2[1]), 10);
});

test("edge cases: small widths maintain exact cell width", () => {
  for (let w = 0; w <= 5; w++) {
    const out = renderBox({ title: "title", lines: ["long content here"], width: w, height: 4, ascii: false });
    assert.equal(out.length, 4);
    for (const line of out) {
      assert.equal(stringWidth(line), w);
    }
  }
});

test("wide characters in title and interior lines", () => {
  const out = renderBox({
    title: "記録",
    lines: ["日本語テキスト123", "short"],
    width: 16,
    height: 4,
    ascii: false,
  });
  assert.equal(out.length, 4);
  for (const line of out) {
    assert.equal(stringWidth(line), 16);
  }
  assert.ok(out[0].includes("記録"));
  assert.ok(out[1].startsWith("│") && out[1].endsWith("│"));
});
