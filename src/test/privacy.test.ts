import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import type { KnowledgeSearchHit, RecallHit, RecentFailureHit } from "../core/memory-query.js";
import type { FailureRecord, FixRecord, TripleRecord } from "../core/memory-read.js";
import {
  MAX_FIELD_BYTES,
  MAX_RESPONSE_BYTES,
  normalizeOutputText,
  projectMemoryRecord,
  projectKnowledgeHits,
  projectRecentFailures,
  projectRecallHits,
  projectTriple,
  redactText,
  strictestExposure,
  truncateUtf8,
} from "../mcp/privacy.js";
import {
  SYNTHETIC_DELIMITER_PRESERVATION_VECTORS,
  SYNTHETIC_EOF_AMBIGUITY_VECTORS,
  SYNTHETIC_EVERY_CONTROL_SPLIT_VECTORS,
  SYNTHETIC_MULTI_CONTROL_PROBES,
  SYNTHETIC_NON_EOF_CONTROL_PROBES,
  SYNTHETIC_SECRET_CLOSURE_VECTORS,
} from "./secret-vectors.js";

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

test("malformed custom knowledge hits disclose truncation instead of disappearing cleanly", () => {
  const valid: KnowledgeSearchHit = {
    id: "valid-search-hit", ts: 10, kind: "triple", snippet: "known", score: 1,
    agent: "codex", source: "agent-hook", filesCovered: ["src/known.ts"],
    truncatedFiles: 0, complete: false, coverageStatus: "unknown",
  };
  const output = projectKnowledgeHits([valid, null] as unknown as KnowledgeSearchHit[], "sanitized");
  assert.equal(output.items.length, 1);
  assert.equal(output.truncated, true);
});

test("malformed recall and recent-failure hits disclose truncation while retaining valid items", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "valid-recall", ts: 10, cwd: "/work", cmd: "npm test", exitCode: 1,
    fingerprint: "fp-valid", signature: ["failure"], excerpt: "failure", origin: "run",
  };
  const recall = projectRecallHits([{ failure, score: 1 }, null] as unknown as RecallHit[], "sanitized");
  assert.equal(recall.items.length, 1);
  assert.equal(recall.truncated, true);

  const recent = projectRecentFailures([{ failure }, null] as unknown as RecentFailureHit[], "sanitized");
  assert.equal(recent.items.length, 1);
  assert.equal(recent.truncated, true);
});

test("future custom recall and recent hits disclose truncation while exact-now evidence stays valid", () => {
  const now = 100;
  const failure: FailureRecord = {
    kind: "failure", id: "valid-now", ts: now, cwd: "/work", cmd: "npm test", exitCode: 1,
    fingerprint: "fp-now", signature: ["failure"], excerpt: "failure", origin: "run",
  };
  const futureFailure = { ...failure, id: "future-failure", ts: now + 1 };
  const fix: FixRecord = { kind: "fix", id: "fix-now", ts: now, cwd: "/work", cmd: "npm test", failureIds: [failure.id] };
  const futureFix = { ...fix, id: "future-fix", ts: now + 1 };

  const recallFailure = projectRecallHits([{ failure, score: 1 }, { failure: futureFailure, score: 1 }], "sanitized", now);
  assert.equal(recallFailure.items.length, 1);
  assert.equal(recallFailure.truncated, true);
  const recallFix = projectRecallHits([{ failure, fix: futureFix, score: 1 }, { failure, fix, score: 1 }], "sanitized", now);
  assert.equal(recallFix.items.length, 1);
  assert.equal(recallFix.items[0]?.hasFix, true);
  assert.equal(recallFix.truncated, true);
  const exact = projectRecallHits([{ failure, fix, score: 1 }], "sanitized", now);
  assert.equal(exact.items.length, 1);
  assert.equal(exact.items[0]?.hasFix, true);
  assert.equal(exact.truncated, false);

  const recent = projectRecentFailures([{ failure }, { failure: futureFailure }], "sanitized", now);
  assert.equal(recent.items.length, 1);
  assert.equal(recent.truncated, true);
  const recentFix = projectRecentFailures([{ failure, fix: futureFix }, { failure, fix }], "sanitized", now);
  assert.equal(recentFix.items.length, 1);
  assert.equal(recentFix.items[0]?.hasFix, true);
  assert.equal(recentFix.truncated, true);
});

