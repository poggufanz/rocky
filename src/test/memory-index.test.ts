import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINGERPRINT_ALGORITHM_VERSION, fingerprint } from "../core/fingerprint.js";
import {
  MAX_MEMORY_FILE_BYTES,
  MAX_SUPPORTED_MEMORY_RECORDS,
  MEMORY_FORMAT_VERSION,
  getMemoryFingerprintIndex,
  getMemoryRecordOffsets,
  loadMemoryChecked,
  memoryReadMetrics,
  type FailureRecord,
  type MemoryRecord,
} from "../core/memory-read.js";
import {
  findByFingerprint,
  queryRecall,
  searchKnowledge,
} from "../core/memory-query.js";
import {
  findByFingerprintOnDisk,
  indexPathForMemory,
  memoryIndexMetrics,
  writeSidecarBestEffort,
  type MemoryIndexRow,
} from "../core/memory-index.js";
import { withMemoryTransaction } from "../core/memory.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { skipIfSymlinkUnavailable } from "./symlink-capability.js";

function failure(
  id: string,
  cmd: string,
  signature: string[],
  excerpt: string,
  ts: number,
  extra: Partial<FailureRecord> = {},
): FailureRecord {
  return {
    kind: "failure",
    id,
    ts,
    cwd: "/work/index",
    cmd,
    exitCode: 1,
    fingerprint: fingerprint(signature.join("\n"), cmd, 1),
    fingerprintV: 2,
    signature,
    excerpt,
    ...extra,
  };
}

function writeLines(path: string, records: MemoryRecord[]): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

/**
 * Test-only stand-in for writer-side maintenance: pure loads never write the
 * sidecar (MCP read graph stays write-free), so tests that seed files
 * directly rebuild explicitly through the same writer helper production uses.
 * Returns the writer helper result so over-cap refusal is assertable.
 */
function rebuildSidecarForTest(memoryPath: string): boolean {
  const loaded = loadMemoryChecked(memoryPath);
  // Mirror the writer guard: a truncated prefix is never published as a map.
  if (loaded.coverage.truncated > 0) return false;
  const offsets = getMemoryRecordOffsets(loaded.records);
  assert.ok(offsets !== undefined && offsets.length === loaded.records.length);
  const stats = lstatSync(memoryPath, { bigint: true });
  const rows: MemoryIndexRow[] = [];
  let hasLegacy = false;
  for (let index = 0; index < loaded.records.length; index += 1) {
    const record = loaded.records[index]!;
    if (record.kind !== "failure") continue;
    if (record.fingerprintV !== 2 || !/^[0-9a-f]{16}$/u.test(record.fingerprint)) hasLegacy = true;
    const offset = offsets![index] ?? -1;
    if (!Number.isSafeInteger(offset) || offset < 0) continue;
    rows.push({ fp: record.fingerprint, offset, id: record.id, ts: record.ts, hasFix: record.resolvedBy !== undefined });
  }
  return writeSidecarBestEffort(memoryPath, stats, rows, {
    version: MEMORY_FORMAT_VERSION,
    fpVersion: FINGERPRINT_ALGORITHM_VERSION,
    scanned: loaded.coverage.scanned,
    skipped: loaded.coverage.skipped,
    complete: loaded.coverage.complete,
    hasLegacy,
    maxBytes: MAX_MEMORY_FILE_BYTES,
    maxRecords: MAX_SUPPORTED_MEMORY_RECORDS,
  });
}

