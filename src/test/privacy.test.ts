import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
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

function maximumRawHit(index: number): RecallHit {
  const field = String(index).repeat(MAX_FIELD_BYTES);
  return {
    failure: {
      kind: "failure", id: field, ts: index, cwd: field, cmd: field, exitCode: 1,
      fingerprint: field, signature: [field], excerpt: field,
    },
    fix: {
      kind: "fix", id: field, ts: index, cwd: field, cmd: field, failureIds: [field],
    },
    score: 1,
  };
}

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

test("privacy limits use the specified byte values", () => {
  assert.equal(MAX_FIELD_BYTES, 16 * 1024);
  assert.equal(MAX_RESPONSE_BYTES, 512 * 1024);
});

test("sanitized projection has exactly the allowlisted keys despite injected unknown data", () => {
  const hit = {
    failure: {
      kind: "failure" as const, id: "persisted-id", ts: 11, cwd: "/private", cmd: "safe command",
      exitCode: 1, fingerprint: "fp-keys", signature: ["safe signature"], excerpt: "private excerpt",
      unknownSecret: "must-not-escape",
    },
    score: 1,
    unknownTopLevel: "must-not-escape",
  };
  const item = projectRecallHits([hit as unknown as RecallHit], "sanitized").items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    "candidateId", "command", "exitCode", "fingerprint", "hasFix", "origin", "signature", "timestamp", "truncatedFields",
  ]);
  assert.doesNotMatch(JSON.stringify(item), /persisted-id|private|must-not-escape/);
});

