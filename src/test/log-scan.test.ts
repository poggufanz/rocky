import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("scanJsonlLines resumes from offset, skips corrupt lines, respects byte cap", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-scan-")));
  const p = join(dir, "log.jsonl");
  writeFileSync(p, JSON.stringify({ a: 1 }) + "\n" + "NOT JSON\n" + JSON.stringify({ a: 2 }) + "\n");
  const { scanJsonlLines } = await import("../agent/logs/scan.js");
  const seen: unknown[] = [];
  const next = scanJsonlLines(p, 0, 1024 * 1024, (o) => seen.push(o));
  assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
  appendFileSync(p, JSON.stringify({ a: 3 }) + "\n");
  const seen2: unknown[] = [];
  scanJsonlLines(p, next, 1024 * 1024, (o) => seen2.push(o));
  assert.deepEqual(seen2, [{ a: 3 }]);
});

test("adapter offsets round-trip, cap at 200 entries, tolerate corruption", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-offsets-")));
  const previousHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = dir;
  try {
    const { readAdapterOffsets, writeAdapterOffsets } = await import("../agent/logs/scan.js");
    assert.deepEqual(readAdapterOffsets(), {});
    writeAdapterOffsets({ "/a/log.jsonl": 12, "/b/log.jsonl": 0 });
    assert.deepEqual(readAdapterOffsets(), { "/a/log.jsonl": 12, "/b/log.jsonl": 0 });
    const many: Record<string, number> = {};
    for (let i = 0; i < 250; i += 1) many[`/log/${i}.jsonl`] = i;
    writeAdapterOffsets(many);
    const capped = readAdapterOffsets();
    assert.equal(Object.keys(capped).length, 200);
    assert.equal(capped["/log/249.jsonl"], 249);
    assert.equal(capped["/log/49.jsonl"], undefined);
    writeFileSync(join(dir, "state.json"), "{broken", "utf8");
    assert.deepEqual(readAdapterOffsets(), {});
  } finally {
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
  }
});
