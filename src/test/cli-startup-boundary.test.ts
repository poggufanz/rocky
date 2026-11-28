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

/** Every file `entryPath` loads statically, each mapped to the module that first imported it. */
function staticClosure(entryPath: string): ImportedBy {
  assert.ok(existsSync(entryPath), `compiled module is missing: ${entryPath}`);
  const importedBy = new Map<string, string | undefined>([[moduleKey(entryPath), undefined]]);
  const pending = [entryPath];
  while (pending.length > 0) {
    const path = pending.shift()!;
    for (const specifier of staticSpecifiers(path)) {
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("."), `external static import ${specifier} from ${moduleKey(path)}`);
      const target = resolve(dirname(path), specifier);
      assert.ok(existsSync(target), `unresolved import ${specifier} from ${moduleKey(path)}`);
      const key = moduleKey(target);
      if (importedBy.has(key)) continue;
      importedBy.set(key, moduleKey(path));
      pending.push(target);
    }
  }
  return importedBy;
}

/** Every file `index.js` loads before it reads argv, each mapped to the module that first imported it. */
function startupClosure(): ImportedBy {
  const importedBy = staticClosure(entry);
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

test("JSON config helpers load without statically importing jsonc-parser", () => {
  staticClosure(join(compiledRoot, "setup", "json-config.js"));
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

test("hook session-start keeps a minimal import closure of node builtins and agent-session", () => {
  const hookModule = join(compiledRoot, "commands", "session-start-hook.js");
  assert.ok(existsSync(hookModule), `compiled module is missing: ${hookModule}`);
  const hookImports = staticSpecifiers(hookModule).sort();
  assert.deepEqual(hookImports, ["../core/agent-session.js", "node:fs", "node:path"]);

  const agentSessionModule = join(compiledRoot, "core", "agent-session.js");
  assert.ok(existsSync(agentSessionModule), `compiled module is missing: ${agentSessionModule}`);
  assert.deepEqual(staticSpecifiers(agentSessionModule), ["node:crypto"]);
});

test("hook session-start prints {} and exits 0 when the session-start module cannot load", (t) => {
  const root = installStartupClosure(t);
  mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, "commands", "session-start-hook.js"), 'throw new Error("session-start cannot load");\n', "utf8");
  const result = runInstalledEntry(root, ["hook", "session-start", "claude-code"], "{}");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
});

test("hook tool-result keeps memory out of its static import closure", () => {
  const hookModule = join(compiledRoot, "commands", "tool-result-hook.js");
  assert.ok(existsSync(hookModule), `compiled module is missing: ${hookModule}`);
  const hookImports = staticSpecifiers(hookModule).sort();
  assert.deepEqual(hookImports, [
    "../core/fixtouch-cache.js", "../core/state-paths.js", "../core/tool-result.js",
    "../harnesses/index.js", "../harnesses/projections/to-tool-result.js", "node:fs",
  ]);

  const closure = staticClosure(hookModule);
  for (const lazyModule of [MEMORY_READER, "core/memory.js", "commands/fixtouch-refresh.js"]) {
    assert.equal(closure.has(lazyModule), false, `tool-result statically imports ${importChain(closure, lazyModule)}`);
  }
});

test("CLI startup and the hook lanes load harness decoders lazily", () => {
  for (const path of ["index.js", "commands/agent-hook.js", "commands/tool-result-hook.js", "listening/hook-ingress.js"]) {
    const closure = staticClosure(join(compiledRoot, path));
    const decoders = [...closure.keys()].filter((file) => file.startsWith("harnesses/decoders/"));
    assert.deepEqual(decoders.map((file) => importChain(closure, file)), [], `${path} loads harness decoders eagerly`);
  }
});

test("hook tool-result prints {} and exits 0 when the tool-result module cannot load", (t) => {
  const root = installStartupClosure(t);
  mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, "commands", "tool-result-hook.js"), 'throw new Error("tool-result cannot load");\n', "utf8");
  const result = runInstalledEntry(root, ["hook", "tool-result", "claude-code"], "{}");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
});

test("core/attempt-note imports no commands/ module", () => {
  const noteModule = join(compiledRoot, "core", "attempt-note.js");
  const closure = staticClosure(noteModule);
  const commandModules = [...closure.keys()]
    .filter((file) => file.startsWith("commands/"))
    .sort()
    .map((file) => importChain(closure, file));
  assert.deepEqual(
    commandModules,
    [],
    "core/attempt-note must not import commands/ modules",
  );
});