test("sanitized projection defaults a missing failure origin to run", () => {
  const hit: RecallHit = {
    failure: {
      kind: "failure", id: "f-default-origin", ts: 12, cwd: "/work", cmd: "test", exitCode: 1,
      fingerprint: "fp-default-origin", signature: [], excerpt: "failure",
    },
    score: 1,
  };
  assert.equal(projectRecallHits([hit], "sanitized").items[0].origin, "run");
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

test("redactor removes composite private flags, UNC and quoted paths, and two-class base64", () => {
  const input = "--private-key=super-secret --client-secret 'two words' \\\\server\\share\\private file.txt \"/opt/private folder/file.txt\" abcdef0123456789abcdef0123456789";
  const output = redactText(input, "/home/ada");
  assert.doesNotMatch(output, /super-secret|two words|server|share|private file|folder\/file|abcdef0123456789/);
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

test("UTF-8 truncation stays linear for a large prefix", { timeout: 20_000 }, () => {
  const input = `${"x".repeat(200_000)}🙂`;
  const started = performance.now();
  const output = truncateUtf8(input, 199_999);
  const elapsedMs = performance.now() - started;

  assert.equal(output.value.length, 199_999);
  assert.equal(output.truncated, true);
  assert.ok(elapsedMs < 2_000, `200 KiB truncation took ${elapsedMs.toFixed(1)}ms`);
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

test("raw projection caps and detaches every fix field including failure IDs", () => {
  const long = "z".repeat(MAX_FIELD_BYTES + 1);
  const fix = Object.freeze({
    kind: "fix" as const, id: long, ts: 51, cwd: long, cmd: long, failureIds: Object.freeze([long]),
  });
  const hit: RecallHit = {
    failure: {
      kind: "failure", id: "f-fix-cap", ts: 50, cwd: "/work", cmd: "fails", exitCode: 1,
      fingerprint: "fp-fix-cap", signature: [], excerpt: "failure",
    },
    fix: fix as unknown as RecallHit["fix"], score: 1,
  };
  const item = projectRecallHits([hit], "raw").items[0];
  const projectedFix = item.rawRecord?.fix;
  assert.equal(Buffer.byteLength(item.fixCommand ?? "", "utf8"), MAX_FIELD_BYTES);
  assert.equal(Buffer.byteLength(projectedFix?.id ?? "", "utf8"), MAX_FIELD_BYTES);
  assert.equal(Buffer.byteLength(projectedFix?.cwd ?? "", "utf8"), MAX_FIELD_BYTES);
  assert.equal(Buffer.byteLength(projectedFix?.cmd ?? "", "utf8"), MAX_FIELD_BYTES);
  assert.equal(Buffer.byteLength((projectedFix?.failureIds ?? []).join("\n"), "utf8"), MAX_FIELD_BYTES);
  assert.notEqual(projectedFix?.failureIds, fix.failureIds);
  (projectedFix?.failureIds as string[])[0] = "changed";
  assert.equal(fix.failureIds[0], long);
  assert.deepEqual([...item.truncatedFields].sort(), [
    "fixCommand", "rawRecord.fix.cmd", "rawRecord.fix.cwd", "rawRecord.fix.failureIds", "rawRecord.fix.id",
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

test("response cap preserves source-local candidate IDs after skipping an oversized middle hit", () => {
  const third: RecallHit = {
    failure: {
      kind: "failure", id: "third", ts: 3, cwd: "/work", cmd: "original third command", exitCode: 1,
      fingerprint: "third-fingerprint", signature: ["third failure"], excerpt: "third excerpt",
    },
    score: 1,
  };

  const output = projectRecallHits([maximumRawHit(1), maximumRawHit(2), third], "raw");

  assert.equal(output.truncated, true);
  assert.deepEqual(output.items.map((item) => item.candidateId), ["c1", "c3"]);
  assert.equal(output.items[1].command, "original third command");
});

test("response cap omits the item that would make an untruncated response 524289 bytes", () => {
  const full = "x.".repeat(MAX_FIELD_BYTES / 2);
  const hits: RecallHit[] = Array.from({ length: 31 }, (_, index) => ({
    failure: {
      kind: "failure", id: `f-${index}`, ts: 1, cwd: "/work", cmd: full, exitCode: 1,
      fingerprint: "fp", signature: [], excerpt: "failure",
    },
    score: 1,
  }));
  hits.push({
    failure: {
      kind: "failure", id: "f-31", ts: 1, cwd: "/work", cmd: "x.".repeat(5_819), exitCode: 1,
      fingerprint: "fp", signature: [], excerpt: "failure",
    },
    score: 1,
  });
  const output = projectRecallHits(hits, "sanitized");
  assert.equal(output.truncated, true);
  assert.equal(output.items.length, 31);
  assert.ok(Buffer.byteLength(JSON.stringify(output), "utf8") <= MAX_RESPONSE_BYTES);
});

test("response exactly at the cap stays complete with truncated false", () => {
  const full = "x.".repeat(MAX_FIELD_BYTES / 2);
  const hits: RecallHit[] = Array.from({ length: 31 }, (_, index) => ({
    failure: {
      kind: "failure", id: `f-exact-${index}`, ts: 1, cwd: "/work", cmd: full, exitCode: 1,
      fingerprint: "fp", signature: [], excerpt: "failure",
    },
    score: 1,
  }));
  hits.push({
    failure: {
      kind: "failure", id: "f-exact-31", ts: 1, cwd: "/work", cmd: `${"x.".repeat(5_818)}x`, exitCode: 1,
      fingerprint: "fp", signature: [], excerpt: "failure",
    },
    score: 1,
  });
  const output = projectRecallHits(hits, "sanitized");
  assert.equal(output.truncated, false);
  assert.equal(output.items.length, 32);
  assert.equal(Buffer.byteLength(JSON.stringify(output), "utf8"), MAX_RESPONSE_BYTES);
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

test("redactor is not defeated by a prefix in front of the key name", () => {
  // A stress audit of 0.4.0 found the key rule anchored to `^`, whitespace or
  // `;`, so any other neighbouring character — `:` in an npm config line,
  // `,` in a list, `(` in a log — let the whole credential through. The
  // entropy fallback could not save it either: `=` sat inside its lookbehind,
  // which is exactly where a credential appears.
  const leaky = [
    "user:_authToken=A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0",
    "config:api_secret=SuperSecretValue12345678",
    "env:password=hunter22222",
    "(api_key=abc123)",
    "x,PASSWORD=letmein",
    "npm config set //registry.npmjs.org/:_authToken=npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    // No recognised key name at all: the entropy fallback is the only net left.
    "unknownfield=A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0",
  ];
  for (const input of leaky) {
    const output = redactText(input, "/home/ada");
    assert.match(output, /\[redacted\]/, `expected redaction for ${input}`);
    assert.doesNotMatch(
      output,
      /A1b2C3d4E5f6|SuperSecretValue|hunter22222|abc123|letmein|npm_A1b2/,
      `secret survived redaction in ${input}`,
    );
  }
});

test("redactor still leaves ordinary words that merely contain a key name", () => {
  for (const benign of ["monkeykeyboard", "keyboard shortcut", "the token bus arrives", "hello world"]) {
    assert.equal(redactText(benign, "/home/ada"), benign);
  }
});
