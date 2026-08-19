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

function writeZstdLog(log: string, records: object[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(log, (zlib as unknown as { zstdCompressSync(b: Buffer): Buffer }).zstdCompressSync(Buffer.from(lines)));
}

test("dsh resume: second scan from nextOffset emits only newer seqs", { skip: !hasZstd }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-dsh-resume-")));
  const log = join(dir, "session.jsonl.zstd");
  writeZstdLog(log, [
    { header: true, version: 1, session: "s2" },
    { type: "reasoning", seq: 1, time: 1000, data: { text: "first thought" } },
    { type: "turn/end", seq: 2, time: 1001, data: {} },
  ]);
  const { dshLogAdapter } = await import("../agent/logs/dsh.js");
  const first = dshLogAdapter.scan("/any", log, 0, 1024 * 1024);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].turnRef, "1");
  assert.equal(first.nextOffset, 2, "nextOffset is the highest seq seen, including non-reasoning records");
  // The session grows; rescan from the returned offset.
  writeZstdLog(log, [
    { header: true, version: 1, session: "s2" },
    { type: "reasoning", seq: 1, time: 1000, data: { text: "first thought" } },
    { type: "turn/end", seq: 2, time: 1001, data: {} },
    { type: "reasoning", seq: 3, time: 1002, data: { text: "second thought" } },
    { type: "turn/end", seq: 4, time: 1003, data: {} },
  ]);
  const second = dshLogAdapter.scan("/any", log, first.nextOffset, 1024 * 1024);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].turnRef, "3");
  assert.equal(second.events[0].text, "second thought");
  assert.equal(second.nextOffset, 4);
});

test("dsh header-less log still emits its first-line event", { skip: !hasZstd }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-dsh-nohead-")));
  const log = join(dir, "session.jsonl.zstd");
  writeZstdLog(log, [
    { type: "reasoning", seq: 1, time: 1000, data: { text: "no header here" } },
    { type: "turn/end", seq: 2, time: 1001, data: {} },
  ]);
  const { dshLogAdapter } = await import("../agent/logs/dsh.js");
  const { events } = dshLogAdapter.scan("/any", log, 0, 1024 * 1024);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "no header here");
  assert.equal(events[0].turnRef, "1");
});

test("dsh empty data.text falls back to data.reasoning", { skip: !hasZstd }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rocky-dsh-fallback-")));
  const log = join(dir, "session.jsonl.zstd");
  writeZstdLog(log, [
    { header: true, version: 1, session: "s3" },
    { type: "reasoning", seq: 1, time: 1000, data: { text: "", reasoning: "real reason" } },
  ]);
  const { dshLogAdapter } = await import("../agent/logs/dsh.js");
  const { events } = dshLogAdapter.scan("/any", log, 0, 1024 * 1024);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "real reason");
});
