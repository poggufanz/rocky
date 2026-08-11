import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redactSecrets } from "../core/redact.js";

test("redactSecrets masks known secret shapes and keeps surrounding text", () => {
  const input = "deploy with sk-ant-abcdefghijklmnopqrst123 done";
  const out = redactSecrets(input);
  assert.ok(!out.includes("sk-ant-abcdefghijklmnopqrst123"));
  assert.ok(out.includes("deploy with"));
  assert.ok(out.includes("[redacted anthropic key]"));
});

test("redactSecrets leaves clean text untouched", () => {
  assert.equal(redactSecrets("margin-top: 8px"), "margin-top: 8px");
});

test("redactSecrets handles multiple hits in one string", () => {
  const out = redactSecrets("a AKIAABCDEFGHIJKLMNOP b npm_" + "x".repeat(36) + " c");
  assert.ok(out.includes("[redacted aws access key]"));
  assert.ok(out.includes("[redacted npm token]"));
});

test("redactSecrets masks password assignments", () => {
  assert.equal(
    redactSecrets('credentials: password = "pA7!cV2@kL9"'),
    "credentials: [redacted password assignment]",
  );
});

test("redactSecrets masks repeated matches of one secret kind", () => {
  const secret = "AKIAABCDEFGHIJKLMNOP";
  assert.equal(
    redactSecrets(`${secret} then ${secret}`),
    "[redacted aws access key] then [redacted aws access key]",
  );
});
