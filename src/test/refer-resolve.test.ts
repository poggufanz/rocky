import test from "node:test";
import assert from "node:assert/strict";
import { resolveRefer, REFER_MAX, REFER_TEXT_CAP, type ReferHit } from "../core/refer-resolve.js";

const MAIN = ["import { add } from \"./math.js\";", "", "const x = add(1, 2);", "console.log(x);"].join("\n");
const MATH = ["export function add(a, b) {", "  return a + b;", "}"].join("\n");

test("definition resolves through a relative import with ranges", () => {
  const got = resolveRefer({
    path: "main.ts", fileText: MAIN, line: 3,
    readNeighbor: (rel: string) => (rel === "math.js" || rel === "math.ts" ? MATH : undefined),
  });
  assert.equal(got.symbol, "add");
  assert.equal(got.definition?.path, "math.js");
  assert.equal(got.definition?.line, 1);
  assert.deepEqual(got.definition?.selectionRange, {
    start: { line: 1, character: 16 }, end: { line: 1, character: 19 },
  });
  assert.deepEqual(got.definition?.range, {
    start: { line: 1, character: 0 }, end: { line: 1, character: 27 },
  });
  assert.equal(got.definition?.confidence, "heuristic");
  assert.equal(got.definition?.text, "export function add(a, b) {");
});

test("references merge witnessed memory hits first, then heuristic scan, capped", () => {
  const texts = new Map([["a.ts", "add(1);\nadding(2);\nadd(3);"]]);
  const got = resolveRefer({
    path: "main.ts", fileText: MAIN, line: 3, texts,
    witnesses: [{ path: "mem.ts", line: 9, text: "add wrapper" }],
  });
  assert.equal(got.references[0]?.confidence, "witnessed");
  assert.ok(got.references.length <= REFER_MAX);
  assert.ok(got.references.every((r: ReferHit) => !r.text.includes("adding")));
});

test("unknown symbol returns null definition and no guesses", () => {
  const got = resolveRefer({ path: "m.ts", fileText: "foo();", line: 1 });
  assert.equal(got.symbol, "foo");
  assert.equal(got.definition, null);
  assert.deepEqual(got.references, []);
});

test("in-file definition resolves with jsdoc, range, and selectionRange", () => {
  const code = [
    "// Adds two numbers together",
    "export function add(a, b) {",
    "  return a + b;",
    "}",
    "",
    "const result = add(2, 3);",
  ].join("\n");

  const got = resolveRefer({
    path: "calc.ts",
    fileText: code,
    line: 6,
  });

  assert.equal(got.symbol, "add");
  assert.notEqual(got.definition, null);
  assert.equal(got.definition?.path, "calc.ts");
  assert.equal(got.definition?.line, 2);
  assert.equal(got.definition?.jsdoc, "// Adds two numbers together");
  assert.deepEqual(got.definition?.selectionRange, {
    start: { line: 2, character: 16 },
    end: { line: 2, character: 19 },
  });
  assert.deepEqual(got.definition?.range, {
    start: { line: 2, character: 0 },
    end: { line: 2, character: 27 },
  });
  assert.equal(got.definition?.confidence, "heuristic");
});

test("definition location is skipped in references", () => {
  const code = [
    "function helper() { return 1; }",
    "helper();",
  ].join("\n");

  const texts = new Map([["calc.ts", code]]);
  const got = resolveRefer({
    path: "calc.ts",
    fileText: code,
    line: 2,
    texts,
  });

  assert.equal(got.symbol, "helper");
  assert.equal(got.definition?.path, "calc.ts");
  assert.equal(got.definition?.line, 1);
  // Reference should only contain line 2, not definition at line 1
  assert.equal(got.references.length, 1);
  assert.equal(got.references[0]?.line, 2);
  assert.equal(got.references[0]?.path, "calc.ts");
});

test("references deduplicate by path:line and respect REFER_MAX", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) {
    lines.push(`run(${i});`);
  }
  const texts = new Map([["big.ts", lines.join("\n")]]);
  const witnesses = [
    { path: "big.ts", line: 1, text: "run(1); // witness duplicate" },
    { path: "mem.ts", line: 10, text: "run(99);" },
  ];

  const got = resolveRefer({
    path: "caller.ts",
    fileText: "run(0);",
    line: 1,
    texts,
    witnesses,
  });

  assert.equal(got.symbol, "run");
  assert.equal(got.references.length, REFER_MAX);
  // First reference is witness for mem.ts:10
  assert.equal(got.references[0]?.path, "big.ts");
  assert.equal(got.references[0]?.confidence, "witnessed");
  assert.equal(got.references[1]?.path, "mem.ts");
  assert.equal(got.references[1]?.confidence, "witnessed");
  // big.ts:1 was already seen from witness, so text hit at big.ts:1 is skipped
  const bigLine1Hits = got.references.filter((r: ReferHit) => r.path === "big.ts" && r.line === 1);
  assert.equal(bigLine1Hits.length, 1);
});

test("word boundary matching ensures exact symbol match", () => {
  const texts = new Map([
    ["sample.ts", [
      "const add = 1;",
      "const adding = 2;",
      "const ladder = 3;",
      "add(4);",
    ].join("\n")],
  ]);

  const got = resolveRefer({
    path: "caller.ts",
    fileText: "",
    line: 1,
    symbol: "add",
    texts,
  });

  assert.equal(got.symbol, "add");
  assert.equal(got.references.length, 2);
  assert.equal(got.references[0]?.line, 1);
  assert.equal(got.references[1]?.line, 4);
});

test("explicit symbol param trims and overrides callee at line", () => {
  const got = resolveRefer({
    path: "caller.ts",
    fileText: "const a = foo();",
    line: 1,
    symbol: "  bar  ",
  });
  assert.equal(got.symbol, "bar");
});

test("empty symbol and no callee on line returns empty result", () => {
  const got = resolveRefer({
    path: "empty.ts",
    fileText: "const x = 1 + 2;",
    line: 1,
  });
  assert.deepEqual(got, { symbol: "", definition: null, references: [] });
});

test("candidate extension resolution falls back to .ts when import specifies .js", () => {
  const code = 'import { sub } from "./sub.js";\nsub(3, 1);';
  const subTs = "export function sub(a, b) { return a - b; }";

  const got = resolveRefer({
    path: "src/main.ts",
    fileText: code,
    line: 2,
    readNeighbor: (rel: string) => {
      // Disk only has sub.ts, not sub.js
      if (rel === "src/sub.ts") return subTs;
      return undefined;
    },
  });

  assert.equal(got.symbol, "sub");
  assert.equal(got.definition?.path, "src/sub.ts");
  assert.equal(got.definition?.line, 1);
});

test("text trimming and REFER_TEXT_CAP slicing works", () => {
  const longLine = "  add(" + "x".repeat(200) + ");  ";
  const texts = new Map([["long.ts", longLine]]);

  const got = resolveRefer({
    path: "caller.ts",
    fileText: "",
    line: 1,
    symbol: "add",
    texts,
  });

  assert.equal(got.references.length, 1);
  assert.equal(got.references[0]?.text.length, REFER_TEXT_CAP);
  assert.ok(got.references[0]?.text.startsWith("add("));
});
