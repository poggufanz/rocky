import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codePointWidth,
  stringWidth,
  truncateToWidth,
  padToWidth,
} from "../ui/tui/width.js";

test("codePointWidth: ASCII characters measure 1 cell", () => {
  assert.equal(codePointWidth(0x0020), 1); // space
  assert.equal(codePointWidth(0x0030), 1); // '0'
  assert.equal(codePointWidth(0x0041), 1); // 'A'
  assert.equal(codePointWidth(0x0061), 1); // 'a'
  assert.equal(codePointWidth(0x007e), 1); // '~'
});

test("codePointWidth: East Asian wide and fullwidth characters measure 2 cells", () => {
  // Hangul Jamo
  assert.equal(codePointWidth(0x1100), 2);
  assert.equal(codePointWidth(0x115f), 2);
  // CJK Radicals / Hiragana / Katakana / Han
  assert.equal(codePointWidth(0x3041), 2); // 'ぁ'
  assert.equal(codePointWidth(0x30a2), 2); // 'ア'
  assert.equal(codePointWidth(0x4e00), 2); // '一'
  assert.equal(codePointWidth(0x9fff), 2);
  // Fullwidth ASCII variants
  assert.equal(codePointWidth(0xff01), 2); // '！'
  assert.equal(codePointWidth(0xff5e), 2); // '～'
  // Emojis and Symbols
  assert.equal(codePointWidth(0x1f600), 2); // '😀'
  assert.equal(codePointWidth(0x1f680), 2); // '🚀'
  // CJK Unified Ideographs Extension B
  assert.equal(codePointWidth(0x20000), 2);
});

test("codePointWidth: combining marks measure 0 cells and ambiguous width defaults to 1", () => {
  // Combining marks
  assert.equal(codePointWidth(0x0300), 0); // combining grave
  assert.equal(codePointWidth(0x036f), 0);
  assert.equal(codePointWidth(0x1ab0), 0);
  assert.equal(codePointWidth(0x1dc0), 0);
  assert.equal(codePointWidth(0x20d0), 0);
  assert.equal(codePointWidth(0xfe00), 0); // variation selector 1
  assert.equal(codePointWidth(0xfe0f), 0); // variation selector 16
  assert.equal(codePointWidth(0xfe20), 0);

  // Ambiguous width characters default to 1
  assert.equal(codePointWidth(0x03b1), 1); // Greek alpha 'α'
  assert.equal(codePointWidth(0x0410), 1); // Cyrillic 'А'
  assert.equal(codePointWidth(0x00e9), 1); // Latin 'é'
});

test("codePointWidth: control characters and zero-width spaces measure 0 cells", () => {
  // C0 controls
  assert.equal(codePointWidth(0x0000), 0); // NUL
  assert.equal(codePointWidth(0x001b), 0); // ESC
  assert.equal(codePointWidth(0x001f), 0);
  // C1 controls
  assert.equal(codePointWidth(0x007f), 0); // DEL
  assert.equal(codePointWidth(0x0080), 0);
  assert.equal(codePointWidth(0x009f), 0);
  // Zero-width spaces and joiners
  assert.equal(codePointWidth(0x200b), 0); // ZWSP
  assert.equal(codePointWidth(0x200c), 0); // ZWNJ
  assert.equal(codePointWidth(0x200d), 0); // ZWJ
  assert.equal(codePointWidth(0x2060), 0); // Word joiner
});

test("stringWidth: computes total cell width of strings", () => {
  assert.equal(stringWidth(""), 0);
  assert.equal(stringWidth("hello"), 5);
  assert.equal(stringWidth("hello world"), 11);
  assert.equal(stringWidth("你好"), 4);
  assert.equal(stringWidth("hello 你好"), 10);
  assert.equal(stringWidth("cafe\u0301"), 4); // 'e' + combining acute = 1 cell
  assert.equal(stringWidth("rocky 🚀"), 8); // 'rocky ' (6) + '🚀' (2) = 8
});

test("truncateToWidth: cuts on cell boundary and appends ellipsis", () => {
  // Shorter or equal to max width
  assert.equal(truncateToWidth("hello", 10), "hello");
  assert.equal(truncateToWidth("hello", 5), "hello");

  // ASCII truncation: max 6 with ellipsis (5 chars + 1 ellipsis)
  assert.equal(truncateToWidth("hello world", 6), "hello…");
  assert.equal(stringWidth(truncateToWidth("hello world", 6)), 6);

  // Wide character truncation: max 5 cells. "你好" is 4 cells, next char is 2 cells (4+2 > 4), so "你好…" = 5 cells
  assert.equal(truncateToWidth("你好世界", 5), "你好…");
  assert.equal(stringWidth(truncateToWidth("你好世界", 5)), 5);

  // Wide character truncation when wide char would exceed max
  // max 4 cells: "你" is 2 cells, next "好" is 2 cells (2+2 = 4 > 3), so "你…" = 3 cells <= 4
  assert.equal(truncateToWidth("你好世界", 4), "你…");
  assert.ok(stringWidth(truncateToWidth("你好世界", 4)) <= 4);

  // Strict boundary check: string width <= max always
  for (let max = 1; max <= 10; max++) {
    const res = truncateToWidth("你好世界 testing 123", max);
    assert.ok(stringWidth(res) <= max, `Truncated string "${res}" exceeds max width ${max}`);
  }
});

test("padToWidth: right-pads with spaces to exact cell width", () => {
  assert.equal(padToWidth("hello", 10), "hello     ");
  assert.equal(stringWidth(padToWidth("hello", 10)), 10);

  assert.equal(padToWidth("你好", 6), "你好  ");
  assert.equal(stringWidth(padToWidth("你好", 6)), 6);

  assert.equal(padToWidth("hello", 5), "hello");
  assert.equal(padToWidth("hello", 3), "hello");
});
