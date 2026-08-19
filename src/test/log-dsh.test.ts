import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function";

test("dsh adapter extracts reasoning events with seq turnRef", { skip: !hasZstd }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-dsh-")));
  const log = join(dir, "session.jsonl.zstd");
  const lines = [
    JSON.stringify({ header: true, version: 1, session: "s1" }),
    JSON.stringify({ type: "turn/start", seq: 1, time: 1000, data: {} }),
    JSON.stringify({ type: "reasoning", seq: 2, time: 1001, data: { text: "cache never invalidated on write" } }),
    JSON.stringify({ type: "turn/end", seq: 3, time: 1002, data: {} }),
  ].join("\n");
  writeFileSync(log, (zlib as unknown as { zstdCompressSync(b: Buffer): Buffer }).zstdCompressSync(Buffer.from(lines)));
  const previousLog = process.env.DSH_SESSION_JSONL;
  process.env.DSH_SESSION_JSONL = log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.DSH_SESSION_JSONL;
    else process.env.DSH_SESSION_JSONL = previousLog;
  });
  const { dshLogAdapter } = await import("../agent/logs/dsh.js");
  const { events } = dshLogAdapter.scan("/any", log, 0, 1024 * 1024);
  assert.equal(events.length, 1);
  assert.equal(events[0].fidelity, "raw");
  assert.equal(events[0].turnRef, "2");
});

test("zstdAvailable reports capability without throwing", async () => {
  const { zstdAvailable } = await import("../agent/logs/dsh.js");
  assert.equal(typeof zstdAvailable(), "boolean");
});
