import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createKeyParser, attachRawInput } from "../ui/tui/input.js";
import { Key } from "../ui/tui/state.js";

function createMockScheduler() {
  let timerId = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();

  const schedule = (fn: () => void, ms: number) => {
    const id = ++timerId;
    timers.set(id, { fn, ms });
    return () => {
      timers.delete(id);
    };
  };

  const advanceTime = (ms: number = 50) => {
    for (const [id, t] of Array.from(timers.entries())) {
      if (t.ms <= ms) {
        timers.delete(id);
        t.fn();
      }
    }
  };

  const pendingCount = () => timers.size;

  return { schedule, advanceTime, pendingCount };
}

test("plain printable characters and multi-byte unicode", () => {
  const events: Key[] = [];
  const { schedule } = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), schedule);

  parser.feed(Buffer.from("a"));
  parser.feed(Buffer.from("Z"));
  parser.feed(Buffer.from("123"));
  parser.feed(Buffer.from("日本語"));
  parser.feed(Buffer.from("🚀"));

  assert.deepEqual(events, [
    { name: "char", ch: "a" },
    { name: "char", ch: "Z" },
    { name: "char", ch: "1" },
    { name: "char", ch: "2" },
    { name: "char", ch: "3" },
    { name: "char", ch: "日" },
    { name: "char", ch: "本" },
    { name: "char", ch: "語" },
    { name: "char", ch: "🚀" },
  ]);
});

test("control characters and common single-byte keys", () => {
  const events: Key[] = [];
  const { schedule } = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), schedule);

  parser.feed(Buffer.from([0x03])); // ctrl-c
  parser.feed(Buffer.from([0x04])); // ctrl-d
  parser.feed(Buffer.from([0x15])); // ctrl-u
  parser.feed(Buffer.from([0x1a])); // ctrl-z
  parser.feed(Buffer.from([0x0d])); // enter (\r)
  parser.feed(Buffer.from([0x0a])); // enter (\n)
  parser.feed(Buffer.from([0x09])); // tab
  parser.feed(Buffer.from([0x7f])); // backspace (DEL)
  parser.feed(Buffer.from([0x08])); // backspace (BS)

  assert.deepEqual(events, [
    { name: "ctrl-c" },
    { name: "ctrl-d" },
    { name: "ctrl-u" },
    { name: "ctrl-z" },
    { name: "enter" },
    { name: "enter" },
    { name: "tab" },
    { name: "backspace" },
    { name: "backspace" },
  ]);
});

test("CSI and SS3 arrow keys and Shift-Tab", () => {
  const events: Key[] = [];
  const { schedule } = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), schedule);

  // CSI arrows
  parser.feed(Buffer.from("\x1b[A"));
  parser.feed(Buffer.from("\x1b[B"));
  parser.feed(Buffer.from("\x1b[C"));
  parser.feed(Buffer.from("\x1b[D"));
  // Shift-Tab
  parser.feed(Buffer.from("\x1b[Z"));
  // SS3 arrows
  parser.feed(Buffer.from("\x1bOA"));
  parser.feed(Buffer.from("\x1bOB"));
  parser.feed(Buffer.from("\x1bOC"));
  parser.feed(Buffer.from("\x1bOD"));

  assert.deepEqual(events, [
    { name: "up" },
    { name: "down" },
    { name: "right" },
    { name: "left" },
    { name: "shifttab" },
    { name: "up" },
    { name: "down" },
    { name: "right" },
    { name: "left" },
  ]);
});

test("lone ESC emits only after timer fires", () => {
  const events: Key[] = [];
  const mock = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), mock.schedule);

  parser.feed(Buffer.from("\x1b"));
  assert.equal(events.length, 0);
  assert.equal(mock.pendingCount(), 1);

  mock.advanceTime(50);
  assert.deepEqual(events, [{ name: "esc" }]);
  assert.equal(mock.pendingCount(), 0);
});

