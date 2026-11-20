import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  commandIdentity,
  FINGERPRINT_ALGORITHM_VERSION,
  fingerprint,
  signatureLines,
} from "../core/fingerprint.js";
import {
  boundCommand,
  clearPendingIfResolved,
  pendingPath,
  recordTripleOnce,
  resolveFixOnSuccess,
  touchPending,
  withMemoryTransaction,
} from "../core/memory.js";
import { findByFingerprintOnDisk } from "../core/memory-index.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  CLOCK_SKEW_MS,
  isCompleteMemoryCoverage,
  loadMemoryChecked,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_LINE_BYTES,
  MAX_SUPPORTED_MEMORY_RECORDS,
  maxSupportedMemoryRecords,
  tailReadable,
  windowCovered,
  type FailureRecord,
  type FixRecord,
} from "../core/memory-read.js";
import { failureLine, failureLines, failureLinesPastByteCap, withRecordCap } from "./memory-cap-fixture.js";

const NOW = 1_700_000_000_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

function tempHome(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rocky-tail-window-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixLine(index: number, ts: number): string {
  return JSON.stringify({
    kind: "fix", id: `fix-${index}`, ts, cwd: "/cap-fixture", cmd: "false", failureIds: [],
  });
}

function associationLine(index: number, ts: number): string {
  return JSON.stringify({
    kind: "association",
    id: `assoc-${index}`,
    ts,
    cwd: "/cap-fixture",
    cmd: "false",
    candidateFailureIds: [],
    links: [{ id: `r${index}`, basis: "program", confidence: "possible" }],
  });
}

function rationaleLine(index: number, ts: number): string {
  return JSON.stringify({
    kind: "rationale",
    id: `rat-${index}`,
    ts,
    v: 1,
    cwd: "/cap-fixture",
    agent: "generic",
    rationale_fidelity: "raw",
    source: "notify",
    excerpt: "expect pass",
  });
}

function tripleLine(index: number, ts: number): string {
  return JSON.stringify({
    kind: "triple",
    id: `triple-${index}`,
    ts,
    cwd: "/cap-fixture",
    schemaV: 1,
    agent: "codex",
    origin: "agent-hook",
    platform: "linux",
    mechanism: {
      files: [{ path: "src/app.ts", plusMinus: [1, 0], props: [] }],
      truncatedFiles: 0,
      coverageStatus: "complete",
    },
  });
}

test("record cap seam applies only under ROCKY_TEST_SEAMS=1", (t) => {
  withRecordCap(t, 50);
  delete process.env.ROCKY_TEST_SEAMS;
  assert.equal(maxSupportedMemoryRecords(), MAX_SUPPORTED_MEMORY_RECORDS);
  process.env.ROCKY_TEST_SEAMS = "1";
  assert.equal(maxSupportedMemoryRecords(), 50);
  process.env.ROCKY_TEST_SEAMS = "true";
  assert.equal(maxSupportedMemoryRecords(), MAX_SUPPORTED_MEMORY_RECORDS);
});

test("record cap seam ignores non-positive or non-integer values", (t) => {
  withRecordCap(t, 50);
  for (const bad of ["0", "-1", "1.5", "abc", ""]) {
    process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = bad;
    assert.equal(maxSupportedMemoryRecords(), MAX_SUPPORTED_MEMORY_RECORDS);
  }
});

test("reader stops at the seam cap", (t) => {
  withRecordCap(t, 50);
  const home = tempHome(t);
  writeFileSync(join(home, "memory.jsonl"), failureLines(50));
  const exact = loadMemoryChecked(join(home, "memory.jsonl"));
  assert.equal(exact.coverage.complete, true);
  assert.equal(exact.coverage.window, undefined);
  writeFileSync(join(home, "memory-over.jsonl"), failureLines(51));
  const over = loadMemoryChecked(join(home, "memory-over.jsonl"));
  assert.equal(over.records.length, 50);
  assert.equal(over.records[0]?.id, "r1");
  assert.equal(over.records.at(-1)?.id, "r50");
  assert.equal(over.coverage.complete, false);
  assert.equal(over.coverage.reason, "record-cap");
  assert.equal(over.coverage.window, "tail");
});

test("over the record cap the reader keeps the newest records", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);
  const path = join(home, "memory.jsonl");
  const lines = Array.from({ length: 10_050 }, (_, index) => `${failureLine(index, "false", NOW - 10_050 + index)}\n`).join("");
  writeFileSync(path, lines, "utf8");

  const loaded = loadMemoryChecked(path, NOW);
  assert.equal(loaded.records.length, 10_000);
  assert.equal(loaded.records[0]?.id, "r50");
  assert.equal(loaded.records.at(-1)?.id, "r10049");
  assert.equal(loaded.coverage.complete, false);
  assert.equal(loaded.coverage.truncated, 1);
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.reason, "record-cap");
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(loaded.coverage.scanned, 10_000);
  assert.ok(typeof loaded.coverage.startOffset === "number" && loaded.coverage.startOffset > 0);
  assert.equal(loaded.coverage.bytesScanned, loaded.coverage.bytesTotal - loaded.coverage.startOffset!);
  assert.equal(isCompleteMemoryCoverage(loaded.coverage), false);
  assert.equal(tailReadable(loaded.coverage), true);
});

