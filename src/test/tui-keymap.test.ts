import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKey, helpLines, assertNoConflicts, type Binding } from "../ui/tui/core/keymap.js";

const B: Binding[] = [
  { keys: ["q"], when: "global", action: "quit", help: "quit" },
  { keys: ["j", "down"], when: "list", action: "next", help: "move down" },
  { keys: ["j", "down"], when: "inspector", action: "scroll-down", help: "scroll" },
  { keys: ["r"], when: "global", action: "reload", help: "reload memory from disk" },
];

test("layer order decides: focused pane beats global, modal beats both", () => {
  assert.equal(resolveKey(B, ["inspector", "global"], "j"), "scroll-down");
  assert.equal(resolveKey(B, ["list", "global"], "j"), "next");
  assert.equal(resolveKey(B, ["list", "global"], "q"), "quit");
  assert.equal(resolveKey(B, ["list", "global"], "x"), undefined);
});

test("helpLines lists exactly the reachable bindings — the r-drift regression", () => {
  const lines = helpLines(B, ["list", "global"]);
  const actions = new Set(lines.map((l) => l.help));
  assert.ok(actions.has("reload memory from disk"), "every reachable binding appears in help");
  const reachable = B.filter((b) => ["list", "global"].includes(b.when));
  assert.equal(lines.length, reachable.length);
});

test("assertNoConflicts throws when one key means two things in one layer", () => {
  const bad: Binding[] = [
    { keys: ["d"], when: "list", action: "one", help: "" },
    { keys: ["d"], when: "list", action: "two", help: "" },
  ];
  assert.throws(() => assertNoConflicts(bad), /d.*list/);
  assert.doesNotThrow(() => assertNoConflicts(B));
});
