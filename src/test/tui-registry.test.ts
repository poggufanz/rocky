import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, matchCommands, parseInput } from "../ui/tui/surface/registry.js";

test("registry names are unique and non-empty", () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const c of COMMANDS) assert.ok(c.name.length > 0 && c.help.length > 0);
});

test("matchCommands filters by prefix; empty prefix lists all", () => {
  assert.equal(matchCommands("").length, COMMANDS.length);
  assert.deepEqual(matchCommands("re").map((c) => c.name), ["recall"]);
  assert.deepEqual(matchCommands("zzz"), []);
});

test("parseInput strips one leading slash and splits arg", () => {
  assert.deepEqual(parseInput("/run npm test"), { cmd: "run", arg: "npm test" });
  assert.deepEqual(parseInput("recall token expiry"), { cmd: "recall", arg: "token expiry" });
  assert.deepEqual(parseInput("  /stats  "), { cmd: "stats", arg: "" });
});
