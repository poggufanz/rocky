import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FINGERPRINT_ALGORITHM_VERSION,
  commandFingerprint,
  fillRawCommandTokens,
  fingerprint,
  fingerprintCandidates,
  fingerprintTokens,
  legacyFingerprint,
  normalizeLine,
  normalizeRetrievalLine,
  queryTokens,
  retrievalTokens,
  tokens,
} from "../core/fingerprint.js";

test("normalizeLine masks paths and numbers", () => {
  const line = "Error: cannot open /home/you/app/src/x.ts:41:7";
  const norm = normalizeLine(line);
  assert.ok(norm.includes("<path>"));
  assert.ok(!norm.includes("41"));
  assert.ok(norm.includes("error"));
});

test("commandFingerprint is stable across volatile parts", () => {
  const a = commandFingerprint("npm run build --cache /tmp/cache-1234", 1);
  const b = commandFingerprint("npm run build --cache /tmp/cache-9876", 1);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("commandFingerprint separates by exit code and command", () => {
  const base = commandFingerprint("npm run build", 1);
  assert.notEqual(base, commandFingerprint("npm run build", 2));
  assert.notEqual(base, commandFingerprint("npm run lint", 1));
});

test("empty or whitespace-only stderr falls back to the command fingerprint", () => {
  assert.equal(fingerprint("", "false", 1), commandFingerprint("false", 1));
  assert.equal(fingerprint("   \n\n  \n", "false", 1), commandFingerprint("false", 1));
});

test("empty-stderr failures of different commands no longer collide", () => {
  assert.notEqual(fingerprint("", "false", 1), fingerprint("", "npm run dev -- --force", 1));
  assert.notEqual(fingerprint("", "false", 1), "da39a3ee5e6b4b0d");
});

test("non-empty stderr fingerprint ignores cmd and exit code (unchanged behavior)", () => {
  assert.equal(fingerprint("Error: boom", "a", 1), fingerprint("Error: boom", "b", 2));
});

test("URL masking consumes the complete URL before path masking", () => {
  const line = normalizeLine("Error GET https://user:pass@[2001:db8::1]:8443/api/item?token=123&mode=full#frag");
  assert.equal(line, "error get <url>");
  assert.equal(line.includes("host"), false);
  assert.equal(line.includes("token"), false);
  assert.equal(line.includes("8443"), false);
});

test("URL masking keeps RFC3986 apostrophes inside URLs and surrounding quotes outside", () => {
  const line = normalizeLine("Error fetch 'https://user:o'connor@[2001:db8::1]:8443/O'Reilly?token=it's#frag'.");
  assert.equal(line, "error fetch '<url>'.");
});

test("URL masking keeps legal terminal punctuation inside the opaque URL", () => {
  for (const punctuation of ["?", "!", ";", "'"]) {
    assert.equal(
      normalizeLine(`Error fetch https://host/path${punctuation}`),
      "error fetch <url>",
      punctuation,
    );
  }
});

test("URL masking preserves nested surrounding wrappers outside one opaque URL", () => {
  assert.equal(normalizeLine("Error ('https://host/path')."), "error ('<url>').");
  assert.equal(normalizeLine("Error ([https://host/path])."), "error ([<url>]).");
  assert.equal(normalizeLine("Error ([\"https://host/path?x=1!\"])."), "error ([\"<url>\"]).");
  assert.equal(normalizeLine("Error ({'https://host/O'Reilly;'})."), "error ({'<url>'}).");
});

test("semantic HTTP status, explicit code, and port numbers survive fingerprint normalization", () => {
  assert.notEqual(fingerprint("Error: HTTP 404 from port 9200", "curl", 1), fingerprint("Error: HTTP 500 from port 9200", "curl", 1));
  assert.notEqual(fingerprint("Error: HTTP 404 code 1001 on port 9200", "curl", 1), fingerprint("Error: HTTP 404 code 1002 on port 9200", "curl", 1));
  assert.notEqual(fingerprint("Error: connect to host:9200", "curl", 1), fingerprint("Error: connect to host:5432", "curl", 1));
});

test("volatile line, pid, and timestamp numbers remain stable", () => {
  const a = "Error at /srv/app/index.ts:41:7 pid 1234 at 2026-08-14T10:11:12Z";
  const b = "Error at /srv/app/index.ts:99:2 pid 9876 at 2027-09-15T21:31:42Z";
  assert.equal(fingerprint(a, "node app", 1), fingerprint(b, "node app", 1));
  assert.equal(fingerprint("Error at file.ts:41:7", "node app", 1), fingerprint("Error at file.ts:99:2", "node app", 1));
});

test("volatile labelled numbers and Unicode decimal digits stay masked", () => {
  assert.equal(normalizeLine("Error pid:1234 worker:9876 index:41"), "error pid:# worker:# index:#");
  assert.equal(normalizeLine("Error worker:١٢٣٤"), "error worker:#");
  assert.equal(fingerprint("Error pid:1234", "node app", 1), fingerprint("Error pid:9876", "node app", 1));
  assert.equal(fingerprint("Error worker:١٢٣٤", "node app", 1), fingerprint("Error worker:٥٦٧٨", "node app", 1));
  assert.equal(fingerprint("Error timestamp:٢٠٢٦-٠٨-١٤T١٠:١١:١٢Z", "node app", 1), fingerprint("Error timestamp:٢٠٢٧-٠٩-١٥T٢١:٣١:٤٢Z", "node app", 1));
});

test("fallback request and job identifiers stay volatile instead of becoming ports", () => {
  const labels = ["request", "job", "request-id", "job-id", "trace-id", "span-id", "session-id"];
  for (const label of labels) {
    assert.equal(
      fingerprint(`Error ${label}:1234`, "node app", 1),
      fingerprint(`Error ${label}:9876`, "node app", 1),
      label,
    );
  }
  assert.notEqual(
    fingerprint("Error connect to service:9200", "node app", 1),
    fingerprint("Error connect to service:5432", "node app", 1),
  );
});

test("network context preserves single-label hostname ports", () => {
  for (const context of ["connect redis", "connect to redis", "connection refused redis"]) {
    assert.notEqual(normalizeLine(`Error ${context}:6379`), normalizeLine(`Error ${context}:5432`), context);
  }
  assert.notEqual(normalizeLine("Error service:9200"), normalizeLine("Error service:5432"));
});

test("identifier-shaped error codes keep semantic differences", () => {
  assert.notEqual(fingerprint("Error code: E123", "node app", 1), fingerprint("Error code: E456", "node app", 1));
});

test("UUID and SHA digests are masked only at safe boundaries", () => {
  const uuidA = "Error request 550e8400-e29b-41d4-a716-446655440000";
  const uuidB = "Error request 6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  assert.equal(fingerprint(uuidA, "api", 1), fingerprint(uuidB, "api", 1));

  const sha256A = "Error sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sha256B = "Error sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.equal(fingerprint(sha256A, "hash", 1), fingerprint(sha256B, "hash", 1));
  for (const [algorithm, length] of [["sha1", 40], ["sha256", 64], ["sha512", 128]] as const) {
    const first = `Error ${algorithm}:${"a".repeat(length)}`;
    const second = `Error ${algorithm}:${"b".repeat(length)}`;
    assert.equal(fingerprint(first, "hash", 1), fingerprint(second, "hash", 1), algorithm);
  }
  assert.notEqual(
    fingerprint(sha256A, "hash", 1),
    fingerprint("Error sha512:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hash", 1),
  );
  assert.notEqual(fingerprint("Error id tokenabc", "hash", 1), fingerprint("Error id tokendef", "hash", 1));
  assert.notEqual(
    fingerprint("Error id x550e8400-e29b-41d4-a716-446655440000", "hash", 1),
    fingerprint("Error id x6ba7b810-9dad-11d1-80b4-00c04fd430c8", "hash", 1),
  );
  assert.equal(
    normalizeLine("Error id x550e8400-e29b-41d4-a716-446655440000"),
    "error id x550e8400-e29b-41d4-a716-446655440000",
  );
});

test("retrieval tokenization is Unicode NFC and keeps separate fingerprint role", () => {
  const cyrillic = tokens("Ошибка файл не найден");
  const arabic = tokens("خطأ ملف مفقود");
  const accentedComposed = tokens("café");
  const accentedCombining = tokens("cafe\u0301");
  const greek = tokens("Σφάλμα αρχείο");
  const cjk = tokens("错误 文件");
  assert.ok(cyrillic.has("ошибка") && cyrillic.has("найден"));
  assert.ok(arabic.has("خطأ") && arabic.has("مفقود"));
  assert.deepEqual(accentedCombining, accentedComposed);
  assert.ok(greek.has("σφάλμα"));
  assert.ok(cjk.has("错误") && cjk.has("文件"));
  assert.ok(retrievalTokens("HTTP 404").has("404"));
  assert.ok(retrievalTokens("404").has("404"));
  assert.ok(queryTokens("9200").has("9200"));
  assert.ok(fingerprintTokens("Error 404").has("#"));
  assert.ok(retrievalTokens("Error 404").has("404"));
  assert.ok(retrievalTokens("line 41 pid 1234").has("#"));
  assert.equal(retrievalTokens("line 41 pid 1234").has("41"), false);
  const volatile = retrievalTokens("line 41 pid 1234 at 2026-08-14T10:11:12Z");
  assert.equal([...volatile].some((token) => /^(?:41|1234|2026|10|11|12)$/u.test(token)), false);
  const sourceLocation = retrievalTokens("file.ts:41:7");
  assert.ok(retrievalTokens("failed 2026-08-14").has("<time>"));
  assert.ok(retrievalTokens("hash deadbeef").has("<hex>"));
  assert.ok(retrievalTokens("address 0xdeadbeef").has("<hex>"));
  assert.equal([...sourceLocation].some((token) => /^(?:41|7)$/u.test(token)), false);
  const unicodeClock = retrievalTokens("time ١٢:٣٤");
  assert.equal([...unicodeClock].some((token) => /^(?:١٢|٣٤)$/u.test(token)), false);
  assert.ok(fingerprintTokens("line 41").has("#"));
  assert.ok(tokens("some-missing-package").has("some-missing-package"));
  assert.ok(tokens("some-missing-package").has("missing"));
});

test("fillRawCommandTokens keeps a path segment retrievalTokens would mask", () => {
  const cmd = "Get-Item ./another-missing-thing";
  // retrievalTokens alone still runs the command through the same
  // volatile-value masking the fingerprint uses (paths included), so the
  // distinctive path word is gone from that view.
  const masked = retrievalTokens(cmd);
  assert.equal(masked.has("another-missing-thing"), false);
  assert.ok(masked.has("<path>"));

  const target = new Set<string>();
  fillRawCommandTokens(cmd, target);
  assert.ok(target.has("another-missing-thing"));
  assert.ok(target.has("another") && target.has("missing") && target.has("thing"));
  assert.ok(target.has("get-item") && target.has("get") && target.has("item"));

  // Additive, not clearing: it must be safe to layer onto existing evidence.
  const existing = new Set(["<path>", "get-item"]);
  fillRawCommandTokens(cmd, existing);
  assert.ok(existing.has("<path>"));
  assert.ok(existing.has("another-missing-thing"));
});

test("retrieval fast path agrees with the full volatile-line corpus", () => {
  const corpus: Array<[string, string]> = [
    ["plain command words 404", "plain command words 404"],
    ["component-name_2.1", "component-name_2.1"],
    ["caf\u00e9 12", "caf\u00e9 12"],
    ["failed 2026-08-14", "failed <time>"],
    ["line-41", "line-41"],
    ["request-id-17", "request-id-17"],
    ["trace_42", "trace_42"],
    ["line 41", "line #"],
    ["request id 17", "request id #"],
    ["trace id 42", "trace id #"],
    ["hash deadbeef", "hash <hex>"],
    ["address 0xdeadbeef", "address <hex>"],
    ["uuid 550e8400-e29b-41d4-a716-446655440000", "uuid <hex>"],
    ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "sha256:<hex>"],
  ];
  for (const [line, expected] of corpus) assert.equal(normalizeRetrievalLine(line), expected, line);
  const safeCorpus = ["alpha beta", "node task-17", "error code 404", "unicode \u03a3\u03c6\u03ac\u03bb\u03bc\u03b1"];
  for (const line of safeCorpus) {
    const expected = line.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
    assert.equal(normalizeRetrievalLine(line), expected, line);
  }
});

test("volatile numeric labels stay masked across ASCII and Unicode decimal fuzz", () => {
  const contexts = ["pid", "worker", "index", "line", "timestamp"];
  const values = ["1234", "9876", "١٢٣٤", "٩٨٧٦", "१२३४", "९८७६"];
  for (const context of contexts) {
    const first = normalizeLine(`Error ${context}:${values[0]}`);
    for (const value of values.slice(1)) {
      assert.equal(normalizeLine(`Error ${context}:${value}`), first, `${context} ${value}`);
    }
    assert.equal(first.includes(values[0]!), false, context);
  }
});

test("deterministic mixed fingerprint fuzz stays bounded and version-shaped", () => {
  const unicodeDigits = ["١٢٣٤", "१२३४", "１２３４", "៤៥៦៧"];
  for (let index = 0; index < 5_000; index++) {
    const url = `https://user:o'connor@[2001:db8::${index % 64}]:${8000 + (index % 17)}/O'Reilly?q=${index}#it's`;
    const uuid = index.toString(16).padStart(8, "0").slice(-8);
    const digest = `${index}`.repeat(128).slice(0, 128).padEnd(128, "a");
    const stderr = `Error ${url} pid:${unicodeDigits[index % unicodeDigits.length]} ${uuid}-e29b-41d4-a716-446655440000 sha512:${digest} line:${index % 101}:7`;
    assert.match(fingerprint(stderr, `node task-${index % 19}.js`, 1), /^[0-9a-f]{16}$/u);
  }
});

test("fingerprint algorithm is versioned and exposes a backward lookup candidate", () => {
  assert.equal(FINGERPRINT_ALGORITHM_VERSION, 2);
  const candidates = fingerprintCandidates("Error: old path /tmp/x-123", "node app", 1);
  assert.equal(candidates[0], fingerprint("Error: old path /tmp/x-123", "node app", 1));
  assert.equal(candidates.includes(legacyFingerprint("Error: old path /tmp/x-123", "node app", 1)), true);
  assert.equal(candidates.length, 2);
});
