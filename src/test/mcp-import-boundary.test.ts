import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceRoot = join(repoRoot, "src");
const entry = join(sourceRoot, "commands", "mcp.ts");

function descendants(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) output.push(...descendants(path));
    else if (path.endsWith(".ts")) output.push(path);
  }
  return output;
}

function relativeImports(path: string): { specifier: string; statement: string }[] {
  const source = readFileSync(path, "utf8");
  const statements = source.match(/import[\s\S]*?from\s+["'][^"']+["'];|import\s+["'][^"']+["'];/g) ?? [];
  return statements.flatMap((statement) => {
    const specifier = /(?:from\s+|import\s*)["'](\.[^"']+)["']/.exec(statement)?.[1];
    return specifier === undefined ? [] : [{ specifier, statement }];
  });
}

function sourceTarget(importer: string, specifier: string): string {
  const resolved = resolve(dirname(importer), specifier);
  return resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
}

test("MCP source graph reaches only read-only query, config, privacy, AI-port, and transport modules", () => {
  assert.ok(existsSync(entry), "src/commands/mcp.ts must be the MCP process boundary");
  const roots = [entry, ...descendants(join(sourceRoot, "mcp"))];
  const allowed = new Set([
    "commands/mcp.ts",
    "core/config.ts",
    "core/fingerprint.ts",
    "core/memory-query.ts",
    "core/memory-read.ts",
    "core/package-identity.ts",
    "core/state-paths.ts",
    "ai/port.ts",
    "ai/client.ts",
    "mcp/privacy.ts",
    "mcp/protocol.ts",
    "mcp/server.ts",
    "mcp/stdio.ts",
    "mcp/tools.ts",
  ]);
  const reachable = new Set<string>();
  const pending = [...roots];

  while (pending.length > 0) {
    const path = pending.pop()!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    const localPath = relative(sourceRoot, path).replaceAll("\\", "/");
    assert.ok(allowed.has(localPath), `forbidden MCP dependency: ${localPath}`);
    assert.doesNotMatch(localPath, /(?:^|\/)(?:run|hook|setup|model)(?:[.-]|\.ts$)|^ui\//);

    for (const imported of relativeImports(path)) {
      assert.doesNotMatch(imported.statement, /\b(?:append\w*|record\w*|save\w*|write\w*|clearPendingIfResolved)\b/,
        `writer import reachable from ${localPath}`);
      const target = sourceTarget(path, imported.specifier);
      assert.ok(existsSync(target), `unresolved relative import ${imported.specifier} from ${localPath}`);
      pending.push(target);
    }
  }

  for (const forbidden of [
    "core/memory.ts",
    "commands/run.ts",
    "commands/hook.ts",
    "ui/rocky.ts",
  ]) {
    assert.equal([...reachable].some((path) => relative(sourceRoot, path).replaceAll("\\", "/") === forbidden), false);
  }
});
