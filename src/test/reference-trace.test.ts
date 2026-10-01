import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  traceReferences,
  isMeaningfulCommentLine,
  extractNearestComments,
} from "../core/reference-trace.js";

test("isMeaningfulCommentLine rejects delimiter-only comments and accepts real text", () => {
  assert.equal(isMeaningfulCommentLine("*/"), false);
  assert.equal(isMeaningfulCommentLine("/*"), false);
  assert.equal(isMeaningfulCommentLine(" * "), false);
  assert.equal(isMeaningfulCommentLine("//"), false);
  assert.equal(isMeaningfulCommentLine("#"), false);
  assert.equal(isMeaningfulCommentLine("<!--"), false);
  assert.equal(isMeaningfulCommentLine("-->"), false);
  assert.equal(isMeaningfulCommentLine("  * \t "), false);

  assert.equal(isMeaningfulCommentLine("// this is a real reason"), true);
  assert.equal(isMeaningfulCommentLine(" * handles user token retry"), true);
  assert.equal(isMeaningfulCommentLine("# check configuration"), true);
});

test("extractNearestComments ignores delimiter-only lines like */", () => {
  const lines = [
    "/*",
    " * Important invariant: lock before writing",
    " */",
    "function performWrite() {",
    "}",
  ];
  const comments = extractNearestComments(lines, 4);
  assert.deepEqual(comments, ["* Important invariant: lock before writing"]);
});

test("multi-hop reference trace traverses Selection -> B -> A across files", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-ref-trace-"));
  mkdirSync(join(root, "src"), { recursive: true });

  // File A (core implementation)
  const fileA = [
    "export function evaluatePolicy(user: string): boolean {",
    "  // Core rule check",
    "  return user.length > 0;",
    "}",
  ].join("\n");
  writeFileSync(join(root, "src", "policy.ts"), fileA);

  // File B (intermediary service calling A)
  const fileB = [
    'import { evaluatePolicy } from "./policy.js";',
    "export function processRequest(user: string): boolean {",
    "  return evaluatePolicy(user);",
    "}",
  ].join("\n");
  writeFileSync(join(root, "src", "service.ts"), fileB);

  // File C (handler calling B)
  const fileC = [
    'import { processRequest } from "./service.js";',
    "export function handleRequest(req: { user: string }) {",
    "  const valid = processRequest(req.user);",
    "  return valid;",
    "}",
  ].join("\n");
  writeFileSync(join(root, "src", "handler.ts"), fileC);

  const result = traceReferences({
    root,
    file: "src/handler.ts",
    startLine: 3,
    endLine: 3,
  });

  assert.equal(result.selection.file, "src/handler.ts");
  assert.ok(result.enclosing !== undefined);
  assert.equal(result.enclosing.name, "handleRequest");

  // Verify multi-hop nodes collected: service (intermediary) and policy (core-implementation)
  const serviceNode = result.nodes.find((n) => n.symbol === "processRequest");
  assert.ok(serviceNode !== undefined, "processRequest node should be found in service.ts");
  assert.equal(serviceNode.role, "intermediary");
  assert.equal(serviceNode.file, "src/service.ts");

  const policyNode = result.nodes.find((n) => n.symbol === "evaluatePolicy");
  assert.ok(policyNode !== undefined, "evaluatePolicy node should be found in policy.ts");
  assert.equal(policyNode.role, "core-implementation");
  assert.equal(policyNode.file, "src/policy.ts");

  // Verify reference chain
  assert.ok(result.referenceChain.length >= 2);
  assert.ok(result.referenceChain.some((c) => c.includes("handler.ts")));
  assert.ok(result.referenceChain.some((c) => c.includes("service.ts")));
  assert.ok(result.referenceChain.some((c) => c.includes("policy.ts")));

  // Verify evidence text includes both definitions
  assert.ok(result.evidenceText.includes("=== definition processRequest (src/service.ts"));
  assert.ok(result.evidenceText.includes("=== definition evaluatePolicy (src/policy.ts"));
});

test("reference cycles do not cause infinite recursion", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-ref-cycle-"));
  mkdirSync(join(root, "src"), { recursive: true });

  // A calls B
  const fileA = [
    'import { funcB } from "./b.js";',
    "export function funcA(n: number): number {",
    "  return funcB(n - 1);",
    "}",
  ].join("\n");
  writeFileSync(join(root, "src", "a.ts"), fileA);

  // B calls A
  const fileB = [
    'import { funcA } from "./a.js";',
    "export function funcB(n: number): number {",
    "  if (n <= 0) return 0;",
    "  return funcA(n - 1);",
    "}",
  ].join("\n");
  writeFileSync(join(root, "src", "b.ts"), fileB);

  const result = traceReferences({
    root,
    file: "src/a.ts",
    startLine: 3,
    endLine: 3,
    maxHops: 5,
  });

  assert.ok(result.nodes.length > 0);
  assert.ok(result.stopReasons.includes("cycle-detected") || result.nodes.length <= 4);
});

test("external library imports hit boundary and stop traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-ref-ext-"));
  const entry = [
    'import { debounce } from "lodash";',
    "export function run(fn: () => void) {",
    "  const debounced = debounce(fn, 100);",
    "  return debounced;",
    "}",
  ].join("\n");
  writeFileSync(join(root, "entry.ts"), entry);

  const result = traceReferences({
    root,
    file: "entry.ts",
    startLine: 3,
    endLine: 3,
  });

  const extNode = result.nodes.find((n) => n.kind === "boundary");
  assert.ok(extNode !== undefined);
  assert.equal(extNode.symbol, "debounce");
  assert.ok(result.stopReasons.includes("library-boundary"));
});