test("custom recall and recent hits snapshot every source field once", () => {
  const reads = new Map<string, number>();
  const values: Record<string, [unknown, unknown]> = {};
  const setValues = (name: string, fields: Record<string, [unknown, unknown]>) => {
    for (const [key, value] of Object.entries(fields)) values[`${name}.${key}`] = value;
  };
  const sourceProxy = (name: string) => new Proxy({}, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") return undefined;
      const key = `${name}.${property}`;
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      if (property === "candidateFailureIds" || property === "links") {
        throw new Error(`irrelevant getter: ${key}`);
      }
      if (!(key in values)) throw new Error(`unexpected getter: ${key}`);
      return count === 1 ? values[key][0] : values[key][1];
    },
    ownKeys() { throw new Error(`must not enumerate ${name}`); },
  }) as unknown as Record<string, unknown>;
  const failureSignature = new Proxy(["failure signature"], {
    get(target, property, receiver) {
      const key = typeof property === "string" ? `failure.signature.${property}` : "failure.signature.symbol";
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("must not enumerate signature"); },
  });
  setValues("failure", {
    kind: ["failure", "failure"], id: ["failure-once", "failure-once"], ts: [10, 10],
    cwd: ["/work", "/work"], cmd: ["npm test", "npm test"], exitCode: [1, 1],
    fingerprint: ["fp-once", "fp-once"], signature: [failureSignature, failureSignature],
    excerpt: ["failure excerpt", "failure excerpt"], origin: [undefined, "Bearer TOPSECRET\u001b[31m"],
  });
  setValues("fix", {
    kind: ["fix", "fix"], id: ["fix-once", "Bearer FIXTOPSECRET"], ts: [11, 11],
    cwd: ["/work", "/work"], cmd: ["npm test", "npm test"], failureIds: [["failure-once"], ["failure-once"]],
  });
  const failure = sourceProxy("failure");
  const fix = sourceProxy("fix");
  const hit = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") return undefined;
      const key = `hit.${property}`;
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      if (property === "failure") return failure;
      if (property === "fix") return fix;
      throw new Error(`unexpected getter: ${property}`);
    },
    ownKeys() { throw new Error("must not enumerate hit"); },
  });

  const output = projectRecallHits([hit as unknown as RecallHit], "sanitized", 100);
  assert.equal(output.items.length, 1);
  assert.equal(output.truncated, false);
  assert.equal(output.items[0]?.origin, "run");
  assert.doesNotMatch(JSON.stringify(output), /TOPSECRET|Bearer|\u001b/);
  assert.equal(reads.get("hit.failure"), 1);
  assert.equal(reads.get("hit.fix"), 1);
  for (const field of ["kind", "id", "ts", "cwd", "cmd", "exitCode", "fingerprint", "signature", "excerpt", "origin"]) {
    assert.equal(reads.get(`failure.${field}`), 1, `failure.${field} read count`);
  }
  for (const field of ["kind", "id", "ts", "cwd", "cmd", "failureIds"]) {
    assert.equal(reads.get(`fix.${field}`), 1, `fix.${field} read count`);
  }
  assert.equal(reads.get("failure.signature.length"), 1);
  assert.equal(reads.get("failure.signature.0"), 1);
});

