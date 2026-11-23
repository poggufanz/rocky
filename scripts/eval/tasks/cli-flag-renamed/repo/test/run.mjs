import { readFileSync } from "node:fs";

const text = readFileSync("src/sample.txt", "utf8");
if (text !== "hello\n") {
  process.stderr.write("AssertionError: sample.txt still has trailing spaces\n");
  process.exit(1);
}
process.stdout.write("eval-accept: cli-flag-renamed ok\n");
