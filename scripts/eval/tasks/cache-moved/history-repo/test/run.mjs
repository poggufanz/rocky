import { loadRows } from "../src/load.js";

const rows = loadRows();
if (rows.length !== 3) {
  process.stderr.write(`AssertionError: expected 3 rows, got ${rows.length}\n`);
  process.exit(1);
}
process.stdout.write("eval-accept: cache-moved ok\n");
