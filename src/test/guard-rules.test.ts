import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DEFAULT_RULES, renderGuardRules, rulesFileIsPristine } from "../core/guard-rules.js";

const bashProbe = spawnSync("bash", ["--version"], { stdio: "ignore" });
const hasBash = !bashProbe.error && bashProbe.status === 0;

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

test("force-push rule matches -f as first argument (real bash [[ =~ ]])", { skip: !hasBash }, () => {
  const rule = DEFAULT_RULES.find((candidate) => candidate.message.includes("force push"));
  assert.ok(rule, "force-push rule exists");
  const cases: [string, boolean][] = [
    ["git push -f", true],
    ["git push origin main --force", true],
    ["git push --force-with-lease", false],
    ["git push origin main", false],
  ];
  for (const [command, expected] of cases) {
    assert.equal(bashMatches(rule.pattern, command), expected, command);
  }
});

/** Run the rule through real bash [[ =~ ]] (exit 0 = match). */
function bashMatches(regex: string, cmd: string): boolean {
  const res = spawnSync("bash", ["-c", 'regex=$1; cmd=$2; [[ "$cmd" =~ $regex ]]', "bash", regex, cmd]);
  return res.status === 0;
}
