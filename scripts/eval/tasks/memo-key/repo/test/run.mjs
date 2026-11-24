import assert from "node:assert/strict";
import { totalRectArea } from "../src/area.js";
import { cases } from "./cases.mjs";

try {
  for (let idx = 0; idx < cases.length; idx += 1) {
    const entry = cases[idx];
    const caseNum = idx + 1;
    const onResult = (actual) => {
      if (actual !== entry.expected) {
        const err = new assert.AssertionError({
          message: `case ${caseNum}: expected ${entry.expected} got ${actual}`,
        });
        Error.captureStackTrace(err, onResult);
        throw err;
      }
    };
    const got = totalRectArea(entry.input, onResult);
    if (got !== entry.expected) {
      throw new assert.AssertionError({
        message: `case ${caseNum}: expected ${entry.expected} got ${got}`,
      });
    }
  }
  process.stdout.write("eval-accept: memo-key ok\n");
} catch (err) {
  if (err instanceof assert.AssertionError) {
    const frames = String(err.stack ?? "")
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim().startsWith("at "));
    process.stderr.write(`AssertionError: ${err.message}\n${frames.join("\n")}\n`);
    process.exit(1);
  }
  throw err;
}
