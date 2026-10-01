import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_GUARD_DRAIN_LINES, drainGuardPending, guardPendingPath, recordGuard } from "../core/memory.js";
import { loadMemoryChecked, parseMemoryRecord } from "../core/memory-read.js";
import { queryStats } from "../core/memory-query.js";

function withHome(home: string, fn: () => void): void {
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
}

test("parseMemoryRecord accepts a valid guard record", () => {
  const parsed = parseMemoryRecord({
    v: 1, kind: "guard", id: "g1", ts: 1_800_000_000_000,
    cwd: "/repo", cmd: "rm -rf /tmp/x", rule: "rm\\s+-rf", outcome: "cancelled",
  });
  assert.ok(parsed);
  assert.equal(parsed.kind, "guard");
  if (parsed.kind === "guard") {
    assert.equal(parsed.outcome, "cancelled");
    assert.equal(parsed.rule, "rm\\s+-rf");
  }
});

test("parseMemoryRecord rejects guard records with bad outcome or missing v", () => {
  assert.equal(parseMemoryRecord({
    v: 1, kind: "guard", id: "g", ts: 1, cwd: "/", cmd: "x", rule: "y", outcome: "blocked",
  }), undefined);
  assert.equal(parseMemoryRecord({
    kind: "guard", id: "g", ts: 1, cwd: "/", cmd: "x", rule: "y", outcome: "cancelled",
  }), undefined);
  assert.equal(parseMemoryRecord({
    v: 1, kind: "guard", id: "g", ts: 1, cwd: "/", cmd: "x", rule: "", outcome: "cancelled",
  }), undefined);
});

test("recordGuard redacts secrets in cmd through boundCommand", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  withHome(home, () => {
    const rec = recordGuard({
      cwd: "/repo",
      cmd: "curl -H 'Authorization: Bearer supersecretvalue1234567890abcdef' https://x",
      rule: "curl.*Authorization",
      outcome: "cancelled",
    });
    assert.ok(!rec.cmd.includes("supersecretvalue1234567890abcdef"));
    const loaded = loadMemoryChecked(join(home, "memory.jsonl"));
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.coverage.skipped, 0);
  });
});

test("recordGuard bounds cwd, cmd, and rule", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  withHome(home, () => {
    const rec = recordGuard({ cwd: "c".repeat(600), cmd: "echo hi", rule: "r".repeat(20_000), outcome: "proceeded" });
    assert.equal(rec.cwd.length, 512);
    assert.equal(rec.rule.length, 16 * 1024);
    const loaded = loadMemoryChecked(join(home, "memory.jsonl"));
    assert.equal(loaded.coverage.skipped, 0);
  });
});

test("recordGuard rejects bad outcome and empty fields", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  withHome(home, () => {
    assert.throws(() => recordGuard({ cwd: "/r", cmd: "x", rule: "y", outcome: "blocked" as "cancelled" }));
    assert.throws(() => recordGuard({ cwd: "", cmd: "x", rule: "y", outcome: "cancelled" }));
    assert.throws(() => recordGuard({ cwd: "/r", cmd: "x", rule: "", outcome: "cancelled" }));
  });
});

test("drainGuardPending appends TSV lines and skips malformed", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  withHome(home, () => {
    const pending = guardPendingPath(home);
    assert.ok(pending.endsWith("guard.pending"));
    writeFileSync(pending, [
      "1799000000\tcancelled\trm\\s+-rf\t/repo\trm -rf /tmp/x",
      "not-a-line",
      "1799000001\tbogus\trule\t/repo\tcmd",
      "1799000002\tproceeded\tcurl.*\t/repo\tcurl https://example.com",
      "",
    ].join("\n"), "utf8");
    const result = drainGuardPending(home);
    assert.equal(result.drained, 2);
    assert.equal(result.skipped, 2);
    assert.ok(!existsSync(pending));
    const loaded = loadMemoryChecked(join(home, "memory.jsonl"));
    assert.equal(loaded.records.filter((r) => r.kind === "guard").length, 2);
    assert.equal(loaded.coverage.skipped, 0);
  });
});

test("drainGuardPending respects the per-pass cap and leaves the rest", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  withHome(home, () => {
    const pending = join(home, "guard.pending");
    const lines: string[] = [];
    for (let i = 0; i < MAX_GUARD_DRAIN_LINES + 3; i += 1) {
      lines.push(`1799000000\tcancelled\trule-${i % 2}\t/repo\tcmd ${i}`);
    }
    writeFileSync(pending, `${lines.join("\n")}\n`, "utf8");
    const result = drainGuardPending(home);
    assert.equal(result.drained, MAX_GUARD_DRAIN_LINES);
    assert.equal(result.skipped, 0);
    const rest = readFileSync(pending, "utf8").split("\n").filter((l) => l.length > 0);
    assert.equal(rest.length, 3);
    const second = drainGuardPending(home);
    assert.equal(second.drained, 3);
    assert.ok(!existsSync(pending));
    const loaded = loadMemoryChecked(join(home, "memory.jsonl"));
    assert.equal(loaded.records.filter((r) => r.kind === "guard").length, MAX_GUARD_DRAIN_LINES + 3);
  });
});

test("queryStats counts guard separately from failure and fix", () => {
  const NOW = 1_800_000_000_000;
  const records = [
    { kind: "failure", id: "f1", ts: NOW - 10, cwd: "/r", cmd: "x", exitCode: 1, fingerprint: "a", signature: [], excerpt: "" },
    { v: 1, kind: "guard", id: "g1", ts: NOW - 5, cwd: "/r", cmd: "rm -rf x", rule: "rm", outcome: "cancelled" },
    { v: 1, kind: "guard", id: "g2", ts: NOW - 4, cwd: "/r", cmd: "curl y", rule: "curl", outcome: "proceeded" },
  ] as never as Parameters<typeof queryStats>[0];
  const result = queryStats(records, { now: NOW });
  assert.equal(result.failures, 1);
  assert.equal(result.fixEvents, 0);
  assert.equal(result.guardTotal, 2);
  assert.equal(result.guardCancelled, 1);
  assert.equal(result.guardProceeded, 1);
  assert.deepEqual(result.guardByRule, { curl: 1, rm: 1 });
});
