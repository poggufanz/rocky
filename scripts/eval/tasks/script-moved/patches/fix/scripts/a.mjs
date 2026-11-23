import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const inputPath = "data/items.json";
if (!existsSync(inputPath)) {
  process.stderr.write("Error: missing input file\n");
  process.exit(1);
}
const items = JSON.parse(readFileSync(inputPath, "utf8"));
mkdirSync("out", { recursive: true });
writeFileSync("out/count.txt", `${items.length}\n`, "utf8");
