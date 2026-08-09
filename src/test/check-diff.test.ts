import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrePushStdin,
  parseUnifiedZeroDiff,
  rangeForPush,
} from "../check/diff.js";

const ZEROS = "0".repeat(40);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("parsePrePushStdin reads githooks four-field lines and skips junk", () => {
  const refs = parsePrePushStdin(
    `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}\n\n` +
      "garbage line\n",
  );

  assert.deepEqual(refs, [{
    localRef: "refs/heads/main",
    localSha: SHA_A,
    remoteRef: "refs/heads/main",
    remoteSha: SHA_B,
  }]);
});

test("rangeForPush distinguishes updates, new refs, and deletions", () => {
  assert.deepEqual(
    rangeForPush({ localRef: "r", localSha: SHA_A, remoteRef: "r", remoteSha: SHA_B }),
    { kind: "endpoints", base: SHA_B, head: SHA_A },
  );
  assert.deepEqual(
    rangeForPush({ localRef: "r", localSha: SHA_A, remoteRef: "r", remoteSha: ZEROS }),
    { kind: "new-ref", head: SHA_A },
  );
  assert.equal(
    rangeForPush({ localRef: "r", localSha: ZEROS, remoteRef: "r", remoteSha: SHA_B }),
    null,
  );
});

test("parseUnifiedZeroDiff extracts only added lines with correct numbering", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -10,2 +10,3 @@ context",
    "-old line",
    "+new line ten",
    "+new line eleven",
    "@@ -40 +41,2 @@",
    "+later line",
    "+later line two",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-deleted",
  ].join("\n");

  assert.deepEqual(parseUnifiedZeroDiff(diff), [
    { file: "src/x.ts", line: 10, text: "new line ten" },
    { file: "src/x.ts", line: 11, text: "new line eleven" },
    { file: "src/x.ts", line: 41, text: "later line" },
    { file: "src/x.ts", line: 42, text: "later line two" },
  ]);
});

test("parseUnifiedZeroDiff handles renames and binary files", () => {
  const diff = [
    "diff --git a/old name.ts b/new name.ts",
    "--- a/old name.ts",
    "+++ b/new name.ts",
    "@@ -1 +1 @@",
    "+renamed content",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
  ].join("\n");

  assert.deepEqual(parseUnifiedZeroDiff(diff), [
    { file: "new name.ts", line: 1, text: "renamed content" },
  ]);
});

test("parseUnifiedZeroDiff accepts CRLF input without retaining carriage returns", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -0,0 +1 @@",
    "+portable line",
    "+second portable line",
  ].join("\r\n");

  assert.deepEqual(parseUnifiedZeroDiff(diff), [
    { file: "src/x.ts", line: 1, text: "portable line" },
    { file: "src/x.ts", line: 2, text: "second portable line" },
  ]);
});

test("parseUnifiedZeroDiff preserves additions whose text begins with pluses", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1 +1 @@",
    "+++counter;",
  ].join("\n");

  assert.deepEqual(parseUnifiedZeroDiff(diff), [
    { file: "src/x.ts", line: 1, text: "++counter;" },
  ]);
});

test("parseUnifiedZeroDiff preserves additions whose text begins with two pluses and a space", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1 +1 @@",
    "+++ two-plus-leading-space",
  ].join("\n");

  assert.deepEqual(parseUnifiedZeroDiff(diff), [
    { file: "src/x.ts", line: 1, text: "++ two-plus-leading-space" },
  ]);
});

test("parseUnifiedZeroDiff ignores plus-prefixed lines outside a hunk", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "+not a diff addition",
    "@@ -1 +1 @@",
    "+actual addition",
  ].join("\n");

  assert.deepEqual(parseUnifiedZeroDiff(diff), [
    { file: "src/x.ts", line: 1, text: "actual addition" },
  ]);
});
