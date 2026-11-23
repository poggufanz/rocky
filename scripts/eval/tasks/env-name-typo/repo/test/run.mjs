import { connect } from "../src/db.js";

try {
  const conn = connect();
  if (!conn.url.startsWith("postgres://")) {
    process.stderr.write("Error: unexpected database url\n");
    process.exit(1);
  }
  process.stdout.write("eval-accept: env-name-typo ok\n");
} catch (err) {
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exit(1);
}
