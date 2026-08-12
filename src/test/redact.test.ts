import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redactSecrets, redactSecretsAtBoundary, stripInvisibleControls } from "../core/redact.js";

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

test("redactSecrets keeps both GitHub token alternatives boundary-aware", () => {
  const ghp = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const githubPat = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
  assert.equal(redactSecrets(`x${ghp}`), `x${ghp}`);
  assert.equal(redactSecrets(`x${githubPat}`), `x${githubPat}`);
  assert.match(redactSecrets(`${ghp}x`), /\[redacted github token\]/u);
  assert.match(redactSecrets(`${githubPat}x`), /\[redacted github token\]/u);
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

test("redactSecretsAtBoundary matches a token after an invisible control follows visible text", () => {
  const token = "sk-ant-abcdefghijklmnopqrst123";
  const normalized = stripInvisibleControls(`prefix\u061C${token}`);
  assert.equal(normalized, `prefix${token}`);
  assert.equal(redactSecretsAtBoundary(`prefix\u061C${token}`), "prefix[redacted anthropic key]");
  assert.equal(
    redactSecretsAtBoundary(`prefix\u061Csk-\u061Cant-abcdefghijklmnopqrst123`),
    "prefix[redacted anthropic key]",
  );
});

test("redactSecretsAtBoundary preserves trailing boundaries removed after fixed-length tokens", () => {
  const aws = "AKIAABCDEFGHIJKLMNOP";
  const npm = "npm_abcdefghijklmnopqrstuvwxyz1234567890";
  assert.equal(redactSecretsAtBoundary(`${aws}\u061Csuffix`), "[redacted aws access key]suffix");
  assert.equal(redactSecretsAtBoundary(`${npm}\u061Csuffix`), "[redacted npm token]suffix");
});

test("redactSecretsAtBoundary stops variable-length tokens at a removed trailing boundary", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["sk-ant-abcdefghijklmnopqrst123", "anthropic key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz1234567890", "github token"],
    ["xoxb-1234567890abcdefghijklmnop", "slack token"],
    ["sk-abcdefghijklmnopqrst123", "openai key"],
  ];

  for (const [token, kind] of cases) {
    assert.equal(
      redactSecretsAtBoundary(`😀${token}\u061CZ`),
      `😀[redacted ${kind}]Z`,
      kind,
    );
  }
});

test("redactSecretsAtBoundary keeps an internal split inside a longer token", () => {
  const token = `sk-ant-${"abcdefghijklmnopqrst"}\u061Cuvw`;
  assert.equal(
    redactSecretsAtBoundary(`😀${token}!`),
    "😀[redacted anthropic key]!",
  );
});

test("redactSecretsAtBoundary removes recognizable fragments for every secret family", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["AKIAABCDEFGH", "aws access key"],
    ["-----BEGIN RSA PR", "private key"],
    ["ghp_abcdefgh", "github token"],
    ["github_pat_abcdefgh", "github token"],
    ["xoxb-abcdefgh", "slack token"],
    ["sk-ant-abcdefgh", "anthropic key"],
    ["sk-abcdefgh", "openai key"],
    ["npm_abcdefgh", "npm token"],
    ["password = \"secret", "password assignment"],
  ];

  for (const [fragment, kind] of cases) {
    const output = redactSecretsAtBoundary(`prefix\u061C${fragment}`, { mayBeTruncated: true });
    assert.doesNotMatch(output, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"), `${kind}: ${fragment}`);
    assert.equal(output, "prefix", kind);
  }
});

test("redactSecretsAtBoundary does not treat internal controls as token boundaries", () => {
  const input = "task-\u061Cant-abcdefghijklmnopqrst123";
  assert.equal(redactSecretsAtBoundary(input, { mayBeTruncated: true }), "task-ant-abcdefghijklmnopqrst123");
  const embedded = "prefix\u061CAKIAABCDEFGHIJKLMNOPsuffix";
  assert.equal(redactSecretsAtBoundary(embedded), "prefixAKIAABCDEFGHIJKLMNOPsuffix");
});

test("redactSecretsAtBoundary preserves embedded family-like prose", () => {
  const safe = [
    "task-ant-abcdefghijklmnopqrst123",
    "mask-value",
    "flask-app",
    "npm_install",
    "github_pattern",
    "passwordless",
  ];
  for (const value of safe) {
    assert.equal(redactSecretsAtBoundary(value), value, value);
    assert.equal(redactSecretsAtBoundary(value, { mayBeTruncated: true }), value, value);
  }
});
