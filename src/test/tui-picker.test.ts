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

const swapping = (side: "A" | "B"): PickerState => ({
  open: true,
  markA: false,
  only: side,
  recA: recs[0],
  recB: recs[1],
  tsel: 0,
  tquery: "",
});

test("swapping one side hides the other side's record from the candidates", () => {
  assert.ok(!pickList(recs, swapping("A")).some((r) => r === recs[1]), "B stays out while A is swapped");
  assert.ok(!pickList(recs, swapping("B")).some((r) => r === recs[0]), "A stays out while B is swapped");
});

test("swapping A previews against the locked B and keeps it after enter", () => {
  let st = swapping("A");
  st = key(st, "down"); // candidates skip B, so idx 1 is recs[2]
  const preview = previewPair(st, recs);
  assert.equal(preview.a?.ts, recs[2].ts);
  assert.equal(preview.b, recs[1], "locked B previews unchanged");
  st = key(st, "enter");
  assert.equal(st.open, false);
  assert.equal(st.recA, recs[2]);
  assert.equal(st.recB, recs[1], "enter never touches the locked side");
});

test("swapping B replaces only B", () => {
  let st = key(swapping("B"), "down"); // candidates skip A, so idx 1 is recs[2]
  st = key(st, "enter");
  assert.equal(st.open, false);
  assert.equal(st.recA, recs[0], "A survives a B swap");
  assert.equal(st.recB, recs[2]);
});

test("esc during a swap closes with the original pair intact", () => {
  let st = key(swapping("A"), "char", "p");
  st = key(st, "esc");
  assert.equal(st.tquery, "", "query clears first");
  assert.equal(st.open, true);
  st = key(st, "esc");
  assert.equal(st.open, false);
  assert.equal(st.recA, recs[0]);
  assert.equal(st.recB, recs[1]);
});

// only recs[1] shares lines with recs[0]; the rest touched the same file elsewhere
const sameLines = (a: any, b: any) => (a === recs[0] || b === recs[0] ? a === recs[1] || b === recs[1] : false);

test("strict keeps only the candidates that touched the same lines", () => {
  const locked: PickerState = { ...open(), markA: true, recA: recs[0], strict: true };
  const strictList = pickList(recs, locked, sameLines);
  assert.deepEqual(strictList, [recs[1]]);
  const looseList = pickList(recs, { ...locked, strict: false }, sameLines);
  assert.equal(looseList.length, recs.length - 1, "loose still hears the whole file");
});

test("strict does nothing before a side is locked", () => {
  const st: PickerState = { ...open(), strict: true };
  assert.equal(pickList(recs, st, sameLines).length, recs.length);
});

test("tab toggles strict and re-seats the cursor", () => {
  let st = key({ ...open(), tsel: 3 }, "tab");
  assert.equal(st.strict, true);
  assert.equal(st.tsel, 0);
  st = key(st, "tab");
  assert.equal(st.strict, false);
});

test("locking A under strict seats the cursor inside the filtered menu", () => {
  const st = updatePicker({ ...open(), strict: true }, recs, { name: "enter" } as any, sameLines);
  assert.equal(st.markA, true);
  assert.equal(st.recA, recs[0]);
  assert.equal(pickList(recs, st, sameLines)[st.tsel], recs[1]);
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

