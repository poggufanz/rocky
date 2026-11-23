import { ready } from "../src/check.js";

if (!ready()) {
  process.stderr.write("Error: check returned false\n");
  process.exit(1);
}
process.stdout.write("ok\n");
