import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceEntry } from "../ui/tui/surface/entry.js";

test("TTY routing: bare→home, dash→compare, repl→stream; compare is not a CLI entry", () => {
  assert.deepEqual(surfaceEntry(undefined, true), { surface: "home" });
  assert.deepEqual(surfaceEntry("dash", true), { surface: "compare" });
  assert.deepEqual(surfaceEntry("repl", true), { surface: "stream" });
  assert.deepEqual(surfaceEntry("compare", true), { passthrough: true });
});

test("no TTY: everything passes through to the existing paths", () => {
  for (const cmd of [undefined, "dash", "repl", "compare"]) {
    assert.deepEqual(surfaceEntry(cmd, false), { passthrough: true });
  }
});
