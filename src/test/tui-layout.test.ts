import { test } from "node:test";
import assert from "node:assert/strict";
import { solveAxis } from "../ui/tui/core/layout.js";

test("grow distributes free space proportionally", () => {
  assert.deepEqual(solveAxis(30, [{ basis: 0, grow: 1 }, { basis: 0, grow: 2 }]), [10, 20]);
});

test("shrink removes deficit weighted by shrink×basis", () => {
  const [a, b] = solveAxis(20, [{ basis: 20, shrink: 1 }, { basis: 20, shrink: 1 }]);
  assert.equal(a + b, 20);
  assert.equal(a, b);
});

test("min/max clamp and redistribute", () => {
  const r = solveAxis(30, [{ basis: 0, grow: 1, max: 5 }, { basis: 0, grow: 1 }]);
  assert.deepEqual(r, [5, 25]);
  const r2 = solveAxis(10, [{ basis: 10, shrink: 1, min: 8 }, { basis: 10, shrink: 1 }]);
  assert.equal(r2[0], 8);
  assert.equal(r2[0] + r2[1], 10);
});

test("gap is reserved before distribution", () => {
  const r = solveAxis(20, [{ basis: 0, grow: 1 }, { basis: 0, grow: 1 }], 2);
  assert.deepEqual(r, [9, 9]);
});

test("largest-remainder: sizes sum exactly to inner for every width and count", () => {
  for (let inner = 20; inner <= 200; inner++) {
    for (let n = 1; n <= 6; n++) {
      const items = Array.from({ length: n }, (_, i) => ({ basis: 0, grow: i + 1 }));
      const sizes = solveAxis(inner, items);
      assert.equal(sizes.reduce((a, b) => a + b, 0), inner, `inner=${inner} n=${n}`);
      for (const s of sizes) assert.ok(Number.isInteger(s) && s >= 0);
    }
  }
});

test("no grow and no shrink leaves overflow to the caller", () => {
  assert.deepEqual(solveAxis(10, [{ basis: 8 }, { basis: 8 }]), [8, 8]);
});

test("empty items array returns empty array", () => {
  assert.deepEqual(solveAxis(30, []), []);
});

test("single item with gap ignores gap", () => {
  assert.deepEqual(solveAxis(25, [{ basis: 0, grow: 1 }], 10), [25]);
});
