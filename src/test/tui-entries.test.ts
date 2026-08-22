import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceEntry } from "../ui/tui/surface/entry.js";

test("TTY routing: bare→home, dash→browse, repl→stream, compare→compare", () => {
  assert.deepEqual(surfaceEntry(undefined, true), { surface: "home" });
  assert.deepEqual(surfaceEntry("dash", true), { surface: "browse" });
  assert.deepEqual(surfaceEntry("repl", true), { surface: "stream" });
  assert.deepEqual(surfaceEntry("compare", true), { surface: "compare" });
});

test("no TTY: everything passes through to the existing paths", () => {
  for (const cmd of [undefined, "dash", "repl", "compare"]) {
    assert.deepEqual(surfaceEntry(cmd, false), { passthrough: true });
  }
});
