import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { RecallHit, RecentFailureHit } from "../core/memory-query.js";
import {
  MAX_FIELD_BYTES,
  MAX_RESPONSE_BYTES,
  projectRecentFailures,
  projectRecallHits,
  redactText,
  strictestExposure,
  truncateUtf8,
} from "../mcp/privacy.js";

test("sanitized projection is an allowlist and never exposes UUID cwd or excerpt", () => {
  const hit = Object.freeze({
    failure: Object.freeze({
      kind: "failure" as const, id: "persisted-f1", ts: 10, cwd: "/home/ada/private",
      cmd: "tool --token 'secret value' https://example.test/private", exitCode: 1,
      fingerprint: "fp1", signature: Object.freeze(["error in /home/ada/private/a.ts"]),
      excerpt: "Bearer abcdefghijklmnopqrstuvwxyz", origin: "run" as const,
    }),
    score: 0.8,
  });
  const output = projectRecallHits([hit as unknown as RecallHit], "sanitized");
  assert.equal(output.items[0].candidateId, "c1");
  assert.equal("cwd" in output.items[0], false);
  assert.equal("excerpt" in output.items[0], false);
  assert.doesNotMatch(JSON.stringify(output), /persisted-f1|secret value|example\.test|\/home\/ada/);
});

test("redactor covers env assignments, flags, Windows paths and bearer values", () => {
  const input = "API_KEY=abc123 --password=hello --token 'two words' C:\\Users\\Ada\\file Bearer longsecretvalue";
  const output = redactText(input, "/home/ada");
  assert.doesNotMatch(output, /abc123|hello|two words|Users|longsecretvalue/);
});

test("strictest exposure never escalates either boundary", () => {
  assert.equal(strictestExposure("raw", "raw"), "raw");
  assert.equal(strictestExposure("raw", "sanitized"), "sanitized");
  assert.equal(strictestExposure("sanitized", "raw"), "sanitized");
});

test("redactor removes every sensitive boundary without relying on key casing", () => {
  const cases = [
    "api_key=abc123",
    "PRIVATE_KEY=super-secret",
    "Authorization: Basic c2VjcmV0",
    "--password=hello",
    "--token 'two words'",
    "--api-key=equals-secret",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "github_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "xoxb-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "AKIAIOSFODNN7EXAMPLE",
    "glpat-ABCdef123",
    "aGVsbG8gdGhpcyBpcyBhIHN1ZmZpY2llbnRseSBsb25nIHNlY3JldA==",
    "deadbeefcafebabefeedface0123456789abcdef",
    "/opt/private/app.ts",
    "C:\\Users\\Ada\\private.txt",
    "https://example.test/very/private?token=secret",
  ];
  for (const input of cases) {
    const output = redactText(input, "/home/ada");
    assert.notEqual(output, input, `expected redaction for ${input}`);
    assert.doesNotMatch(output, /abc123|super-secret|c2VjcmV0|hello|two words|equals-secret|abcdefghijklmnopqrstuvwxyz|deadbeef|Users|example\.test|\/opt\/private/);
  }
});

test("normalization removes ASCII and bidi controls before output", () => {
  const input = "  one\u0000\u0007\u000b\u007f\u202etwo\u2069  three\n";
  assert.equal(redactText(input), "one two three");
});

test("UTF-8 truncation stops before a multi-byte code point", () => {
  const input = `${"a".repeat(MAX_FIELD_BYTES - 3)}🙂`;
  const output = truncateUtf8(input, MAX_FIELD_BYTES);
  assert.equal(output.value, "a".repeat(MAX_FIELD_BYTES - 3));
  assert.equal(output.truncated, true);
  assert.equal(Buffer.byteLength(output.value, "utf8"), MAX_FIELD_BYTES - 3);
});

