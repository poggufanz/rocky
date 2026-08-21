import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  update,
  visibleRows,
  type DashRow,
  type Key,
} from "../ui/tui/state.js";

function makeRows(n: number): DashRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    badge: "fail" as const,
    label: `row ${i}`,
    ts: i * 1000,
    kind: "failure",
    json: JSON.stringify({ index: i }),
  }));
}

function loadedState(n = 10, cols = 100, rows = 30) {
  const initial = initialState(cols, rows);
  return update(initial, {
    type: "data",
    rows: makeRows(n),
    coverageLine: "coverage: 85%",
  });
}

const keyEvent = (name: Key["name"]) => ({
  type: "key" as const,
  key: { name } as Key,
});

const charEvent = (ch: string) => ({
  type: "key" as const,
  key: { name: "char" as const, ch },
});

test("initialState initializes default fields and stacked layout threshold", () => {
  const sWide = initialState(100, 30);
  assert.equal(sWide.cols, 100);
  assert.equal(sWide.rows, 30);
  assert.equal(sWide.stacked, false);
  assert.equal(sWide.focus, "list");
  assert.equal(sWide.inspectorOpen, false);
  assert.deepEqual(sWide.allRows, []);
  assert.equal(sWide.selected, 0);
  assert.equal(sWide.filter, "all");
  assert.deepEqual(sWide.search, { active: false, query: "" });
  assert.equal(sWide.tab, "info");
  assert.equal(sWide.help, false);
  assert.equal(sWide.fullDiff, false);
  assert.equal(sWide.coverageLine, "");
  assert.equal(sWide.quit, false);
  assert.equal(sWide.reloadRequested, false);
  assert.deepEqual(sWide.diff, { state: "idle", lines: [] });
  assert.deepEqual(sWide.scroll, { inspector: 0 });

  const sNarrow = initialState(79, 30);
  assert.equal(sNarrow.stacked, true);

  const sShort = initialState(100, 19);
  assert.equal(sShort.stacked, true);

  const sBoundary = initialState(80, 20);
  assert.equal(sBoundary.stacked, false);
});

test("j/k move selection and clamp at both ends", () => {
  let s = loadedState(3);
  assert.equal(s.selected, 0);
  s = update(s, charEvent("j"));
  assert.equal(s.selected, 1);
  s = update(s, charEvent("j"));
  assert.equal(s.selected, 2);
  s = update(s, charEvent("j"));
  assert.equal(s.selected, 2, "clamped at bottom");
  s = update(s, charEvent("k"));
  assert.equal(s.selected, 1);
  s = update(s, charEvent("k"));
  assert.equal(s.selected, 0);
  s = update(s, charEvent("k"));
  assert.equal(s.selected, 0, "clamped at top");

  // arrow keys down and up
  s = update(s, keyEvent("down"));
  assert.equal(s.selected, 1);
  s = update(s, keyEvent("up"));
  assert.equal(s.selected, 0);
});

test("g/G jump to start/end, ctrl-d/ctrl-u half-page against viewport rows", () => {
  let s = loadedState(50, 100, 30);
  // half page: Math.max(1, Math.floor((30 - 6) / 2)) = 12
  s = update(s, charEvent("G"));
  assert.equal(s.selected, 49, "G jumps to last item");
  s = update(s, charEvent("g"));
  assert.equal(s.selected, 0, "g jumps to first item");

  s = update(s, keyEvent("ctrl-d"));
  assert.equal(s.selected, 12, "ctrl-d advances half page (12 rows)");

  s = update(s, keyEvent("ctrl-d"));
  assert.equal(s.selected, 24);

  s = update(s, keyEvent("ctrl-u"));
  assert.equal(s.selected, 12);

  s = update(s, keyEvent("ctrl-u"));
  assert.equal(s.selected, 0);

  s = update(s, keyEvent("ctrl-u"));
  assert.equal(s.selected, 0, "ctrl-u clamps at top");
});

test("tab and shifttab cycle pane focus both directions", () => {
  let s = loadedState();
  assert.equal(s.focus, "list");
  s = update(s, keyEvent("tab"));
  assert.equal(s.focus, "inspector");
  s = update(s, keyEvent("tab"));
  assert.equal(s.focus, "list");
  s = update(s, keyEvent("shifttab"));
  assert.equal(s.focus, "inspector");
  s = update(s, keyEvent("shifttab"));
  assert.equal(s.focus, "list");
});

test("enter key opens inspector and sets focus to inspector", () => {
  let s = loadedState();
  assert.equal(s.focus, "list");
  assert.equal(s.inspectorOpen, false);
  s = update(s, keyEvent("enter"));
  assert.equal(s.focus, "inspector");
  assert.equal(s.inspectorOpen, true);
});

