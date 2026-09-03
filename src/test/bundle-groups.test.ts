import test from "node:test";
import assert from "node:assert/strict";
import { bundleGroups, splitRowsByFile, BUNDLE_MAX_FILES } from "../core/bundle-groups.js";
import type { CompareRec } from "../core/compare-data.js";
import { parsePatch } from "../core/compare-data.js";

function rec(over: Partial<CompareRec> = {}): CompareRec {
  return { kind: "triple", ts: 1000, cwd: "/r", source: "hook", machine: false, ...over };
}

test("one commit across two files becomes one bundle", () => {
  const diff = { commit: "abc1234", rows: parsePatch("diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b") };
  const { bundles, unattributed } = bundleGroups([
    { path: "/r/x.ts", repo: "r", rec: rec(), diff },
    { path: "/r/y.ts", repo: "r", rec: rec(), diff: { commit: "abc1234", rows: parsePatch("diff --git a/y.ts b/y.ts\n@@ -5 +5 @@\n-c\n+d") } },
  ]);
  assert.equal(unattributed.length, 0);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0]?.commit, "abc1234");
  assert.equal(bundles[0]?.files.length, 2);
  assert.equal(bundles[0]?.witnessCount, 2);
  assert.ok((bundles[0]?.files[0]?.spans.length ?? 0) > 0);
});

test("message-only diffs land in unattributed, never hidden", () => {
  const { bundles, unattributed } = bundleGroups([
    { path: "/r/x.ts", repo: "r", rec: rec(), diff: { rows: [{ k: "m", t: "(no change)" }] } },
  ]);
  assert.equal(bundles.length, 0);
  assert.equal(unattributed.length, 1);
});

test("splitRowsByFile splits a combined commit diff per file", () => {
  const rows = parsePatch("diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.ts b/y.ts\n@@ -2 +2 @@\n-c\n+d");
  const byFile = splitRowsByFile(rows);
  assert.equal(byFile.size, 2);
  assert.ok((byFile.get("x.ts")?.length ?? 0) > 0);
  assert.ok((byFile.get("y.ts")?.length ?? 0) > 0);
});

test("bundle caps files at BUNDLE_MAX_FILES and says so", () => {
  const inputs = Array.from({ length: BUNDLE_MAX_FILES + 5 }, (_, i) => ({
    path: `/r/f${i}.ts`,
    repo: "r",
    rec: rec(),
    diff: { commit: "abc1234", rows: parsePatch(`diff --git a/f${i}.ts b/f${i}.ts\n@@ -1 +1 @@\n-a\n+b`) },
  }));
  const { bundles } = bundleGroups(inputs);
  assert.equal(bundles[0]?.files.length, BUNDLE_MAX_FILES);
  assert.equal(bundles[0]?.truncated, true);
  assert.equal(bundles[0]?.witnessCount, BUNDLE_MAX_FILES + 5);
});

test("uncommitted diffs group into uncommitted bundle with epistemic uncommitted", () => {
  const { bundles } = bundleGroups([
    { path: "/r/x.ts", repo: "r", rec: rec({ ts: 1000 }), diff: { commit: "uncommitted", rows: parsePatch("diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b") } },
    { path: "/r/y.ts", repo: "r", rec: rec({ ts: 2000 }), diff: { commit: "uncommitted", rows: parsePatch("diff --git a/y.ts b/y.ts\n@@ -1 +1 @@\n-c\n+d") } },
  ]);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0]?.key, "uncommitted");
  assert.equal(bundles[0]?.commit, "uncommitted");
  assert.equal(bundles[0]?.epistemic, "uncommitted");
  assert.equal(bundles[0]?.ts, 2000);
});

test("diff without commit groups by snapshot text with epistemic recorded", () => {
  const patch = "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b";
  const { bundles } = bundleGroups([
    { path: "/r/x.ts", repo: "r", rec: rec(), diff: { rows: parsePatch(patch) } },
  ]);
  assert.equal(bundles.length, 1);
  assert.ok(bundles[0]?.key.startsWith("recorded-snapshot:\n"));
  assert.equal(bundles[0]?.commit, undefined);
  assert.equal(bundles[0]?.epistemic, "recorded");
});

test("same file witnessed multiple times updates ts and witnessCount without duplicating file", () => {
  const diff = { commit: "abc1234", rows: parsePatch("diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b") };
  const { bundles } = bundleGroups([
    { path: "/r/x.ts", repo: "r", rec: rec({ ts: 1000 }), diff },
    { path: "/r/x.ts", repo: "r", rec: rec({ ts: 5000 }), diff },
  ]);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0]?.files.length, 1);
  assert.equal(bundles[0]?.witnessCount, 2);
  assert.equal(bundles[0]?.ts, 5000);
});

test("epistemic maps correctly for stored, after, prior, committed", () => {
  const p = parsePatch("diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b");
  const { bundles } = bundleGroups([
    { path: "/r/x.ts", repo: "r", rec: rec(), diff: { commit: "c1", stored: true, rows: p } },
    { path: "/r/x.ts", repo: "r", rec: rec(), diff: { commit: "c2", after: true, rows: p } },
    { path: "/r/x.ts", repo: "r", rec: rec(), diff: { commit: "c3", prior: true, rows: p } },
    { path: "/r/x.ts", repo: "r", rec: rec(), diff: { commit: "c4", rows: p } },
  ]);
  assert.equal(bundles.length, 4);
  assert.equal(bundles[0]?.epistemic, "recorded");
  assert.equal(bundles[0]?.key, "recorded:c1");
  assert.equal(bundles[1]?.epistemic, "after");
  assert.equal(bundles[1]?.key, "after:c2");
  assert.equal(bundles[2]?.epistemic, "prior");
  assert.equal(bundles[2]?.key, "prior:c3");
  assert.equal(bundles[3]?.epistemic, "committed");
  assert.equal(bundles[3]?.key, "committed:c4");
});

test("splitRowsByFile assigns leading rows to (unknown)", () => {
  const rows = [
    { k: "m" as const, t: "leading message" },
    ...parsePatch("diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b"),
  ];
  const byFile = splitRowsByFile(rows);
  assert.ok(byFile.has("(unknown)"));
  assert.equal(byFile.get("(unknown)")?.length, 1);
  assert.ok(byFile.has("x.ts"));
});
