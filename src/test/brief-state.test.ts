import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACK_WINDOW_MS, parseSinceDuration, readState, writeState } from "../core/brief-state.js";

test("state round-trips and survives corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-state-"));
  const path = join(dir, "state.json");
  assert.deepEqual(readState(path), { v: 1 });
  writeState({ v: 1, lastBriefTs: 1_800_000_000_000 }, path);
  assert.deepEqual(readState(path), { v: 1, lastBriefTs: 1_800_000_000_000 });
  writeFileSync(path, "{broken", "utf8");
  assert.deepEqual(readState(path), { v: 1 });
  writeFileSync(path, JSON.stringify({ v: 1, lastBriefTs: -3 }), "utf8");
  assert.deepEqual(readState(path), { v: 1 });
});

test("parseSinceDuration understands m, h, d and rejects everything else", () => {
  assert.equal(parseSinceDuration("90m"), 90 * 60_000);
  assert.equal(parseSinceDuration("24h"), 24 * 3_600_000);
  assert.equal(parseSinceDuration("7d"), 7 * 86_400_000);
  assert.equal(parseSinceDuration("v0.5.5"), undefined);
  assert.equal(parseSinceDuration("24"), undefined);
  assert.equal(parseSinceDuration("h"), undefined);
  assert.equal(parseSinceDuration("-2d"), undefined);
});

test("fallback window is 24 hours", () => {
  assert.equal(FALLBACK_WINDOW_MS, 86_400_000);
});
