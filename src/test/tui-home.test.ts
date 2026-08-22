import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveHome, adaptHit } from "../ui/tui/surface/home-data.js";
import { homeView } from "../ui/tui/surface/views.js";
import { renderToLines } from "../ui/tui/core/renderer.js";
import { stringWidth } from "../ui/tui/core/text.js";
import type { MemoryRecord } from "../core/memory-read.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const NOW = 1_756_000_000_000;
const rec = (kind: string, agoMs: number, extra: object = {}): MemoryRecord =>
  ({ v: 1, kind, ts: NOW - agoMs, ...extra }) as any;

test("deriveHome counts kinds, day window and machine envelopes", () => {
  const records = [
    rec("failure", 1000, { cmd: "npm test" }),
    rec("triple", 2000, { intent: { text: "<task-notification><task-id>x</task-id><summary>Agent done</summary>" } }),
    rec("fix", 30 * 3600 * 1000, { cmd: "npm ci" }), // outside 24h
  ];
  const d = deriveHome(records, undefined, NOW);
  assert.equal(d.total, 3);
  assert.equal(d.day.heard, 2);
  assert.equal(d.day.failures, 1);
  assert.ok(d.byKind.find((k) => k.kind === "fix")?.count === 1);
  const machine = d.recent.find((r) => r.machine);
  assert.ok(machine && machine.label === "Agent done", "envelope collapses to its summary");
  assert.equal(d.coverageLine, "coverage full");
});

test("partial coverage is disclosed, never hidden", () => {
  const d = deriveHome([], "file-size-cap", NOW);
  assert.equal(d.coverageLine, "coverage partial (file-size-cap)");
});

test("homeView renders four panels at exact frame size", () => {
  const d = deriveHome([rec("failure", 1000, { cmd: "x" })], undefined, NOW);
  const lines = renderToLines(homeView(d, { cols: 100, rows: 26 }, false), 100, 26, 1).map(strip);
  assert.equal(lines.length, 26);
  for (const l of lines) assert.equal(stringWidth(l), 100);
  const joined = lines.join("\n");
  for (const title of ["what rocky holds", "since 24h", "most heard files", "recent"]) {
    assert.ok(joined.includes(title), `panel: ${title}`);
  }
  assert.ok(joined.includes("local only · no egress"));
});

test("adaptHit redacts secrets and formats elapsed time", () => {
  const secretRec = rec("failure", 120_000, { cmd: "git push https://ghp_111122223333444455556666777788889999@github.com/repo.git" });
  const hit = adaptHit(secretRec, NOW);
  assert.equal(hit.kind, "failure");
  assert.equal(hit.machine, false);
  assert.equal(hit.agoText, "2 minutes ago");
  assert.ok(hit.label.includes("[redacted github token]"));
  assert.ok(!hit.label.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"));
});

test("topFiles aggregates basenames from mechanism files", () => {
  const records = [
    rec("triple", 1000, {
      mechanism: {
        files: [
          { path: "src/core/memory.ts" },
          { path: "src/ui/rocky.ts" },
        ],
      },
    }),
    rec("triple", 2000, {
      mechanism: {
        files: [
          { path: "lib/memory.ts" },
          { path: "src/index.ts" },
        ],
      },
    }),
  ];
  const d = deriveHome(records, undefined, NOW);
  assert.equal(d.topFiles[0]?.name, "memory.ts");
  assert.equal(d.topFiles[0]?.count, 2);
});

test("homeView with ascii mode produces only ascii borders", () => {
  const d = deriveHome([rec("failure", 1000, { cmd: "x" })], undefined, NOW);
  const lines = renderToLines(homeView(d, { cols: 80, rows: 24 }, true), 80, 24, 1).map(strip);
  const joined = lines.join("\n");
  assert.ok(!/[┌┐└┘─│]/.test(joined), "no box unicode characters in ascii mode");
  assert.ok(joined.includes("+"), "ascii borders present");
});

test("deriveHome handles empty records gracefully", () => {
  const d = deriveHome([], undefined, NOW);
  assert.equal(d.total, 0);
  assert.equal(d.coverageLine, "coverage full");
  assert.equal(d.day.heard, 0);
  assert.equal(d.day.failures, 0);
  assert.equal(d.day.fixes, 0);
  assert.equal(d.day.whys, 0);
  assert.equal(d.topFiles.length, 0);
  assert.equal(d.recent.length, 0);
  assert.equal(d.byKind.length, 0);
});
