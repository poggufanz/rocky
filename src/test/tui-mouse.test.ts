import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSgrMouse, MOUSE_ENABLE, MOUSE_DISABLE } from "../ui/tui/core/mouse.js";

test("press and release parse to zero-based coordinates", () => {
  assert.deepEqual(parseSgrMouse("0;10;5", "M"), { kind: "press", x: 9, y: 4, button: 0 });
  assert.deepEqual(parseSgrMouse("0;1;1", "m"), { kind: "release", x: 0, y: 0, button: 0 });
});

test("wheel buttons map to wheel kinds", () => {
  assert.equal(parseSgrMouse("64;3;3", "M")?.kind, "wheel-up");
  assert.equal(parseSgrMouse("65;3;3", "M")?.kind, "wheel-down");
});

test("malformed and motion sequences are dropped", () => {
  assert.equal(parseSgrMouse("banana;1;1", "M"), undefined);
  assert.equal(parseSgrMouse("0;1", "M"), undefined);
  assert.equal(parseSgrMouse("35;4;4", "M"), undefined); // motion (32-bit set, not wheel)
});

test("enable and disable strings mirror each other", () => {
  assert.equal(MOUSE_ENABLE, "\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  assert.equal(MOUSE_DISABLE, "\x1b[?1006l\x1b[?1002l\x1b[?1000l");
});
