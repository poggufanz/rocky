import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--fix")) {
  process.stderr.write("Error: unknown option '--fix'\n");
  process.exit(1);
}

let writeMode = false;
const files = [];
for (const arg of args) {
  if (arg === "--write") {
    writeMode = true;
  } else if (arg.startsWith("-")) {
    process.stderr.write(`Error: unknown option '${arg}'\n`);
    process.exit(1);
  } else {
    files.push(arg);
  }
}

if (!writeMode || files.length === 0) {
  process.stderr.write("Error: pass --write and a file path\n");
  process.exit(1);
}

for (const file of files) {
  const cleaned = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  writeFileSync(file, cleaned, "utf8");
}