test("over-cap custom signatures and failure IDs disclose truncation instead of accepting prefixes", () => {
  const valid: FailureRecord = {
    kind: "failure", id: "valid-bounded", ts: 10, cwd: "/work", cmd: "npm test", exitCode: 1,
    fingerprint: "fp-bounded", signature: ["failure"], excerpt: "failure", origin: "run",
  };
  const tooManySignatures = { ...valid, id: "too-many-signatures", signature: Array.from({ length: 257 }, () => "failure") };
  const tooManyFailureIds: FixRecord = {
    kind: "fix", id: "too-many-failure-ids", ts: 11, cwd: "/work", cmd: "npm test",
    failureIds: Array.from({ length: 257 }, () => valid.id),
  };
  const tooManyIds = { failure: valid, fix: tooManyFailureIds, score: 1 };
  const tooManyBytes = {
    failure: { ...valid, id: "too-many-signature-bytes", signature: ["x".repeat(22_000), "y".repeat(22_000), "z".repeat(22_000)] },
    score: 1,
  };
  const hits = [
    { failure: valid, score: 1 },
    { failure: tooManySignatures, score: 1 },
    tooManyIds,
    tooManyBytes,
  ] as unknown as RecallHit[];
  const recall = projectRecallHits(hits, "sanitized", 100);
  assert.deepEqual(recall.items.map((item) => item.fingerprint), ["fp-bounded"]);
  assert.equal(recall.truncated, true);
  const recent = projectRecentFailures(hits as unknown as RecentFailureHit[], "sanitized", 100);
  assert.deepEqual(recent.items.map((item) => item.fingerprint), ["fp-bounded"]);
  assert.equal(recent.truncated, true);
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

test("projection work budgets stop long hostile arrays after a bounded prefix", () => {
  const large = "x".repeat(30_000);
  const recallValues: RecallHit[] = Array.from({ length: 100 }, (_, index) => ({
    failure: {
      kind: "failure", id: `budget-${index}`, ts: index, cwd: "/work", cmd: "needle", exitCode: 1,
      fingerprint: `budget-fp-${index}`, signature: [large], excerpt: large,
    },
    score: 1,
  }));
  let recallReads = 0;
  const recallHits = new Proxy(recallValues, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) recallReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const recall = projectRecallHits(recallHits, "sanitized");
  assert.ok(recallReads > 0 && recallReads < recallValues.length, `recall accesses: ${recallReads}`);
  assert.equal(recall.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(recall), "utf8") <= MAX_RESPONSE_BYTES);

  const knowledgeValues: KnowledgeSearchHit[] = Array.from({ length: 100 }, (_, index) => ({
    id: `knowledge-budget-${index}`, ts: index, kind: "note", snippet: large, score: 1, source: "note",
  }));
  let knowledgeReads = 0;
  const knowledgeHits = new Proxy(knowledgeValues, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) knowledgeReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const knowledge = projectKnowledgeHits(knowledgeHits, "sanitized");
  assert.ok(knowledgeReads > 0 && knowledgeReads < knowledgeValues.length, `knowledge accesses: ${knowledgeReads}`);
  assert.equal(knowledge.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(knowledge), "utf8") <= MAX_RESPONSE_BYTES);
});

test("projection work budgets stop malformed recall and recent arrays", () => {
  const malformed = new Proxy({}, { get() { throw new Error("malformed hit"); } });
  const values = Array.from({ length: 20_000 }, () => malformed);
  let recallReads = 0;
  const recallHits = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) recallReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const recall = projectRecallHits(recallHits as unknown as RecallHit[], "sanitized");
  assert.equal(recall.items.length, 0);
  assert.equal(recall.truncated, true);
  assert.ok(recallReads > 0 && recallReads < values.length, `malformed recall accesses: ${recallReads}`);

  let recentReads = 0;
  const recentHits = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) recentReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const recent = projectRecentFailures(recentHits as unknown as RecentFailureHit[], "sanitized");
  assert.equal(recent.items.length, 0);
  assert.equal(recent.truncated, true);
  assert.ok(recentReads > 0 && recentReads < values.length, `malformed recent accesses: ${recentReads}`);
});