test("q and ctrl-c set quit flag; r sets reloadRequested", () => {
  const s = loadedState();
  assert.equal(update(s, charEvent("q")).quit, true);
  assert.equal(update(s, keyEvent("ctrl-c")).quit, true);

  const reloaded = update(s, charEvent("r"));
  assert.equal(reloaded.reloadRequested, true);

  const dataCleared = update(reloaded, {
    type: "data",
    rows: makeRows(5),
    coverageLine: "cov",
  });
  assert.equal(dataCleared.reloadRequested, false);
});

test("selection change resets inspector scroll and diff state", () => {
  let s = loadedState(5);
  s = update(s, { type: "diff-ready", rowId: "r0", lines: ["+added", "-removed"] });
  assert.equal(s.diff.state, "ready");
  assert.equal(s.diff.lines.length, 2);

  // Set scroll offset
  s = { ...s, scroll: { inspector: 10 } };

  // Move selection
  s = update(s, charEvent("j"));
  assert.equal(s.selected, 1);
  assert.equal(s.diff.state, "idle", "diff reset on selection move");
  assert.deepEqual(s.diff.lines, []);
  assert.equal(s.scroll.inspector, 0, "scroll reset on selection move");
});

test("diff-loading and diff-ready lifecycle with stale result discarding", () => {
  let s = loadedState(5);
  assert.equal(s.diff.state, "idle");

  s = update(s, { type: "diff-loading", rowId: "r0" });
  assert.equal(s.diff.state, "loading");
  assert.equal(s.diff.rowId, "r0");

  // diff-loading does not overwrite when already loading
  s = update(s, { type: "diff-loading", rowId: "r1" });
  assert.equal(s.diff.rowId, "r0");

  // diff-ready for a different rowId is ignored as stale
  const stale = update(s, { type: "diff-ready", rowId: "r99", lines: ["stale"] });
  assert.equal(stale.diff.state, "loading");

  // diff-ready for selected rowId succeeds
  const ready = update(s, { type: "diff-ready", rowId: "r0", lines: ["line1", "line2"] });
  assert.equal(ready.diff.state, "ready");
  assert.equal(ready.diff.rowId, "r0");
  assert.deepEqual(ready.diff.lines, ["line1", "line2"]);
});

test("resize below 80x20 sets stacked mode and updates dimensions", () => {
  let s = loadedState(5, 100, 30);
  assert.equal(s.stacked, false);

  s = update(s, { type: "resize", cols: 70, rows: 18 });
  assert.equal(s.cols, 70);
  assert.equal(s.rows, 18);
  assert.equal(s.stacked, true);

  s = update(s, { type: "resize", cols: 120, rows: 40 });
  assert.equal(s.cols, 120);
  assert.equal(s.rows, 40);
  assert.equal(s.stacked, false);
});

test("visibleRows filters rows by kind according to active filter", () => {
  const allRows: DashRow[] = [
    { id: "1", badge: "fail", label: "fail 1", ts: 1, kind: "failure", json: "{}" },
    { id: "2", badge: "fix", label: "fix 1", ts: 2, kind: "fix", json: "{}" },
    { id: "3", badge: "why", label: "triple 1", ts: 3, kind: "triple", json: "{}" },
    { id: "4", badge: "why", label: "rationale 1", ts: 4, kind: "rationale", json: "{}" },
    { id: "5", badge: "why", label: "note 1", ts: 5, kind: "note", json: "{}" },
    { id: "6", badge: "guard", label: "session 1", ts: 6, kind: "brief_run", json: "{}" },
    { id: "7", badge: "guard", label: "inv 1", ts: 7, kind: "invariant_touch", json: "{}" },
  ];

  let s = initialState(100, 30);
  s = update(s, { type: "data", rows: allRows, coverageLine: "" });

  // all
  assert.equal(visibleRows(s).length, 7);

  // failures (failure + fix)
  s = { ...s, filter: "failures" };
  assert.deepEqual(visibleRows(s).map((r: DashRow) => r.id), ["1", "2"]);

  // triples (triple + rationale + note)
  s = { ...s, filter: "triples" };
  assert.deepEqual(visibleRows(s).map((r: DashRow) => r.id), ["3", "4", "5"]);

  // sessions (brief_run)
  s = { ...s, filter: "sessions" };
  assert.deepEqual(visibleRows(s).map((r: DashRow) => r.id), ["6"]);

  // invariants (invariant_touch)
  s = { ...s, filter: "invariants" };
  assert.deepEqual(visibleRows(s).map((r: DashRow) => r.id), ["7"]);
});

test("data event clamps selected index when visible rows shrink", () => {
  let s = loadedState(10);
  s = update(s, charEvent("G"));
  assert.equal(s.selected, 9);

  // New data with only 3 rows
  s = update(s, { type: "data", rows: makeRows(3), coverageLine: "new cov" });
  assert.equal(s.selected, 2, "clamped to new max index");
  assert.equal(s.diff.state, "idle");
  assert.equal(s.scroll.inspector, 0);

  // New data with 0 rows
  s = update(s, { type: "data", rows: [], coverageLine: "" });
  assert.equal(s.selected, 0, "clamped to 0 when empty");
});
