import { validate } from "../src/validate.js";

try {
  validate({ id: 1, name: "Ada", email: "ada@example.invalid" });
  process.stdout.write("ok\n");
} catch (err) {
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exit(1);
}
