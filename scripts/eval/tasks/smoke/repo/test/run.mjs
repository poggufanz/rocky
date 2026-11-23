import { runProbe } from "../src/probe.js";

try {
  const result = runProbe();
  if (result !== "ok") {
    process.stderr.write("Error: unexpected probe result\n");
    process.exit(1);
  }
  process.stdout.write("eval-accept: smoke ok\n");
} catch (err) {
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exit(1);
}