test("tail oldestTs counts only failure, fix, and association records", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);

  const mixedPath = join(home, "mixed.jsonl");
  const mixedLines: string[] = [];
  for (let index = 0; index < 50; index += 1) mixedLines.push(`${failureLine(index, "false", 1)}\n`);
  mixedLines.push(`${rationaleLine(50, 1)}\n`);
  mixedLines.push(`${tripleLine(51, 2)}\n`);
  for (let index = 52; index < 10_048; index += 1) mixedLines.push(`${failureLine(index, "false", NOW - 3_600_000 + index)}\n`);
  mixedLines.push(`${fixLine(10_048, NOW - 3_600_000)}\n`);
  mixedLines.push(`${associationLine(10_049, NOW - 3_600_000)}\n`);
  writeFileSync(mixedPath, mixedLines.join(""), "utf8");

  const mixed = loadMemoryChecked(mixedPath, NOW);
  assert.equal(mixed.coverage.window, "tail");
  assert.equal(mixed.coverage.oldestTs, NOW - 3_600_000);
  assert.equal(tailReadable(mixed.coverage), true);
  assert.equal(windowCovered(mixed.coverage, NOW, EIGHT_HOURS_MS), false);

  const assocPath = join(home, "assoc-oldest.jsonl");
  const assocLines: string[] = [];
  for (let index = 0; index < 50; index += 1) assocLines.push(`${failureLine(index, "false", 1)}\n`);
  assocLines.push(`${associationLine(50, NOW - EIGHT_HOURS_MS - CLOCK_SKEW_MS - 1)}\n`);
  for (let index = 51; index < 10_050; index += 1) assocLines.push(`${failureLine(index, "false", NOW - 1000)}\n`);
  writeFileSync(assocPath, assocLines.join(""), "utf8");

  const assoc = loadMemoryChecked(assocPath, NOW);
  assert.equal(assoc.coverage.oldestTs, NOW - EIGHT_HOURS_MS - CLOCK_SKEW_MS - 1);
  assert.equal(windowCovered(assoc.coverage, NOW, EIGHT_HOURS_MS), true);

  const fixPath = join(home, "fix-oldest.jsonl");
  const fixLines: string[] = [];
  for (let index = 0; index < 50; index += 1) fixLines.push(`${failureLine(index, "false", 1)}\n`);
  fixLines.push(`${fixLine(50, NOW - EIGHT_HOURS_MS - CLOCK_SKEW_MS - 1)}\n`);
  for (let index = 51; index < 10_050; index += 1) fixLines.push(`${failureLine(index, "false", NOW - 1000)}\n`);
  writeFileSync(fixPath, fixLines.join(""), "utf8");

  const fixOldest = loadMemoryChecked(fixPath, NOW);
  assert.equal(fixOldest.coverage.oldestTs, NOW - EIGHT_HOURS_MS - CLOCK_SKEW_MS - 1);
  assert.equal(windowCovered(fixOldest.coverage, NOW, EIGHT_HOURS_MS), true);

  const nonRockyPath = join(home, "non-rocky.jsonl");
  const nonRockyLines: string[] = [];
  for (let index = 0; index < 50; index += 1) nonRockyLines.push(`${failureLine(index, "false", 1)}\n`);
  for (let index = 50; index < 10_050; index += 1) {
    nonRockyLines.push(index % 2 === 0 ? `${rationaleLine(index, 1)}\n` : `${tripleLine(index, 1)}\n`);
  }
  writeFileSync(nonRockyPath, nonRockyLines.join(""), "utf8");

  const nonRocky = loadMemoryChecked(nonRockyPath, NOW);
  assert.equal(nonRocky.coverage.window, "tail");
  assert.equal(nonRocky.coverage.oldestTs, undefined);
  assert.equal(tailReadable(nonRocky.coverage), true);
  assert.equal(windowCovered(nonRocky.coverage, NOW, EIGHT_HOURS_MS), false);
});

test("windowCovered needs the window to reach past 8h plus skew", (t) => {
  withRecordCap(t, 10_000);
  assert.equal(CLOCK_SKEW_MS, 600_000);
  const home = tempHome(t);

  const makeFile = (name: string, oldestInTailTs: number): string => {
    const path = join(home, name);
    const lines: string[] = [];
    for (let index = 0; index < 50; index += 1) lines.push(`${failureLine(index, "false", 1)}\n`);
    lines.push(`${failureLine(50, "false", oldestInTailTs)}\n`);
    for (let index = 51; index < 10_050; index += 1) lines.push(`${failureLine(index, "false", NOW - 1_000)}\n`);
    writeFileSync(path, lines.join(""), "utf8");
    return path;
  };

  const outsideSkew = loadMemoryChecked(makeFile("outside.jsonl", NOW - EIGHT_HOURS_MS - 11 * 60_000), NOW);
  assert.equal(windowCovered(outsideSkew.coverage, NOW, EIGHT_HOURS_MS), true);

  const insideSkew = loadMemoryChecked(makeFile("inside.jsonl", NOW - EIGHT_HOURS_MS - 9 * 60_000), NOW);
  assert.equal(windowCovered(insideSkew.coverage, NOW, EIGHT_HOURS_MS), false);
});

