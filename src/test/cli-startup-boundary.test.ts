import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PACKAGE_VERSION } from "../core/package-info.js";

// Compiled tests run from <root>/test, next to the compiled entry they inspect.
const compiledRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(compiledRoot, "index.js");

// Everything `index.js` imports statically is loaded and evaluated before argv
// is read, so this closure is the startup cost of `rocky --version`, of every
// shell-hook spawn, and of every agent-hook call. Command modules load on
// dispatch through `await import()` inside their `case` instead.
const MAX_STARTUP_FILES = 12;
const ARGUMENT_PARSER = "commands/cli-args.js";
const MEMORY_READER = "core/memory-read.js";

type ImportedBy = ReadonlyMap<string, string | undefined>;

function moduleKey(path: string): string {
  return relative(compiledRoot, path).replaceAll("\\", "/");
}

/**
 * Specifiers of the static `import ... from`, `import "x"` and
 * `export ... from` statements of one compiled module. Compiled output has no
 * type-only imports, and an `import()` call loads lazily, so neither counts.
 */
function staticSpecifiers(path: string): string[] {
  const syntax = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const specifiers: string[] = [];
  for (const statement of syntax.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier !== undefined && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
  }
  return specifiers;
}

/** Every file `index.js` loads before it reads argv, each mapped to the module that first imported it. */
function startupClosure(): ImportedBy {
  assert.ok(existsSync(entry), `compiled entry is missing: ${entry}`);
  const importedBy = new Map<string, string | undefined>([[moduleKey(entry), undefined]]);
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.shift()!;
    for (const specifier of staticSpecifiers(path)) {
      if (!specifier.startsWith(".")) continue; // node: builtins; the package has no runtime dependencies
      const target = resolve(dirname(path), specifier);
      assert.ok(existsSync(target), `unresolved import ${specifier} from ${moduleKey(path)}`);
      const key = moduleKey(target);
      if (importedBy.has(key)) continue;
      importedBy.set(key, moduleKey(path));
      pending.push(target);
    }
  }
  assert.ok(importedBy.size > 1, "the startup walk found no static import; the walker is broken");
  return importedBy;
}

/** "index.js > ui/rocky.js > ui/phrases.js": how startup reaches a file. */
function importChain(importedBy: ImportedBy, key: string): string {
  const chain = [key];
  for (let parent = importedBy.get(key); parent !== undefined; parent = importedBy.get(parent)) chain.unshift(parent);
  return chain.join(" > ");
}

test("startup imports no command module except the argument parser", () => {
  const closure = startupClosure();
  const commandModules = [...closure.keys()]
    .filter((file) => file.startsWith("commands/") && file !== ARGUMENT_PARSER)
    .sort()
    .map((file) => importChain(closure, file));
  assert.deepEqual(commandModules, [], "startup statically imports command modules; load each with await import() inside its case");
});

test("startup never loads the memory reader", () => {
  const closure = startupClosure();
  assert.equal(
    closure.has(MEMORY_READER),
    false,
    `startup statically imports the memory reader: ${importChain(closure, MEMORY_READER)}`,
  );
});

test("startup stays within its file budget", () => {
  const files = [...startupClosure().keys()].sort();
  assert.ok(
    files.length <= MAX_STARTUP_FILES,
    `startup loads ${files.length} files, budget is ${MAX_STARTUP_FILES}: ${files.join(", ")}`,
  );
});

/**
 * A directory holding only the startup closure, as an installed package would
 * if nothing else were loadable. Node's own loader then proves the walk
 * complete: a missed edge fails here as a missing module.
 */
function installStartupClosure(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-startup-closure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of startupClosure().keys()) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(compiledRoot, file), join(root, file));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  return root;
}

function runInstalledEntry(root: string, args: readonly string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(root, "index.js"), ...args], {
    cwd: root,
    env: { ...process.env, ROCKY_HOME: join(root, "home") },
    input,
    encoding: "utf8",
  });
}

test("rocky --version runs from the startup closure alone", (t) => {
  const result = runInstalledEntry(installStartupClosure(t), ["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${PACKAGE_VERSION}\n`);
});

test("hook gate-event allows and exits 0 when the gate module cannot load", (t) => {
  const root = installStartupClosure(t);
  // Replace the gate module with one that throws while it loads.
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "gate.js"), 'throw new Error("gate cannot load");\n', "utf8");
  const result = runInstalledEntry(root, ["hook", "gate-event", "claude-code"], "{}");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
});