test("knowledge projection snapshots nested file witnesses before global work charging", () => {
  const files = Array.from({ length: 20_000 }, () => "src/duplicate.ts");
  let nestedReads = 0;
  const hostileFiles = new Proxy(files, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) nestedReads += 1;
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("files must not be enumerated"); },
  });
  const hits: KnowledgeSearchHit[] = Array.from({ length: 100 }, (_, index) => ({
    id: `nested-budget-${index}`, ts: index, kind: "triple", snippet: "duplicate", score: 1,
    filesCovered: hostileFiles, truncatedFiles: 0, coverageStatus: "complete", complete: true,
  }));
  const output = projectKnowledgeHits(hits, "sanitized");
  assert.ok(nestedReads > 0 && nestedReads <= hits.length * 256, `nested file accesses: ${nestedReads}`);
  assert.ok(output.items.length > 0);
  assert.ok((output.items[0]?.truncatedFiles ?? 0) > 0);
  assert.ok((output.items[0]?.truncatedFiles ?? 0) <= 20_000);
  assert.equal(output.items[0]?.coverageStatus, "truncated");

  const small = projectKnowledgeHits([{
    id: "small-known", ts: 1, kind: "triple", snippet: "known", score: 1,
    filesCovered: ["src/known.ts", "src/known.ts"], truncatedFiles: 0,
    coverageStatus: "unknown", complete: false,
  }], "sanitized");
  assert.deepEqual(small.items[0]?.filesCovered, ["src/known.ts"]);
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

test("projectTriple sanitized is explicit, redacted, bounded, and detached", () => {
  const triple: TripleRecord = {
    kind: "triple", id: "opaque-triple-id", ts: 31, cwd: "/home/ada/private", schemaV: 1,
    agent: "codex", origin: "agent-hook",
    intent: { text: "use sk-ant-abcdefghijklmnopqrstuvwxyz1234567890 for button" },
    rationale: { text: "secret=sk-ant-abcdefghijklmnopqrstuvwxyz1234567890", tags: ["sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"] , source: "notify" },
    mechanism: {
      head: "head --token sk-ant-abcdefghijklmnopqrstuvwxyz1234567890",
      files: [{
        path: "/home/ada/private/button.tsx",
        plusMinus: [3, 1],
        props: ["--token=sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"],
        excerpt: "excerpt sk-ant-abcdefghijklmnopqrstuvwxyz1234567890",
      }],
      truncatedFiles: 0,
    },
  };

  const output = projectTriple(triple, "sanitized");
  assert.equal(output.id, triple.id);
  assert.equal("cwd" in output, false);
  assert.equal(output.files[0]?.excerpt, undefined);
  assert.doesNotMatch(JSON.stringify(output), /sk-ant-|\/home\/ada\/private/);
  assert.notEqual(output.files, triple.mechanism.files);
  assert.notEqual(output.files[0]?.props, triple.mechanism.files[0]?.props);
  assert.notEqual(output.files[0]?.plusMinus, triple.mechanism.files[0]?.plusMinus);
});

test("projectTriple raw keeps bounded excerpt and normalized cwd without sharing arrays", () => {
  const triple: TripleRecord = {
    kind: "triple", id: "opaque-raw-id", ts: 32, cwd: "/work\u0000/private", schemaV: 1,
    agent: "claude-code", origin: "agent-hook",
    intent: { text: "change button" },
    mechanism: {
      files: [{ path: "src/button.tsx", plusMinus: [1, 2], props: ["color"], excerpt: "raw excerpt\u0000" }],
      truncatedFiles: 0,
    },
  };

  const output = projectTriple(triple, "raw");
  assert.equal(output.id, triple.id);
  assert.equal(output.cwd, "/work /private");
  assert.equal(output.files[0]?.excerpt, "raw excerpt");
  assert.notEqual(output.files, triple.mechanism.files);
  assert.notEqual(output.files[0]?.plusMinus, triple.mechanism.files[0]?.plusMinus);
});

test("modern prefixed keys stay sanitized by default while explicit raw triple exposure remains raw", () => {
  const modernKey = "sk-proj-aB3dE5fG7hI9-jK2mN4pQ6rS8tU0vW1xY2zA4";
  const triple: TripleRecord = {
    kind: "triple", id: "modern-key-projection", ts: 33, cwd: "/work", schemaV: 1,
    agent: "codex", origin: "agent-hook",
    intent: { text: `deploy ${modernKey}` },
    mechanism: {
      files: [{ path: "src/deploy.ts", plusMinus: [1, 0], props: [], excerpt: `token=${modernKey}` }],
      truncatedFiles: 0,
    },
  };

  const sanitized = projectTriple(triple, "sanitized");
  const raw = projectTriple(triple, "raw");
  assert.doesNotMatch(JSON.stringify(sanitized), /sk-proj-|aB3dE5fG7hI9/u);
  assert.equal(raw.intent, `deploy ${modernKey}`);
  assert.equal(raw.files[0]?.excerpt, `token=${modernKey}`);
});

