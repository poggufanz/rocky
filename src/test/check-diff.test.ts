import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrePushStdin,
  parseNameOnlyZero,
  parseUnifiedZeroDiff,
  parseUnifiedZeroDiffChecked,
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

test("checked unified diff requires exact declared hunk counts", async () => {
  const cases = [
    [
      "declared old/new counts overflow",
      [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,2 +1,3 @@",
        "+only line",
      ].join("\n"),
    ],
    [
      "declared old/new counts underflow",
      [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1 +1 @@",
        "+first",
        "+second",
      ].join("\n"),
    ],
    [
      "context/deletion/addition accounting",
      [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,2 +1,2 @@",
        " context",
        "-deleted",
      ].join("\n"),
    ],
    [
      "no-newline marker without a preceding hunk line",
      [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1 +1 @@",
        "\\ No newline at end of file",
      ].join("\n"),
    ],
    [
      "no-newline marker followed by another hunk line",
      [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1 +1 @@",
        "+first",
        "\\ No newline at end of file",
        "+second",
      ].join("\n"),
    ],
  ] as const;

  for (const [name, diff] of cases) {
    assert.equal((await parseUnifiedZeroDiffChecked(diff)).complete, false, name);
  }
});

test("checked unified diff rejects incomplete metadata and raw blank grammar", async () => {
  const cases = [
    ["one-operand diff header", "diff --git a/file.ts\n"],
    [
      "one-operand header with otherwise valid hunk",
      [
        "diff --git a/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -0,0 +1 @@",
        "+line",
      ].join("\n"),
    ],
    [
      "unrecognized leading text",
      [
        "mail preamble",
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -0,0 +1 @@",
        "+line",
      ].join("\n"),
    ],
    ["leading raw blank", "\ndiff --git a/file.ts b/file.ts\n"],
    [
      "interior raw blank",
      [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -0,0 +1 @@",
        "+line",
        "",
        "diff --git a/other.ts b/other.ts",
        "Binary files a/other.ts and b/other.ts differ",
      ].join("\n"),
    ],
    [
      "reversed file markers",
      [
        "diff --git a/file.ts b/file.ts",
        "+++ b/file.ts",
        "--- a/file.ts",
        "@@ -0,0 +1 @@",
        "+line",
      ].join("\n"),
    ],
    [
      "duplicate file markers",
      [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -0,0 +1 @@",
        "+line",
      ].join("\n"),
    ],
    ["empty rename path", "diff --git a/file.ts b/file.ts\nsimilarity index 100%\nrename from \nrename to file.ts\n"],
    ["invalid mode", "diff --git a/file.ts b/file.ts\nold mode 10064x\nnew mode 100755\n"],
    ["invalid mode pair", "diff --git a/file.ts b/file.ts\nold mode 100644\nnew mode 10064x\n"],
    ["reversed mode pair", "diff --git a/file.ts b/file.ts\nnew mode 100755\nold mode 100644\n"],
    ["truncated index", "diff --git a/file.ts b/file.ts\nindex 1234567\n"],
    ["duplicate index", "diff --git a/file.ts b/file.ts\nindex 1234567..89abcde\nindex 1234567..89abcde\n"],
    ["duplicate similarity", "diff --git a/file.ts b/file.ts\nsimilarity index 100%\nsimilarity index 100%\nrename from file.ts\nrename to new.ts\n"],
    ["reversed rename pair", "diff --git a/file.ts b/new.ts\nsimilarity index 100%\nrename to new.ts\nrename from file.ts\n"],
    ["empty copy path", "diff --git a/file.ts b/file.ts\nsimilarity index 100%\ncopy from \ncopy to file.ts\n"],
    [
      "mixed rename and copy metadata",
      [
        "diff --git a/file.ts b/new.ts",
        "similarity index 100%",
        "rename from file.ts",
        "rename to new.ts",
        "copy from file.ts",
        "copy to copy.ts",
      ].join("\n"),
    ],
    ["binary side missing", "diff --git a/file.bin b/file.bin\nBinary files a/file.bin and  differ\n"],
    [
      "dev-null marker without file mode",
      [
        "diff --git a/file.ts b/file.ts",
        "--- /dev/null",
        "+++ b/file.ts",
        "@@ -0,0 +1 @@",
        "+line",
      ].join("\n"),
    ],
  ] as const;

  for (const [name, diff] of cases) {
    assert.equal((await parseUnifiedZeroDiffChecked(diff)).complete, false, name);
  }
});

test("checked unified diff decodes C-quoted paths and accepts exact zero-count hunks", async () => {
  const diff = [
    'diff --git "a/space\\tname.ts" "b/space\\tname.ts"',
    '--- "a/space\\tname.ts"',
    '+++ "b/space\\tname.ts"',
    "@@ -1,0 +1 @@",
    "+added",
  ].join("\n");

  assert.deepEqual(await parseUnifiedZeroDiffChecked(diff), {
    complete: true,
    added: [{ file: "space\tname.ts", line: 1, text: "added" }],
  });
});

