import { test } from "node:test";
import assert from "node:assert/strict";
import { riskiestLine, scoreLine } from "../check/risk.js";

test("risky constructs outscore plain code", () => {
  assert.ok(scoreLine("eval(userInput)") > scoreLine("const x = 1;"));
  assert.ok(scoreLine('exec("rm -rf " + dir)') > scoreLine("console.log(x)"));
  assert.ok(scoreLine("headers.authorization = token") > 0);
  assert.equal(scoreLine("const total = a + b;"), 0);
});

test("riskiestLine picks the highest score, first-seen wins ties, undefined when all zero", () => {
  const lines = [
    { file: "a.ts", line: 1, text: "const x = 1;" },
    { file: "a.ts", line: 2, text: "eval(payload)" },
    { file: "b.ts", line: 9, text: "eval(other)" },
  ];
  assert.deepEqual(riskiestLine(lines), { file: "a.ts", line: 2, text: "eval(payload)" });
  assert.equal(riskiestLine([{ file: "a.ts", line: 1, text: "const y = 2;" }]), undefined);
});
