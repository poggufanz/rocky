import { test } from "node:test";
import assert from "node:assert/strict";
import { initialShell, updateShell, type ShellState } from "../ui/tui/surface/shell.js";
import { streamView, surfaceRoot } from "../ui/tui/surface/views.js";
import { renderToLines } from "../ui/tui/core/renderer.js";

const deps = { exists: (p: string) => p.replace(/\\/g, "/").endsWith("/rocky"), home: () => "/h" };
const type = (s: ShellState, text: string) =>
  [...text].reduce((st, ch) => updateShell(st, { type: "key", key: { name: "char", ch } }, deps), s);
const press = (s: ShellState, name: any, ch?: string) =>
  updateShell(s, { type: "key", key: (ch !== undefined ? { name: "char", ch } : { name }) as any }, deps);

test("slash menu: arrows select, enter fills; no-arg command runs on enter", () => {
  let s = type(initialShell("/proj"), "/");
  s = press(s, "down");                              // csel -> 1 (recall)
  assert.equal(s.csel, 1);
  s = press(s, "enter");
  assert.equal(s.input, "/recall ");
  let t = type(initialShell("/proj"), "/stats");
  t = press(t, "enter");
  assert.equal(t.input, "");
  assert.equal(t.cards.at(-1)?.kind, "stats");       // ran immediately
});

test("submit routes: unknown command yields error card, you-card precedes answers", () => {
  let s = type(initialShell("/proj"), "frobnicate");
  s = press(s, "enter");
  assert.equal(s.cards.at(-2)?.kind, "you");
  assert.equal(s.cards.at(-1)?.kind, "?");
  assert.equal(s.view, "stream");
});

test("run: cd intercepts and updates session cwd; real commands set pendingRun", () => {
  let s = type(initialShell("/proj"), "/run cd rocky");
  s = press(s, "enter");
  assert.ok(s.cwd.replace(/\\/g, "/").endsWith("/rocky"));
  assert.equal(s.pendingRun, undefined);
  let t = type({ ...initialShell("/proj") }, "/run npm test");
  t = press(t, "enter");
  assert.equal(t.pendingRun, "npm test");
  assert.equal(t.cards.at(-1)?.meta, "running…");
});

test("esc: clears input first, then returns stream to home; never quits", () => {
  let s = type(initialShell("/p"), "abc");
  s = press(s, "esc");
  assert.equal(s.input, "");
  s = { ...s, view: "stream" };
  s = press(s, "esc");
  assert.equal(s.view, "home");
  s = press(s, "esc");
  assert.equal(s.quit, false);
});

test("async card event lands in the stream", () => {
  const s = updateShell(initialShell("/p"), { type: "card", card: { kind: "run", accent: "ok", subject: "x", lines: [], facts: ["x"] } as any }, deps);
  assert.equal(s.cards.at(-1)?.kind, "run");
});

test("ctrl-c sets quit flag", () => {
  const s = press(initialShell("/p"), "ctrl-c");
  assert.equal(s.quit, true);
});

test("backspace and paste update input and reset csel", () => {
  let s = type(initialShell("/p"), "/re");
  s = { ...s, csel: 2 };
  s = press(s, "backspace");
  assert.equal(s.input, "/r");
  assert.equal(s.csel, 0);

  s = updateShell(s, { type: "key", key: { name: "paste", text: "un" } }, deps);
  assert.equal(s.input, "/run");
  assert.equal(s.csel, 0);
});

test("stream scrolling: ctrl-u, ctrl-d, up, down", () => {
  let s: ShellState = { ...initialShell("/p"), view: "stream", input: "", scroll: 0 };
  s = press(s, "up");
  assert.equal(s.scroll, 1);
  s = press(s, "ctrl-u");
  assert.equal(s.scroll, 9);
  s = press(s, "ctrl-d");
  assert.equal(s.scroll, 1);
  s = press(s, "down");
  assert.equal(s.scroll, 0);
  s = press(s, "down");
  assert.equal(s.scroll, 0);
});

test("cd with invalid path creates err card and keeps cwd", () => {
  let s = type(initialShell("/proj"), "/run cd nonexistent_dir");
  s = press(s, "enter");
  assert.equal(s.cwd, "/proj");
  assert.equal(s.cards.at(-1)?.kind, "cd");
  assert.equal(s.cards.at(-1)?.accent, "err");
});

