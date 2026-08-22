import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mouseAllowed, Live } from "../ui/tui/core/live.js";
import { createScreen } from "../ui/tui/screen.js";
import { MOUSE_ENABLE, MOUSE_DISABLE } from "../ui/tui/core/mouse.js";
import { TextNode } from "../ui/tui/core/node.js";
import type { Key } from "../ui/tui/state.js";

function fakeStdout(): { ws: NodeJS.WriteStream; chunks: string[] } {
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  const ws = Object.assign(emitter, {
    write: (s: string) => { chunks.push(String(s)); return true; },
    columns: 80,
    rows: 24,
    getColorDepth: () => 24,
  }) as unknown as NodeJS.WriteStream;
  return { ws, chunks };
}

function fakeStdin(): { rs: NodeJS.ReadStream; emitKey: (buf: Buffer) => void } {
  const emitter = new EventEmitter();
  const rs = Object.assign(emitter, {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
  }) as unknown as NodeJS.ReadStream;
  return {
    rs,
    emitKey: (buf: Buffer) => {
      emitter.emit("data", buf);
    },
  };
}

test("mouseAllowed: knob off wins; win32 needs WT_SESSION", () => {
  assert.equal(mouseAllowed({ ROCKY_TUI_MOUSE: "off", WT_SESSION: "1" }, "win32"), false);
  assert.equal(mouseAllowed({}, "linux"), true);
  assert.equal(mouseAllowed({}, "win32"), false);
  assert.equal(mouseAllowed({ WT_SESSION: "x" }, "win32"), true);
});

test("screen with mouse option writes enable on enter and disable on leave", () => {
  const { ws, chunks } = fakeStdout();
  const s = createScreen(ws, { mouse: true });
  s.enter();
  assert.ok(chunks.join("").includes(MOUSE_ENABLE));
  s.leave();
  assert.ok(chunks.join("").includes(MOUSE_DISABLE));
});

test("screen without the option never writes mouse sequences", () => {
  const { ws, chunks } = fakeStdout();
  const s = createScreen(ws);
  s.enter(); s.leave();
  assert.ok(!chunks.join("").includes("?1006"));
});

test("Live lifecycle: start, render frame, requestFrame, and stop", () => {
  const { ws, chunks } = fakeStdout();
  const { rs } = fakeStdin();
  let builtFrames = 0;

  const live = new Live({
    stdout: ws,
    stdin: rs,
    env: { ROCKY_TUI_MOTION: "off" },
    tickMs: 1000,
  });

  live.setRoot(({ cols, rows, frame }) => {
    builtFrames++;
    return new TextNode(`Frame ${frame} size ${cols}x${rows}`);
  });

  live.start();
  assert.equal(builtFrames, 1);
  assert.ok(chunks.length > 0);

  live.requestFrame();
  assert.equal(builtFrames, 2);

  live.stop();
  // Idempotent stop
  assert.doesNotThrow(() => live.stop());
});

test("Live motion: increments frame per tick only when motion enabled", async () => {
  const { ws } = fakeStdout();
  const { rs } = fakeStdin();

  // With motion enabled
  const liveOn = new Live({
    stdout: ws,
    stdin: rs,
    env: { ROCKY_TUI_MOTION: "on" },
    tickMs: 20,
  });
  liveOn.setRoot(() => new TextNode("test"));
  liveOn.start();

  await new Promise((r) => setTimeout(r, 65));
  liveOn.stop();
  assert.ok(liveOn.frame >= 2, `expected frame >= 2, got ${liveOn.frame}`);

  // With motion disabled
  const liveOff = new Live({
    stdout: ws,
    stdin: rs,
    env: { ROCKY_TUI_MOTION: "off" },
    tickMs: 20,
  });
  liveOff.setRoot(() => new TextNode("test"));
  liveOff.start();

  await new Promise((r) => setTimeout(r, 65));
  liveOff.stop();
  assert.equal(liveOff.frame, 0, "frame should stay 0 when motion disabled");
});

test("Live routes parsed keys to onKey handler", () => {
  const { ws } = fakeStdout();
  const { rs, emitKey } = fakeStdin();
  const received: Key[] = [];

  const live = new Live({
    stdout: ws,
    stdin: rs,
    env: {},
    tickMs: 1000,
  });

  live.setRoot(() => new TextNode("input test"));
  live.onKey((key) => received.push(key));
  live.start();

  emitKey(Buffer.from("q"));
  emitKey(Buffer.from("\r"));
  emitKey(Buffer.from("\x1b[A"));

  live.stop();

  assert.deepEqual(received, [
    { name: "char", ch: "q" },
    { name: "enter" },
    { name: "up" },
  ]);
});

test("Live handles resize event by resetting diff and repainting", async () => {
  const { ws } = fakeStdout();
  const { rs } = fakeStdin();
  let lastSize = { cols: 0, rows: 0 };

  const live = new Live({
    stdout: ws,
    stdin: rs,
    env: {},
    tickMs: 1000,
  });

  live.setRoot(({ cols, rows }) => {
    lastSize = { cols, rows };
    return new TextNode("resize test");
  });

  live.start();
  assert.deepEqual(lastSize, { cols: 80, rows: 24 });

  (ws as any).columns = 100;
  (ws as any).rows = 30;
  (ws as any).emit("resize");

  await new Promise((r) => setTimeout(r, 80));
  live.stop();

  assert.deepEqual(lastSize, { cols: 100, rows: 30 });
});
