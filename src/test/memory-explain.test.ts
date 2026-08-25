// src/test/memory-explain.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainContentHash, recordExplain } from "../core/memory.js";
import { loadMemory, parseMemoryRecord } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";

function freshPaths() {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-explain-"));
  return resolveRockyPaths();
}

test("recordExplain appends a parseable explain record", () => {
  const paths = freshPaths();
  const rec = recordExplain({
    cwd: "C:/proj", path: "src/a.ts", source: "agent:claude-code",
    code: "async because two awaited IO calls in sequence",
    business: "journal accepts DOCENTRY documents only",
    snippet: "const x = await load();",
  }, paths);
  assert.equal(rec.kind, "explain");
  assert.equal(typeof rec.contentHash, "string");
  const loaded = loadMemory(paths.memory, Date.now());
  const found = loaded.find((r) => r.kind === "explain");
  assert.ok(found && found.kind === "explain" && found.path === "src/a.ts");
});

test("free text is redacted and bounded", () => {
  const paths = freshPaths();
  const rec = recordExplain({
    cwd: "C:/proj", path: "src/a.ts", source: "agent:claude-code",
    code: "token ghp_1234567890abcdefghij1234567890abcdefgh in text " + "y".repeat(4000),
    business: "b",
  }, paths);
  assert.ok(!rec.code.includes("ghp_1234567890abcdefghij1234567890abcdefgh"));
  assert.ok(Buffer.byteLength(rec.code, "utf8") <= 1200);
});

test("parseMemoryRecord rejects malformed explain, accepts minimal", () => {
  assert.equal(parseMemoryRecord({ kind: "explain", id: "x" }), undefined);
  const ok = parseMemoryRecord({
    kind: "explain", id: "id-1", ts: 1, v: 1,
    cwd: "c", path: "p.ts", source: "agent:claude-code", code: "c", business: "b",
  });
  assert.ok(ok && ok.kind === "explain");
});

test("explainContentHash is stable under whitespace normalization", () => {
  assert.equal(explainContentHash("const  x=1;\n"), explainContentHash("const x=1;"));
  assert.notEqual(explainContentHash("const x=1;"), explainContentHash("const y=1;"));
});
