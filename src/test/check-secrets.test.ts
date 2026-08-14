import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddedLine } from "../check/diff.js";
import { scanSecrets } from "../check/secrets.js";
import {
  EXACT_PLACEHOLDER_ASSIGNMENTS,
  SYNTHETIC_DELIMITER_PRESERVATION_VECTORS,
  SYNTHETIC_EOF_AMBIGUITY_VECTORS,
  SYNTHETIC_EVERY_CONTROL_SPLIT_VECTORS,
  SYNTHETIC_SECRET_CLOSURE_VECTORS,
} from "./secret-vectors.js";

function line(text: string): AddedLine {
  return { file: "src/x.ts", line: 7, text };
}

test("detects each supported secret family", () => {
  const cases: Array<[string, string]> = [
    ["AKIA" + "A1B2C3D4E5F6G7H8", "aws access key"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private key"],
    ["ghp_" + "aB3d".repeat(9), "github token"],
    ["github_pat_" + "aB3dE5fG7hI9jK2mN4pQ6r" + "_" + "sT8uV0wX1yZ2cD4eF6gH8iJ9kL3mNP", "github token"],
    ["xoxb-1234567890-AbCdEfGhIj", "slack token"],
    ["sk-ant-aB3dE5fG7hI9jK2mN4pQ6rS8", "anthropic key"],
    ["sk-aB3dE5fG7hI9jK2mN4pQ6rS8tU0vW1xY", "openai key"],
    ["npm_" + "aB3d".repeat(9), "npm token"],
    ['password = "pA7!cV2@kL9"', "password assignment"],
  ];

  for (const [text, kind] of cases) {
    const hits = scanSecrets([line(`const k = "${text}"`)]);
    assert.equal(hits.length, 1, text);
    assert.equal(hits[0]!.kind, kind, text);
    assert.equal(hits[0]!.file, "src/x.ts");
    assert.equal(hits[0]!.line, 7);
  }
});

test("detects modern prefixed keys and quoted or unquoted credential assignments", () => {
  const cases: Array<[string, string]> = [
    ["sk-proj-aB3dE5fG7hI9-jK2mN4pQ6rS8tU0vW1xY2zA4", "openai key"],
    ["password=pA7!cV2@kL9", "password assignment"],
    ["secret = 'rT8$wX3!nM6'", "password assignment"],
    ["token=tok_aB3d-E5fG7hI9jK2mN4pQ6", "credential assignment"],
    ['api_key = "api-aB3dE5fG7hI9jK2mN4pQ6"', "credential assignment"],
    ['authorization="Bearer syn_aB3dE5fG7hI9jK2mN4pQ6"', "credential assignment"],
    ["authorization: Bearer syn_aB3dE5fG7hI9jK2mN4pQ6", "credential assignment"],
  ];

  for (const [text, kind] of cases) {
    assert.deepEqual(scanSecrets([line(text)]).map((hit) => hit.kind), [kind], text);
  }
});

test("strips terminal controls and bidi obfuscation before secret detection", () => {
  const cases = [
    "sk-\u202eproj-aB3dE5fG7hI9jK2mN4pQ6rS8tU0vW1xY2zA4",
    "sk-\u001b[31mproj-aB3dE5fG7hI9jK2mN4pQ6rS8tU0vW1xY2zA4",
    "pass\u0000word=pA7!cV2@kL9",
  ];

  for (const text of cases) {
    assert.equal(scanSecrets([line(text)]).length, 1, JSON.stringify(text));
  }
});

test("shared secret vectors detect quoted keys, realistic placeholder words, controls, and overlap", () => {
  for (const vector of SYNTHETIC_SECRET_CLOSURE_VECTORS) {
    assert.deepEqual(scanSecrets([line(vector.text)]).map((hit) => hit.kind), [vector.kind], vector.name);
  }
});

test("logical delimiters after complete values do not hide hits or consume following records", () => {
  for (const vector of SYNTHETIC_DELIMITER_PRESERVATION_VECTORS) {
    assert.deepEqual(scanSecrets([line(vector.text)]).map((hit) => hit.kind), [vector.kind], vector.name);
  }
});

test("detects every TAB LF and CR split position in shared synthetic credentials", () => {
  for (const vector of SYNTHETIC_EVERY_CONTROL_SPLIT_VECTORS) {
    assert.deepEqual(scanSecrets([line(vector.text)]).map((hit) => hit.kind), [vector.kind], vector.name);
  }
});

test("detects assignments with ambiguous EOF continuations", () => {
  for (const vector of SYNTHETIC_EOF_AMBIGUITY_VECTORS) {
    assert.deepEqual(scanSecrets([line(vector.text)]).map((hit) => hit.kind), [vector.kind], vector.name);
  }
});

test("anthropic keys are not double-reported as openai keys", () => {
  const hits = scanSecrets([line("sk-ant-aB3dE5fG7hI9jK2mN4pQ6rS8")]);

  assert.deepEqual(hits.map((hit) => hit.kind), ["anthropic key"]);
});

test("reports only the first matching secret per added line", () => {
  const hits = scanSecrets([
    line("const keys = [\"AKIAA1B2C3D4E5F6G7H8\", \"sk-aB3dE5fG7hI9jK2mN4pQ6rS8\"]"),
  ]);

  assert.deepEqual(hits.map((hit) => hit.kind), ["aws access key"]);
});

test("detects real-shaped secrets in comment-like added lines", () => {
  const realKey = "sk-ant-aB3dE5fG7hI9jK2mN4pQ6rS8";
  const cases = [
    `  #apiKey = "${realKey}";`,
    `* leaked key: ${realKey}`,
    `// const apiKey = "${realKey}";`,
  ];

  for (const text of cases) {
    assert.deepEqual(scanSecrets([line(text)]).map((hit) => hit.kind), ["anthropic key"], text);
  }
});

test("does not flag benign, placeholder, or test-example lines", () => {
  const benign = [
    "const password = process.env.PASSWORD;",
    'password = ""',
    "// example: sk-ant-" + "x".repeat(24),
    "const b64 = \"aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=\";",
    "skill = new Skill()",
    "AKIAI is not a full key",
    "const placeholder = \"sk-ant-" + "x".repeat(24) + "\";",
    "const placeholder = \"sk-" + "z".repeat(24) + "\";",
    'password = "test-password-123"',
    "secret=example-secret",
    "token=changeme",
    'api_key="placeholder-value"',
    'authorization="Bearer example-token"',
    "authorization: Bearer placeholder-token",
    "sk-proj-" + "x".repeat(28),
    ...EXACT_PLACEHOLDER_ASSIGNMENTS,
  ];

  assert.equal(scanSecrets(benign.map(line)).length, 0);
});
