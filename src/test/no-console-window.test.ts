import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXED_SOURCES = ["src/core/exec.ts", "src/commands/hook.ts", "src/listening/consent.ts"];
const SPAWN_CALL = /\b(?:spawnSync|execFileSync|spawn|execFile)\(/g;
const HIDDEN_WINDOW = /windowsHide: true/g;
const CONSOLE_KEPT = "// console kept: runs the user's own command";

function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return typeScriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("no console window from setup paths", () => {
  // ponytail: count match, not a parser; a miss here means a console window when the daemon runs Node.
  const setupSources = typeScriptFiles(join(packageRoot, "src", "setup"));
  assert.ok(setupSources.length > 0, "no setup sources found");
  const sources = [...FIXED_SOURCES.map((file) => join(packageRoot, file)), ...setupSources];
  for (const source of sources) {
    const text = readFileSync(source, "utf8");
    const spawnCalls = text.match(SPAWN_CALL)?.length ?? 0;
    const allowances = (text.match(HIDDEN_WINDOW)?.length ?? 0) + text.split(CONSOLE_KEPT).length - 1;
    assert.ok(
      spawnCalls <= allowances,
      `${relative(packageRoot, source)}: ${spawnCalls} spawn calls, ${allowances} allowances`,
    );
  }
});
