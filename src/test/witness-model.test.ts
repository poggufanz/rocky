import test from "node:test";
import assert from "node:assert/strict";
import {
  groupMomentsByChange,
  type DiffRow,
} from "../core/compare-data.js";

interface FakeMoment {
  id: string;
  reason?: string;
  diff?: { commit?: string; stored?: boolean; after?: boolean; prior?: boolean; rows: DiffRow[] } | undefined;
}

const plus = (t: string): DiffRow => ({ k: "+", n: 1, t });
const msg = (t: string): DiffRow => ({ k: "m", t });
const commitDiff = (commit: string, extra: object = {}) => ({ commit, rows: [plus("x")], ...extra });

test("one commit shared by many moments renders one change", () => {
  const moments: FakeMoment[] = [
    { id: "a", reason: "first", diff: commitDiff("abc", { after: true }) },
    { id: "b", reason: "second", diff: commitDiff("abc", { after: true }) },
  ];
  const out = groupMomentsByChange(moments);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0]?.commit, "abc");
  assert.equal(out.changes[0]?.epistemic, "after");
  assert.deepEqual(out.changes[0]?.witnesses.map((w) => w.id), ["a", "b"]);
  assert.equal(out.unattributed.length, 0);
});

test("distinct commits stay separate in stable order", () => {
  const moments: FakeMoment[] = [
    { id: "a", diff: commitDiff("ccc", { prior: true }) },
    { id: "b", diff: commitDiff("aaa", { prior: true }) },
  ];
  const out = groupMomentsByChange(moments);
  assert.deepEqual(out.changes.map((c) => c.commit), ["ccc", "aaa"]);
});

test("same sha with different claims stays split", () => {
  const moments: FakeMoment[] = [
    { id: "a", diff: commitDiff("abc", { prior: true }) },
    { id: "b", diff: commitDiff("abc", { after: true }) },
  ];
  const out = groupMomentsByChange(moments);
  assert.equal(out.changes.length, 2);
});

test("exact-sha anchor without flags is committed evidence", () => {
  const out = groupMomentsByChange([{ id: "a", diff: commitDiff("abc") }]);
  assert.equal(out.changes[0]?.epistemic, "committed");
});

test("uncommitted moments form one transient group", () => {
  const out = groupMomentsByChange([
    { id: "a", diff: commitDiff("uncommitted") },
    { id: "b", diff: commitDiff("uncommitted") },
  ]);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0]?.epistemic, "uncommitted");
  assert.equal(out.changes[0]?.commit, "uncommitted");
});

test("identical snapshots group, different snapshots split", () => {
  const snap = (t: string) => ({ rows: [{ k: "@", t: "@@ -1 +1 @@" } as DiffRow, plus(t)], stored: true });
  const same = groupMomentsByChange([
    { id: "a", diff: snap("x") },
    { id: "b", diff: snap("x") },
  ]);
  assert.equal(same.changes.length, 1);
  assert.equal(same.changes[0]?.epistemic, "recorded");
  const split = groupMomentsByChange([
    { id: "a", diff: snap("x") },
    { id: "b", diff: snap("y") },
  ]);
  assert.equal(split.changes.length, 2);
});

test("placeholder-only moments become unattributed with reason intact", () => {
  const out = groupMomentsByChange([
    { id: "a", reason: "why", diff: { rows: [msg("(no change to this file before this moment)")] } },
    { id: "b", reason: "bare" },
  ]);
  assert.equal(out.changes.length, 0);
  assert.deepEqual(out.unattributed.map((w) => w.id), ["a", "b"]);
  assert.equal(out.unattributed[0]?.reason, "why");
});
