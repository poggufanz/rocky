import { test } from "node:test";
import assert from "node:assert/strict";
import { codePointWidth, stringWidth, wrapToWidth } from "../ui/tui/core/text.js";

test("checkmark U+2705 is two cells", () => {
  assert.equal(codePointWidth(0x2705), 2);
});

test("gear U+2699 without VS16 is one cell", () => {
  assert.equal(codePointWidth(0x2699), 1);
});

test("star U+2B50 is two cells, arrow U+2192 is one", () => {
  assert.equal(codePointWidth(0x2b50), 2);
  assert.equal(codePointWidth(0x2192), 1);
});

test("stringWidth counts emoji and CJK as two", () => {
  assert.equal(stringWidth("a✅b"), 4);
  assert.equal(stringWidth("汉字"), 4);
});

test("wrapToWidth breaks on spaces and never exceeds max cells", () => {
  const lines = wrapToWidth("append-only, reader bounded, never rewrite evidence", 20);
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.ok(stringWidth(l) <= 20, `too wide: ${l}`);
  assert.equal(lines.join(" ").replace(/\s+/g, " "),
    "append-only, reader bounded, never rewrite evidence");
});

test("wrapToWidth hard-breaks an over-long token", () => {
  const lines = wrapToWidth("rationale:f73b8c24-5497-494d-af79-043c00ef1ef1", 16);
  for (const l of lines) assert.ok(stringWidth(l) <= 16);
  assert.equal(lines.join(""), "rationale:f73b8c24-5497-494d-af79-043c00ef1ef1");
});

test("wrapToWidth is wide-aware when hard-breaking", () => {
  const lines = wrapToWidth("✅".repeat(10), 7); // 10 checkmarks, 20 cells
  for (const l of lines) assert.ok(stringWidth(l) <= 7);
});

test("wrapToWidth preserves explicit newlines and empty input", () => {
  assert.deepEqual(wrapToWidth("a\nb", 10), ["a", "b"]);
  assert.deepEqual(wrapToWidth("", 10), [""]);
  assert.deepEqual(wrapToWidth("x", 0), [""]);
});