test("checked unified diff retains additions from every exact hunk and section", async () => {
  const diff = [
    "diff --git a/one.ts b/one.ts",
    "index 1111111..2222222",
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -0,0 +1 @@",
    "+first",
    "@@ -5,0 +6,2 @@",
    "+second",
    "+third",
    "diff --git a/two.ts b/two.ts",
    "index 3333333..4444444",
    "--- a/two.ts",
    "+++ b/two.ts",
    "@@ -1 +1 @@",
    "-old",
    "+fourth",
  ].join("\n");

  assert.deepEqual(await parseUnifiedZeroDiffChecked(diff), {
    complete: true,
    added: [
      { file: "one.ts", line: 1, text: "first" },
      { file: "one.ts", line: 6, text: "second" },
      { file: "one.ts", line: 7, text: "third" },
      { file: "two.ts", line: 1, text: "fourth" },
    ],
  });
});

test("name-only NUL framing accepts only exact nonempty frames plus one terminator", () => {
  assert.deepEqual(parseNameOnlyZero(""), []);
  assert.deepEqual(parseNameOnlyZero("odd\nline\0ümlaut\0"), ["odd\nline", "ümlaut"]);
  for (const [name, output] of [
    ["missing terminator", "package.json"],
    ["leading NUL", "\0package.json\0"],
    ["doubled NUL", "package.json\0\0"],
    ["interior empty frame", "package.json\0\0src/a.ts\0"],
    ["bare NUL", "\0"],
  ] as const) {
    assert.throws(() => parseNameOnlyZero(output), name);
  }
});

test("checked parser accepts Git's ordinary metadata and file-shape matrix", async () => {
  const cases = [
    [
      "modify with mode",
      [
        "diff --git a/file.ts b/file.ts",
        "index 1111111..2222222 100644",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    ],
    [
      "context deletion and addition accounting",
      [
        "diff --git a/file.ts b/file.ts",
        "index 1111111..2222222",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,2 +1,2 @@",
        " context",
        "-old",
        "+new",
      ].join("\n"),
    ],
    [
      "new empty file",
      [
        "diff --git a/empty.txt b/empty.txt",
        "new file mode 100644",
        "index 0000000..e69de29",
      ].join("\n"),
    ],
    [
      "deleted empty file",
      [
        "diff --git a/empty.txt b/empty.txt",
        "deleted file mode 100644",
        "index e69de29..0000000",
      ].join("\n"),
    ],
    [
      "new nonempty file",
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+new",
      ].join("\n"),
    ],
    [
      "deleted nonempty file with no final newline",
      [
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        "\\ No newline at end of file",
      ].join("\n"),
    ],
    [
      "mode change",
      [
        "diff --git a/script.sh b/script.sh",
        "old mode 100644",
        "new mode 100755",
      ].join("\n"),
    ],
    [
      "rename only",
      [
        "diff --git a/old.txt b/new.txt",
        "similarity index 100%",
        "rename from old.txt",
        "rename to new.txt",
      ].join("\n"),
    ],
    [
      "copy only",
      [
        "diff --git a/source.txt b/copy.txt",
        "similarity index 100%",
        "copy from source.txt",
        "copy to copy.txt",
      ].join("\n"),
    ],
    [
      "rename with edits",
      [
        "diff --git a/old.txt b/new.txt",
        "similarity index 80%",
        "rename from old.txt",
        "rename to new.txt",
        "index 1111111..2222222",
        "--- a/old.txt",
        "+++ b/new.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    ],
    [
      "binary differ",
      [
        "diff --git a/image.bin b/image.bin",
        "index 1111111..2222222 100644",
        "Binary files a/image.bin and b/image.bin differ",
      ].join("\n"),
    ],
    [
      "submodule change",
      [
        "diff --git a/sub b/sub",
        "index 1111111..2222222 160000",
        "--- a/sub",
        "+++ b/sub",
        "@@ -1 +1 @@",
        "-Subproject commit 1111111",
        "+Subproject commit 2222222",
      ].join("\n"),
    ],
    [
      "symlink mode/type change",
      [
        "diff --git a/link b/link",
        "old mode 100644",
        "new mode 120000",
        "index 1111111..2222222",
        "--- a/link",
        "+++ b/link",
        "@@ -1 +1 @@",
        "-old-target",
        "+new-target",
      ].join("\n"),
    ],
    [
      "SHA-256 object ids",
      [
        "diff --git a/file b/file",
        "index 1111111111111111111111111111111111111111111111111111111111111111..2222222222222222222222222222222222222222222222222222222222222222",
        "--- a/file",
        "+++ b/file",
        "@@ -0,0 +1 @@",
        "+sha256",
      ].join("\n"),
    ],
  ] as const;

  for (const [name, diff] of cases) {
    assert.equal((await parseUnifiedZeroDiffChecked(diff)).complete, true, name);
  }
});

test("checked parser accepts normal Unicode and space path operands", async () => {
  const diff = [
    "diff --git a/space name/ユニコード.ts b/space name/ユニコード.ts",
    "index 1111111..2222222",
    "--- a/space name/ユニコード.ts",
    "+++ b/space name/ユニコード.ts",
    "@@ -0,0 +1 @@",
    "+portable",
  ].join("\n");

  assert.deepEqual(await parseUnifiedZeroDiffChecked(diff), {
    complete: true,
    added: [{ file: "space name/ユニコード.ts", line: 1, text: "portable" }],
  });
});
