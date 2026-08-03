import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLine, commandFingerprint } from "../core/fingerprint.js";

test("normalizeLine masks paths and numbers", () => {
  const line = "Error: cannot open /home/you/app/src/x.ts:41:7";
  const norm = normalizeLine(line);
  assert.ok(norm.includes("<path>"));
  assert.ok(!norm.includes("41"));
  assert.ok(norm.includes("error"));
});

test("commandFingerprint is stable across volatile parts", () => {
  const a = commandFingerprint("npm run build --cache /tmp/cache-1234", 1);
  const b = commandFingerprint("npm run build --cache /tmp/cache-9876", 1);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("commandFingerprint separates by exit code and command", () => {
  const base = commandFingerprint("npm run build", 1);
  assert.notEqual(base, commandFingerprint("npm run build", 2));
  assert.notEqual(base, commandFingerprint("npm run lint", 1));
});
