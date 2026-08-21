import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFrames, createScreen } from "../ui/tui/screen.js";
import { Writable } from "node:stream";

test("diffFrames: first frame homes cursor and writes all lines wrapped in synchronized output", () => {
  const lines = ["Line 1", "Line 2", "Line 3"];
  const out = diffFrames(undefined, lines);

  assert.equal(
    out,
    "\x1b[?2026h\x1b[H\x1b[1;1HLine 1\x1b[K\x1b[2;1HLine 2\x1b[K\x1b[3;1HLine 3\x1b[K\x1b[?2026l",
  );
});

test("diffFrames: empty next array on first frame produces empty string", () => {
  const out = diffFrames(undefined, []);
  assert.equal(out, "");
});

test("diffFrames: identical frames produce empty write string", () => {
  const lines = ["Line 1", "Line 2", "Line 3"];
  const out = diffFrames(lines, lines);
  assert.equal(out, "");
});

test("diffFrames: unchanged lines are skipped, only changed lines are addressed", () => {
  const prev = ["Header", "Status: Old", "Footer"];
  const next = ["Header", "Status: New", "Footer"];
  const out = diffFrames(prev, next);

  assert.equal(
    out,
    "\x1b[?2026h\x1b[2;1HStatus: New\x1b[K\x1b[?2026l",
  );
});

test("diffFrames: line removal clears trailing lines", () => {
  const prev = ["Line 1", "Line 2", "Line 3"];
  const next = ["Line 1", "Line 2"];
  const out = diffFrames(prev, next);

  assert.equal(
    out,
    "\x1b[?2026h\x1b[3;1H\x1b[K\x1b[?2026l",
  );
});

test("diffFrames: line addition addresses new lines", () => {
  const prev = ["Line 1", "Line 2"];
  const next = ["Line 1", "Line 2", "Line 3"];
  const out = diffFrames(prev, next);

  assert.equal(
    out,
    "\x1b[?2026h\x1b[3;1HLine 3\x1b[K\x1b[?2026l",
  );
});

test("createScreen: enter, paint, resetDiff, and leave lifecycle", () => {
  const written: string[] = [];
  const mockStdout = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  }) as unknown as NodeJS.WriteStream;

  const screen = createScreen(mockStdout);

  // 1. Enter
  screen.enter();
  assert.equal(written.length, 1);
  assert.equal(written[0], "\x1b[?1049h\x1b[?25l\x1b[?2004h");

  // 2. First paint
  screen.paint(["Hello", "World"]);
  assert.equal(written.length, 2);
  assert.equal(
    written[1],
    "\x1b[?2026h\x1b[H\x1b[1;1HHello\x1b[K\x1b[2;1HWorld\x1b[K\x1b[?2026l",
  );

  // 3. Paint same lines -> no write
  screen.paint(["Hello", "World"]);
  assert.equal(written.length, 2);

  // 4. Paint modified line
  screen.paint(["Hello", "Rocky"]);
  assert.equal(written.length, 3);
  assert.equal(
    written[2],
    "\x1b[?2026h\x1b[2;1HRocky\x1b[K\x1b[?2026l",
  );

  // 5. resetDiff -> next paint acts like first frame
  screen.resetDiff();
  screen.paint(["Hello", "Rocky"]);
  assert.equal(written.length, 4);
  assert.equal(
    written[3],
    "\x1b[?2026h\x1b[H\x1b[1;1HHello\x1b[K\x1b[2;1HRocky\x1b[K\x1b[?2026l",
  );

  // 6. Leave
  screen.leave();
  assert.equal(written.length, 5);
  assert.equal(written[4], "\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l");
});
