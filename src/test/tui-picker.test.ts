import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionItems, pickList, updatePicker, previewPair, type PickerState } from "../ui/tui/surface/picker.js";

const MIN = 60_000;
const R = (i: number, ts: number, intent?: string, machine = false, summary?: string) =>
  ({ kind: "triple", ts, cwd: "/r", source: "", machine, intent, summary } as any);
// newest-first, two sessions split by a 31-minute gap
const recs = [R(0, 100 * MIN), R(1, 99 * MIN), R(2, 60 * MIN), R(3, 59 * MIN, "publish tag pin"), R(4, 58 * MIN, undefined, true, "Agent review finished")];
const open = (): PickerState => ({ open: true, markA: false, tsel: 0, tquery: "" });
const key = (st: PickerState, name: string, ch?: string) =>
  updatePicker(st, recs, (ch !== undefined ? { name: "char", ch } : { name }) as any);

test("session headers split on the 30-minute gap", () => {
  const items = sessionItems(recs);
  const hdrs = items.filter((i) => i.hdr !== undefined);
  assert.equal(hdrs.length, 2);
  assert.equal(hdrs[1].n, 3);
});

test("phase-1 cursor previews A; lock moves cursor to A's neighbor", () => {
  let st = open();
  st = key(st, "down");                            // cursor on idx 1
  assert.equal(previewPair(st, recs).a?.ts, 99 * MIN);
  st = key(st, "enter");                           // lock A = idx 1
  assert.equal(st.markA, true);
  assert.equal(previewPair(st, recs).b?.ts, 100 * MIN, "cursor lands on newer neighbor");
});

test("a locked A never appears in the candidate list", () => {
  let st = open();
  st = key(st, "enter");                           // lock A = idx 0
  assert.ok(!pickList(recs, st).some((r) => r.ts === 100 * MIN));
});

test("esc unwinds one phase at a time; query clears first", () => {
  let st = open();
  st = key(st, "enter");                           // phase 2
  st = key(st, "char", "p");
  st = key(st, "esc");
  assert.equal(st.tquery, "");
  assert.equal(st.markA, true);
  st = key(st, "esc");
  assert.equal(st.markA, false);
  st = key(st, "esc");
  assert.equal(st.open, false);
});

test("session jump lands on each group's first record", () => {
  let st = open();
  st = key(st, "right");
  const items = sessionItems(recs);
  const secondStart = items.findIndex((i) => i.hdr === 2);
  assert.equal(st.tsel, items[secondStart + 1].idx);
});

test("intent search matches agent records only through their summary", () => {
  let st = { ...open(), tquery: "review" };
  const l = pickList(recs, st);
  assert.equal(l.length, 1);
  assert.equal(l[0].summary, "Agent review finished");
  const none = pickList(recs, { ...open(), tquery: "task-id" });
  assert.equal(none.length, 0, "raw envelope text is not searchable");
});

test("left arrow jumps backward between session headers", () => {
  let st = open();
  st = key(st, "right"); // jump to session 2 start (idx 2)
  assert.equal(st.tsel, 2);
  st = key(st, "left");  // jump back to session 1 start (idx 0)
  assert.equal(st.tsel, 0);
});

test("phase-2 enter locks B and closes picker with both recs set", () => {
  let st = open();
  st = key(st, "enter"); // lock A = idx 0 (100*MIN)
  assert.equal(st.markA, true);
  st = key(st, "enter"); // lock B = candidate idx 0 (99*MIN)
  assert.equal(st.open, false);
  assert.equal(st.recB?.ts, 99 * MIN);
});

test("backspace and paste update picker search query and reset tsel", () => {
  let st = open();
  st = key(st, "char", "a");
  st = key(st, "char", "b");
  assert.equal(st.tquery, "ab");
  st = updatePicker(st, recs, { name: "paste", text: "c" });
  assert.equal(st.tquery, "abc");
  st = key(st, "backspace");
  assert.equal(st.tquery, "ab");
});