test("ESC followed by CSI sequence cancels timer and parses sequence", () => {
  const events: Key[] = [];
  const mock = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), mock.schedule);

  parser.feed(Buffer.from("\x1b"));
  assert.equal(events.length, 0);
  assert.equal(mock.pendingCount(), 1);

  // Bytes arrive within 50ms window
  parser.feed(Buffer.from("[A"));
  assert.equal(mock.pendingCount(), 0);
  assert.deepEqual(events, [{ name: "up" }]);

  // Advancing timer should not emit stray esc
  mock.advanceTime(50);
  assert.deepEqual(events, [{ name: "up" }]);
});

test("ESC followed by normal char cancels timer and emits esc then char", () => {
  const events: Key[] = [];
  const mock = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), mock.schedule);

  parser.feed(Buffer.from("\x1b"));
  assert.equal(events.length, 0);
  assert.equal(mock.pendingCount(), 1);

  parser.feed(Buffer.from("a"));
  assert.equal(mock.pendingCount(), 0);
  assert.deepEqual(events, [{ name: "esc" }, { name: "char", ch: "a" }]);
});

test("bracketed paste envelope in single chunk", () => {
  const events: Key[] = [];
  const { schedule } = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), schedule);

  parser.feed(Buffer.from("\x1b[200~npm test\x1b[201~"));
  assert.deepEqual(events, [{ name: "paste", text: "npm test" }]);
});

test("bracketed paste split across multiple chunks", () => {
  const events: Key[] = [];
  const { schedule } = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), schedule);

  parser.feed(Buffer.from("\x1b[200~npm "));
  assert.equal(events.length, 0);
  parser.feed(Buffer.from("run test\x1b[201~"));
  assert.deepEqual(events, [{ name: "paste", text: "npm run test" }]);
});

test("bracketed paste with split markers across chunks", () => {
  const events: Key[] = [];
  const { schedule } = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), schedule);

  parser.feed(Buffer.from("\x1b[20"));
  assert.equal(events.length, 0);
  parser.feed(Buffer.from("0~content\x1b[2"));
  assert.equal(events.length, 0);
  parser.feed(Buffer.from("01~"));
  assert.deepEqual(events, [{ name: "paste", text: "content" }]);
});

test("bracketed paste with newlines and control characters inside", () => {
  const events: Key[] = [];
  const { schedule } = createMockScheduler();
  const parser = createKeyParser((k: Key) => events.push(k), schedule);

  parser.feed(Buffer.from("\x1b[200~line 1\nline 2\r\nline 3\t\x1b[201~"));
  assert.deepEqual(events, [{ name: "paste", text: "line 1\nline 2\r\nline 3\t" }]);
});

test("attachRawInput attaches listener, manages raw mode, and cleans up", () => {
  const emitter = new EventEmitter() as any;
  let rawMode = false;
  let resumed = false;
  let paused = false;

  emitter.isTTY = true;
  emitter.setRawMode = (mode: boolean) => {
    rawMode = mode;
  };
  emitter.resume = () => {
    resumed = true;
  };
  emitter.pause = () => {
    paused = true;
  };

  const fedChunks: Buffer[] = [];
  const parser = {
    feed(chunk: Buffer) {
      fedChunks.push(chunk);
    },
  };

  const cleanup = attachRawInput(emitter as NodeJS.ReadStream, parser);

  assert.equal(rawMode, true);
  assert.equal(resumed, true);

  emitter.emit("data", Buffer.from("hello"));
  assert.equal(fedChunks.length, 1);
  assert.equal(fedChunks[0].toString(), "hello");

  cleanup();
  assert.equal(rawMode, false);
  assert.equal(paused, true);
  assert.equal(emitter.listenerCount("data"), 0);
});

test("attachRawInput handles non-TTY stream and erroring setRawMode gracefully", () => {
  const emitter = new EventEmitter() as any;
  let resumeCalled = false;
  emitter.isTTY = false;
  emitter.setRawMode = () => {
    throw new Error("not a tty");
  };
  emitter.resume = () => {
    resumeCalled = true;
  };
  emitter.pause = () => {};

  const parser = {
    feed() {},
  };

  const cleanup = attachRawInput(emitter as NodeJS.ReadStream, parser);
  assert.equal(resumeCalled, true);
  assert.doesNotThrow(() => cleanup());
});
