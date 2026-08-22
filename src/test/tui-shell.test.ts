import { test } from "node:test";
import assert from "node:assert/strict";
import { initialShell, updateShell, type ShellState } from "../ui/tui/surface/shell.js";
import { streamView, surfaceRoot } from "../ui/tui/surface/views.js";
import { renderToLines } from "../ui/tui/core/renderer.js";

const deps = { exists: (p: string) => p.replace(/\\/g, "/").endsWith("/rocky"), home: () => "/h" };
const type = (s: ShellState, text: string) =>
  [...text].reduce((st, ch) => updateShell(st, { type: "key", key: { name: "char", ch } }, deps), s);
const press = (s: ShellState, name: any) => updateShell(s, { type: "key", key: { name } }, deps);

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
