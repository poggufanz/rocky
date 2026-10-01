import test from "node:test";
import assert from "node:assert/strict";
import {
  diffFor,
  getCachedDiff,
  clearDiffCache,
  type CompareRec,
} from "../core/compare-data.js";

type DiffIo = Parameters<typeof diffFor>[2];

function baseIo(overrides: Partial<DiffIo> = {}): DiffIo {
  return {
    exists: () => true,
    lsFiles: () => ["f.ts"],
    resolve: () => undefined,
    lastShaBefore: () => "",
    firstShaAfter: () => "",
    ...overrides,
  };
}

function rationaleRec(overrides: Partial<CompareRec> = {}): CompareRec {
  return { kind: "rationale", ts: 1_000_000, cwd: "/r", source: "notify", machine: false, ...overrides };
}

test("rationale resolves via the first child after the base", () => {
  const io = baseIo({
    resolve: (opts) => opts.head === "child222"
      ? { commit: "child222", diff: "@@ -1 +1 @@\n-a\n+b" }
      : undefined,
    firstShaAfter: () => "child222",
  });
  const out = diffFor("/r/f.ts", rationaleRec({ baseHead: "base111" }), io);
  assert.equal(out.after, true);
  assert.equal(out.commit, "child222");
  assert.ok(out.rows.some((r) => r.k === "-"));
});

test("rationale without an attributable child keeps the old placeholder", () => {
  const out = diffFor("/r/f.ts", rationaleRec({}), baseIo());
  assert.deepEqual(out.rows.map((r) => r.t), ["(no change to this file before this moment)"]);
});

test("explain still resolves via lastShaBefore with prior flag", () => {
  const io = baseIo({
    resolve: (opts) => opts.head === "old999"
      ? { commit: "old999", diff: "@@ -1 +1 @@\n-x\n+y" }
      : undefined,
    lastShaBefore: () => "old999",
  });
  const rec: CompareRec = { kind: "explain", ts: 1_000_000, cwd: "/r", source: "agent:generic", machine: false };
  const out = diffFor("/r/f.ts", rec, io);
  assert.equal(out.prior, true);
  assert.equal(out.after, undefined);
  assert.equal(out.commit, "old999");
});

test("stored snapshot wins without touching git", () => {
  let calls = 0;
  const io = baseIo({
    resolve: () => { calls += 1; return undefined; },
    lastShaBefore: () => { calls += 1; return ""; },
    firstShaAfter: () => { calls += 1; return ""; },
  });
  const out = diffFor("/r/f.ts", rationaleRec({ baseHead: "abc1234", snapshot: "@@ -1 +1 @@\n-a\n+b" }), io);
  assert.equal(calls, 0);
  assert.equal(out.stored, true);
  assert.ok(out.rows.some((r) => r.k === "+"));
});

test("explain on a new file falls back to the child after the moment", () => {
  const io = baseIo({
    resolve: (opts) => opts.head === "child222"
      ? { commit: "child222", diff: "@@ -0,0 +1 @@\n+new" }
      : undefined,
    lastShaBefore: () => "",
    firstShaAfter: () => "child222",
  });
  const rec: CompareRec = { kind: "explain", ts: 1_000_000, cwd: "/r", source: "agent:generic", machine: false };
  const out = diffFor("/r/f.ts", rec, io);
  assert.equal(out.after, true);
  assert.equal(out.prior, undefined);
  assert.equal(out.commit, "child222");
  assert.ok(out.rows.some((r) => r.k === "+"));
});

test("explain on an old file still prefers prior over after", () => {
  const io = baseIo({
    resolve: (opts) => opts.head === "old999"
      ? { commit: "old999", diff: "@@ -1 +1 @@\n-x\n+y" }
      : opts.head === "child222"
        ? { commit: "child222", diff: "@@ -1 +1 @@\n-a\n+b" }
        : undefined,
    lastShaBefore: () => "old999",
    firstShaAfter: () => "child222",
  });
  const rec: CompareRec = { kind: "explain", ts: 1_000_000, cwd: "/r", source: "agent:generic", machine: false };
  const out = diffFor("/r/f.ts", rec, io);
  assert.equal(out.prior, true);
  assert.equal(out.after, undefined);
  assert.equal(out.commit, "old999");
});

test("getCachedDiff does not serve stale rows after clearDiffCache", () => {
  let n = 0;
  const io = baseIo({
    resolve: () => {
      n += 1;
      return n === 1 ? undefined : { commit: "abc", diff: "@@ -1 +1 @@\n-a\n+b" };
    },
  });
  const rec = rationaleRec({ ts: 7_000_000 });
  const first = getCachedDiff("/r/cache-probe-1.ts", rec, io);
  assert.equal(n, 1);
  assert.ok(first.rows.some((r) => r.k === "m"));
  const second = getCachedDiff("/r/cache-probe-1.ts", rec, io);
  assert.equal(n, 1, "second call must hit the cache");
  assert.deepEqual(second, first);
  clearDiffCache();
  const third = getCachedDiff("/r/cache-probe-1.ts", rec, io);
  assert.equal(n, 2, "after clear the diff must be recomputed");
  assert.ok(third.rows.some((r) => r.k === "+"));
});
