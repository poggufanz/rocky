import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDashRows, searchRows } from "../ui/tui/data.js";
import { initialState, update, visibleRows, type DashRow } from "../ui/tui/state.js";

describe("tui data", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rocky-tui-data-test-"));

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("failure and fix records map to badged rows, sorted newest first", () => {
    const memPath = join(tempDir, "records-order.jsonl");
    const failureRecord = {
      kind: "failure",
      id: "fail-1",
      ts: 1000,
      cwd: "/app",
      cmd: "npm test",
      exitCode: 1,
      fingerprint: "fp1",
      signature: ["Error: test failed"],
      excerpt: "Error: test failed",
    };
    const guardRecord = {
      v: 1,
      kind: "invariant_touch",
      id: "guard-1",
      ts: 2000,
      cwd: "/app",
      invariant: "no-secrets",
      path: "src/auth.ts",
    };
    const fixRecord = {
      kind: "fix",
      id: "fix-1",
      ts: 3000,
      cwd: "/app",
      cmd: "npm test",
      failureIds: ["fail-1"],
    };
    const tripleRecord = {
      schemaV: 1,
      origin: "agent-hook",
      agent: "claude-code",
      kind: "triple",
      id: "triple-1",
      ts: 4000,
      cwd: "/app",
      mechanism: {
        files: [],
        truncatedFiles: 0,
      },
    };

    writeFileSync(
      memPath,
      [
        JSON.stringify(failureRecord),
        JSON.stringify(guardRecord),
        JSON.stringify(fixRecord),
        JSON.stringify(tripleRecord),
      ].join("\n") + "\n",
      "utf8",
    );

    const { rows, coverageLine } = loadDashRows(memPath, 5000);

    assert.equal(coverageLine, "coverage full");
    assert.equal(rows.length, 4);

    // Sorted newest first (descending timestamp)
    assert.equal(rows[0]?.ts, 4000);
    assert.equal(rows[0]?.kind, "triple");
    assert.equal(rows[0]?.badge, "why");
    assert.equal(rows[0]?.id, "triple:triple-1");

    assert.equal(rows[1]?.ts, 3000);
    assert.equal(rows[1]?.kind, "fix");
    assert.equal(rows[1]?.badge, "fix");
    assert.equal(rows[1]?.id, "fix:fix-1");
    assert.equal(rows[1]?.label, "npm test");

    assert.equal(rows[2]?.ts, 2000);
    assert.equal(rows[2]?.kind, "invariant_touch");
    assert.equal(rows[2]?.badge, "guard");
    assert.equal(rows[2]?.id, "invariant_touch:guard-1");

    assert.equal(rows[3]?.ts, 1000);
    assert.equal(rows[3]?.kind, "failure");
    assert.equal(rows[3]?.badge, "fail");
    assert.equal(rows[3]?.id, "failure:fail-1");
    assert.equal(rows[3]?.label, "npm test");
  });

  test("secrets in command labels and json are redacted at load boundary", () => {
    const memPath = join(tempDir, "secrets.jsonl");
    const secretKey = "AKIAIOSFODNN7EXAMPLE";
    const secretCmd = `deploy --key=${secretKey} --stage=prod`;
    const record = {
      kind: "failure",
      id: "sec-1",
      ts: 1000,
      cwd: "/app",
      cmd: secretCmd,
      exitCode: 1,
      fingerprint: "fp-sec",
      signature: ["Deploy failed"],
      excerpt: "Deploy failed",
    };

    writeFileSync(memPath, JSON.stringify(record) + "\n", "utf8");

    const { rows } = loadDashRows(memPath, 2000);
    assert.equal(rows.length, 1);

    const row = rows[0]!;
    assert.ok(!row.label.includes(secretKey), "label must not contain secret key");
    assert.ok(row.label.includes("[redacted aws access key]"), "label must contain redaction notice");
    assert.ok(!row.json.includes(secretKey), "json must not contain secret key");
    assert.ok(row.json.includes("[redacted aws access key]"), "json must contain redaction notice");
  });

  test("missing memory file yields zero rows and honest coverage line", () => {
    const nonExistent = join(tempDir, "does-not-exist.jsonl");
    const { rows, coverageLine } = loadDashRows(nonExistent, 1000);
    assert.deepEqual(rows, []);
    assert.equal(coverageLine, "coverage full");
  });

  test("searchRows ranks token overlap and drops zero-score rows; empty query returns all rows", () => {
    const rows: DashRow[] = [
      {
        id: "r1",
        badge: "fail",
        label: "compile typescript error in parser module",
        ts: 3000,
        kind: "failure",
        json: "{}",
      },
      {
        id: "r2",
        badge: "fail",
        label: "syntax error in tokenizer",
        ts: 2000,
        kind: "failure",
        json: "{}",
      },
      {
        id: "r3",
        badge: "fix",
        label: "unrelated test run passed cleanly",
        ts: 1000,
        kind: "fix",
        json: "{}",
      },
    ];

    // Empty query returns all rows in original order
    const emptyResult = searchRows(rows, "");
    assert.equal(emptyResult, rows);
    assert.equal(emptyResult.length, 3);

    // Matching query ranks by token overlap similarity and drops zero-score rows
    const searchResult = searchRows(rows, "typescript parser error");
    assert.equal(searchResult.length, 2);
    assert.equal(searchResult[0]?.id, "r1");
    assert.equal(searchResult[1]?.id, "r2");

    // Unmatched query returns empty array
    const noMatchResult = searchRows(rows, "completely unmatched words xyz");
    assert.deepEqual(noMatchResult, []);
  });

  test("visibleRows in state.ts filters by kind and searches via searchRows", () => {
    const rows: DashRow[] = [
      {
        id: "r1",
        badge: "fail",
        label: "compile typescript error in parser",
        ts: 3000,
        kind: "failure",
        json: "{}",
      },
      {
        id: "r2",
        badge: "fix",
        label: "fixed typescript parser issue",
        ts: 2000,
        kind: "fix",
        json: "{}",
      },
      {
        id: "r3",
        badge: "why",
        label: "session info brief",
        ts: 1000,
        kind: "brief_run",
        json: "{}",
      },
    ];

    let state = initialState(100, 30);
    state = update(state, { type: "data", rows, coverageLine: "coverage full" });

    // Initial: filter 'all', no search query -> all 3 rows
    assert.equal(visibleRows(state).length, 3);

    // Search query applied
    state = { ...state, search: { active: false, query: "typescript parser" } };
    const searchVis = visibleRows(state);
    assert.equal(searchVis.length, 2);
    assert.equal(searchVis[0]?.id, "r1");
    assert.equal(searchVis[1]?.id, "r2");

    // Filter applied in combination with search
    state = { ...state, filter: "failures" }; // failures filter matches 'failure' and 'fix'
    const failSearch = visibleRows(state);
    assert.equal(failSearch.length, 2);

    state = { ...state, filter: "sessions" }; // sessions filter matches 'brief_run'
    const sessionSearch = visibleRows(state);
    assert.equal(sessionSearch.length, 0); // brief_run does not match 'typescript parser'
  });
});
