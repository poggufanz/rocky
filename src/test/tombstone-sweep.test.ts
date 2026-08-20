import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("sweep removes only old tombstones, capped per run", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-tomb-")));
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  for (let i = 0; i < 105; i++) {
    const p = join(dir, `memory.jsonl.triple.lock.reclaim.tombstone.${i}.abc${i}`);
    writeFileSync(p, "");
    utimesSync(p, old, old);
  }
  const young = join(dir, "memory.jsonl.triple.lock.reclaim.tombstone.9999.young");
  writeFileSync(young, "");
  writeFileSync(join(dir, "memory.jsonl"), "");
  const { sweepReclaimTombstones, countReclaimTombstones, TOMBSTONE_SWEEP_MAX_REMOVALS } = await import("../core/memory.js");
  const removed = sweepReclaimTombstones(dir);
  assert.equal(removed, TOMBSTONE_SWEEP_MAX_REMOVALS);
  const left = readdirSync(dir).filter((f) => f.includes(".reclaim.tombstone."));
  assert.equal(left.length, 105 + 1 - TOMBSTONE_SWEEP_MAX_REMOVALS);
  assert.ok(left.includes("memory.jsonl.triple.lock.reclaim.tombstone.9999.young"));
  assert.equal(countReclaimTombstones(dir), left.length);
});
