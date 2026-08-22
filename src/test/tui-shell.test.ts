import { test } from "node:test";
import assert from "node:assert/strict";
import { browseVisible, initialCompareState, initialShell, updateShell, handleWhy, type ShellState } from "../ui/tui/surface/shell.js";
import { streamView, surfaceRoot, compareView } from "../ui/tui/surface/views.js";
import { renderToLines } from "../ui/tui/core/renderer.js";

const SIZE = { cols: 100, rows: 30 };
const plainText = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

const cmpRec = (ts: number, intent: string) =>
  ({ kind: "triple", ts, cwd: "/proj", source: "", machine: false, intent });

function twoMoments(intentA: string, intentB: string): ShellState {
  const recA = cmpRec(2000, intentA);
  const recB = cmpRec(1000, intentB);
  const entry = { path: "/proj/src/f.ts", recs: [recA, recB], count: 2, firstTs: 1000, lastTs: 2000 };
  return {
    ...initialShell("/proj"),
    view: "compare",
    compare: {
      ...initialCompareState([]),
      files: [entry],
      file: entry,
      mode: "two",
      focus: "recA",
      A: 2000,
      B: 1000,
      recA,
      recB,
    },
  };
}

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

const EXCERPT_TOKEN = "ghp_111122223333444455556666777788889999";

test("/why redacts stored failure excerpts at the card boundary", () => {
  const rec = {
    kind: "failure",
    ts: 1000,
    cwd: "/proj",
    cmd: "npm test",
    exitCode: 1,
    fingerprint: "a".repeat(16),
    signature: ["auth failed"],
    excerpt: `npm ERR! auth failed for ${EXCERPT_TOKEN}`,
  } as any;
  const card = handleWhy("why", [rec], 2000);
  assert.equal(card.kind, "why");
  const all = JSON.stringify(card);
  assert.ok(!all.includes(EXCERPT_TOKEN), "raw excerpt token must not reach the why card");
  assert.ok(all.includes("[redacted github token]"), "card carries the redacted form instead");
});

const wheel = (s: ShellState, kind: "wheel-up" | "wheel-down", x = 10, y = 10): ShellState =>
  updateShell(s, { type: "key", key: { name: "mouse", event: { kind, x, y, button: kind === "wheel-up" ? 64 : 65 } } }, deps);

test("stream scrolling: wheel mirrors ctrl-u and ctrl-d", () => {
  let s: ShellState = { ...initialShell("/p"), view: "stream", input: "", scroll: 0 };
  s = wheel(s, "wheel-up");
  assert.equal(s.scroll, 8);
  s = wheel(s, "wheel-down");
  assert.equal(s.scroll, 0);
  s = wheel(s, "wheel-down");
  assert.equal(s.scroll, 0, "clamps at zero like ctrl-d");
});

test("mouse press and release never touch the stream scroll", () => {
  let s: ShellState = { ...initialShell("/p"), view: "stream", input: "", scroll: 3 };
  for (const kind of ["press", "release"] as const) {
    s = updateShell(s, { type: "key", key: { name: "mouse", event: { kind, x: 10, y: 10, button: 0 } } }, deps);
    assert.equal(s.scroll, 3);
  }
});