test("tail reads a multibyte character split across the 64 KiB chunk boundary", (t) => {
  withRecordCap(t, 200);
  const home = tempHome(t);
  const path = join(home, "utf8-boundary.jsonl");
  const marker = "é漢🙂";
  const prefix = Array.from({ length: 10 }, (_, index) => `${failureLine(index, "a".repeat(300), NOW)}\n`).join("");
  const tailAfter = Array.from({ length: 95 }, (_, index) => `${failureLine(index + 115, "b".repeat(450), NOW)}\n`).join("");
  const tailAfterBytes = Buffer.byteLength(tailAfter, "utf8");
  const baseLine = `${failureLine(114, `PAD_${marker}_`, NOW)}\n`;
  const markerOffsetInLine = Buffer.byteLength(baseLine.slice(0, baseLine.indexOf(marker)), "utf8");
  const bytesNeededAfterMarkerStart = 65_536 + 4 - tailAfterBytes;
  const tailPadLength = bytesNeededAfterMarkerStart - (Buffer.byteLength(baseLine, "utf8") - markerOffsetInLine);
  assert.ok(tailPadLength > 0, `expected positive pad length, got ${tailPadLength}`);
  const targetLine = `${failureLine(114, `PAD_${marker}_${"z".repeat(tailPadLength)}`, NOW)}\n`;
  const middle = Array.from({ length: 104 }, (_, index) => `${failureLine(index + 10, "c".repeat(300), NOW)}\n`).join("");
  const content = prefix + middle + targetLine + tailAfter;
  writeFileSync(path, content, "utf8");

  const totalBytes = Buffer.byteLength(content, "utf8");
  const boundaryFromEof = totalBytes - 65_536;
  const targetStart = Buffer.byteLength(prefix + middle, "utf8");
  const markerStart = targetStart + Buffer.byteLength(targetLine.slice(0, targetLine.indexOf(marker)), "utf8");
  const markerEnd = markerStart + Buffer.byteLength(marker, "utf8");
  assert.ok(markerStart < boundaryFromEof && boundaryFromEof < markerEnd, "chunk boundary from EOF must split the multibyte sequence");

  const loaded = loadMemoryChecked(path, NOW);
  assert.equal(loaded.records.length, 200);
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(tailReadable(loaded.coverage), true);
  const target = loaded.records.find((record) => record.id === "r114");
  assert.equal(target?.kind, "failure");
  if (target?.kind === "failure") {
    assert.ok(target.excerpt.includes(marker));
    assert.equal(target.excerpt, `PAD_${marker}_${"z".repeat(tailPadLength)}`);
  }
});

test("tail keeps the final line without a trailing newline", (t) => {
  withRecordCap(t, 50);
  const home = tempHome(t);

  const path51 = join(home, "no-nl-51.jsonl");
  writeFileSync(path51, Array.from({ length: 51 }, (_, index) => failureLine(index)).join("\n"), "utf8");
  const loaded51 = loadMemoryChecked(path51, NOW);
  assert.equal(loaded51.records.length, 50);
  assert.equal(loaded51.records[0]?.id, "r1");
  assert.equal(loaded51.records.at(-1)?.id, "r50");
  assert.equal(loaded51.coverage.window, "tail");
  assert.equal(loaded51.coverage.skipped, 0);
  assert.equal(tailReadable(loaded51.coverage), true);

  const path55 = join(home, "no-nl-55.jsonl");
  writeFileSync(path55, Array.from({ length: 55 }, (_, index) => failureLine(index)).join("\n"), "utf8");
  const loaded55 = loadMemoryChecked(path55, NOW);
  assert.equal(loaded55.records.length, 50);
  assert.equal(loaded55.records[0]?.id, "r5");
  assert.equal(loaded55.records.at(-1)?.id, "r54");
  assert.equal(loaded55.coverage.window, "tail");
  assert.equal(loaded55.coverage.skipped, 0);
  assert.equal(tailReadable(loaded55.coverage), true);
});

test("tail parses CRLF lines like LF lines", (t) => {
  withRecordCap(t, 50);
  const home = tempHome(t);
  const path = join(home, "crlf.jsonl");
  writeFileSync(path, Array.from({ length: 60 }, (_, index) => failureLine(index)).join("\r\n") + "\r\n", "utf8");

  const loaded = loadMemoryChecked(path, NOW);
  assert.equal(loaded.records.length, 50);
  assert.equal(loaded.records[0]?.id, "r10");
  assert.equal(loaded.records.at(-1)?.id, "r59");
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(tailReadable(loaded.coverage), true);
});

test("tail with one oversized line reports skipped and is not tailReadable", (t) => {
  withRecordCap(t, 50);
  const home = tempHome(t);
  const path = join(home, "oversized-tail.jsonl");
  const lines = Array.from({ length: 60 }, (_, index) =>
    index === 55 ? failureLine(index, "x".repeat(MAX_MEMORY_LINE_BYTES + 100)) : failureLine(index)
  );
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

  const loaded = loadMemoryChecked(path, NOW);
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.skipped, 1);
  assert.equal(loaded.records.length, 49);
  assert.equal(tailReadable(loaded.coverage), false);
  assert.equal(windowCovered(loaded.coverage, NOW, EIGHT_HOURS_MS), false);
});

test("file over 32 MiB reads a tail bounded by the byte cap", (t) => {
  const home = tempHome(t);
  const path = join(home, "big.jsonl");
  const content = failureLinesPastByteCap();
  const expectedCount = content.trimEnd().split("\n").length;
  writeFileSync(path, content, "utf8");

  const loaded = loadMemoryChecked(path, NOW);
  assert.equal(loaded.coverage.reason, "file-size-cap");
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.complete, false);
  assert.equal(loaded.coverage.truncated, 1);
  assert.equal(loaded.coverage.skipped, 0);
  assert.ok(loaded.coverage.bytesScanned <= MAX_MEMORY_FILE_BYTES);
  assert.ok(typeof loaded.coverage.startOffset === "number" && loaded.coverage.startOffset > 0);
  assert.equal(loaded.coverage.bytesScanned, loaded.coverage.bytesTotal - loaded.coverage.startOffset!);
  assert.equal(loaded.records.at(-1)?.id, `r${expectedCount - 1}`);
  assert.equal(tailReadable(loaded.coverage), true);
});

