import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiffLoader } from "../ui/tui/diff.js";
import type { DashRow } from "../ui/tui/state.js";

function makeRow(id: string, ts = 1000): DashRow {
  return {
    id,
    badge: "fail",
    label: `Row ${id}`,
    ts,
    kind: "failure",
    json: "{}",
  };
}

test("diff loader debounces: no fetch before window elapses, then diff-loading, then diff-ready", () => {
  const calls: { ts: number }[] = [];
  const loader = createDiffLoader({
    resolve: (q) => {
      calls.push(q);
      return [`+diff for ${q.ts}`];
    },
    debounceMs: 150,
  });

  const row = makeRow("r1", 1234);
  loader.select(row, 1000);

  // Before debounce window elapses
  assert.equal(loader.due(1000), undefined);
  assert.equal(loader.due(1100), undefined);
  assert.equal(loader.due(1149), undefined);
  assert.equal(calls.length, 0);

  // At/after debounce window: 1st call returns diff-loading
  const event1 = loader.due(1150);
  assert.deepEqual(event1, { type: "diff-loading", rowId: "r1" });
  assert.equal(calls.length, 0);

  // Next due() resolves diff and returns diff-ready
  const event2 = loader.due(1150);
  assert.deepEqual(event2, {
    type: "diff-ready",
    rowId: "r1",
    lines: ["+diff for 1234"],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ts: 1234 });

  // Subsequent due() returns undefined since pending work is done
  assert.equal(loader.due(1151), undefined);
});

test("moving selection inside debounce window cancels prior request and resets timer", () => {
  const calls: { ts: number }[] = [];
  const loader = createDiffLoader({
    resolve: (q) => {
      calls.push(q);
      return [`diff-${q.ts}`];
    },
    debounceMs: 150,
  });

  loader.select(makeRow("r1", 100), 1000);
  assert.equal(loader.due(1100), undefined); // 100ms in

  // Move to r2 at 1100
  loader.select(makeRow("r2", 200), 1100);

  // At 1150, r1's 150ms would have passed, but r1 was cancelled, r2 only at 50ms
  assert.equal(loader.due(1150), undefined);
  assert.equal(loader.due(1249), undefined);
  assert.equal(calls.length, 0);

  // At 1250, r2's 150ms has elapsed
  assert.deepEqual(loader.due(1250), { type: "diff-loading", rowId: "r2" });
  assert.deepEqual(loader.due(1250), {
    type: "diff-ready",
    rowId: "r2",
    lines: ["diff-200"],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ts: 200 });
});

test("moving selection after diff-loading announced cancels resolution of prior row", () => {
  const calls: { ts: number }[] = [];
  const loader = createDiffLoader({
    resolve: (q) => {
      calls.push(q);
      return [`diff-${q.ts}`];
    },
    debounceMs: 100,
  });

  loader.select(makeRow("r1", 100), 1000);
  assert.deepEqual(loader.due(1100), { type: "diff-loading", rowId: "r1" });

  // Before second due() resolves r1, user moves to r2
  loader.select(makeRow("r2", 200), 1110);
  assert.equal(calls.length, 0, "r1 resolve was never called");

  // r2 debounce window is 1110 + 100 = 1210
  assert.equal(loader.due(1200), undefined);
  assert.deepEqual(loader.due(1210), { type: "diff-loading", rowId: "r2" });
  assert.deepEqual(loader.due(1210), {
    type: "diff-ready",
    rowId: "r2",
    lines: ["diff-200"],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ts: 200 });
});

