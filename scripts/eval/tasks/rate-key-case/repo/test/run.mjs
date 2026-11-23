import { totalWithTax } from "../src/price.js";

const got = totalWithTax(100, "us");
if (got !== 110) {
  process.stderr.write(`AssertionError: expected total 110, got ${got}\n`);
  process.exit(1);
}
const upper = totalWithTax(100, "US");
if (upper !== 110) {
  process.stderr.write(`AssertionError: expected total 110, got ${upper}\n`);
  process.exit(1);
}
process.stdout.write("eval-accept: rate-key-case ok\n");