test("append during the tail read reports read-race", (t) => {
  const root = tempHome(t);
  const path = join(root, "memory.jsonl");
  const marker = join(root, "tail-race-fired");
  writeFileSync(path, failureLines(60), "utf8");
  const extraLine = `${failureLine(60)}\n`;
  const preload = join(root, "tail-race.cjs");
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readSync.bind(fs);",
    "const fds = new Set();",
    "let reads = 0;",
    "let fired = false;",
    "fs.openSync = (value, ...args) => { const fd = originalOpen(value, ...args); if (String(value) === process.env.ROCKY_TEST_MEMORY) fds.add(fd); return fd; };",
    "fs.readSync = (fd, ...args) => {",
    "  const result = originalRead(fd, ...args);",
    "  if (fds.has(fd)) {",
    "    reads += 1;",
    "    if (!fired && reads === 2) {",
    "      fired = true;",
    "      fs.appendFileSync(process.env.ROCKY_TEST_MEMORY, process.env.ROCKY_TEST_APPEND_LINE, 'utf8');",
    "      fs.writeFileSync(process.env.ROCKY_TEST_RACE_MARKER, 'fired');",
    "    }",
    "  }",
    "  return result;",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");

  const modulePath = join(process.cwd(), "dist", "core", "memory-read.js");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", [
    `const { loadMemoryChecked, tailReadable } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    `const first = loadMemoryChecked(${JSON.stringify(path)});`,
    `const firstTailReadable = tailReadable(first.coverage);`,
    `const second = loadMemoryChecked(${JSON.stringify(path)});`,
    `const secondTailReadable = tailReadable(second.coverage);`,
    "process.stdout.write(JSON.stringify({",
    "  firstCount: first.records.length,",
    "  firstComplete: first.complete,",
    "  firstReason: first.coverage.reason,",
    "  firstWindow: first.coverage.window,",
    "  firstTailReadable,",
    "  secondCount: second.records.length,",
    "  secondLastId: second.records.at(-1)?.id,",
    "  secondWindow: second.coverage.window,",
    "  secondTailReadable,",
    "}));",
  ].join("\n")], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      ROCKY_TEST_SEAMS: "1",
      ROCKY_TEST_MAX_MEMORY_RECORDS: "50",
      ROCKY_TEST_MEMORY: path,
      ROCKY_TEST_RACE_MARKER: marker,
      ROCKY_TEST_APPEND_LINE: extraLine,
    },
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(marker), true, "tail read-race seam must fire");
  const output = JSON.parse(child.stdout) as {
    firstCount: number;
    firstComplete: boolean;
    firstReason?: string;
    firstWindow?: string;
    firstTailReadable: boolean;
    secondCount: number;
    secondLastId?: string;
    secondWindow?: string;
    secondTailReadable: boolean;
  };
  assert.equal(output.firstCount, 0);
  assert.equal(output.firstComplete, false);
  assert.equal(output.firstReason, "read-race");
  assert.equal(output.firstWindow, undefined);
  assert.equal(output.firstTailReadable, false);
  assert.equal(output.secondCount, 50);
  assert.equal(output.secondLastId, "r60");
  assert.equal(output.secondWindow, "tail");
  assert.equal(output.secondTailReadable, true);
});

test("exact-cap file with a trailing blank CRLF line stays complete", (t) => {
  withRecordCap(t, 2);
  const home = tempHome(t);
  const path = join(home, "exact-cap-blank-crlf.jsonl");
  writeFileSync(path, `${failureLine(0)}\r\n${failureLine(1)}\r\n\r\n`, "utf8");

  const loaded = loadMemoryChecked(path, NOW);
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.records[0]?.id, "r0");
  assert.equal(loaded.records[1]?.id, "r1");
  assert.equal(loaded.complete, true);
  assert.equal(loaded.coverage.complete, true);
  assert.equal(loaded.coverage.window, undefined);
  assert.equal(loaded.coverage.reason, undefined);
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(loaded.coverage.truncated, 0);
  assert.equal(isCompleteMemoryCoverage(loaded.coverage), true);
});

test("file over 32 MiB with no LF in the last 32 MiB scans zero lines and zero bytes with zero skips", (t) => {
  const home = tempHome(t);
  const path = join(home, "no-lf-tail.jsonl");
  const prefix = Buffer.from(`${failureLine(0, "false", NOW - 1_000)}\n`, "utf8");
  const suffix = Buffer.alloc(MAX_MEMORY_FILE_BYTES + 1024, 0x61);
  writeFileSync(path, Buffer.concat([prefix, suffix]));

  const loaded = loadMemoryChecked(path, NOW);
  assert.equal(loaded.records.length, 0);
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.reason, "file-size-cap");
  assert.equal(loaded.coverage.complete, false);
  assert.equal(loaded.coverage.truncated, 1);
  assert.equal(loaded.coverage.scanned, 0);
  assert.equal(loaded.coverage.bytesScanned, 0);
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(loaded.coverage.startOffset, loaded.coverage.bytesTotal);
  assert.equal(loaded.coverage.oldestTs, undefined);
  assert.equal(tailReadable(loaded.coverage), true);
  assert.equal(windowCovered(loaded.coverage, NOW, EIGHT_HOURS_MS), false);
});

test("duplicate id straddling an unterminated tail cutoff keeps the newest copy without a skip", (t) => {
  withRecordCap(t, 2);
  const home = tempHome(t);
  const path = join(home, "unterminated-dup.jsonl");
  const rowA = JSON.stringify({
    kind: "failure", id: "row-a", ts: NOW - 4_000, cwd: "/cap-fixture", cmd: "false", exitCode: 1,
    fingerprint: "a".repeat(16), signature: ["false"], excerpt: "a",
  });
  const rowBOld = JSON.stringify({
    kind: "failure", id: "dup-b", ts: NOW - 3_000, cwd: "/cap-fixture", cmd: "false", exitCode: 1,
    fingerprint: "b".repeat(16), signature: ["false"], excerpt: "old-b",
  });
  const rowC = JSON.stringify({
    kind: "failure", id: "row-c", ts: NOW - 2_000, cwd: "/cap-fixture", cmd: "false", exitCode: 1,
    fingerprint: "c".repeat(16), signature: ["false"], excerpt: "c",
  });
  const rowBNew = JSON.stringify({
    kind: "failure", id: "dup-b", ts: NOW - 1_000, cwd: "/cap-fixture", cmd: "false", exitCode: 1,
    fingerprint: "b".repeat(16), signature: ["false"], excerpt: "new-b",
  });
  writeFileSync(path, [rowA, rowBOld, rowC, rowBNew].join("\n"), "utf8");

  const loaded = loadMemoryChecked(path, NOW);
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.records[0]?.id, "row-c");
  assert.equal(loaded.records[1]?.id, "dup-b");
  assert.equal(loaded.records[1]?.kind, "failure");
  if (loaded.records[1]?.kind === "failure") {
    assert.equal(loaded.records[1].excerpt, "new-b");
    assert.equal(loaded.records[1].ts, NOW - 1_000);
  }
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.reason, "record-cap");
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(loaded.coverage.scanned, 2);
  assert.equal(tailReadable(loaded.coverage), true);
});

function namedFailureLine(id: string, ts = NOW): string {
  return JSON.stringify({
    kind: "failure",
    id,
    ts,
    cwd: "/cap-fixture",
    cmd: "false",
    exitCode: 1,
    fingerprint: id.toLowerCase().repeat(16),
    signature: ["false"],
    excerpt: id,
  });
}

test("tail ignores an unterminated whitespace-only suffix", (t) => {
  withRecordCap(t, 2);
  const home = tempHome(t);
  const rowA = namedFailureLine("A", NOW - 3_000);
  const rowB = namedFailureLine("B", NOW - 2_000);
  const rowC = namedFailureLine("C", NOW - 1_000);

  const spacePath = join(home, "suffix-space.jsonl");
  writeFileSync(spacePath, `${rowA}\n${rowB}\n${rowC}\n `, "utf8");
  const spaceLoaded = loadMemoryChecked(spacePath, NOW);
  assert.deepEqual(spaceLoaded.records.map((record) => record.id), ["B", "C"]);
  assert.equal(spaceLoaded.coverage.window, "tail");
  assert.equal(spaceLoaded.coverage.reason, "record-cap");
  assert.equal(spaceLoaded.coverage.skipped, 0);
  assert.equal(tailReadable(spaceLoaded.coverage), true);

  const tabChunkPath = join(home, "suffix-tab-chunk.jsonl");
  writeFileSync(tabChunkPath, `${rowA}\n${rowB}\n${rowC}\n\t${" ".repeat(65_600)}`, "utf8");
  const tabChunkLoaded = loadMemoryChecked(tabChunkPath, NOW);
  assert.deepEqual(tabChunkLoaded.records.map((record) => record.id), ["B", "C"]);
  assert.equal(tabChunkLoaded.coverage.window, "tail");
  assert.equal(tabChunkLoaded.coverage.reason, "record-cap");
  assert.equal(tabChunkLoaded.coverage.skipped, 0);
  assert.equal(tailReadable(tabChunkLoaded.coverage), true);
});

test("tail ignores a trailing blank LF line", (t) => {
  withRecordCap(t, 2);
  const home = tempHome(t);
  const rowA = namedFailureLine("A", NOW - 3_000);
  const rowB = namedFailureLine("B", NOW - 2_000);
  const rowC = namedFailureLine("C", NOW - 1_000);

  const path = join(home, "trailing-blank-lf.jsonl");
  writeFileSync(path, `${rowA}\n${rowB}\n${rowC}\n\n`, "utf8");
  const loaded = loadMemoryChecked(path, NOW);
  assert.deepEqual(loaded.records.map((record) => record.id), ["B", "C"]);
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.reason, "record-cap");
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(tailReadable(loaded.coverage), true);

  const interiorPath = join(home, "interior-blank-lf.jsonl");
  writeFileSync(interiorPath, `${rowA}\n${rowB}\n \t \n${rowC}\n`, "utf8");
  const interiorLoaded = loadMemoryChecked(interiorPath, NOW);
  assert.deepEqual(interiorLoaded.records.map((record) => record.id), ["B", "C"]);
  assert.equal(interiorLoaded.coverage.window, "tail");
  assert.equal(interiorLoaded.coverage.reason, "record-cap");
  assert.equal(interiorLoaded.coverage.skipped, 0);
  assert.equal(tailReadable(interiorLoaded.coverage), true);
});

test("tail ignores a trailing blank CRLF line", (t) => {
  withRecordCap(t, 2);
  const home = tempHome(t);
  const rowA = namedFailureLine("A", NOW - 3_000);
  const rowB = namedFailureLine("B", NOW - 2_000);
  const rowC = namedFailureLine("C", NOW - 1_000);

  const path = join(home, "trailing-blank-crlf.jsonl");
  writeFileSync(path, `${rowA}\r\n${rowB}\r\n${rowC}\r\n\r\n`, "utf8");
  const loaded = loadMemoryChecked(path, NOW);
  assert.deepEqual(loaded.records.map((record) => record.id), ["B", "C"]);
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.reason, "record-cap");
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(tailReadable(loaded.coverage), true);
});

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function withRockyHome(t: TestContext, home: string): void {
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
}

function reliableFailureRecord(
  id: string,
  cmd: string,
  cwd: string,
  ts: number,
  stderr = "false",
): FailureRecord {
  const storedCmd = boundCommand(cmd);
  const identity = commandIdentity(storedCmd);
  assert.equal(identity.reliable, true, `expected reliable command identity for ${cmd}`);
  return {
    kind: "failure",
    id,
    ts,
    cwd,
    cmd: storedCmd,
    exitCode: 1,
    fingerprint: fingerprint(stderr, storedCmd, 1),
    fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: signatureLines(stderr),
    excerpt: stderr,
    commandIdentity: identity.value,
    identityV: identity.version,
    identityReliable: identity.reliable,
    platform: process.platform,
  };
}

function fillerFailureLines(count: number, cwd: string, ts: number): string[] {
  const template = reliableFailureRecord("filler-template", "cargo check", cwd, ts, "check failed");
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    ...template,
    id: `filler-${index}`,
  }));
}

test("unlock: covered tail links the fix and clears pending", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const targetFailure = reliableFailureRecord(
    "target-failure",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const lines = [
    ...fillerFailureLines(10_049, otherCwd, NOW - THREE_DAYS_MS),
    JSON.stringify(targetFailure),
  ];
  writeFileSync(join(home, "memory.jsonl"), `${lines.join("\n")}\n`, "utf8");
  touchPending();
  assert.equal(existsSync(pendingPath()), true);

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 1);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, undefined);

  const lastLine = readFileSync(join(home, "memory.jsonl"), "utf8").trimEnd().split("\n").at(-1);
  assert.ok(lastLine !== undefined);
  const lastRecord = JSON.parse(lastLine) as FixRecord;
  assert.equal(lastRecord.kind, "fix");
  assert.equal(lastRecord.failureIds.includes(targetFailure.id), true);
  assert.equal(existsSync(pendingPath()), false);

  const hits = createMemoryQueries().recall({ query: "TypeError token undefined", now: NOW });
  const match = hits.find((hit) => hit.failure.id === targetFailure.id);
  assert.ok(match !== undefined, "expected recall to find the failure in the covered tail");
  assert.ok(match.fix !== undefined);
  assert.equal(match.fix.failureIds.includes(targetFailure.id), true);
});

test("lock: tail entirely inside 8h writes no fix and keeps pending", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const targetFailure = reliableFailureRecord(
    "target-failure",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const lines = [
    ...fillerFailureLines(10_049, otherCwd, NOW - 2 * 60 * 60 * 1000),
    JSON.stringify(targetFailure),
  ];
  const memoryFile = join(home, "memory.jsonl");
  writeFileSync(memoryFile, `${lines.join("\n")}\n`, "utf8");
  const before = readFileSync(memoryFile, "utf8");
  touchPending();

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 0);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, "coverage");
  assert.equal(readFileSync(memoryFile, "utf8"), before);
  assert.equal(existsSync(pendingPath()), true);
});

test("skew: oldest record inside the 10-minute margin is refused", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const targetFailure = reliableFailureRecord(
    "target-failure",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const lines = [
    ...fillerFailureLines(10_049, otherCwd, NOW - EIGHT_HOURS_MS - 5 * 60 * 1000),
    JSON.stringify(targetFailure),
  ];
  const memoryFile = join(home, "memory.jsonl");
  writeFileSync(memoryFile, `${lines.join("\n")}\n`, "utf8");
  const before = readFileSync(memoryFile, "utf8");
  touchPending();

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 0);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, "coverage");
  assert.equal(readFileSync(memoryFile, "utf8"), before);
  assert.equal(existsSync(pendingPath()), true);
});

test("corrupt line in the tail pauses linking", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const targetFailure = reliableFailureRecord(
    "target-failure",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const lines = [
    ...fillerFailureLines(10_048, otherCwd, NOW - THREE_DAYS_MS),
    "{not-json}",
    JSON.stringify(targetFailure),
  ];
  const memoryFile = join(home, "memory.jsonl");
  writeFileSync(memoryFile, `${lines.join("\n")}\n`, "utf8");
  const before = readFileSync(memoryFile, "utf8");
  touchPending();

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 0);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, "coverage");
  assert.equal(readFileSync(memoryFile, "utf8"), before);
  assert.equal(existsSync(pendingPath()), true);
});

test("triple writes stay fail-closed above the cap", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const targetFailure = reliableFailureRecord(
    "target-failure",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const lines = [
    ...fillerFailureLines(10_049, otherCwd, NOW - THREE_DAYS_MS),
    JSON.stringify(targetFailure),
  ];
  const memoryFile = join(home, "memory.jsonl");
  writeFileSync(memoryFile, `${lines.join("\n")}\n`, "utf8");
  const before = readFileSync(memoryFile, "utf8");

  assert.throws(
    () => recordTripleOnce(
      {
        agent: "codex",
        cwd: targetCwd,
        mechanism: { files: [{ path: "src/app.ts", plusMinus: [1, 0], props: [] }], truncatedFiles: 0 },
      },
      "tail-triple-claim",
    ),
    /complete memory coverage/u,
  );
  assert.equal(readFileSync(memoryFile, "utf8"), before);
});

test("clearPendingIfResolved clears on a covered tail and keeps on a short one", (t) => {
  withRecordCap(t, 10_000);

  const coveredHome = tempHome(t);
  withRockyHome(t, coveredHome);
  const coveredCwd = join(coveredHome, "repo");
  const otherCwd = join(coveredHome, "other");
  const resolvedFailure = reliableFailureRecord(
    "resolved-failure",
    "npm test",
    coveredCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const resolvingFix: FixRecord = {
    kind: "fix",
    id: "resolving-fix",
    ts: NOW - 30 * 60 * 1000,
    cwd: coveredCwd,
    cmd: "npm test",
    failureIds: [resolvedFailure.id],
    links: [{ id: resolvedFailure.id, basis: "identity", confidence: "confirmed" }],
  };
  writeFileSync(
    join(coveredHome, "memory.jsonl"),
    [
      ...fillerFailureLines(10_048, otherCwd, NOW - THREE_DAYS_MS),
      JSON.stringify(resolvedFailure),
      JSON.stringify(resolvingFix),
    ].join("\n") + "\n",
    "utf8",
  );
  touchPending();
  clearPendingIfResolved([], EIGHT_HOURS_MS, NOW);
  assert.equal(existsSync(pendingPath()), false);

  const shortHome = tempHome(t);
  withRockyHome(t, shortHome);
  const shortCwd = join(shortHome, "repo");
  const truncatedOlderFailure = reliableFailureRecord(
    "truncated-older-failure",
    "cargo test",
    shortCwd,
    NOW - 5 * 60 * 60 * 1000,
    "earlier unresolved failure",
  );
  const recentFixTemplate: FixRecord = {
    kind: "fix",
    id: "recent-fix-template",
    ts: NOW - 2 * 60 * 60 * 1000,
    cwd: shortCwd,
    cmd: "npm test",
    failureIds: ["resolved-failure"],
    links: [{ id: "resolved-failure", basis: "identity", confidence: "confirmed" }],
  };
  const recentFixes = Array.from({ length: 10_048 }, (_, index) => JSON.stringify({
    ...recentFixTemplate,
    id: `recent-fix-${index}`,
  }));
  writeFileSync(
    join(shortHome, "memory.jsonl"),
    [
      JSON.stringify(truncatedOlderFailure),
      ...recentFixes,
      JSON.stringify(resolvedFailure),
      JSON.stringify(resolvingFix),
    ].join("\n") + "\n",
    "utf8",
  );
  touchPending();
  clearPendingIfResolved([], EIGHT_HOURS_MS, NOW);
  assert.equal(existsSync(pendingPath()), true);
});

test("exact-cap ledger linking an evicted failure reports the fix truthfully and keeps pending", (t) => {
  withRecordCap(t, 3);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const targetFailure = reliableFailureRecord(
    "oldest-target",
    "npm test",
    targetCwd,
    NOW - 2 * 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const fillerB = reliableFailureRecord("recent-b", "cargo check", otherCwd, NOW - 60 * 60 * 1000, "b");
  const fillerC = reliableFailureRecord("recent-c", "cargo check", otherCwd, NOW - 30 * 60 * 1000, "c");
  const memoryFile = join(home, "memory.jsonl");
  writeFileSync(
    memoryFile,
    [JSON.stringify(targetFailure), JSON.stringify(fillerB), JSON.stringify(fillerC)].join("\n") + "\n",
    "utf8",
  );
  touchPending();

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 1);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, undefined);
  assert.ok(result.fix !== undefined);

  const lastLine = readFileSync(memoryFile, "utf8").trimEnd().split("\n").at(-1);
  assert.ok(lastLine !== undefined);
  const lastRecord = JSON.parse(lastLine) as FixRecord;
  assert.equal(lastRecord.kind, "fix");
  assert.equal(lastRecord.id, result.fix.id);
  assert.equal(lastRecord.failureIds.includes(targetFailure.id), true);
  assert.equal(existsSync(pendingPath()), true);
  assert.equal(windowCovered(loadMemoryChecked(memoryFile, NOW).coverage, NOW, EIGHT_HOURS_MS), false);
});

test("capped tail whose sole old witness is evicted by linking reports the fix truthfully and keeps pending", (t) => {
  withRecordCap(t, 3);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const evictedFiller = reliableFailureRecord(
    "evicted-filler",
    "cargo check",
    otherCwd,
    NOW - THREE_DAYS_MS - 1_000,
    "older",
  );
  const soleWitness = reliableFailureRecord(
    "sole-witness",
    "cargo check",
    otherCwd,
    NOW - THREE_DAYS_MS,
    "witness",
  );
  const fillerB = reliableFailureRecord("recent-b", "cargo check", otherCwd, NOW - 2 * 60 * 60 * 1000, "b");
  const targetFailure = reliableFailureRecord(
    "recent-target",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const memoryFile = join(home, "memory.jsonl");
  writeFileSync(
    memoryFile,
    [
      JSON.stringify(evictedFiller),
      JSON.stringify(soleWitness),
      JSON.stringify(fillerB),
      JSON.stringify(targetFailure),
    ].join("\n") + "\n",
    "utf8",
  );
  touchPending();

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 1);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, undefined);
  assert.ok(result.fix !== undefined);

  const lastLine = readFileSync(memoryFile, "utf8").trimEnd().split("\n").at(-1);
  assert.ok(lastLine !== undefined);
  const lastRecord = JSON.parse(lastLine) as FixRecord;
  assert.equal(lastRecord.kind, "fix");
  assert.equal(lastRecord.id, result.fix.id);
  assert.equal(lastRecord.failureIds.includes(targetFailure.id), true);
  assert.equal(existsSync(pendingPath()), true);
  assert.equal(windowCovered(loadMemoryChecked(memoryFile, NOW).coverage, NOW, EIGHT_HOURS_MS), false);
});

test("unlock: covered tail omitting terminal newline separates the fix, keeps skipped at 0, and clears pending", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const targetFailure = reliableFailureRecord(
    "target-failure",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const memoryFile = join(home, "memory.jsonl");
  const lines = [
    ...fillerFailureLines(10_049, otherCwd, NOW - THREE_DAYS_MS),
    JSON.stringify(targetFailure),
  ];
  writeFileSync(memoryFile, lines.join("\n"), "utf8");
  assert.notEqual(readFileSync(memoryFile).at(-1), 0x0a);
  touchPending();

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 1);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, undefined);
  assert.ok(result.fix !== undefined);

  const loaded = loadMemoryChecked(memoryFile, NOW);
  assert.equal(loaded.coverage.window, "tail");
  assert.equal(loaded.coverage.skipped, 0);
  assert.equal(tailReadable(loaded.coverage), true);

  const parsedFailure = loaded.records.find(
    (record): record is FailureRecord => record.kind === "failure" && record.id === targetFailure.id,
  );
  assert.ok(parsedFailure !== undefined);
  assert.equal(parsedFailure.resolvedBy, result.fix.id);

  const parsedFix = loaded.records.at(-1);
  assert.equal(parsedFix?.kind, "fix");
  if (parsedFix?.kind === "fix") {
    assert.equal(parsedFix.id, result.fix.id);
    assert.equal(parsedFix.failureIds.includes(targetFailure.id), true);
  }
  assert.equal(existsSync(pendingPath()), false);
});

test("append accounts for missing terminal LF in sidecar offsets and byte budgeting", (t) => {
  const home = tempHome(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  const first = reliableFailureRecord("first-unterminated", "npm test", join(home, "repo"), NOW - 2_000, "TypeError: first error");
  const second = reliableFailureRecord("second-appended", "cargo check", join(home, "repo"), NOW - 1_000, "ReferenceError: second error");
  writeFileSync(paths.memory, JSON.stringify(first), "utf8");
  withMemoryTransaction((transaction) => {
    transaction.append(second);
  }, paths, { now: NOW });

  const loaded = loadMemoryChecked(paths.memory, NOW);
  assert.equal(loaded.coverage.skipped, 0);
  assert.deepEqual(loaded.records.map((record) => record.id), [first.id, second.id]);
  const sidecarHit = findByFingerprintOnDisk(second.fingerprint, paths.memory);
  assert.equal(sidecarHit.via, "sidecar");
  assert.deepEqual(sidecarHit.hits.map((hit) => hit.id), [second.id]);

  const budgetHome = tempHome(t);
  const budgetPaths = resolveRockyPaths({ ROCKY_HOME: budgetHome });
  const candidate = reliableFailureRecord("budget-candidate", "npm test", join(budgetHome, "repo"), NOW - 1_000, "err");
  const candidateBytes = Buffer.byteLength(`${JSON.stringify(candidate)}\n`, "utf8");
  const targetPrefixBytes = MAX_MEMORY_FILE_BYTES - candidateBytes;

  const chunks: string[] = [];
  let currentBytes = 0;
  const bigPad = "x".repeat(900_000);
  let index = 0;
  while (targetPrefixBytes - currentBytes > 950_000) {
    const line = `${failureLine(index++, bigPad, NOW - 10_000)}\n`;
    chunks.push(line);
    currentBytes += Buffer.byteLength(line, "utf8");
  }
  const remainingNeeded = targetPrefixBytes - currentBytes;
  const shellLine = failureLine(index, "", NOW - 10_000);
  const padLength = remainingNeeded - Buffer.byteLength(shellLine, "utf8");
  assert.ok(padLength > 0);
  const unterminatedLast = failureLine(index, "y".repeat(padLength), NOW - 10_000);
  assert.equal(currentBytes + Buffer.byteLength(unterminatedLast, "utf8"), targetPrefixBytes);
  writeFileSync(budgetPaths.memory, `${chunks.join("")}${unterminatedLast}`, "utf8");

  const overBySeparator = withMemoryTransaction(
    (transaction) => transaction.canAppendComplete([candidate]),
    budgetPaths,
    { now: NOW },
  );
  assert.equal(overBySeparator, false);

  const terminatedLast = failureLine(index, "y".repeat(padLength - 1), NOW - 10_000) + "\n";
  assert.equal(currentBytes + Buffer.byteLength(terminatedLast, "utf8"), targetPrefixBytes);
  writeFileSync(budgetPaths.memory, `${chunks.join("")}${terminatedLast}`, "utf8");

  const fitsWithNewline = withMemoryTransaction(
    (transaction) => transaction.canAppendComplete([candidate]),
    budgetPaths,
    { now: NOW },
  );
  assert.equal(fitsWithNewline, true);
});
