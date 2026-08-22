import { test } from "node:test";
import assert from "node:assert/strict";
import { motionEnabled, spinner, pulse } from "../ui/tui/core/motion.js";

test("ROCKY_TUI_MOTION=off disables, anything else enables", () => {
  assert.equal(motionEnabled({ ROCKY_TUI_MOTION: "off" } as any), false);
  assert.equal(motionEnabled({} as any), true);
  assert.equal(motionEnabled({ ROCKY_TUI_MOTION: "" } as any), true);
});

test("spinner is a pure function of frame and cycles", () => {
  assert.equal(spinner(0, false, true), spinner(10, false, true));
  assert.notEqual(spinner(0, false, true), spinner(1, false, true));
});

test("ascii spinner survives conhost — only |/-\\ characters", () => {
  for (let f = 0; f < 8; f++) assert.match(spinner(f, true, true), /^[|/\\-]$/);
});

test("disabled motion renders one stable frame", () => {
  assert.equal(spinner(3, false, false), spinner(99, false, false));
  assert.equal(pulse(3, false), true);
  assert.equal(pulse(999, false), true);
});

test("pulse alternates with the given period when enabled", () => {
  assert.equal(pulse(0, true, 4), true);
  assert.equal(pulse(2, true, 4), false);
});
