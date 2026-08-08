import test from "node:test";
import assert from "node:assert/strict";
import { commandBase, commandSignature } from "../core/fingerprint.js";

const cases: Array<[string, string]> = [
  ["rocky setup --yes", "rocky setup"],
  ["rocky setup", "rocky setup"],
  ["rocky --help", "rocky --help"],
  ["claude --resunme", "claude --resunme"],
  ["claude --resume", "claude --resume"],
  ["npm run build", "npm run"],
  ["npm run dev", "npm run"],
  ["cargo build --release", "cargo build"],
  ["cargo build", "cargo build"],
  ["/usr/bin/npm run build", "npm run"],
  ["ls -l -a", "ls -a -l"],
  ["ls -a -l", "ls -a -l"],
  ["ls -a -a -l", "ls -a -l"],
  ["", ""],
  ["   ", ""],
];

test("commandSignature matches the spec table", () => {
  for (const [input, expected] of cases) {
    assert.equal(commandSignature(input), expected, `commandSignature(${JSON.stringify(input)})`);
  }
});

test("commandSignature pairing consequences", () => {
  assert.equal(commandSignature("rocky setup --yes"), commandSignature("rocky setup"));
  assert.notEqual(commandSignature("rocky setup --yes"), commandSignature("rocky --help"));
  assert.notEqual(commandSignature("claude --resunme"), commandSignature("claude --resume"));
});

test("commandBase reduces path tokens to their basename on either separator", () => {
  assert.equal(commandBase("/usr/bin/npm run build"), "npm");
  assert.equal(commandBase("C:\\tools\\npm run build"), "npm");
});
