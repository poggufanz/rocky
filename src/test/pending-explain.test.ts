import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_EXPLAIN_WINDOW_MS, spoolPendingSnippet, takePendingSnippet } from "../agent/pending-explain.js";

test("spool then take round-trips within the window and consumes the entry", () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-pend-"));
  const now = 1_756_000_000_000;
  spoolPendingSnippet("C:/p/src/a.ts", "const x = 1;", now);
  const hit = takePendingSnippet("C:/p/src/a.ts", now + 1000);
  assert.ok(hit && hit.snippet === "const x = 1;");
  assert.equal(takePendingSnippet("C:/p/src/a.ts", now + 2000), undefined); // consumed
});

test("stale entries beyond the window are not returned", () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-pend-"));
  const now = 1_756_000_000_000;
  spoolPendingSnippet("C:/p/src/a.ts", "old", now);
  assert.equal(takePendingSnippet("C:/p/src/a.ts", now + PENDING_EXPLAIN_WINDOW_MS + 1), undefined);
});

test("store is capped and newest wins per path", () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-pend-"));
  const now = 1_756_000_000_000;
  for (let i = 0; i < 40; i++) spoolPendingSnippet(`C:/p/f${i}.ts`, "s", now + i);
  spoolPendingSnippet("C:/p/f39.ts", "newest", now + 100);
  const hit = takePendingSnippet("C:/p/f39.ts", now + 200);
  assert.ok(hit && hit.snippet === "newest");
});