test("sidecar warm exact is O(hits): positional reads, no full rescan", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-memory-index-warm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memoryPath = join(root, "memory.jsonl");
  const base = failure("base", "npm test", ["module missing foo"], "module missing foo", 100);
  const records: MemoryRecord[] = [];
  for (let index = 0; index < 5; index += 1) {
    records.push({ ...base, id: `dup-${index}`, ts: 100 + index });
  }
  records.push(failure("other", "npm test", ["type error bar"], "type error bar", 150));
  writeLines(memoryPath, records);

  const loaded = loadMemoryChecked(memoryPath);
  assert.equal(loaded.records.length, 6);
  assert.equal(loaded.coverage.complete, true);

  const indexPath = indexPathForMemory(memoryPath);
  // Pure loads never write: the sidecar appears only via writer maintenance.
  assert.equal(existsSync(indexPath), false);
  assert.equal(rebuildSidecarForTest(memoryPath), true);
  assert.equal(existsSync(indexPath), true);
  const header = JSON.parse(readFileSync(indexPath, "utf8").split("\n")[0]!) as Record<string, unknown>;
  assert.equal(header.kind, "memory-index");
  assert.equal(header.version, 1);
  assert.equal(header.fpVersion, 2);
  assert.equal(header.count, 6);
  assert.equal(header.scanned, 6);
  if (process.platform !== "win32") {
    assert.equal(statSync(indexPath).mode & 0o777, 0o600);
  }

  const cached = getMemoryFingerprintIndex(loaded.records);
  assert.ok(cached);
  assert.equal(cached!.byFp.get(base.fingerprint)?.length, 5);

  const warm = findByFingerprint(loaded.records, base.fingerprint);
  assert.deepEqual(warm.map((hit) => hit.id), ["dup-0", "dup-1", "dup-2", "dup-3", "dup-4"]);

  const parsesBefore = memoryReadMetrics().parses;
  const fast = findByFingerprintOnDisk(base.fingerprint, memoryPath);
  assert.equal(fast.via, "sidecar");
  assert.deepEqual(fast.hits.map((hit) => hit.id).sort(), ["dup-0", "dup-1", "dup-2", "dup-3", "dup-4"]);
  assert.equal(fast.coverage.complete, true);
  assert.equal(fast.coverage.scanned, 6);
  assert.equal(memoryReadMetrics().parses - parsesBefore, 0);

  const miss = findByFingerprintOnDisk("0000000000000000", memoryPath);
  assert.equal(miss.via, "sidecar");
  assert.deepEqual(miss.hits, []);
  assert.equal(miss.coverage.complete, true);
});

test("corrupt or stale sidecar falls back to a full scan with disclosed coverage", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-memory-index-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memoryPath = join(root, "memory.jsonl");
  const first = failure("first", "npm test", ["module missing foo"], "module missing foo", 100);
  const second = failure("second", "npm test", ["type error bar"], "type error bar", 200);
  writeLines(memoryPath, [first, second]);
  assert.equal(loadMemoryChecked(memoryPath).records.length, 2);

  const indexPath = indexPathForMemory(memoryPath);
  assert.equal(existsSync(indexPath), false);
  assert.equal(rebuildSidecarForTest(memoryPath), true);
  assert.equal(existsSync(indexPath), true);

  writeFileSync(indexPath, "not json\n{broken\n", "utf8");
  const corrupt = findByFingerprintOnDisk(first.fingerprint, memoryPath);
  assert.equal(corrupt.via, "scan");
  assert.deepEqual(corrupt.hits.map((hit) => hit.id), ["first"]);
  assert.ok(corrupt.coverage.scanned >= 2);

  // Pure reads never heal a corrupt sidecar; the next writer rebuild does.
  assert.equal(loadMemoryChecked(memoryPath).records.length, 2);
  assert.equal(rebuildSidecarForTest(memoryPath), true);
  const rebuilt = findByFingerprintOnDisk(first.fingerprint, memoryPath);
  assert.equal(rebuilt.via, "sidecar");
  assert.deepEqual(rebuilt.hits.map((hit) => hit.id), ["first"]);

  const third = failure("third", "npm test", ["module missing foo"], "module missing foo", 300);
  appendFileSync(memoryPath, `${JSON.stringify(third)}\n`, "utf8");
  const stale = findByFingerprintOnDisk(third.fingerprint, memoryPath);
  assert.equal(stale.via, "scan");
  assert.ok(stale.hits.some((hit) => hit.id === "third"));
});

