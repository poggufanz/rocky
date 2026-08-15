import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DEFAULT_RULES, renderGuardRules, rulesFileIsPristine } from "../core/guard-rules.js";

const bashVersionProbe = spawnSync("bash", ["--version"], { stdio: "ignore" });
const hasBash = !bashVersionProbe.error && bashVersionProbe.status === 0;
const forcePushRule = DEFAULT_RULES.find((candidate) => candidate.message.includes("force push"));
const forcePushCommand = "git push -f";
const argvProbeSeparator = "\u001f";
const argvProbeTerminator = "\u001e";
const bashArgvProbe = hasBash && forcePushRule
  ? spawnSync(
    "bash",
    ["-c", "printf '%s\\037%s\\036' \"$1\" \"$2\"", "rocky-argv-probe", forcePushRule.pattern, forcePushCommand],
    { encoding: "utf8" },
  )
  : undefined;
const bashArgvRoundTrip = forcePushRule !== undefined
  && bashArgvProbe?.status === 0
  && bashArgvProbe.stdout === `${forcePushRule.pattern}${argvProbeSeparator}${forcePushCommand}${argvProbeTerminator}`;
const bashSemanticSkipReason = !hasBash
  ? "Bash executable unavailable; owner: Linux/WSL hook smoke CI"
  : !forcePushRule
    ? "force-push production rule missing; owner: guard-rules maintainers"
  : !bashArgvRoundTrip
    ? "Bash argv round-trip failed for representative force-push command; owner: native-Windows WSL argv bridge"
    : false;

const forcePushCases: readonly [string, boolean][] = [
  [forcePushCommand, true],
  ["git push origin main --force", true],
  ["git push --force-with-lease", false],
  ["git push origin main", false],
];

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

test("force-push production ERE semantics stay independent of Bash argv", () => {
  assert.ok(forcePushRule, "force-push rule exists");
  // Node has no POSIX ERE engine. This narrow translation is derived directly
  // from the production rule, so it fails loudly if that rule gains syntax
  // which this platform-independent semantic check cannot represent.
  const matches = new RegExp(forcePushRule.pattern.replaceAll("[[:space:]]", "\\s"), "u");
  for (const [command, expected] of forcePushCases) assert.equal(matches.test(command), expected, command);
});

test("force-push rule matches through Bash [[ =~ ]] when Bash argv is available", { skip: bashSemanticSkipReason }, () => {
  assert.ok(forcePushRule, "force-push rule exists");
  for (const [command, expected] of forcePushCases) {
    assert.equal(bashMatches(forcePushRule.pattern, command), expected, command);
  }
});

/** Run the rule through real bash [[ =~ ]] (exit 0 = match). */
function bashMatches(regex: string, cmd: string): boolean {
  const res = spawnSync("bash", ["-c", 'regex=$1; cmd=$2; [[ "$cmd" =~ $regex ]]', "bash", regex, cmd]);
  return res.status === 0;
}