test("shared secret vectors stay closed in sanitized MCP while quoted-key raw exposure remains explicit", () => {
  for (const [index, vector] of SYNTHETIC_SECRET_CLOSURE_VECTORS.entries()) {
    const triple: TripleRecord = {
      kind: "triple", id: `shared-projection-${index}`, ts: 34, cwd: "/work", schemaV: 1,
      agent: "codex", origin: "agent-hook", intent: { text: vector.text },
      mechanism: {
        files: [{ path: "src/x.ts", plusMinus: [0, 0], props: [], excerpt: vector.text }],
        truncatedFiles: 0,
      },
    };
    const sanitized = projectTriple(triple, "sanitized");
    const raw = projectTriple(triple, "raw");
    assert.match(redactText(vector.text, "/home/ada"), /\[redacted\]/u, vector.name);
    assert.match(sanitized.intent ?? "", /\[redacted\]/u, vector.name);
    assert.equal(raw.intent, normalizeOutputText(vector.text), vector.name);
    assert.equal(raw.files[0]?.excerpt, normalizeOutputText(vector.text), vector.name);
  }
});

test("sanitized MCP binds ambiguous continuations and preserves only canonical outside text", () => {
  for (const vector of SYNTHETIC_DELIMITER_PRESERVATION_VECTORS) {
    assert.equal(redactText(vector.text, "/home/ada"), vector.sanitizedMcp, vector.name);
  }
});

test("sanitized MCP contains every control split and suffix context while raw remains explicit", () => {
  for (const [index, vector] of SYNTHETIC_EVERY_CONTROL_SPLIT_VECTORS.entries()) {
    const triple: TripleRecord = {
      kind: "triple", id: `control-split-${index}`, ts: 35, cwd: "/work", schemaV: 1,
      agent: "codex", origin: "agent-hook", intent: { text: vector.text },
      mechanism: {
        files: [{ path: "src/x.ts", plusMinus: [0, 0], props: [], excerpt: vector.text }],
        truncatedFiles: 0,
      },
    };
    const sanitized = projectTriple(triple, "sanitized");
    const raw = projectTriple(triple, "raw");
    assert.equal(redactText(vector.text, "/home/ada"), vector.sanitizedMcp, vector.name);
    assert.equal(sanitized.intent, vector.sanitizedMcp, vector.name);
    assert.equal(raw.intent, normalizeOutputText(vector.text), vector.name);
    assert.equal(raw.files[0]?.excerpt, normalizeOutputText(vector.text), vector.name);
  }
});

test("sanitized MCP contains the three non-EOF review probes", () => {
  for (const [index, vector] of SYNTHETIC_NON_EOF_CONTROL_PROBES.entries()) {
    const triple: TripleRecord = {
      kind: "triple", id: `non-eof-review-${index}`, ts: 37, cwd: "/work", schemaV: 1,
      agent: "codex", origin: "agent-hook", intent: { text: vector.text },
      mechanism: {
        files: [{ path: "src/x.ts", plusMinus: [0, 0], props: [], excerpt: vector.text }],
        truncatedFiles: 0,
      },
    };
    const sanitized = projectTriple(triple, "sanitized");
    const raw = projectTriple(triple, "raw");
    assert.equal(redactText(vector.text, "/home/ada"), vector.sanitizedMcp, vector.name);
    assert.equal(sanitized.intent, vector.sanitizedMcp, vector.name);
    assert.ok(!JSON.stringify(sanitized).includes(vector.leakedSuffix), vector.name);
    assert.equal(raw.intent, normalizeOutputText(vector.text), vector.name);
    assert.equal(raw.files[0]?.excerpt, normalizeOutputText(vector.text), vector.name);
  }
});

test("sanitized MCP applies structural marker policy to multiple controls", () => {
  for (const vector of SYNTHETIC_MULTI_CONTROL_PROBES) {
    assert.equal(redactText(vector.text, "/home/ada"), vector.sanitizedMcp, vector.name);
  }
});

