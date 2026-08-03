import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLine } from "../core/fingerprint.js";

test("normalizeLine masks paths and numbers", () => {
  const line = "Error: cannot open /home/you/app/src/x.ts:41:7";
  const norm = normalizeLine(line);
  assert.ok(norm.includes("<path>"));
  assert.ok(!norm.includes("41"));
  assert.ok(norm.includes("error"));
});