test("home: wheel is a no-op because home has no scroll mechanism", () => {
  let s: ShellState = { ...initialShell("/p"), view: "home", scroll: 4 };
  s = wheel(s, "wheel-up");
  s = wheel(s, "wheel-down");
  assert.equal(s.view, "home");
  assert.equal(s.scroll, 4);
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

test("record panes clamp the shared scroll once against the taller side", () => {
  const long = "word ".repeat(160).trim();
  const s = twoMoments(long, "short");
  s.compare!.cscroll = 3;
  renderToLines(compareView(s.compare!, SIZE, 0, false), SIZE.cols, SIZE.rows, 24);
  assert.equal(s.compare!.cscroll, 3, "short pane B must not pin the shared scroll back to 0");
});

test("mouse wheel scrolls the pane under the cursor and click focuses it", () => {
  const base = twoMoments("evidence ".repeat(40).trim(), "short");
  renderToLines(compareView(base.compare!, SIZE, 0, false), SIZE.cols, SIZE.rows, 24);
  const ra = base.compare!.rects!.recA;
  assert.ok(ra && ra.w > 0 && ra.h > 0, "record pane registers its rect");

  let n = updateShell(base, { type: "key", key: { name: "mouse", event: { kind: "wheel-down", x: ra.x + Math.floor(ra.w / 2), y: ra.y + 2, button: 65 } } }, deps);
  assert.equal(n.compare?.cscroll, 3);

  const rb = n.compare!.rects!.recB!;
  n = updateShell(n, { type: "key", key: { name: "mouse", event: { kind: "press", x: rb.x + 2, y: rb.y + 2, button: 0 } } }, deps);
  assert.equal(n.compare?.focus, "recB");

  const cmp = {
    ...initialCompareState([]),
    focus: "files" as const,
    files: Array.from({ length: 5 }, (_, i) => ({ path: `/p/g${i}.ts`, recs: [], count: 0, firstTs: 0, lastTs: 0 })),
  };
  const h: ShellState = { ...initialShell("/proj"), view: "compare", compare: cmp };
  renderToLines(compareView(cmp, SIZE, 0, false), SIZE.cols, SIZE.rows, 24);
  assert.ok(cmp.rects!.files, "files list registers its rect");
  const fr = cmp.rects!.files!;
  const m = updateShell(h, { type: "key", key: { name: "mouse", event: { kind: "wheel-down", x: fr.x, y: fr.y, button: 65 } } }, deps);
  assert.equal(m.compare?.fsel, 3);
});

test("z zoom gives the focused record pane full height without diff panes", () => {
  const z = twoMoments("fix a", "fix b");
  z.compare!.zoom = true;
  const zoomed = renderToLines(compareView(z.compare!, SIZE, 0, false), SIZE.cols, SIZE.rows, 24);
  assert.equal(plainText(zoomed[13])[0], "│", "record box border continues past the old split row when zoomed");

  const u = twoMoments("fix a", "fix b");
  const plain = renderToLines(compareView(u.compare!, SIZE, 0, false), SIZE.cols, SIZE.rows, 24);
  assert.equal(plainText(plain[13])[0], "└", "unzoomed record box ends above the diff panes");
});

const browseRow = (id: string, label: string, file?: string) => ({
  id,
  badge: "why" as const,
  label,
  ts: 1000,
  kind: "triple",
  json: JSON.stringify({ kind: "triple", ts: 1000, ...(file ? { file } : {}), intent: { text: "because the parser caches stems" } }),
});

test("/browse opens overlay, esc closes, enter prefills input from row", () => {
  let s = type(initialShell("/proj"), "/browse");
  s = press(s, "enter");
  assert.equal(s.overlay, "browse");
  assert.equal(s.view, "stream");
  s = press(s, "esc");
  assert.equal(s.overlay, undefined);

  const seeded: ShellState = {
    ...initialShell("/proj"),
    overlay: "browse",
    brows: [
      browseRow("t1", "parser cache bug", "/proj/src/p.ts"),
      { ...browseRow("t3", "triple carries file"), json: JSON.stringify({ kind: "triple", ts: 1000, mechanism: { files: [{ path: "/proj/src/t.ts" }] }, intent: { text: "because" } }) },
      browseRow("t2", "unrelated note"),
    ],
    bsel: 0,
    bquery: "",
  };
  const picked = press(seeded, "enter");
  assert.equal(picked.overlay, undefined);
  assert.equal(picked.input, "why /proj/src/p.ts");

  const second: ShellState = { ...seeded, bsel: 1 };
  const fromMechanism = press(second, "enter");
  assert.equal(fromMechanism.input, "why /proj/src/t.ts");

  const third: ShellState = { ...seeded, bsel: 2 };
  const fallback = press(third, "enter");
  assert.equal(fallback.input.startsWith("recall "), true);
  assert.match(fallback.input, /unrelated note/);
});

test("browse overlay filters as you type and arrows move within filtered rows", () => {
  let s: ShellState = {
    ...initialShell("/proj"),
    overlay: "browse",
    brows: [browseRow("a", "alpha parser"), browseRow("b", "beta renderer"), browseRow("c", "gamma parser")],
    bsel: 0,
    bquery: "",
  };
  s = type(s, "parser");
  assert.equal(browseVisible(s).length, 2);
  s = press(s, "down");
  assert.equal(s.bsel, 1);
  s = press(s, "down");
  assert.equal(s.bsel, 1, "selection clamps to filtered list");
  s = press(s, "up");
  s = press(s, "up");
  assert.equal(s.bsel, 0);
});

test("browse overlay renders through surfaceRoot without errors", () => {
  const s: ShellState = {
    ...initialShell("/proj"),
    view: "stream",
    cards: [{ kind: "run", accent: "guard", subject: "npm test", meta: "running…", facts: ["x"], lines: [] }],
    overlay: "browse",
    brows: [browseRow("t1", "parser cache", "/p.ts")],
    bsel: 0,
    bquery: "",
  };
  const node = surfaceRoot(s, SIZE, 0, false);
  const lines = renderToLines(node, SIZE.cols, SIZE.rows, 24);
  assert.equal(lines.length, SIZE.rows);
  assert.ok(cmpBrowseRects(s));
});

function cmpBrowseRects(state: ShellState): boolean {
  return !!state.brects && state.brects.w > 0 && state.brects.h > 0;
}

test("compare cursors freeze when motion is off and blink on the pulse duty cycle", () => {
  const st = { ...initialShell("/proj"), view: "compare" as const, compare: initialCompareState([]) };

  const p6 = renderToLines(compareView(st.compare!, SIZE, 6, false), SIZE.cols, SIZE.rows, 24);
  const p7 = renderToLines(compareView(st.compare!, SIZE, 7, false), SIZE.cols, SIZE.rows, 24);
  assert.notDeepEqual(p6, p7, "cursor animates on the shared 7/14 pulse duty cycle");

  const g6 = renderToLines(compareView(st.compare!, SIZE, 6, false, undefined, false), SIZE.cols, SIZE.rows, 24);
  const g7 = renderToLines(compareView(st.compare!, SIZE, 7, false, undefined, false), SIZE.cols, SIZE.rows, 24);
  const g9 = renderToLines(compareView(st.compare!, SIZE, 9, false, undefined, false), SIZE.cols, SIZE.rows, 24);
  assert.deepEqual(g6, g7, "ROCKY_TUI_MOTION=off freezes across the pulse boundary");
  assert.deepEqual(g7, g9, "ROCKY_TUI_MOTION=off freezes across frames");
});

