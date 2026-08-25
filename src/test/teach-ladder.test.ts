import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  buildLadder,
  MAX_LADDER_HOPS,
  type LadderResult,
} from "../core/teach-ladder.js";
import { gitFirstTouch } from "../core/git-diff.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("catalog hop detects the async/await construct", () => {
  const fileText = [
    "async function syncAll(items) {",
    "  const done = [];",
    "  for (const item of items) {",
    "    done.push(await persist(item));",
    "  }",
    "  return done;",
    "}",
  ].join("\n");
  const result = buildLadder({ file: "src/sync.ts", startLine: 4, endLine: 4, fileText });
  const catalog = result.rungs.find((r) => r.source === "catalog");
  assert.ok(catalog, "catalog rung expected for await construct");
  assert.match(catalog.finding, /async because await used at line 4/);
});

test("ast hop finds the enclosing function", () => {
  const fileText = [
    "async function syncAll(items) {",
    "  const done = [];",
    "  for (const item of items) {",
    "    done.push(await persist(item));",
    "  }",
    "  return done;",
    "}",
  ].join("\n");
  const result = buildLadder({ file: "src/sync.ts", startLine: 4, endLine: 4, fileText });
  const ast = result.rungs.find((r) => r.source === "ast");
  assert.ok(ast, "ast rung expected inside syncAll");
  assert.match(ast.finding, /inside syncAll/);
});

test("def hop finds a callee definition with JSDoc in the same fileText", () => {
  const fileText = [
    "/** Adds two numbers together. */",
    "function sum(a, b) {",
    "  return a + b;",
    "}",
    "",
    "function render() {",
    "  const v = sum(1, 2);",
    "  return v;",
    "}",
  ].join("\n");
  const result = buildLadder({ file: "src/calc.ts", startLine: 7, endLine: 7, fileText });
  const def = result.rungs.find((r) => r.source === "def");
  assert.ok(def, "def rung expected for callee sum");
  assert.match(def.finding, /sum/);
  assert.match(def.finding, /line 2/);
  assert.match(def.finding, /Adds two numbers together/);
});

test("def hop resolves a callee through a relative import via readNeighbor", () => {
  const fileText = [
    'import { helper } from "./helper.js";',
    "",
    "export function run() {",
    "  const out = helper({ x: 1 });",
    "  return out;",
    "}",
  ].join("\n");
  const result = buildLadder({
    file: "src/run.ts",
    startLine: 4,
    endLine: 4,
    fileText,
    readNeighbor: (rel) => (rel === "src/helper.js" ? "export function helper(cfg) {\n  return cfg.x;\n}" : undefined),
  });
  const def = result.rungs.find((r) => r.source === "def");
  assert.ok(def, "def rung expected via readNeighbor");
  assert.match(def.finding, /src\/helper\.js/);
  assert.match(def.finding, /line 1/);
});

test("comment hop captures the nearest comment above the selection", () => {
  const fileText = [
    "function load() {",
    "  const a = 1;",
    "  // fetch once, keep hot",
    "  const b = await fetchAll();",
    "  return b;",
    "}",
  ].join("\n");
  const result = buildLadder({ file: "src/load.ts", startLine: 4, endLine: 4, fileText });
  const comment = result.rungs.find((r) => r.source === "comment");
  assert.ok(comment, "comment rung expected");
  assert.match(comment.finding, /fetch once, keep hot/);
});

test("git hop fires through the injected fake git", () => {
  const fileText = [
    "function save() {",
    "  const v = await writeRows();",
    "  return v;",
    "}",
  ].join("\n");
  const result = buildLadder({
    file: "src/save.ts",
    startLine: 2,
    endLine: 2,
    fileText,
    git: () => ({ commit: "abc", subject: "feat: add lock" }),
  });
  const gitRung = result.rungs.find((r) => r.source === "git");
  assert.ok(gitRung, "git rung expected from injected first-touch");
  assert.match(gitRung.finding, /feat: add lock/);
});

test("skipped rungs leave no gap in the hop order", () => {
  const fileText = [
    "function save() {",
    "  const v = await writeRows();",
    "  return v;",
    "}",
  ].join("\n");
  const result = buildLadder({
    file: "src/save.ts",
    startLine: 2,
    endLine: 2,
    fileText,
    git: () => ({ commit: "abc", subject: "feat: add lock" }),
  });
  assert.deepEqual(result.rungs.map((r) => r.source), ["catalog", "ast", "git"]);
});

test("rich selection stops at max-hops with a full ladder", () => {
  const fileText = [
    "/** Mints a fresh token. */",
    "function mintToken(owner) {",
    "  return `tok-${owner}`;",
    "}",
    "",
    "/** Builds the lock table. */",
    "async function buildLock(owner) {",
    "  // lock identity pairs path with stats",
    "  const token = await mintToken(owner);",
    "  return token;",
    "}",
  ].join("\n");
  const result = buildLadder({
    file: "src/max.ts",
    startLine: 9,
    endLine: 9,
    fileText,
    readNeighbor: (rel) =>
      rel === "src/test/max.test.ts" ? "it('mints')\n  expect(mintToken).toBeDefined();" : undefined,
  });
  assert.equal(result.stopReason, "max-hops");
  assert.equal(result.rungs.length, MAX_LADDER_HOPS);
  assert.deepEqual(
    result.rungs.map((r) => r.source),
    ["catalog", "ast", "def", "comment", "test"],
  );
  const testRung = result.rungs.find((r) => r.source === "test");
  assert.ok(testRung, "test rung expected naming the callee");
  assert.match(testRung.finding, /mintToken/);
});

test("bare snippet exhausts evidence with no fabricated rungs", () => {
  const result = buildLadder({ file: "src/a.ts", startLine: 1, endLine: 2, fileText: "const x = 1;\n" });
  assert.equal(result.rungs.length, 0);
  assert.equal(result.stopReason, "evidence-exhausted");
});

test("empty input yields empty rungs and evidence-exhausted", () => {
  const result = buildLadder({ file: "src/a.ts", startLine: 1, endLine: 1, fileText: "" });
  assert.deepEqual(result.rungs, []);
  assert.equal(result.stopReason, "evidence-exhausted");
});

test("a non-relative import that names the only callee stops at the library boundary", () => {
  const fileText = [
    'import { readFileSync } from "node:fs";',
    "",
    "export function load() {",
    '  const data = readFileSync("x");',
    "  return data;",
    "}",
  ].join("\n");
  const result: LadderResult = buildLadder({ file: "src/load.ts", startLine: 4, endLine: 4, fileText });
  assert.equal(result.stopReason, "library-boundary");
  assert.ok(result.rungs.some((r) => r.source === "ast"));
});

test("a callee that resolves to the enclosing function site stops the walk as a cycle", () => {
  const fileText = [
    "function factorial(n) {",
    "  if (n <= 1) return 1;",
    "  return n * factorial(n - 1);",
    "}",
  ].join("\n");
  const result = buildLadder({ file: "src/fact.ts", startLine: 3, endLine: 3, fileText });
  assert.equal(result.stopReason, "cycle");
});

test("gitFirstTouch resolves the first-touch commit shape or fails open", { skip: !hasGit() }, () => {
  const result = gitFirstTouch("src/core/fingerprint.ts", 1, 10, packageRoot);
  if (result !== undefined) {
    assert.equal(typeof result.commit, "string");
    assert.ok(result.commit.length > 0, "commit must be non-empty when present");
    assert.equal(typeof result.subject, "string");
    assert.ok(result.subject.length > 0, "subject must be non-empty when present");
  }
});
