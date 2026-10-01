import test from "node:test";
import assert from "node:assert/strict";
import { resolveContext, CONTEXT_WINDOW_PAD } from "../core/context-resolve.js";
import { parsePatch } from "../core/compare-data.js";

const FN = ["function add(a, b) {", "  const s = a + b;", "  return s;", "}", "", "add(1, 2);"].join("\n");

test("hunk wins over function: five-line context selects five", () => {
  const rows = parsePatch("diff --git a/x.ts b/x.ts\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e");
  const got = resolveContext({ fileText: FN, line: 2, rows });
  assert.deepEqual(got, { start: 1, end: 5, why: "hunk" });
});

test("function wins when no hunk covers the line", () => {
  const got = resolveContext({ fileText: FN, line: 3 });
  assert.deepEqual(got, { start: 1, end: 4, why: "function" });
});

test("window fallback is plus-minus three, clamped", () => {
  const got = resolveContext({ fileText: "a\nb", line: 1 });
  assert.deepEqual(got, { start: 1, end: 2, why: "window" });
});

test("empty file text returns window at 1..1", () => {
  const got = resolveContext({ fileText: "", line: 1 });
  assert.deepEqual(got, { start: 1, end: 1, why: "window" });
});

test("line clamped below 1 and above total", () => {
  const gotLow = resolveContext({ fileText: "a\nb\nc", line: -5 });
  assert.deepEqual(gotLow, { start: 1, end: 3, why: "window" });

  const gotHigh = resolveContext({ fileText: "a\nb\nc", line: 100 });
  assert.deepEqual(gotHigh, { start: 1, end: 3, why: "window" });
});

test("multiple hunks scan and first containing hunk wins", () => {
  const patch = [
    "diff --git a/x.ts b/x.ts",
    "@@ -1,2 +1,2 @@",
    " a",
    " b",
    "@@ -10,3 +10,4 @@",
    " x",
    "+y",
    " z",
    " w",
  ].join("\n");
  const rows = parsePatch(patch);
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

  const got1 = resolveContext({ fileText: text, line: 2, rows });
  assert.deepEqual(got1, { start: 1, end: 2, why: "hunk" });

  const got11 = resolveContext({ fileText: text, line: 11, rows });
  assert.deepEqual(got11, { start: 10, end: 13, why: "hunk" });

  // Line 5 is outside both hunks; no function -> window
  const got5 = resolveContext({ fileText: text, line: 5, rows });
  assert.deepEqual(got5, { start: 2, end: 8, why: "window" });
});

test("hunk with omitted count defaults to 1", () => {
  const rows = parsePatch("diff --git a/x.ts b/x.ts\n@@ -1 +5 @@\n+single");
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const got = resolveContext({ fileText: text, line: 5, rows });
  assert.deepEqual(got, { start: 5, end: 5, why: "hunk" });
});

test("CONTEXT_WINDOW_PAD is 3", () => {
  assert.equal(CONTEXT_WINDOW_PAD, 3);
});
