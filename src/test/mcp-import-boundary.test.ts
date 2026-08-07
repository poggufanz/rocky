import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceRoot = join(repoRoot, "src");
const entry = join(sourceRoot, "commands", "mcp.ts");
const boundaryFixtures = join(repoRoot, "test", "fixtures", "mcp", "import-boundary");

function descendants(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) output.push(...descendants(path));
    else if (path.endsWith(".ts")) output.push(path);
  }
  return output;
}

interface SourceImport {
  specifier: string;
  statement: string;
  importedNames: readonly string[];
}

function namedBindings(bindings: ts.NamedImportBindings | undefined): string[] {
  if (bindings === undefined) return [];
  if (ts.isNamespaceImport(bindings)) return ["*"];
  return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
}

function sourceImports(path: string): SourceImport[] {
  const source = readFileSync(path, "utf8");
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: SourceImport[] = [];
  const add = (specifier: string, node: ts.Node, importedNames: readonly string[]): void => {
    imports.push({ specifier, statement: node.getText(syntax), importedNames });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      add(node.moduleSpecifier.text, node, [
        ...(clause?.name === undefined ? [] : ["default"]),
        ...namedBindings(clause?.namedBindings),
      ]);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)
        ? ["*"]
        : node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text);
      add(node.moduleSpecifier.text, node, names);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        add(argument.text, node, ["*"]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return imports;
}

function sourceTarget(importer: string, specifier: string): string {
  const resolved = resolve(dirname(importer), specifier);
  return resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
}

const FILESYSTEM_MUTATIONS = new Set([
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync",
  "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod", "fchmodSync",
  "fchown", "fchownSync", "fdatasync", "fdatasyncSync", "fsync", "fsyncSync", "ftruncate",
  "ftruncateSync", "futimes", "futimesSync", "link", "linkSync", "lchmod", "lchmodSync",
  "lchown", "lchownSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync", "mkdtemp",
  "mkdtempSync", "open", "openSync", "promises", "rename", "renameSync", "rm", "rmSync", "rmdir",
  "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync",
  "utimes", "utimesSync", "write", "writeFile", "writeFileSync", "writeSync", "writev", "writevSync",
]);

function assertReadOnlyImport(imported: SourceImport, localPath: string): void {
  if (["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(imported.specifier)) {
    const mutation = imported.importedNames.find((name) =>
      name === "*" || name === "default" || FILESYSTEM_MUTATIONS.has(name));
    assert.equal(mutation, undefined,
      `filesystem mutation import reachable from ${localPath}: ${mutation ?? "unknown"}`);
    return;
  }
  const writer = imported.importedNames.find((name) =>
    /^(?:append\w*|record\w*|save\w*|write\w*|clearPendingIfResolved)$/.test(name));
  assert.equal(writer, undefined, `writer import reachable from ${localPath}: ${writer ?? "unknown"}`);
}

function assertReadOnlyGraph(roots: readonly string[], graphSourceRoot: string, allowed: ReadonlySet<string>): void {
  const reachable = new Set<string>();
  const pending = [...roots];

  while (pending.length > 0) {
    const path = pending.pop()!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    const localPath = relative(graphSourceRoot, path).replaceAll("\\", "/");
    assert.ok(allowed.has(localPath), `forbidden MCP dependency: ${localPath}`);
    assert.doesNotMatch(localPath, /(?:^|\/)(?:run|hook|setup|model)(?:[.-]|\.ts$)|^ui\//);

    for (const imported of sourceImports(path)) {
      assertReadOnlyImport(imported, localPath);
      if (!imported.specifier.startsWith(".")) continue;
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
    assert.equal([...reachable].some((path) => relative(graphSourceRoot, path).replaceAll("\\", "/") === forbidden), false);
  }
}

test("MCP source graph reaches only read-only query, config, privacy, AI-port, and transport modules", () => {
  assert.ok(existsSync(entry), "src/commands/mcp.ts must be the MCP process boundary");
  const roots = [entry, ...descendants(join(sourceRoot, "mcp"))];
  const allowed = new Set([
    "commands/mcp.ts",
    "core/config-read.ts",
    "core/fingerprint.ts",
    "core/memory-query.ts",
    "core/memory-read.ts",
    "core/package-info.ts",
    "core/state-paths.ts",
    "ai/ollama.ts",
    "ai/port.ts",
    "ai/recall-ai.ts",
    "ai/schema.ts",
    "mcp/privacy.ts",
    "mcp/protocol.ts",
    "mcp/server.ts",
    "mcp/stdio.ts",
    "mcp/tools.ts",
  ]);
  assertReadOnlyGraph(roots, sourceRoot, allowed);
});

test("MCP graph rejects a forbidden module reached through export-from", () => {
  assert.throws(
    () => assertReadOnlyGraph(
      [join(boundaryFixtures, "export-entry.ts")],
      boundaryFixtures,
      new Set(["export-entry.ts"]),
    ),
    /forbidden MCP dependency: export-forbidden\.ts/,
  );
});

test("MCP graph rejects a forbidden module reached through literal dynamic import", () => {
  assert.throws(
    () => assertReadOnlyGraph(
      [join(boundaryFixtures, "dynamic-entry.ts")],
      boundaryFixtures,
      new Set(["dynamic-entry.ts"]),
    ),
    /forbidden MCP dependency: dynamic-forbidden\.ts/,
  );
});

test("MCP graph rejects direct node:fs mutation imports", () => {
  assert.throws(
    () => assertReadOnlyGraph(
      [join(boundaryFixtures, "write-entry.ts")],
      boundaryFixtures,
      new Set(["write-entry.ts"]),
    ),
    /filesystem mutation import reachable from write-entry\.ts: writeFileSync/,
  );
});

for (const fixture of [
  { file: "fs-promises-entry.ts", capability: "promises" },
  { file: "fs-writev-entry.ts", capability: "writev" },
  { file: "fs-writev-sync-entry.ts", capability: "writevSync" },
  { file: "fs-default-entry.ts", capability: "default" },
  { file: "fs-namespace-entry.ts", capability: "*" },
  { file: "fs-dynamic-entry.ts", capability: "*" },
  { file: "fs-promises-dynamic-entry.ts", capability: "*" },
] as const) {
  test(`MCP graph rejects broad or writable filesystem capability from ${fixture.file}`, () => {
    assert.throws(
      () => assertReadOnlyGraph(
        [join(boundaryFixtures, fixture.file)],
        boundaryFixtures,
        new Set([fixture.file]),
      ),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.message.split("\n", 1)[0],
          `filesystem mutation import reachable from ${fixture.file}: ${fixture.capability}`);
        return true;
      },
    );
  });
}

test("MCP graph allows explicitly named read-only node:fs functions", () => {
  assert.doesNotThrow(() => assertReadOnlyGraph(
    [join(boundaryFixtures, "fs-read-entry.ts")],
    boundaryFixtures,
    new Set(["fs-read-entry.ts"]),
  ));
});
