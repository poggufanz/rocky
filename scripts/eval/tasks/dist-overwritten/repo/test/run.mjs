import { total } from "../dist/cart.js";

try {
  const sum = total([{ price: 10 }, { price: 15 }]);
  if (sum !== 25) {
    process.stderr.write(`AssertionError: expected 25, got ${sum}\n`);
    process.exit(1);
  }
  process.stdout.write("eval-accept: dist-overwritten ok\n");
} catch (err) {
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exit(1);
}
