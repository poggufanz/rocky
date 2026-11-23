import { readFileSync } from "node:fs";

const count = readFileSync("out/count.txt", "utf8").trim();
if (count !== "3") {
  process.stderr.write(`AssertionError: expected count 3, got ${count}\n`);
  process.exit(1);
}
process.stdout.write("eval-accept: script-moved ok\n");