test("fuzzy equivalence: one representative per fingerprint keeps scores and hits identical", () => {
  const needle = failure("needle-1", "npm test", ["needle haystack"], "needle haystack", 100);
  const duplicates: MemoryRecord[] = [
    needle,
    { ...needle, id: "needle-2", ts: 200 },
    { ...needle, id: "needle-3", ts: 300 },
  ];
  const middle = failure("middle", "npm test", ["needle broad extra"], "needle broad extra", 200);
  const full = queryRecall([...duplicates, middle], { query: "needle" });
  const singleton = queryRecall([needle, middle], { query: "needle" });
  // Dedup keeps one hit per canonical fingerprint; with identical evidence
  // the score is identical and the newest duplicate wins the family.
  assert.equal(full.length, singleton.length);
  assert.deepEqual(full.map((hit) => hit.score), singleton.map((hit) => hit.score));
  assert.deepEqual(full.map((hit) => hit.failure.fingerprint), singleton.map((hit) => hit.failure.fingerprint));
  assert.equal(full[0]!.failure.id, "needle-3");
  assert.equal(singleton[0]!.failure.id, "needle-1");

  const knowledgeFull = searchKnowledge([...duplicates, middle], { query: "needle" });
  const knowledgeSingle = searchKnowledge([needle, middle], { query: "needle" });
  assert.equal(knowledgeFull.length, knowledgeSingle.length);
  assert.deepEqual(
    knowledgeFull.map((hit) => hit.score),
    knowledgeSingle.map((hit) => hit.score),
  );
});

test("fuzzy fallback: divergent excerpts in one fingerprint family stay findable", () => {
  const cmd = "npm test";
  const signature = ["build failed at step compile"];
  const fp = fingerprint(signature.join("\n"), cmd, 1);
  const first: FailureRecord = {
    kind: "failure", id: "div-1", ts: 100, cwd: "/work/index", cmd, exitCode: 1,
    fingerprint: fp, fingerprintV: 2, signature, excerpt: "first tail alpha",
  };
  const second: FailureRecord = {
    kind: "failure", id: "div-2", ts: 200, cwd: "/work/index", cmd, exitCode: 1,
    fingerprint: fp, fingerprintV: 2, signature, excerpt: "second tail zebracorn",
  };
  const hits = queryRecall([first, second], { query: "zebracorn" });
  assert.ok(hits.some((hit) => hit.failure.id === "div-2"));
  const knowledge = searchKnowledge([first, second], { query: "zebracorn" });
  assert.ok(knowledge.some((hit) => hit.id === "div-2"));
});

test("rare-token floor survives representative dedup", () => {
  const cmd = "npm test";
  const signature = ["enospc no space left on device"];
  const excerpt = "enospc no space left on device";
  const fp = fingerprint(signature.join("\n"), cmd, 1);
  const make = (id: string, ts: number): FailureRecord => ({
    kind: "failure", id, ts, cwd: "/work/index", cmd, exitCode: 1,
    fingerprint: fp, fingerprintV: 2, signature, excerpt,
  });
  const records: MemoryRecord[] = [make("rare-1", 100), make("rare-2", 200)];
  for (let index = 0; index < 8; index += 1) {
    records.push(failure(`filler-${index}`, "npm test", [`filler token ${index}`], `filler token ${index}`, 300 + index));
  }
  const hits = queryRecall(records, { query: "enospc" });
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.score >= 0.06);
});

