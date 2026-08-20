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

test("scanJsonlLines restarts from 0 when the file shrinks below the offset", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-scan-trunc-")));
  const p = join(dir, "log.jsonl");
  const { scanJsonlLines } = await import("../agent/logs/scan.js");
  const original = JSON.stringify({ a: 1 }) + "\n" + JSON.stringify({ a: 2 }) + "\n";
  writeFileSync(p, original);
  const seen: unknown[] = [];
  const next = scanJsonlLines(p, 0, 1024 * 1024, (o) => seen.push(o));
  assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
  assert.equal(next, Buffer.byteLength(original));
  // Rotation at the same path: new content is shorter than the stale offset.
  const rotated = JSON.stringify({ b: 1 }) + "\n";
  writeFileSync(p, rotated);
  const seen2: unknown[] = [];
  const next2 = scanJsonlLines(p, next, 1024 * 1024, (o) => seen2.push(o));
  assert.deepEqual(seen2, [{ b: 1 }]);
  assert.equal(next2, Buffer.byteLength(rotated));
});

test("scanJsonlLines resumes mid-line after a byte-cap cut without loss or duplication", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-scan-cut-")));
  const p = join(dir, "log.jsonl");
  const line1 = JSON.stringify({ n: 1 }) + "\n";
  const line2 = JSON.stringify({ n: 2, pad: "x".repeat(50) }) + "\n";
  const line3 = JSON.stringify({ n: 3 }) + "\n";
  writeFileSync(p, line1 + line2 + line3);
  const { scanJsonlLines } = await import("../agent/logs/scan.js");
  // Cut ten bytes inside line 2.
  const cap = Buffer.byteLength(line1) + 10;
  const seen: unknown[] = [];
  const next = scanJsonlLines(p, 0, cap, (o) => seen.push(o));
  assert.deepEqual(seen, [{ n: 1 }]);
  assert.equal(next, Buffer.byteLength(line1));
  const seen2: unknown[] = [];
  scanJsonlLines(p, next, 1024 * 1024, (o) => seen2.push(o));
  assert.deepEqual(seen2, [{ n: 2, pad: "x".repeat(50) }, { n: 3 }]);
});

test("scanJsonlLines skips an oversized line instead of getting stuck", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-scan-big-")));
  const p = join(dir, "log.jsonl");
  const giant = JSON.stringify({ big: "x".repeat(700) }) + "\n";
  const normal = JSON.stringify({ ok: true }) + "\n";
  writeFileSync(p, giant + normal);
  const { scanJsonlLines } = await import("../agent/logs/scan.js");
  const maxBytes = 512; // smaller than the giant line
  const seen: unknown[] = [];
  const next = scanJsonlLines(p, 0, maxBytes, (o) => seen.push(o));
  assert.deepEqual(seen, []);
  // Progress past the giant line, not stuck at fromOffset.
  assert.equal(next, Buffer.byteLength(giant));
  const seen2: unknown[] = [];
  const next2 = scanJsonlLines(p, next, maxBytes, (o) => seen2.push(o));
  assert.deepEqual(seen2, [{ ok: true }]);
  assert.equal(next2, Buffer.byteLength(giant + normal));
});
