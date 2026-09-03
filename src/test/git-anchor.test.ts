import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMemoryRecord } from "../core/memory-read.js";

test("parseMemoryRecord keeps a valid git anchor on rationale", () => {
  const rec = parseMemoryRecord({
    kind: "rationale", id: "r1", ts: 1, v: 1, cwd: "/repo",
    agent: "generic", rationale_fidelity: "summary", source: "notify",
    excerpt: "why",
    git: { base: "abc123", dirty: true, snapshot: "@@ -1 +1 @@\n-a\n+b" },
  });
  if (!rec || rec.kind !== "rationale") throw new Error("expected a rationale record");
  assert.deepEqual(rec.git, { base: "abc123", dirty: true, snapshot: "@@ -1 +1 @@\n-a\n+b" });
});

test("parseMemoryRecord keeps a valid git anchor on explain", () => {
  const rec = parseMemoryRecord({
    kind: "explain", id: "e1", ts: 1, v: 1, cwd: "/repo",
    path: "src/a.ts", source: "agent:generic", code: "c", business: "b",
    git: { base: "unborn", dirty: true },
  });
  if (!rec || rec.kind !== "explain") throw new Error("expected an explain record");
  assert.deepEqual(rec.git, { base: "unborn", dirty: true });
});

test("parseMemoryRecord accepts legacy records without git", () => {
  const rec = parseMemoryRecord({
    kind: "rationale", id: "r2", ts: 1, v: 1, cwd: "/repo",
    agent: "generic", rationale_fidelity: "summary", source: "notify", excerpt: "why",
  });
  if (!rec || rec.kind !== "rationale") throw new Error("expected a rationale record");
  assert.equal("git" in rec, false);
});

test("parseMemoryRecord rejects malformed git anchors", () => {
  assert.equal(parseMemoryRecord({
    kind: "rationale", id: "r3", ts: 1, v: 1, cwd: "/repo",
    agent: "generic", rationale_fidelity: "summary", source: "notify", excerpt: "why",
    git: { base: 42 },
  }), undefined);
  assert.equal(parseMemoryRecord({
    kind: "explain", id: "e2", ts: 1, v: 1, cwd: "/repo",
    path: "src/a.ts", source: "agent:generic", code: "c", business: "b",
    git: { snapshot: "x".repeat(9000) },
  }), undefined);
});

test("recordRationale stores a bounded redacted git anchor", async () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-anchor-"));
  const { recordRationale } = await import("../core/memory.js");
  const token = "ghp_1234567890abcdefghij1234567890abcdefgh";
  // Position the token spanning across the 8192 MAX_GIT_SNAPSHOT_CHARS boundary:
  // 8180 'x' characters + space boundary (token starts at 8181, spans through 8224).
  const rec = recordRationale({
    cwd: "/repo", agent: "generic", rationale_fidelity: "summary", source: "notify",
    text: "why", files: ["src/a.ts"],
    git: {
      base: "abc123",
      dirty: true,
      snapshot: "x".repeat(8180) + " " + token + "\n" + "y".repeat(20000),
    },
  });
  assert.equal(rec.git?.base, "abc123");
  assert.equal(rec.git?.dirty, true);
  assert.ok(rec.git?.snapshot, "snapshot must exist");
  assert.ok(!rec.git.snapshot.includes("ghp_"), "snapshot must completely redact boundary-spanning secret without leaving fragments");
  assert.ok(rec.git.snapshot.includes("[redacted"), "snapshot should contain redaction placeholder");
  assert.ok(Buffer.byteLength(rec.git.snapshot, "utf8") <= 8192, "snapshot must be bounded");
});

test("recordExplain stores the anchor and omits it when absent", async () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-anchor2-"));
  const { recordExplain } = await import("../core/memory.js");
  const withGit = recordExplain({
    cwd: "/repo", path: "src/a.ts", source: "agent:generic", code: "c", business: "b",
    git: { base: "unborn", dirty: true },
  });
  assert.deepEqual(withGit.git, { base: "unborn", dirty: true });
  const withoutGit = recordExplain({
    cwd: "/repo", path: "src/a.ts", source: "agent:generic", code: "c", business: "b",
  });
  assert.equal("git" in withoutGit, false);
});
