import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  update,
  visibleRows,
  type DashRow,
  type Key,
  type DashState,
} from "../ui/tui/state.js";

function makeRows(): DashRow[] {
  return [
    { id: "1", badge: "fail", label: "fail 1", ts: 100, kind: "failure", json: "{}" },
    { id: "2", badge: "fix", label: "fix 1", ts: 200, kind: "fix", json: "{}" },
    { id: "3", badge: "why", label: "triple 1", ts: 300, kind: "triple", json: "{}" },
    { id: "4", badge: "why", label: "rationale 1", ts: 400, kind: "rationale", json: "{}" },
    { id: "5", badge: "why", label: "note 1", ts: 500, kind: "note", json: "{}" },
    { id: "6", badge: "guard", label: "session 1", ts: 600, kind: "brief_run", json: "{}" },
    { id: "7", badge: "guard", label: "inv 1", ts: 700, kind: "invariant_touch", json: "{}" },
  ];
}

function loadedState(cols = 100, rows = 30): DashState {
  const initial = initialState(cols, rows);
  return update(initial, {
    type: "data",
    rows: makeRows(),
    coverageLine: "coverage: 90%",
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

const pasteEvent = (text: string) => ({
  type: "key" as const,
  key: { name: "paste" as const, text },
});

test("f cycles filters and resets selection when focus is list", () => {
  let s = loadedState();
  // Select row 3
  s = update(s, charEvent("j"));
  s = update(s, charEvent("j"));
  s = update(s, charEvent("j"));
  assert.equal(s.selected, 3);
  assert.equal(s.filter, "all");
  assert.equal(visibleRows(s).length, 7);

  // Cycle 1: all -> failures
  s = update(s, charEvent("f"));
  assert.equal(s.filter, "failures");
  assert.equal(s.selected, 0, "selection reset to 0 on filter change");
  assert.equal(visibleRows(s).length, 2);

  // Cycle 2: failures -> triples
  s = update(s, charEvent("f"));
  assert.equal(s.filter, "triples");
  assert.equal(s.selected, 0);
  assert.equal(visibleRows(s).length, 3);

  // Cycle 3: triples -> sessions
  s = update(s, charEvent("f"));
  assert.equal(s.filter, "sessions");
  assert.equal(s.selected, 0);
  assert.equal(visibleRows(s).length, 1);

  // Cycle 4: sessions -> invariants
  s = update(s, charEvent("f"));
  assert.equal(s.filter, "invariants");
  assert.equal(s.selected, 0);
  assert.equal(visibleRows(s).length, 1);

  // Cycle 5: invariants -> all
  s = update(s, charEvent("f"));
  assert.equal(s.filter, "all");
  assert.equal(s.selected, 0);
  assert.equal(visibleRows(s).length, 7);

  // When focus is inspector, 'f' should NOT cycle filter
  s = update(s, keyEvent("enter"));
  assert.equal(s.focus, "inspector");
  s = update(s, charEvent("f"));
  assert.equal(s.filter, "all", "filter unchanged when inspector is focused");
});

test("[ and ] cycle inspector tabs with wrap-around in both directions", () => {
  let s = loadedState();
  assert.equal(s.tab, "info");

  // Cycle forward with ]
  s = update(s, charEvent("]"));
  assert.equal(s.tab, "rationale");
  s = update(s, charEvent("]"));
  assert.equal(s.tab, "diff");
  s = update(s, charEvent("]"));
  assert.equal(s.tab, "json");
  s = update(s, charEvent("]"));
  assert.equal(s.tab, "info", "wrapped around forward");

  // Cycle backward with [
  s = update(s, charEvent("["));
  assert.equal(s.tab, "json", "wrapped around backward");
  s = update(s, charEvent("["));
  assert.equal(s.tab, "diff");
  s = update(s, charEvent("["));
  assert.equal(s.tab, "rationale");
  s = update(s, charEvent("["));
  assert.equal(s.tab, "info");
});

test("search modal typing, backspace, confirmation, cancellation, and key isolation", () => {
  let s = loadedState();
  assert.deepEqual(s.search, { active: false, query: "" });

  // Open search with /
  s = update(s, charEvent("/"));
  assert.deepEqual(s.search, { active: true, query: "" });

  // Typing chars
  s = update(s, charEvent("t"));
  s = update(s, charEvent("e"));
  s = update(s, charEvent("s"));
  s = update(s, charEvent("t"));
  assert.deepEqual(s.search, { active: true, query: "test" });

  // Backspace
  s = update(s, keyEvent("backspace"));
  assert.deepEqual(s.search, { active: true, query: "tes" });

  // Keys like 'q', 'j', 'k', 'r' are captured as typing or swallowed, not triggering hotkeys
  s = update(s, charEvent("q"));
  assert.equal(s.quit, false, "q does not quit inside search");
  assert.equal(s.search.query, "tesq");

  s = update(s, charEvent("j"));
  assert.equal(s.selected, 0, "j does not move selection inside search");
  assert.equal(s.search.query, "tesqj");

  s = update(s, charEvent("r"));
  assert.equal(s.reloadRequested, false, "r does not request reload inside search");
  assert.equal(s.search.query, "tesqjr");

  // Non-char keys like tab or up/down are ignored in search
  const queryBefore = s.search.query;
  s = update(s, keyEvent("tab"));
  assert.equal(s.focus, "list", "tab does not switch focus inside search");
  assert.equal(s.search.query, queryBefore);

  // Enter confirms query and exits search mode
  s = update(s, keyEvent("enter"));
  assert.equal(s.search.active, false);
  assert.equal(s.search.query, "tesqjr", "query preserved on enter");

  // Re-open search with /: clears query and activates
  s = update(s, charEvent("/"));
  assert.deepEqual(s.search, { active: true, query: "" });
  s = update(s, charEvent("a"));
  s = update(s, charEvent("b"));
  assert.equal(s.search.query, "ab");

  // Esc cancels search: clears query and deactivates
  s = update(s, keyEvent("esc"));
  assert.deepEqual(s.search, { active: false, query: "" });
});

test("search sanitizes ASCII controls and enforces 120 char max length", () => {
  let s = loadedState();
  s = update(s, charEvent("/"));

  // Control characters stripped
  s = update(s, pasteEvent("hello\x00\x1f\x7f\x9fworld"));
  assert.equal(s.search.query, "helloworld");

  // Exceeding 120 chars is sliced
  const longText = "a".repeat(150);
  s = update(s, charEvent("/"));
  s = update(s, pasteEvent(longText));
  assert.equal(s.search.query.length, 120);
});

test("paste is accepted inside search modal and inert elsewhere", () => {
  let s = loadedState();

  // Outside search modal: paste is inert
  const sAfterPaste = update(s, pasteEvent("some text"));
  assert.deepEqual(sAfterPaste, s);

  // Inside search modal: paste appends text
  s = update(s, charEvent("/"));
  s = update(s, pasteEvent("filter query"));
  assert.equal(s.search.query, "filter query");
});

test("d toggles fullDiff flag", () => {
  let s = loadedState();
  assert.equal(s.fullDiff, false);

  s = update(s, charEvent("d"));
  assert.equal(s.fullDiff, true);

  s = update(s, charEvent("d"));
  assert.equal(s.fullDiff, false);
});

test("inspector scrolling with j/k, up/down, g/G, ctrl-d/ctrl-u when focused on inspector", () => {
  let s = loadedState(100, 30);
  // Focus inspector
  s = update(s, keyEvent("enter"));
  assert.equal(s.focus, "inspector");
  assert.equal(s.scroll.inspector, 0);

  // j and down scroll down by 1
  s = update(s, charEvent("j"));
  assert.equal(s.scroll.inspector, 1);
  s = update(s, keyEvent("down"));
  assert.equal(s.scroll.inspector, 2);

  // k and up scroll up by 1, clamped at 0
  s = update(s, charEvent("k"));
  assert.equal(s.scroll.inspector, 1);
  s = update(s, keyEvent("up"));
  assert.equal(s.scroll.inspector, 0);
  s = update(s, charEvent("k"));
  assert.equal(s.scroll.inspector, 0, "clamped at top");

  // ctrl-d and ctrl-u (half page: Math.max(1, Math.floor((30 - 6) / 2)) = 12)
  s = update(s, keyEvent("ctrl-d"));
  assert.equal(s.scroll.inspector, 12);
  s = update(s, keyEvent("ctrl-d"));
  assert.equal(s.scroll.inspector, 24);
  s = update(s, keyEvent("ctrl-u"));
  assert.equal(s.scroll.inspector, 12);
  s = update(s, keyEvent("ctrl-u"));
  assert.equal(s.scroll.inspector, 0);
  s = update(s, keyEvent("ctrl-u"));
  assert.equal(s.scroll.inspector, 0, "clamped at top");

  // g jumps to top (0), G jumps to large scroll
  s = update(s, keyEvent("ctrl-d"));
  assert.equal(s.scroll.inspector, 12);
  s = update(s, charEvent("g"));
  assert.equal(s.scroll.inspector, 0);

  s = update(s, charEvent("G"));
  assert.equal(s.scroll.inspector, Number.MAX_SAFE_INTEGER);
});

test("? opens help modal and any key closes help swallowing its normal action", () => {
  let s = loadedState();
  assert.equal(s.help, false);

  // ? opens help
  s = update(s, charEvent("?"));
  assert.equal(s.help, true);

  // Pressing 'q' closes help and does NOT quit
  s = update(s, charEvent("q"));
  assert.equal(s.help, false);
  assert.equal(s.quit, false);

  // Open help again; pressing 'j' closes help and does NOT move selection
  s = update(s, charEvent("?"));
  assert.equal(s.help, true);
  s = update(s, charEvent("j"));
  assert.equal(s.help, false);
  assert.equal(s.selected, 0);

  // Open help again; pressing 'esc' closes help
  s = update(s, charEvent("?"));
  assert.equal(s.help, true);
  s = update(s, keyEvent("esc"));
  assert.equal(s.help, false);

  // ctrl-c still quits even in help
  s = update(s, charEvent("?"));
  assert.equal(s.help, true);
  s = update(s, keyEvent("ctrl-c"));
  assert.equal(s.quit, true);
});

test("strict Esc precedence dismisses one layer per press without quitting", () => {
  let s = loadedState();

  // Set up all layers: inspector open, fullDiff open, search active, help open
  s = update(s, keyEvent("enter")); // focus inspector, inspectorOpen: true
  s = update(s, charEvent("d"));     // fullDiff: true
  s = { ...s, search: { active: true, query: "foo" } }; // search active
  s = { ...s, help: true };         // help modal open

  assert.equal(s.help, true);
  assert.equal(s.search.active, true);
  assert.equal(s.fullDiff, true);
  assert.equal(s.focus, "inspector");
  assert.equal(s.inspectorOpen, true);

  // Esc 1: dismisses help
  s = update(s, keyEvent("esc"));
  assert.equal(s.help, false, "layer 1: help dismissed");
  assert.equal(s.search.active, true);
  assert.equal(s.search.query, "foo");
  assert.equal(s.fullDiff, true);
  assert.equal(s.focus, "inspector");

  // Esc 2: dismisses search and clears query
  s = update(s, keyEvent("esc"));
  assert.equal(s.search.active, false, "layer 2: search dismissed");
  assert.equal(s.search.query, "", "search query cleared");
  assert.equal(s.fullDiff, true);
  assert.equal(s.focus, "inspector");

  // Esc 3: dismisses fullDiff
  s = update(s, keyEvent("esc"));
  assert.equal(s.fullDiff, false, "layer 3: fullDiff dismissed");
  assert.equal(s.focus, "inspector");
  assert.equal(s.inspectorOpen, true);

  // Esc 4: returns from inspector to list
  s = update(s, keyEvent("esc"));
  assert.equal(s.focus, "list", "layer 4: inspector closed back to list");
  assert.equal(s.inspectorOpen, false);

  // Esc 5: at top level, Esc is a no-op and never quits
  s = update(s, keyEvent("esc"));
  assert.equal(s.quit, false, "esc at top level does not quit");
  assert.equal(s.focus, "list");
});
