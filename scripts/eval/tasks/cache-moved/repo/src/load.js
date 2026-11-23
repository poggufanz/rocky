import { existsSync, readFileSync } from "node:fs";

const CACHE_FILE = ".app-cache/rows.json";

export function loadRows() {
  if (existsSync(CACHE_FILE)) {
    const raw = readFileSync(CACHE_FILE, "utf8").trim();
    if (raw.length > 0) {
      const cached = JSON.parse(raw);
      if (Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    }
  }
  const lines = readFileSync("data/source.csv", "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(1).map((line) => {
    const [id, name] = line.split(",");
    return { id, name };
  });
}
