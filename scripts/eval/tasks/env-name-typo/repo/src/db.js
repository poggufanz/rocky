import { readFileSync } from "node:fs";

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function connect() {
  const env = parseEnv(readFileSync("config.env", "utf8"));
  const url = env.DATABSE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return { url };
}