test("traceReferences respects commit revision when given", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-ref-git-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });

  // Commit 1: v1
  writeFileSync(join(root, "calc.ts"), "export function calc() { return 42; }\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "v1 calc"], { cwd: root, stdio: "ignore" });
  const commit1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  // Working tree: v2 (mutated)
  writeFileSync(join(root, "calc.ts"), "export function calc() { return 999; }\n");

  // Trace with commit1 specified
  const result = traceReferences({
    root,
    file: "calc.ts",
    startLine: 1,
    endLine: 1,
    commit: commit1,
  });

  assert.ok(result.selection.snippet.includes("42"), "should read commit 1 content, not working tree 999");
});

test("PHP PSR-4 multi-hop reference trace traverses Controller -> Service -> Model", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-php-ref-"));
  mkdirSync(join(root, "app", "Http", "Controllers"), { recursive: true });
  mkdirSync(join(root, "app", "Services"), { recursive: true });
  mkdirSync(join(root, "app", "Models"), { recursive: true });
  writeFileSync(join(root, "composer.json"), JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }));

  // Model
  writeFileSync(
    join(root, "app", "Models", "User.php"),
    ["<?php", "namespace App\\Models;", "class User {", "    public function find($id) {", "        return $id;", "    }", "}", ""].join("\n"),
  );

  // Service
  writeFileSync(
    join(root, "app", "Services", "UserService.php"),
    ["<?php", "namespace App\\Services;", "use App\\Models\\User;", "class UserService {", "    public function getUser($id) {", "        $u = new User();", "        return $u->find($id);", "    }", "}", ""].join("\n"),
  );

  // Controller
  writeFileSync(
    join(root, "app", "Http", "Controllers", "UserController.php"),
    ["<?php", "namespace App\\Http\\Controllers;", "use App\\Services\\UserService;", "class UserController {", "    public function show($id) {", "        $s = new UserService();", "        return $s->getUser($id);", "    }", "}", ""].join("\n"),
  );

  const result = traceReferences({
    root,
    file: "app/Http/Controllers/UserController.php",
    startLine: 7,
    endLine: 7,
  });

  assert.ok(result.nodes.some((n) => n.symbol === "UserService" || n.symbol === "getUser"));
  assert.ok(result.evidenceText.includes("app/Services/UserService.php"));
});

test("unresolved symbols are marked with unresolved stop reason and node", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-unresolved-"));
  writeFileSync(
    join(root, "script.ts"),
    "export function main() {\n  unknownFunctionCall(123);\n}\n",
  );

  const result = traceReferences({
    root,
    file: "script.ts",
    startLine: 2,
    endLine: 2,
  });

  const unresolvedNode = result.nodes.find((n) => n.kind === "unresolved");
  assert.ok(unresolvedNode !== undefined);
  assert.equal(unresolvedNode.symbol, "unknownFunctionCall");
  assert.ok(result.stopReasons.includes("unresolved-target"));
});

test("definition JSDoc extraction skips delimiter line */ and extracts meaningful comment", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-jsdoc-"));
  const text = [
    "/**",
    " * Invariant: validate user token before query",
    " */",
    "export function validateUser(token: string) {",
    "  return token.length > 0;",
    "}",
    "export function runAuth(token: string) {",
    "  return validateUser(token);",
    "}",
  ].join("\n");
  writeFileSync(join(root, "auth.ts"), text);

  const result = traceReferences({
    root,
    file: "auth.ts",
    startLine: 8,
    endLine: 8,
  });

  const node = result.nodes.find((n) => n.symbol === "validateUser");
  assert.ok(node !== undefined);
  assert.ok(node.jsdoc !== undefined);
  assert.ok(!node.jsdoc.includes("*/"));
  assert.ok(node.jsdoc.includes("validate user token before query"));
});

test("multi-hop tracing resolves import aliases and CommonJS destructuring", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-alias-"));
  mkdirSync(join(root, "src"), { recursive: true });

  writeFileSync(
    join(root, "src", "math.ts"),
    "export function calculateProduct(a: number, b: number) { return a * b; }\n",
  );

  writeFileSync(
    join(root, "src", "consumer.ts"),
    [
      'import { calculateProduct as multiply } from "./math.js";',
      "export function runMultiply() {",
      "  return multiply(3, 4);",
      "}",
    ].join("\n"),
  );

  const result = traceReferences({
    root,
    file: "src/consumer.ts",
    startLine: 3,
    endLine: 3,
  });

  const mathNode = result.nodes.find((n) => n.symbol === "multiply" || n.symbol === "calculateProduct");
  assert.ok(mathNode !== undefined, "should find calculateProduct definition even when imported as multiply");
  assert.equal(mathNode.file, "src/math.ts");
});

test("PHP same-directory classes resolve without explicit use statements", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-php-dir-"));
  mkdirSync(join(root, "src"), { recursive: true });

  writeFileSync(
    join(root, "src", "Helper.php"),
    ["<?php", "namespace App;", "class Helper {", "    public function format($s) { return trim($s); }", "}", ""].join("\n"),
  );

  writeFileSync(
    join(root, "src", "Service.php"),
    ["<?php", "namespace App;", "class Service {", "    public function run($s) {", "        $h = new Helper();", "        return $h->format($s);", "    }", "}", ""].join("\n"),
  );

  const result = traceReferences({
    root,
    file: "src/Service.php",
    startLine: 5,
    endLine: 5,
  });

  assert.ok(result.nodes.some((n) => n.symbol === "Helper" || n.symbol === "format"));
  assert.ok(result.evidenceText.includes("src/Helper.php"));
});

