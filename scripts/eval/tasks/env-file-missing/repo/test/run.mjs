import { createClient } from "../src/client.js";

try {
  const client = createClient();
  if (!client.ready) {
    process.stderr.write("Error: client not ready\n");
    process.exit(1);
  }
  process.stdout.write("ok\n");
} catch (err) {
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exit(1);
}
