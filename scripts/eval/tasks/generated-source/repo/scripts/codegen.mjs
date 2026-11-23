import { readFileSync, writeFileSync } from "node:fs";

const schema = JSON.parse(readFileSync("schema.json", "utf8"));
const content = [
  "// Generated from schema.json",
  `export const FIELDS = new Set(${JSON.stringify(schema.fields)});`,
  "",
].join("\n");
writeFileSync("src/schema.generated.js", content, "utf8");
