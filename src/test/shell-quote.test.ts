import test from "node:test";
import assert from "node:assert/strict";
import { quoteShellPath } from "../core/shell-quote.js";

test("POSIX shell paths use canonical single-quote escaping", () => {
  const cases = [
    { value: "", expected: "''" },
    { value: "/tmp/rocky path", expected: "'/tmp/rocky path'" },
    { value: "/tmp/rocky's path", expected: "'/tmp/rocky'\\''s path'" },
  ] as const;
  for (const { value, expected } of cases) {
    assert.equal(quoteShellPath(value, "linux"), expected);
  }
});

test("Windows shell paths accept spaces and backslashes inside double quotes", () => {
  assert.equal(
    quoteShellPath("C:\\Program Files\\Rocky\\rocky.js", "win32"),
    '"C:\\Program Files\\Rocky\\rocky.js"',
  );
  assert.equal(quoteShellPath("", "win32"), '""');
});

test("Windows shell paths refuse cmd expansion and control characters", () => {
  for (const value of [
    'C:\\Rocky\\"quoted"',
    "C:\\Rocky\\line\rreturn",
    "C:\\Rocky\\line\nfeed",
    "C:\\Rocky\\nul\0byte",
    "C:\\Rocky\\%TEMP%",
    "C:\\Rocky\\bang!",
  ]) {
    assert.throws(() => quoteShellPath(value, "win32"), /unsafe/i, value);
  }
});
