import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSgrMouse } from "../ui/tui/core/mouse.js";
import { applyMouseToTeach, initialTeachState, type ShellDeps, type TeachState } from "../ui/tui/surface/shell.js";
import type { MemoryRecord } from "../core/memory-read.js";

function explainRecord(path: string): MemoryRecord {
  return {
    kind: "explain", id: `e-${path}`, ts: 1, v: 1,
    cwd: "C:/p", path, source: "agent:claude-code",
    code: "code why", business: "business why",
  } as MemoryRecord;
}

const FILE_TEXT = "line one\nline two\nline three\nline four";

function deps(): ShellDeps {
  return {
    exists: () => true,
    home: () => "C:/",
    read: () => FILE_TEXT,
    git: () => undefined,
  };
}

test("parseSgrMouse emits drag for button-motion instead of dropping it", () => {
  const ev = parseSgrMouse("32;10;5", "M");
  assert.ok(ev && ev.kind === "drag" && ev.x === 9 && ev.y === 4 && ev.button === 0);
  const press = parseSgrMouse("0;3;3", "M");
  assert.ok(press && press.kind === "press");
  const wheel = parseSgrMouse("64;3;3", "M");
  assert.ok(wheel && wheel.kind === "wheel-up");
});

test("file phase: press on a row opens that file", () => {
  const state = initialTeachState([explainRecord("src/a.ts")]);
  state.rects = { files: { x: 1, y: 2, w: 30, h: 10 } };
  const next = applyMouseToTeach(state, { kind: "press", x: 2, y: 2, button: 0 }, deps());
  assert.ok(next.file !== null && next.file.endsWith("src/a.ts"));
  assert.equal(next.lines.length, 4);
});

function openedState(): TeachState {
  const state = initialTeachState([explainRecord("src/a.ts")]);
  state.rects = { files: { x: 1, y: 2, w: 30, h: 10 } };
  const opened = applyMouseToTeach(state, { kind: "press", x: 2, y: 2, button: 0 }, deps());
  opened.rects = { lines: { x: 1, y: 2, w: 30, h: 10 } };
  return opened;
}

test("line phase: press anchors, drag extends, release runs lookup", () => {
  const d = deps();
  let s = openedState();
  s = applyMouseToTeach(s, { kind: "press", x: 2, y: 3, button: 0 }, d);
  assert.equal(s.anchor, 2);
  assert.equal(s.extending, true);
  s = applyMouseToTeach(s, { kind: "drag", x: 2, y: 4, button: 0 }, d);
  assert.equal(s.start, 2);
  assert.equal(s.end, 3);
  s = applyMouseToTeach(s, { kind: "release", x: 2, y: 4, button: 0 }, d);
  assert.equal(s.extending, false);
  assert.equal(s.label, "line 2–3");
});

test("drag upward selects backwards from the anchor", () => {
  const d = deps();
  let s = openedState();
  s = applyMouseToTeach(s, { kind: "press", x: 2, y: 4, button: 0 }, d);
  s = applyMouseToTeach(s, { kind: "drag", x: 2, y: 2, button: 0 }, d);
  assert.equal(s.start, 1);
  assert.equal(s.end, 3);
});

test("press outside the lines pane changes nothing", () => {
  const d = deps();
  const s = openedState();
  const next = applyMouseToTeach(s, { kind: "press", x: 2, y: 40, button: 0 }, d);
  assert.equal(next.extending, false);
  assert.equal(next.start, s.start);
});

test("release without a held selection does not run lookup", () => {
  const d = deps();
  const s = openedState();
  const next = applyMouseToTeach(s, { kind: "release", x: 2, y: 3, button: 0 }, d);
  assert.equal(next.label, "");
});
