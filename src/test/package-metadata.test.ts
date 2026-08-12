import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_BINARY,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../core/package-info.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const expectedFiles = [
  "dist/index.js",
  "dist/commands",
  "dist/check",
  "dist/core",
  "dist/ui",
  "dist/mcp",
  "dist/setup",
  "dist/ai",
  "dist/agent",
  "dist/shell",
  "skills/rocky-voice",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
] as const;

interface JsonObject {
  [key: string]: unknown;
}

interface PackFile {
  path: string;
  size: number;
  mode: number;
}

interface PackResult {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  files: PackFile[];
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function object(value: unknown, label: string): JsonObject {
  assert.equal(typeof value, "object", `${label} must be object`);
  assert.notEqual(value, null, `${label} must be object`);
  assert.equal(Array.isArray(value), false, `${label} must be object`);
  return value as JsonObject;
}

function productionTypeScript(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (path !== join(root, "test")) files.push(...productionTypeScript(root, path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function allowedPackPath(path: string): boolean {
  return path === "LICENSE"
    || path === "README.md"
    || path === "CHANGELOG.md"
    || path === "package.json"
    || path === "dist/index.js"
    || path.startsWith("dist/commands/")
    || path.startsWith("dist/check/")
    || path.startsWith("dist/core/")
    || path.startsWith("dist/ui/")
    || path.startsWith("dist/mcp/")
    || path.startsWith("dist/setup/")
    || path.startsWith("dist/ai/")
    || path.startsWith("dist/agent/")
    || path.startsWith("dist/shell/")
    || path === "skills/rocky-voice/SKILL.md"
    || path === "skills/rocky-voice/agents/openai.yaml";
}

function assertNoForbiddenArtifact(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  assert.doesNotMatch(normalized, /(^|\/)test(\/|$)|\.test\.|(^|\/)src(\/|$)|fixture|cache|validation|\.rocky-managed\.json/i);
  if (normalized !== "dist/commands/model.js") {
    assert.doesNotMatch(normalized, /model|weight/i);
  }
}

function spawnDiagnostic(result: ReturnType<typeof spawnSync>): string {
  return JSON.stringify({
    error: result.error?.message ?? null,
    signal: result.signal ?? null,
    status: result.status ?? null,
    stderr: typeof result.stderr === "string"
      ? result.stderr
      : result.stderr === undefined || result.stderr === null
        ? ""
        : String(result.stderr),
  });
}

function resolveNpmCli(): string | undefined {
  // Under `npm run test --`, npm's lifecycle exposes its own JS entry point
  // directly. Under bare `node scripts/test.mjs` (CLAUDE.md's documented
  // focused-iteration command), no npm lifecycle is running, so npm_execpath
  // is unset - fall back to the standard Node-relative layout every mainstream
  // Node install (official installer, nvm, n, asdf) uses: npm ships bundled
  // at <node-install-prefix>/lib/node_modules/npm/bin/npm-cli.js, one level up
  // from the directory holding the running `node` binary itself.
  if (typeof process.env.npm_execpath === "string" && process.env.npm_execpath.length > 0) {
    return process.env.npm_execpath;
  }
  const bundled = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(bundled) ? bundled : undefined;
}

function dryRunPack(t: test.TestContext, npmCli: string): PackResult {
  const root = mkdtempSync(join(tmpdir(), "rocky-package-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cache = join(root, "npm-cache");
  const userConfig = join(root, "empty-npmrc");
  writeFileSync(userConfig, "", "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || /^(?:npm_token|node_auth_token)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_OFFLINE: "true",
  });
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    npmCli,
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--cache",
    cache,
  ], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
  });
  const diagnostic = spawnDiagnostic(result);
  assert.equal(result.status, 0, diagnostic);
  assert.notEqual(result.stdout.trim(), "", diagnostic);
  const parsed = JSON.parse(result.stdout) as unknown;
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  return parsed[0] as PackResult;
}

test("package launcher diagnostics survive a missing executable and undefined stderr", () => {
  const missing = spawnSync(join(tmpdir(), "rocky-missing-npm-launcher"), [], {
    encoding: "utf8",
  });

  assert.doesNotThrow(() => spawnDiagnostic(missing));
  assert.deepEqual(JSON.parse(spawnDiagnostic(missing)), {
    error: missing.error?.message ?? null,
    signal: null,
    status: null,
    stderr: "",
  });
  assert.match(missing.error?.message ?? "", /ENOENT|not found/i);
});

test("public package metadata pins the scoped beta identity and release coordinates", () => {
  const metadata = readJson(join(packageRoot, "package.json"));
  assert.equal(metadata.name, "@poggufanz/rocky-cli");
  assert.equal(metadata.version, "0.4.0");
  assert.deepEqual(metadata.bin, { rocky: "./dist/index.js" });
  assert.deepEqual(metadata.engines, { node: ">=18" });
  assert.deepEqual(metadata.repository, {
    type: "git",
    url: "git+https://github.com/poggufanz/rocky.git",
  });
  assert.equal(metadata.homepage, "https://github.com/poggufanz/rocky#readme");
  assert.deepEqual(metadata.bugs, { url: "https://github.com/poggufanz/rocky/issues" });
  assert.equal(metadata.author, "Muhammad Faiq");
  assert.equal(metadata.license, "MIT");
  // No `tag` here on purpose: it was left over from the 0.2.1-beta era, and it
  // sent 0.4.0 to the `beta` tag while a bare `npm install -g` kept serving
  // 0.3.0 — the release with the sanitized-MCP credential leak.
  assert.deepEqual(metadata.publishConfig, { access: "public" });
  assert.deepEqual(metadata.files, expectedFiles);
  assert.equal(object(metadata.scripts, "scripts").prepack, "npm run build");
  assert.equal(object(metadata.scripts, "scripts").prepublishOnly, "npm test");
});

test("package and lock contain no runtime or optional dependencies", () => {
  const metadata = readJson(join(packageRoot, "package.json"));
  const lock = readJson(join(packageRoot, "package-lock.json"));
  assert.deepEqual(metadata.dependencies ?? {}, {});
  assert.deepEqual(metadata.optionalDependencies ?? {}, {});
  assert.equal(lock.name, "@poggufanz/rocky-cli");
  assert.equal(lock.version, "0.4.0");
  const packages = object(lock.packages, "lock packages");
  const root = object(packages[""], "lock root");
  assert.equal(root.name, "@poggufanz/rocky-cli");
  assert.equal(root.version, "0.4.0");
  assert.deepEqual(root.dependencies ?? {}, {});
  assert.deepEqual(root.optionalDependencies ?? {}, {});
  for (const [path, value] of Object.entries(packages)) {
    if (path !== "") assert.equal(object(value, path).dev, true, `${path} is not dev-only`);
  }
});

test("production identity constants match package metadata without duplicate literals", () => {
  const metadata = readJson(join(packageRoot, "package.json"));
  assert.equal(PACKAGE_NAME, metadata.name);
  assert.equal(PACKAGE_VERSION, metadata.version);
  assert.equal(PACKAGE_BINARY, Object.keys(object(metadata.bin, "bin"))[0]);

  const occurrences = productionTypeScript(join(packageRoot, "src"))
    .flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [PACKAGE_NAME, PACKAGE_VERSION].flatMap((literal) => Array.from(
        { length: occurrenceCount(source, literal) },
        () => ({ path: relative(packageRoot, path).replaceAll("\\", "/"), literal }),
      ));
    });
  assert.deepEqual(occurrences, [
    { path: "src/core/package-info.ts", literal: "@poggufanz/rocky-cli" },
    { path: "src/core/package-info.ts", literal: "0.4.0" },
  ]);
});

