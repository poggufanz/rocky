import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, renderGuardRules, rulesFileIsPristine } from "../core/guard-rules.js";

test("renderGuardRules emits tab-separated rules with hash header", () => {
  const out = renderGuardRules();
  const lines = out.trimEnd().split("\n");
  const ruleLines = lines.filter((l) => !l.startsWith("#"));
  assert.equal(ruleLines.length, DEFAULT_RULES.length);
  for (const l of ruleLines) assert.equal(l.split("\t").length, 2);
  assert.ok(lines.some((l) => /^# sha256:[0-9a-f]{64}$/.test(l)));
});

test("pristine detection", () => {
  const out = renderGuardRules();
  assert.equal(rulesFileIsPristine(out), true);
  assert.equal(rulesFileIsPristine(out + "myregex\tmy message\n"), false);
  assert.equal(rulesFileIsPristine("no header at all\n"), false);
});

test("no rule field contains a tab or empty part", () => {
  for (const r of DEFAULT_RULES) {
    assert.ok(!r.pattern.includes("\t") && !r.message.includes("\t"));
    assert.ok(r.pattern.length > 0 && r.message.length > 0);
  }
});
