import { test } from "node:test";
import assert from "node:assert/strict";
import { carapaceLines, moodFor } from "../ui/tui/components/carapace.js";
import { stringWidth } from "../ui/tui/core/text.js";

const MOODS = ["idle", "listening", "thinking", "heard-fail", "remembered"] as const;

test("every mood renders fixed-width rows, no eyes, no emoji", () => {
  for (const m of MOODS) {
    const lines = carapaceLines(m, 0, false, true);
    assert.ok(lines.length >= 3 && lines.length <= 5);
    const w = stringWidth(lines[0]);
    for (const l of lines) {
      assert.equal(stringWidth(l), w, `${m}: ragged row`);
      assert.ok(!/[oO0@•●◉👀]/.test(l), `${m}: he is blind — no eye glyphs`);
      assert.ok(!/[\u{1F000}-\u{1FAFF}]/u.test(l), `${m}: no emoji`);
    }
  }
});

test("moods are visually distinct and thinking shimmers only when motion is on", () => {
  const a = carapaceLines("idle", 0, false, true).join("\n");
  const b = carapaceLines("heard-fail", 0, false, true).join("\n");
  assert.notEqual(a, b);
  assert.notEqual(carapaceLines("thinking", 0, false, true).join(""), carapaceLines("thinking", 3, false, true).join(""));
  assert.equal(carapaceLines("thinking", 0, false, false).join(""), carapaceLines("thinking", 99, false, false).join(""));
});

test("ascii fallback stays legible or empty, never mixed unicode", () => {
  const lines = carapaceLines("idle", 0, true, true);
  for (const l of lines) assert.ok(!/[═║╲╱▔]/.test(l));
});

test("moodFor: running beats card kinds; failure and fix map to their moods", () => {
  assert.equal(moodFor({ runningCount: 1 }), "thinking");
  assert.equal(moodFor({ runningCount: 0, lastCard: { kind: "run", accent: "err" } as any }), "heard-fail");
  assert.equal(moodFor({ runningCount: 0, lastCard: { kind: "run", accent: "ok" } as any }), "remembered");
  assert.equal(moodFor({ runningCount: 0 }), "idle");
});
