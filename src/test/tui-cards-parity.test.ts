import { test } from "node:test";
import assert from "node:assert/strict";
import { assertParity } from "../ui/tui/cards/card.js";
import { COMMANDS } from "../ui/tui/surface/registry.js";
import * as B from "../ui/tui/cards/build.js";

const hits = [
  { label: "npm test", agoText: "2d ago", source: "hook", machine: false },
  { label: 'Agent "review" finished', agoText: "5h ago", source: "claude-code", machine: true },
];

const CARDS = [
  ["recall", B.buildRecall("token expiry", hits)],
  ["recall-empty", B.buildRecall("nothing here", [])],
  ["why", B.buildWhy("memory.ts", [{ text: "append-only, reader bounded", source: "claude-code", agoText: "5d ago" }])],
  ["why-empty", B.buildWhy("ghost.ts", [])],
  ["sessions", B.buildSessions([{ index: 1, cwdTail: "proj/rocky", count: 12, endedAgo: "2h ago" }])],
  ["stats", B.buildStats([{ kind: "triple", count: 422 }, { kind: "failure", count: 46 }], 468, "4d ago")],
  ["brief", B.buildBrief({ heard: 176, failures: 10, fixes: 6, whys: 163 }, hits)],
  ["run-ok", B.buildRun("npm test", { displayCode: 0, out: ["ok"], err: [] })],
  ["run-fail", B.buildRun("npm test", { displayCode: -4058, out: [], err: ["ENOENT"] })],
  ["help", B.buildHelp(COMMANDS)],
  ["you", B.buildYou("recall token")],
  ["error", B.buildError("frobnicate", COMMANDS)],
] as const;

for (const [name, card] of CARDS) {
  test(`density parity: ${name}`, () => {
    assert.doesNotThrow(() => assertParity(card, 80), name);
    assert.doesNotThrow(() => assertParity(card, 30), `${name} at width 30`);
  });
}

test("facts carry the numbers users would quote", () => {
  const stats = B.buildStats([{ kind: "triple", count: 422 }], 422, "4d ago");
  assert.ok(stats.facts.some((f) => f.includes("422")));
  const run = B.buildRun("x", { displayCode: -4058, out: [], err: [] });
  assert.ok(run.facts.some((f) => f.includes("-4058")));
});

test("voice rules hold: no question marks, no emoji in card strings", () => {
  for (const [, card] of CARDS) {
    const all = [card.subject, card.meta ?? "", card.actions ?? "", ...card.lines.map((l) => l.text)].join(" ");
    assert.ok(!/[?]/.test(all.replace(/, question/g, "")), `${card.kind}: bare question mark`);
    assert.ok(!/[\u{1F000}-\u{1FAFF}✅❌⚡⭐]/u.test(all), `${card.kind}: emoji in rocky string`);
  }
});