test("cache hit returns diff-ready immediately without calling resolve again", () => {
  let callCount = 0;
  const loader = createDiffLoader({
    resolve: (q) => {
      callCount++;
      return [`diff-for-${q.ts}`];
    },
    debounceMs: 150,
  });

  const row1 = makeRow("r1", 1000);

  // 1. Fetch r1 into cache
  loader.select(row1, 0);
  loader.due(150); // loading
  loader.due(150); // ready
  assert.equal(callCount, 1);

  // 2. Select r1 again -> should return diff-ready immediately on due(0)
  loader.select(row1, 200);
  const event = loader.due(200);
  assert.deepEqual(event, {
    type: "diff-ready",
    rowId: "r1",
    lines: ["diff-for-1000"],
  });
  assert.equal(callCount, 1, "resolve was not called again");

  // After cache hit, pending is cleared
  assert.equal(loader.due(200), undefined);
});

test("selecting undefined clears pending work", () => {
  const loader = createDiffLoader({
    resolve: () => ["diff"],
    debounceMs: 150,
  });

  loader.select(makeRow("r1"), 1000);
  loader.select(undefined, 1050);

  assert.equal(loader.due(1200), undefined);
});

test("LRU eviction evicts oldest entry when exceeding cacheSize", () => {
  const loader = createDiffLoader({
    resolve: (q) => [`diff-${q.ts}`],
    debounceMs: 10,
    cacheSize: 2,
  });

  // Populate cache with r1, r2
  const r1 = makeRow("r1", 1);
  const r2 = makeRow("r2", 2);
  const r3 = makeRow("r3", 3);

  loader.select(r1, 0);
  loader.due(10);
  loader.due(10); // r1 cached

  loader.select(r2, 20);
  loader.due(30);
  loader.due(30); // r2 cached

  // Touch r1 to make r1 more recently used than r2
  loader.select(r1, 40);
  const hit1 = loader.due(40);
  assert.deepEqual(hit1, { type: "diff-ready", rowId: "r1", lines: ["diff-1"] });

  // Add r3 -> cache has [r1, r2], touching r1 made order: r2 (oldest), r1 (newest).
  // Adding r3 should evict r2.
  loader.select(r3, 50);
  loader.due(60);
  loader.due(60); // r3 cached, r2 evicted

  // r1 should still be cached (immediate hit)
  loader.select(r1, 70);
  assert.deepEqual(loader.due(70), { type: "diff-ready", rowId: "r1", lines: ["diff-1"] });

  // r2 was evicted -> selecting r2 requires debounce window
  loader.select(r2, 80);
  assert.equal(loader.due(80), undefined, "r2 is not in cache");
  assert.deepEqual(loader.due(90), { type: "diff-loading", rowId: "r2" });
  assert.deepEqual(loader.due(90), { type: "diff-ready", rowId: "r2", lines: ["diff-2"] });
});

test("default options use debounceMs=150 and cacheSize=16", () => {
  let callCount = 0;
  const loader = createDiffLoader({
    resolve: (q) => {
      callCount++;
      return [`diff-${q.ts}`];
    },
  });

  // Test default debounce = 150
  loader.select(makeRow("r0", 0), 0);
  assert.equal(loader.due(149), undefined);
  assert.deepEqual(loader.due(150), { type: "diff-loading", rowId: "r0" });
  assert.deepEqual(loader.due(150), { type: "diff-ready", rowId: "r0", lines: ["diff-0"] });

  // Fill up to 16 items (r0..r15)
  for (let i = 1; i < 16; i++) {
    loader.select(makeRow(`r${i}`, i), i * 200);
    loader.due(i * 200 + 150);
    loader.due(i * 200 + 150);
  }
  assert.equal(callCount, 16);

  // r0 should still be in cache (total 16 items)
  loader.select(makeRow("r0", 0), 5000);
  assert.deepEqual(loader.due(5000), { type: "diff-ready", rowId: "r0", lines: ["diff-0"] });
  assert.equal(callCount, 16);

  // Now add 17th item -> evicts the oldest (which is now r1, because r0 was touched)
  loader.select(makeRow("r16", 16), 6000);
  loader.due(6150);
  loader.due(6150);
  assert.equal(callCount, 17);

  // r1 was evicted
  loader.select(makeRow("r1", 1), 7000);
  assert.equal(loader.due(7000), undefined, "r1 was evicted");
});