test("npm pack dry-run exposes only the bounded production payload", (t) => {
  const npmCli = resolveNpmCli();
  if (npmCli === undefined) {
    t.skip("no npm CLI entry point found: npm_execpath is unset (not running under an npm "
      + "lifecycle) and no bundled npm-cli.js exists next to the running node binary");
    return;
  }
  const packed = dryRunPack(t, npmCli);
  assert.equal(packed.name, "@poggufanz/rocky-cli");
  assert.equal(packed.version, "0.4.0");
  assert.ok(packed.size < 1_000_000, `tarball is ${packed.size} bytes`);
  assert.ok(Number.isFinite(packed.unpackedSize) && packed.unpackedSize > 0);
  const paths = packed.files.map(({ path }) => path).sort();
  assert.ok(paths.length > 0);
  for (const path of paths) {
    assert.equal(allowedPackPath(path), true, `unexpected packed path: ${path}`);
    assertNoForbiddenArtifact(path);
  }
  for (const required of [
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "package.json",
    "dist/index.js",
    "dist/agent/schema.js",
    "skills/rocky-voice/SKILL.md",
    "skills/rocky-voice/agents/openai.yaml",
  ]) {
    assert.ok(paths.includes(required), `missing packed path: ${required}`);
  }
  assert.ok(paths.some((path) => path.startsWith("dist/mcp/")), "MCP production modules are missing");
  assert.ok(paths.some((path) => path.startsWith("dist/agent/")), "agent production modules are missing");
});