test("raw projection preserves secrets, deep-clones canonical records, and normalizes controls", () => {
  const failure = Object.freeze({
    kind: "failure" as const, id: "f-raw", ts: 20, cwd: "/work\u0000/private",
    cmd: "deploy --token actual-secret\u202e", exitCode: 2, fingerprint: "fp-raw",
    signature: Object.freeze(["first\u0007 signature", "second signature"]),
    excerpt: "Bearer actual-secret\u0000", origin: "hook" as const,
  });
  const fix = Object.freeze({
    kind: "fix" as const, id: "x-raw", ts: 21, cwd: "/work/fix", cmd: "deploy --token fixed-secret",
    failureIds: Object.freeze(["f-raw"]),
  });
  const output = projectRecallHits([Object.freeze({ failure, fix, score: 1 }) as unknown as RecallHit], "raw");
  const item = output.items[0];

  assert.equal(item.command, "deploy --token actual-secret");
  assert.equal(item.cwd, "/work /private");
  assert.equal(item.excerpt, "Bearer actual-secret");
  assert.equal(item.fixCommand, "deploy --token fixed-secret");
  assert.deepEqual(item.rawRecord, {
    failure: {
      kind: "failure", id: "f-raw", ts: 20, cwd: "/work /private",
      cmd: "deploy --token actual-secret", exitCode: 2, fingerprint: "fp-raw",
      signature: ["first signature", "second signature"], excerpt: "Bearer actual-secret", origin: "hook",
    },
    fix: {
      kind: "fix", id: "x-raw", ts: 21, cwd: "/work/fix", cmd: "deploy --token fixed-secret", failureIds: ["f-raw"],
    },
  });
  assert.notEqual(item.rawRecord?.failure, failure);
  assert.notEqual(item.rawRecord?.fix, fix);
  (item.rawRecord?.failure.signature as string[])[0] = "changed";
  assert.equal(failure.signature[0], "first\u0007 signature");
});

test("projection caps individual string fields and complete signatures", () => {
  const long = "a".repeat(MAX_FIELD_BYTES + 1);
  const hit: RecallHit = {
    failure: {
      kind: "failure", id: "f-cap", ts: 30, cwd: "/work", cmd: long, exitCode: 1, fingerprint: "fp-cap",
      signature: ["b".repeat(MAX_FIELD_BYTES - 1), "cc"], excerpt: long,
    },
    score: 1,
  };
  const item = projectRecallHits([hit], "raw").items[0];
  assert.equal(Buffer.byteLength(item.command, "utf8"), MAX_FIELD_BYTES);
  assert.equal(Buffer.byteLength(item.excerpt ?? "", "utf8"), MAX_FIELD_BYTES);
  assert.equal(Buffer.byteLength(item.signature.join("\n"), "utf8"), MAX_FIELD_BYTES);
  assert.deepEqual([...item.truncatedFields].sort(), [
    "command", "excerpt", "rawRecord.failure.cmd", "rawRecord.failure.excerpt", "rawRecord.failure.signature", "signature",
  ]);
});

test("response cap omits a whole projected item and never exceeds its byte limit", () => {
  const field = "x".repeat(MAX_FIELD_BYTES);
  const hits: RecallHit[] = Array.from({ length: 20 }, (_, index) => ({
    failure: {
      kind: "failure", id: `f-${index}`, ts: index, cwd: field, cmd: field, exitCode: 1,
      fingerprint: `fp-${index}`, signature: [field], excerpt: field,
    },
    score: 1,
  }));
  const output = projectRecallHits(hits, "raw");
  assert.equal(output.truncated, true);
  assert.ok(output.items.length > 0 && output.items.length < hits.length);
  assert.ok(Buffer.byteLength(JSON.stringify(output), "utf8") <= MAX_RESPONSE_BYTES);
  const candidateIds = (output.items as readonly { candidateId: string }[]).map((item) => item.candidateId);
  assert.deepEqual(candidateIds, candidateIds.map((_, index) => `c${index + 1}`));
});

test("recent and recall responses restart candidate IDs at c1", () => {
  const hit: RecentFailureHit = {
    failure: {
      kind: "failure", id: "f-local", ts: 40, cwd: "/work", cmd: "test", exitCode: 1,
      fingerprint: "fp-local", signature: ["failure"], excerpt: "failure",
    },
  };
  assert.equal(projectRecentFailures([hit], "sanitized").items[0].candidateId, "c1");
  assert.equal(projectRecallHits([{ ...hit, score: 1 }], "sanitized").items[0].candidateId, "c1");
});
