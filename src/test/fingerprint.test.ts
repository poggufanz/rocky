import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLine, commandFingerprint, fingerprint } from "../core/fingerprint.js";

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

test("empty or whitespace-only stderr falls back to the command fingerprint", () => {
  assert.equal(fingerprint("", "false", 1), commandFingerprint("false", 1));
  assert.equal(fingerprint("   \n\n  \n", "false", 1), commandFingerprint("false", 1));
});

test("empty-stderr failures of different commands no longer collide", () => {
  assert.notEqual(fingerprint("", "false", 1), fingerprint("", "npm run dev -- --force", 1));
  assert.notEqual(fingerprint("", "false", 1), "da39a3ee5e6b4b0d");
});

test("non-empty stderr fingerprint ignores cmd and exit code (unchanged behavior)", () => {
  assert.equal(fingerprint("Error: boom", "a", 1), fingerprint("Error: boom", "b", 2));
});
