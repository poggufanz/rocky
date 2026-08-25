// src/test/explain-extract.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_EXPLAIN_SNIPPET_BYTES, snippetFromToolInput } from "../agent/explain-extract.js";

test("Write tool: content is the snippet", () => {
  assert.equal(snippetFromToolInput("Write", { file_path: "a.ts", content: "const x = 1;" }), "const x = 1;");
});

test("Edit tool: new_string is the snippet", () => {
  assert.equal(snippetFromToolInput("Edit", { file_path: "a.ts", old_string: "old", new_string: "new code" }), "new code");
});

test("MultiEdit tool: all edits[] new_strings joined with newline", () => {
  const input = { file_path: "a.ts", edits: [{ old_string: "a", new_string: "first" }, { old_string: "b", new_string: "second" }] };
  assert.equal(snippetFromToolInput("MultiEdit", input), "first\nsecond");
});

test("MultiEdit tolerates malformed edits entries", () => {
  const input = { file_path: "a.ts", edits: [{ new_string: "ok" }, null, { new_string: 7 }, "junk"] };
  assert.equal(snippetFromToolInput("MultiEdit", input), "ok");
});

test("unknown tool or non-object input returns undefined", () => {
  assert.equal(snippetFromToolInput("Read", { file_path: "a.ts" }), undefined);
  assert.equal(snippetFromToolInput("Write", null), undefined);
  assert.equal(snippetFromToolInput("Write", { file_path: "a.ts" }), undefined);
});

test("snippet is truncated to MAX_EXPLAIN_SNIPPET_BYTES of UTF-8", () => {
  const big = "x".repeat(MAX_EXPLAIN_SNIPPET_BYTES * 2);
  const out = snippetFromToolInput("Write", { file_path: "a.ts", content: big });
  assert.ok(out !== undefined && Buffer.byteLength(out, "utf8") <= MAX_EXPLAIN_SNIPPET_BYTES);
});