test("sanitized MCP discloses conservative EOF redaction without exposing the removed token", () => {
  for (const [index, vector] of SYNTHETIC_EOF_AMBIGUITY_VECTORS.entries()) {
    const triple: TripleRecord = {
      kind: "triple", id: `ambiguous-eof-${index}`, ts: 36, cwd: "/work", schemaV: 1,
      agent: "codex", origin: "agent-hook", intent: { text: vector.text },
      mechanism: { files: [], truncatedFiles: 0 },
    };
    assert.equal(redactText(vector.text, "/home/ada"), vector.sanitizedMcp, vector.name);
    assert.equal(projectTriple(triple, "sanitized").intent, vector.sanitizedMcp, vector.name);
    assert.equal(projectTriple(triple, "raw").intent, normalizeOutputText(vector.text), vector.name);
  }
});

test("triple props and tags preserve array boundaries, cardinality, and empty entries", () => {
  const triple: TripleRecord = {
    kind: "triple", id: "boundary-triple", ts: 33, cwd: "/work", schemaV: 1,
    agent: "codex", origin: "agent-hook",
    rationale: { text: "why", tags: ["one\ntwo", "", "three"], source: "notify" },
    mechanism: {
      files: [{ path: "src/file.ts", plusMinus: [1, 1], props: ["one\ntwo", "", "three"] }],
      truncatedFiles: 0,
    },
  };
  const output = projectTriple(triple, "sanitized");
  assert.deepEqual(output.rationale?.tags, ["one two", "", "three"]);
  assert.deepEqual(output.files[0]?.props, ["one two", "", "three"]);
  assert.equal(output.rationale?.tags.length, triple.rationale?.tags.length);
  assert.equal(output.files[0]?.props.length, triple.mechanism.files[0]?.props.length);
});

test("persisted IDs and link IDs stay opaque while fix arrays remain detached", () => {
  const opaque = "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890";
  const fix: FixRecord = {
    kind: "fix", id: opaque, ts: 34, cwd: "/work", cmd: "npm test",
    failureIds: [opaque, "", "second-id"],
    links: [{ id: opaque, basis: "signature" }],
  };
  const output = projectMemoryRecord(fix, "sanitized", true) as {
    id: string; failureIds: string[]; links: { id: string; basis: string }[];
  };
  assert.equal(output.id, "[redacted]");
  assert.deepEqual(output.failureIds, ["[redacted]", "[redacted]", "second-id"]);
  assert.deepEqual(output.links, [{ id: "[redacted]", basis: "signature" }]);
  const raw = projectMemoryRecord(fix, "raw") as {
    id: string; failureIds: string[]; links: { id: string; basis: string }[];
  };
  assert.equal(raw.id, opaque);
  assert.deepEqual(raw.failureIds, [opaque, "", "second-id"]);
  assert.deepEqual(raw.links, [{ id: opaque, basis: "signature" }]);
  assert.notEqual(output.failureIds, fix.failureIds);
  assert.notEqual(output.links, fix.links);
  assert.notEqual(output.links[0], fix.links?.[0]);
});

test("sanitized nested reserved and credential IDs never remain literal", () => {
  const ids = ["note-secret", "triple-api-key", "failure-password", "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"];
  const fix: FixRecord = {
    kind: "fix", id: ids[0]!, ts: 35, cwd: "/work", cmd: "npm test",
    failureIds: ids,
    links: ids.map((id) => ({ id, basis: "signature" as const })),
  };
  const sanitized = projectMemoryRecord(fix, "sanitized", true) as {
    id: string; failureIds: string[]; links: { id: string }[];
  };
  assert.equal(sanitized.id, "[redacted]");
  assert.deepEqual(sanitized.failureIds, ids.map(() => "[redacted]"));
  assert.deepEqual(sanitized.links.map((link) => link.id), ids.map(() => "[redacted]"));
  const raw = projectMemoryRecord(fix, "raw") as {
    id: string; failureIds: string[]; links: { id: string }[];
  };
  assert.equal(raw.id, ids[0]);
  assert.deepEqual(raw.failureIds, ids);
  assert.deepEqual(raw.links.map((link) => link.id), ids);
});