test("bounds, permissions, and locks do not regress", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-memory-index-bounds-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memoryPath = join(root, "memory.jsonl");
  const valid = failure("valid", "npm test", ["module missing"], "module missing", 100);
  writeFileSync(memoryPath, [`${JSON.stringify(valid)}`, "{not-json}"].join("\n") + "\n", "utf8");
  const loaded = loadMemoryChecked(memoryPath);
  assert.equal(loaded.records.length, 1);
  assert.ok(loaded.coverage.skipped >= 1);
  assert.equal(loaded.coverage.complete, false);

  const indexPath = indexPathForMemory(memoryPath);
  assert.equal(existsSync(indexPath), false);
  assert.equal(rebuildSidecarForTest(memoryPath), true);
  const header = JSON.parse(readFileSync(indexPath, "utf8").split("\n")[0]!) as Record<string, unknown>;
  assert.equal(header.skipped, loaded.coverage.skipped);
  assert.equal(header.complete, false);
  if (process.platform !== "win32") {
    assert.equal(statSync(indexPath).mode & 0o777, 0o600);
  }

  const fast = findByFingerprintOnDisk(valid.fingerprint, memoryPath);
  assert.deepEqual(fast.hits.map((hit) => hit.id), ["valid"]);
  assert.equal(fast.coverage.complete, false);

  const leftovers = readdirSync(root).filter((name) => name.includes(".tmp."));
  assert.deepEqual(leftovers, []);
});

test("symlink sidecar never poisons exact answers", (t) => {
  if (skipIfSymlinkUnavailable(t)) return;
  const root = mkdtempSync(join(tmpdir(), "rocky-memory-index-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memoryPath = join(root, "memory.jsonl");
  const valid = failure("valid", "npm test", ["module missing"], "module missing", 100);
  writeLines(memoryPath, [valid]);
  assert.equal(loadMemoryChecked(memoryPath).records.length, 1);
  assert.equal(rebuildSidecarForTest(memoryPath), true);

  const indexPath = indexPathForMemory(memoryPath);
  const target = join(root, "target.jsonl");
  writeFileSync(target, "poison\n", "utf8");
  rmSync(indexPath, { force: true });
  symlinkSync(target, indexPath);
  assert.equal(lstatSync(indexPath).isSymbolicLink(), true);

  const fast = findByFingerprintOnDisk(valid.fingerprint, memoryPath);
  assert.equal(fast.via, "scan");
  assert.deepEqual(fast.hits.map((hit) => hit.id), ["valid"]);
});

test("over-cap memory never publishes a prefix sidecar", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-memory-index-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memoryPath = join(root, "memory.jsonl");
  const lines: string[] = [];
  for (let index = 0; index < MAX_SUPPORTED_MEMORY_RECORDS + 1; index += 1) {
    lines.push(JSON.stringify(failure(`cap-${index}`, "npm test", [`cap token ${index}`], `cap token ${index}`, 100 + index)));
  }
  writeFileSync(memoryPath, `${lines.join("\n")}\n`, "utf8");

  const loaded = loadMemoryChecked(memoryPath);
  assert.equal(loaded.records.length, MAX_SUPPORTED_MEMORY_RECORDS);
  assert.equal(loaded.coverage.complete, false);
  assert.ok(loaded.coverage.truncated > 0);

  assert.equal(rebuildSidecarForTest(memoryPath), false);
  assert.equal(existsSync(indexPathForMemory(memoryPath)), false);
  const fast = findByFingerprintOnDisk("0000000000000000", memoryPath);
  assert.equal(fast.via, "scan");
  assert.deepEqual(fast.hits, []);
});

test("writer transactions maintain the sidecar incrementally", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-memory-index-writer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: root });
  const first = failure("writer-1", "npm test", ["writer module missing"], "writer module missing", 100);
  withMemoryTransaction((transaction) => {
    transaction.append(first);
  }, paths);
  const indexPath = indexPathForMemory(paths.memory);
  assert.equal(existsSync(indexPath), true);
  assert.equal(findByFingerprintOnDisk(first.fingerprint, paths.memory).via, "sidecar");
  const second = failure("writer-2", "npm test", ["writer type error"], "writer type error", 200);
  withMemoryTransaction((transaction) => {
    transaction.append(second);
  }, paths);
  const header = JSON.parse(readFileSync(indexPath, "utf8").split("\n")[0]!) as Record<string, unknown>;
  assert.equal(header.count, 2);
  assert.deepEqual(
    findByFingerprintOnDisk(second.fingerprint, paths.memory).hits.map((hit) => hit.id),
    ["writer-2"],
  );
});