test("async run card replaces running card with same subject", () => {
  let s = type(initialShell("/proj"), "/run npm test");
  s = press(s, "enter");
  assert.equal(s.cards.at(-1)?.meta, "running…");
  const runningCardIndex = s.cards.length - 1;

  const finishedCard = {
    kind: "run",
    accent: "ok" as const,
    subject: "npm test",
    meta: "exit 0",
    facts: ["npm test", "exit 0"],
    lines: [{ text: "all passed" }],
  };

  s = updateShell(s, { type: "card", card: finishedCard }, deps);
  assert.equal(s.cards[runningCardIndex].meta, "exit 0");
  assert.equal(s.cards[runningCardIndex].accent, "ok");
});

test("streamView and surfaceRoot render without errors", () => {
  const s = type(initialShell("/proj"), "/run npm test");
  const node = surfaceRoot(s, { cols: 80, rows: 24 }, 0, false);
  const lines = renderToLines(node, 80, 24, 24);
  assert.equal(lines.length, 24);

  const streamNode = streamView(s.cards, 0, { cols: 80, rows: 24 });
  assert.ok(streamNode);
});

test("/compare routes to compare view and renders via surfaceRoot", () => {
  let s = type(initialShell("/proj"), "/compare");
  s = press(s, "enter");
  assert.equal(s.view, "compare");
  assert.ok(s.compare);

  const node = surfaceRoot(s, { cols: 80, rows: 24 }, 0, false);
  const lines = renderToLines(node, 80, 24, 24);
  assert.equal(lines.length, 24);

  // Esc from top-level compare returns to home
  s = press(s, "esc");
  assert.equal(s.view, "home");
});

test("compare state: focus cycling, zoom, and diff toggle", () => {
  let s: ShellState = {
    ...initialShell("/proj"),
    view: "compare",
    compare: {
      records: [],
      files: [{
        path: "/proj/src/f.ts",
        recs: [
          { kind: "triple", ts: 2000, cwd: "/proj", source: "", machine: false, intent: "fix a" },
          { kind: "triple", ts: 1000, cwd: "/proj", source: "", machine: false, intent: "fix b" },
        ],
        count: 2,
        firstTs: 1000,
        lastTs: 2000,
      }],
      fquery: "",
      fsel: 0,
      ftop: 0,
      focus: "files",
      modal: null,
      msel: 0,
      picker: { open: false, markA: false, tsel: 0, tquery: "" },
      file: null,
      mode: null,
      A: null,
      B: null,
      recA: null,
      recB: null,
      expA: false,
      expB: false,
      cscroll: 0,
      dscrollA: 0,
      dscrollB: 0,
      hscrollA: 0,
      hscrollB: 0,
      showDiff: true,
      zoom: false,
    },
  };

  // Select file and choose two moments
  s = press(s, "enter"); // open scope modal
  assert.equal(s.compare?.modal, "scope");
  s = press(s, "down");  // msel = 1 (two moments)
  assert.equal(s.compare?.msel, 1);
  s = press(s, "enter"); // open timeline picker
  assert.equal(s.compare?.modal, "timeline");
  assert.equal(s.compare?.picker.open, true);

  // Lock A and B
  s = press(s, "enter"); // lock A
  assert.equal(s.compare?.picker.markA, true);
  s = press(s, "enter"); // lock B -> modal closed, mode = "two", focus = "recB"
  assert.equal(s.compare?.modal, null);
  assert.equal(s.compare?.mode, "two");
  assert.equal(s.compare?.focus, "recB");

  // Tab cycles focus
  s = press(s, "tab"); // diffA
  assert.equal(s.compare?.focus, "diffA");

  // Zoom toggle
  s = press(s, "char", "z");
  assert.equal(s.compare?.zoom, true);
  s = press(s, "char", "z");
  assert.equal(s.compare?.zoom, false);

  // Diff toggle
  s = press(s, "char", "d");
  assert.equal(s.compare?.showDiff, false);
  assert.equal(s.compare?.focus, "recA");
});

