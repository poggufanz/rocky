import { loadConfig } from "../src/config.js";

try {
  const cfg = loadConfig();
  if (cfg.port <= 0) {
    process.stderr.write("Error: port must be positive\n");
    process.exit(1);
  }
  process.stdout.write("eval-accept: config-override ok\n");
} catch (err) {
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exit(1);
}
