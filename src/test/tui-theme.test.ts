import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectColorDepth,
  paint,
  type ColorDepth,
  type ThemeToken,
} from "../ui/tui/theme.js";

test("NO_COLOR and NODE_DISABLE_COLORS win over stream depth", () => {
  assert.equal(detectColorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }, () => 24), 1);
  assert.equal(detectColorDepth({ NO_COLOR: "" }, () => 24), 1);
  assert.equal(detectColorDepth({ NODE_DISABLE_COLORS: "1" }, () => 24), 1);
  assert.equal(detectColorDepth({ NODE_DISABLE_COLORS: "true" }, () => 8), 1);
});

test("FORCE_COLOR wins over NO_COLOR (explicit beats blanket)", () => {
  assert.equal(detectColorDepth({ FORCE_COLOR: "3", NO_COLOR: "1" }, () => 4), 24);
  assert.equal(detectColorDepth({ FORCE_COLOR: "2", NO_COLOR: "1" }, () => 4), 8);
  assert.equal(detectColorDepth({ FORCE_COLOR: "1", NO_COLOR: "1" }, () => 24), 4);
  assert.equal(detectColorDepth({ FORCE_COLOR: "0", NO_COLOR: "1" }, () => 24), 1);
  assert.equal(detectColorDepth({ FORCE_COLOR: "true" }, () => 1), 24);
  assert.equal(detectColorDepth({ FORCE_COLOR: "any-non-empty" }, () => 1), 24);
});

test("falls through to stream color depth, then COLORTERM, then TERM, then fallback 4", () => {
  // Stream color depths
  assert.equal(detectColorDepth({}, () => 24), 24);
  assert.equal(detectColorDepth({}, () => 32), 24);
  assert.equal(detectColorDepth({}, () => 8), 8);
  assert.equal(detectColorDepth({}, () => 4), 4);
  assert.equal(detectColorDepth({}, () => 1), 1);

  // When streamDepth throws or returns < 1
  assert.equal(detectColorDepth({ COLORTERM: "truecolor" }, () => { throw new Error("no tty"); }), 24);
  assert.equal(detectColorDepth({ COLORTERM: "24bit" }, () => { throw new Error("no tty"); }), 24);
  assert.equal(detectColorDepth({ TERM: "xterm-256color" }, () => { throw new Error("no tty"); }), 8);
  assert.equal(detectColorDepth({ TERM: "screen-256color" }, () => { throw new Error("no tty"); }), 8);
  assert.equal(detectColorDepth({ TERM: "xterm" }, () => { throw new Error("no tty"); }), 4);
  assert.equal(detectColorDepth({}, () => { throw new Error("no tty"); }), 4);
});

test("paint at depth 1 returns text unchanged, deeper depths wrap with SGR reset", () => {
  const tokens: ThemeToken[] = [
    "border", "accent", "text", "text2", "muted",
    "ok", "err", "why", "guard", "diffAdd", "diffDel", "diffHunk",
  ];

  for (const token of tokens) {
    // depth 1: plain unchanged
    assert.equal(paint(token, "hello", 1), "hello");

    // depth 24: truecolor 38;2;r;g;bm ... \x1b[39m
    const p24 = paint(token, "hello", 24);
    assert.ok(p24.startsWith("\x1b[38;2;"), `Expected 24-bit truecolor prefix for ${token}, got ${p24}`);
    assert.ok(p24.endsWith("\x1b[39m"), `Expected SGR reset suffix for ${token}, got ${p24}`);
    assert.ok(p24.includes("hello"));

    // depth 8: 256-color 38;5;cm ... \x1b[39m
    const p8 = paint(token, "hello", 8);
    assert.ok(p8.startsWith("\x1b[38;5;"), `Expected 8-bit 256-color prefix for ${token}, got ${p8}`);
    assert.ok(p8.endsWith("\x1b[39m"), `Expected SGR reset suffix for ${token}, got ${p8}`);
    assert.ok(p8.includes("hello"));

    // depth 4: 16-color \x1b[cm ... \x1b[39m
    const p4 = paint(token, "hello", 4);
    assert.ok(p4.startsWith("\x1b["), `Expected 4-bit 16-color prefix for ${token}, got ${p4}`);
    assert.ok(p4.endsWith("\x1b[39m"), `Expected SGR reset suffix for ${token}, got ${p4}`);
    assert.ok(p4.includes("hello"));
  }
});

test("paint uses exact palette values for tokens", () => {
  // border: [0x3f, 0x3f, 0x46, 240, 90] (0x3f = 63, 0x46 = 70)
  assert.equal(paint("border", "x", 24), "\x1b[38;2;63;63;70mx\x1b[39m");
  assert.equal(paint("border", "x", 8), "\x1b[38;5;240mx\x1b[39m");
  assert.equal(paint("border", "x", 4), "\x1b[90mx\x1b[39m");

  // accent: [0x14, 0xb8, 0xa6, 37, 96] (0x14 = 20, 0xb8 = 184, 0xa6 = 166)
  assert.equal(paint("accent", "x", 24), "\x1b[38;2;20;184;166mx\x1b[39m");
  assert.equal(paint("accent", "x", 8), "\x1b[38;5;37mx\x1b[39m");
  assert.equal(paint("accent", "x", 4), "\x1b[96mx\x1b[39m");

  // ok: [0x10, 0xb9, 0x81, 36, 92] (0x10 = 16, 0xb9 = 185, 0x81 = 129)
  assert.equal(paint("ok", "x", 24), "\x1b[38;2;16;185;129mx\x1b[39m");
  assert.equal(paint("ok", "x", 8), "\x1b[38;5;36mx\x1b[39m");
  assert.equal(paint("ok", "x", 4), "\x1b[92mx\x1b[39m");

  // err: [0xf4, 0x3f, 0x5e, 204, 91] (0xf4 = 244, 0x3f = 63, 0x5e = 94)
  assert.equal(paint("err", "x", 24), "\x1b[38;2;244;63;94mx\x1b[39m");
  assert.equal(paint("err", "x", 8), "\x1b[38;5;204mx\x1b[39m");
  assert.equal(paint("err", "x", 4), "\x1b[91mx\x1b[39m");
});
