import { parse } from "../lib/parse.cjs";

const parts = parse("a,b");
if (parts.length !== 2 || parts[0] !== "a" || parts[1] !== "b") {
  process.stderr.write("AssertionError: unexpected parse result\n");
  process.exit(1);
}
process.stdout.write("eval-accept: cjs-named-export ok\n");
