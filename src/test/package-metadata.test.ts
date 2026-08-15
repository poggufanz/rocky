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
import { fileURLToPath, pathToFileURL } from "node:url";
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
  assert.equal(metadata.version, "0.5.0");
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

test("release metadata validation rejects a wrong package name independently", async () => {
  const releaseCheck = await import(pathToFileURL(join(packageRoot, "scripts", "release-check.mjs")).href) as {
    validateReleaseMetadata(value: unknown): boolean;
    assertMetadata(state: { metadata?: Record<string, unknown> }): void;
  };
  const metadata = readJson(join(packageRoot, "package.json"));
  assert.equal(releaseCheck.validateReleaseMetadata(metadata), true);
  assert.equal(
    releaseCheck.validateReleaseMetadata({ ...metadata, name: "@attacker/not-rocky" }),
    false,
  );
});

test("release metadata assertion consumes valid metadata without a scope error", async () => {
  const releaseCheck = await import(pathToFileURL(join(packageRoot, "scripts", "release-check.mjs")).href) as {
    assertMetadata(state: { metadata?: Record<string, unknown> }): void;
  };
  const state: { metadata?: Record<string, unknown> } = {};
  assert.doesNotThrow(() => releaseCheck.assertMetadata(state));
  assert.deepEqual(state.metadata, {
    name: "@poggufanz/rocky-cli",
    version: "0.5.0",
    binary: "rocky",
    license: "MIT",
    author: "Muhammad Faiq",
    runtimeDependencies: 0,
    optionalDependencies: 0,
  });
});

test("release metadata validation rejects malformed dependency fields without throwing", async () => {
  const releaseCheck = await import(pathToFileURL(join(packageRoot, "scripts", "release-check.mjs")).href) as {
    validateReleaseMetadata(value: unknown): boolean;
  };
  const metadata = readJson(join(packageRoot, "package.json"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
    for (const value of [false, 0, 1, "", [], ["package"], { package: "^1.0.0" }, new Date()]) {
      assert.equal(
        releaseCheck.validateReleaseMetadata({ ...metadata, [field]: value }),
        false,
        `${field}=${String(value)} must fail validation`,
      );
    }
    assert.equal(releaseCheck.validateReleaseMetadata({ ...metadata, [field]: null }), true);
    assert.equal(releaseCheck.validateReleaseMetadata({ ...metadata, [field]: {} }), true);
  }
  for (const field of ["bundledDependencies", "bundleDependencies"]) {
    for (const value of [false, 0, 1, "", {}, ["package"], new Date()]) {
      assert.equal(
        releaseCheck.validateReleaseMetadata({ ...metadata, [field]: value }),
        false,
        `${field}=${String(value)} must fail validation`,
      );
    }
    assert.equal(releaseCheck.validateReleaseMetadata({ ...metadata, [field]: null }), true);
    assert.equal(releaseCheck.validateReleaseMetadata({ ...metadata, [field]: [] }), true);
  }
});

test("package and lock contain no runtime or optional dependencies", () => {
  const metadata = readJson(join(packageRoot, "package.json"));
  const lock = readJson(join(packageRoot, "package-lock.json"));
  assert.deepEqual(metadata.dependencies ?? {}, {});
  assert.deepEqual(metadata.optionalDependencies ?? {}, {});
  assert.deepEqual(metadata.peerDependencies ?? {}, {});
  assert.deepEqual(metadata.peerDependenciesMeta ?? {}, {});
  assert.deepEqual(metadata.bundledDependencies ?? [], []);
  assert.deepEqual(metadata.bundleDependencies ?? [], []);
  assert.equal(lock.name, "@poggufanz/rocky-cli");
  assert.equal(lock.version, "0.5.0");
  const packages = object(lock.packages, "lock packages");
  const root = object(packages[""], "lock root");
  assert.equal(root.name, "@poggufanz/rocky-cli");
  assert.equal(root.version, "0.5.0");
  assert.deepEqual(root.bin, { rocky: "dist/index.js" });
  assert.deepEqual(root.dependencies ?? {}, {});
  assert.deepEqual(root.optionalDependencies ?? {}, {});
  assert.deepEqual(root.peerDependencies ?? {}, {});
  assert.deepEqual(root.peerDependenciesMeta ?? {}, {});
  assert.deepEqual(root.bundledDependencies ?? [], []);
  assert.deepEqual(root.bundleDependencies ?? [], []);
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
    { path: "src/core/package-info.ts", literal: "0.5.0" },
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
  assert.equal(packed.version, "0.5.0");
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

test("canonical release truth rejects drift in every release marker", async () => {
  const releaseCheck = await import(pathToFileURL(join(packageRoot, "scripts", "release-check.mjs")).href) as {
    readReleaseTruthSnapshot(root: string): {
      metadata: Record<string, unknown>;
      lock: Record<string, unknown>;
      packageInfoSource: string;
      readme: string;
      changelog: string;
      help: string;
      helpStdout: string;
      helpStderr: string;
      versionOutput: string;
      versionStdout: string;
      versionStderr: string;
      helpCompleted: boolean;
      versionCompleted: boolean;
    };
    validateReleaseTruth(snapshot: unknown): string[];
  };
  const snapshot = releaseCheck.readReleaseTruthSnapshot(packageRoot);
  assert.deepEqual(releaseCheck.validateReleaseTruth(snapshot), []);
  assert.deepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      readme: `${snapshot.readme}\nThe staged transaction publishes audited bytes.\n`,
    }),
    [],
    "unrelated publishes wording must not be treated as package publication",
  );
  assert.deepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      readme: `${snapshot.readme}\nPackage docs updated. The staged transaction publishes audited bytes.\n`,
    }),
    [],
    "publication wording in an unrelated compound clause must not inherit package context",
  );
  assert.deepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      readme: `${snapshot.readme}\n\`\`\`text\nThe npm package was published to npm.\n\`\`\`\n`,
    }),
    [],
    "publication claims inside fenced Markdown must be ignored",
  );
  assert.deepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      changelog: `${snapshot.changelog}\nThe v0.4 release was released on 9 August.\n`,
    }),
    [],
    "release history wording must not be treated as package publication",
  );
  for (const [label, mutated] of [
    ["README no package publication", { ...snapshot, readme: `${snapshot.readme}\nNo package publication is implied.\n` }],
    ["README package not available", { ...snapshot, readme: `${snapshot.readme}\nThe package is not available on npm.\n` }],
    ["README package never published", { ...snapshot, readme: `${snapshot.readme}\nThe package was never published on npm.\n` }],
    ["CHANGELOG publication not complete", { ...snapshot, changelog: `${snapshot.changelog}\nnpm publication is not complete.\n` }],
    ["README no saving percentage", { ...snapshot, readme: `${snapshot.readme}\nThis project publishes no saving percentage.\n` }],
    ["README no npm publication occurred", { ...snapshot, readme: `${snapshot.readme}\nNo npm publication occurred.\n` }],
    ["README never actually published", { ...snapshot, readme: `${snapshot.readme}\nThe package was never actually published.\n` }],
    ["README not currently available", { ...snapshot, readme: `${snapshot.readme}\nThe package is not currently available on npm.\n` }],
  ] as const) {
    assert.deepEqual(releaseCheck.validateReleaseTruth(mutated), [], `${label} must remain allowed`);
  }
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: `${snapshot.readme}\nnpm publish succeeded.\n` }),
    [],
    "an npm publish success claim must fail",
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: `${snapshot.readme}\nThe package is available on npm.\n` }),
    [],
    "package availability on npm must fail",
  );
  for (const [label, mutated] of [
    ["unrelated not before publish", { ...snapshot, readme: `${snapshot.readme}\nThe package is not legacy and npm publish succeeded.\n` }],
    ["unrelated not before publish without conjunction", { ...snapshot, readme: `${snapshot.readme}\nThe package is not legacy npm publish succeeded.\n` }],
    ["unrelated no before publication", { ...snapshot, changelog: `${snapshot.changelog}\nNo guarantee is made and npm publication is complete.\n` }],
    ["negative publication before positive availability", { ...snapshot, readme: `${snapshot.readme}\nThe package is not published, but is now available on npm.\n` }],
  ] as const) {
    assert.notDeepEqual(releaseCheck.validateReleaseTruth(mutated), [], `${label} must fail`);
  }
  for (const [label, mutated] of [
    ["availability in npm registry", { ...snapshot, readme: `${snapshot.readme}\nThe package is now available in the npm registry.\n` }],
    ["package now on npm", { ...snapshot, readme: `${snapshot.readme}\nThe package is now on npm.\n` }],
    ["semver publication", { ...snapshot, changelog: `${snapshot.changelog}\nVersion 0.5.0 was published.\n` }],
    ["bare numeric publication", { ...snapshot, readme: `${snapshot.readme}\n0.5.0 was published.\n` }],
    ["bare semver publication", { ...snapshot, readme: `${snapshot.readme}\nv0.5.0 was published.\n` }],
    ["bare semver availability", { ...snapshot, readme: `${snapshot.readme}\nv0.5.0 is now on npm.\n` }],
    ["wrapped package availability", { ...snapshot, readme: `${snapshot.readme}\nThe package is now\non npm.\n` }],
    ["wrapped package publication", { ...snapshot, readme: `${snapshot.readme}\nThe package was\npublished.\n` }],
    ["wrapped package available", { ...snapshot, readme: `${snapshot.readme}\nThe package is available on\nnpm.\n` }],
    ["package landed on npm", { ...snapshot, readme: `${snapshot.readme}\nThe package landed on npm.\n` }],
    ["package downloadable from npm", { ...snapshot, readme: `${snapshot.readme}\nThe package is downloadable from npm.\n` }],
    ["heading publication", { ...snapshot, readme: `${snapshot.readme}\n## v0.5.0 was published\n` }],
    ["numeric heading publication", { ...snapshot, readme: `${snapshot.readme}\n## 0.5.0 was published\n` }],
    ["wrapped numeric heading publication", { ...snapshot, readme: `${snapshot.readme}\n## 0.5.0\nwas published.\n` }],
  ] as const) {
    assert.notDeepEqual(releaseCheck.validateReleaseTruth(mutated), [], `${label} must fail`);
  }
  const realRoadmapMarker = /^-\s+\*\*v0\.5\b[^\r\n]*\(current release\)[^\r\n]*$/im.exec(snapshot.readme)?.[0];
  assert.ok(realRoadmapMarker !== undefined, "canonical README roadmap marker must exist");
  const realCurrentReleaseLine = /^\s*Current release\s*:[^\r\n]*$/im.exec(snapshot.readme)?.[0];
  assert.ok(realCurrentReleaseLine !== undefined, "canonical README current-release marker must exist");
  const roadmapMarkerRemoved = snapshot.readme.replace(realRoadmapMarker!, realRoadmapMarker!.replace("(current release)", "(implemented)"));
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: `${roadmapMarkerRemoved}\n- **v0.5 — fake (current release)**\n` }),
    [],
    "a fake current roadmap marker outside the Roadmap section must fail",
  );
  const readmeWithoutRealMarkers = snapshot.readme
    .replace(realCurrentReleaseLine!, "")
    .replace(realRoadmapMarker!, "");
  const roadmapStart = readmeWithoutRealMarkers.indexOf("## Roadmap");
  const roadmapEnd = readmeWithoutRealMarkers.indexOf("\n## Contributing", roadmapStart);
  assert.ok(roadmapStart >= 0 && roadmapEnd > roadmapStart, "canonical README Roadmap bounds must exist");
  const indentedFakeReadme = `${readmeWithoutRealMarkers.slice(0, roadmapEnd)}\n    Current release: \`${PACKAGE_NAME}@${PACKAGE_VERSION}\`\n    - **v0.5 — fake (current release)**\n${readmeWithoutRealMarkers.slice(roadmapEnd)}`;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: indentedFakeReadme }),
    [],
    "indented README release markers must not satisfy canonical truth",
  );
  const roadmapHeadingRemoved = roadmapMarkerRemoved.replace(/^## Roadmap\r?\n/im, "");
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      readme: `${roadmapHeadingRemoved}\n\`\`\`markdown\n## Roadmap\n- **v0.5 — fake (current release)**\n\`\`\`\n`,
    }),
    [],
    "a fenced fake Roadmap heading and marker must not satisfy README truth",
  );
  const htmlFakeReadme = `${readmeWithoutRealMarkers.replace(/^## Roadmap\r?\n/im, "")}\n<pre>\nCurrent release: \`${PACKAGE_NAME}@${PACKAGE_VERSION}\`\n## Roadmap\n- **v0.5 — fake (current release)**\n</pre>\n`;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: htmlFakeReadme }),
    [],
    "README release markers and headings inside raw HTML preformatted content must not satisfy truth",
  );
  const multilineHtmlFakeReadme = `${readmeWithoutRealMarkers.replace(/^## Roadmap\r?\n/im, "")}\n<pre\n>\nCurrent release: \`${PACKAGE_NAME}@${PACKAGE_VERSION}\`\n## Roadmap\n- **v0.5 — fake (current release)**\n</pre>\n`;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: multilineHtmlFakeReadme }),
    [],
    "README release markers inside a multiline raw HTML pre block must not satisfy truth",
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      readme: `${readmeWithoutRealMarkers.replace(/^## Roadmap\r?\n/im, "")}\n<pre\n>\nCurrent release: \`${PACKAGE_NAME}@${PACKAGE_VERSION}\`\n## Roadmap\n- **v0.5 — fake (current release)**\n`,
    }),
    [],
    "an open-ended multiline README pre block must fail closed",
  );
  const htmlCommentFakeReadme = `${readmeWithoutRealMarkers.replace(/^## Roadmap\r?\n/im, "")}\n<!--\nCurrent release: \`${PACKAGE_NAME}@${PACKAGE_VERSION}\`\n## Roadmap\n- **v0.5 — fake (current release)**\n-->\n`;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: htmlCommentFakeReadme }),
    [],
    "README release markers and headings inside HTML comments must not satisfy truth",
  );
  const changelogHeadingRemoved = snapshot.changelog.replace(/^## 0\.5\.0[^\r\n]*\r?\n/im, "");
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      changelog: `${changelogHeadingRemoved}\n\`\`\`markdown\n## 0.5.0 — fake\nFenced fake section.\n\`\`\`\n`,
    }),
    [],
    "a fenced fake CHANGELOG release heading must not satisfy release truth",
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      changelog: `${changelogHeadingRemoved}\n    ## 0.5.0 — fake\n    Indented fake section.\n`,
    }),
    [],
    "an indented fake CHANGELOG release heading must not satisfy release truth",
  );
  const htmlFakeChangelog = `${changelogHeadingRemoved}\n<pre>\n## 0.5.0 — fake\nFake release section.\n</pre>\n`;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, changelog: htmlFakeChangelog }),
    [],
    "CHANGELOG release headings inside raw HTML preformatted content must not satisfy truth",
  );
  const htmlCommentFakeChangelog = `${changelogHeadingRemoved}\n<!-- ## 0.5.0 — fake\nFake release section. -->\n`;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, changelog: htmlCommentFakeChangelog }),
    [],
    "CHANGELOG release headings inside HTML comments must not satisfy truth",
  );
  const multilineHtmlFakeChangelog = `${changelogHeadingRemoved}\n<pre\n>\n## 0.5.0 — fake\nFake release section.\n</pre>\n`;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, changelog: multilineHtmlFakeChangelog }),
    [],
    "CHANGELOG release headings inside a multiline raw HTML pre block must not satisfy truth",
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      changelog: `${changelogHeadingRemoved}\n<!--\n## 0.5.0 — fake\nFake release section.\n`,
    }),
    [],
    "an open-ended CHANGELOG comment must fail closed",
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: `${snapshot.readme}\n\u0000\n` }),
    [],
    "a source sentinel collision must fail closed",
  );
  for (const [label, readme] of [
    ["visible publication before same-line comment", `${snapshot.readme}\nThe package is now available on npm. <!-- hidden note -->\n`],
    ["visible publication after same-line comment", `${snapshot.readme}\n<!-- hidden note --> The package is now available on npm.\n`],
    ["visible publication before same-line pre", `${snapshot.readme}\nThe package is now available on npm. <pre>hidden note</pre>\n`],
    ["visible publication after same-line pre", `${snapshot.readme}\n<pre>hidden note</pre> The package is now available on npm.\n`],
    ["visible publication after non-HTML pre spacing", `${snapshot.readme}\n<pre\u00a0>hidden note</pre> The package is now available on npm.\n`],
  ] as const) {
    assert.notDeepEqual(
      releaseCheck.validateReleaseTruth({ ...snapshot, readme }),
      [],
      `${label} must remain visible to publication validation`,
    );
  }
  for (const [label, mutated] of [
    ["README canonical upstream URL", { ...snapshot, readme: snapshot.readme.replace("https://github.com/poggufanz/rocky.git", "https://github.com/example/rocky.git") }],
    ["README canonical developer branch", { ...snapshot, readme: snapshot.readme.replace("Canonical developer branch is `main`", "Canonical developer branch is `develop`") }],
    ["README canonical outer package root", { ...snapshot, readme: snapshot.readme.replace("outer workspace, that same package root is the `rocky/` directory", "outer workspace, that same package root is the `package/` directory") }],
  ] as const) {
    assert.notDeepEqual(releaseCheck.validateReleaseTruth(mutated), [], `${label} drift must fail`);
  }
  const changedRealVersion = snapshot.packageInfoSource.replace(
    'export const PACKAGE_VERSION = "0.5.0";',
    'export const PACKAGE_VERSION = "9.9.9";',
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      packageInfoSource: `// export const PACKAGE_VERSION = "0.5.0";\n${changedRealVersion}`,
    }),
    [],
    "commented PACKAGE_VERSION exports must not spoof executable package-info assignments",
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      packageInfoSource: `${snapshot.packageInfoSource}\nexport const PACKAGE_VERSION = "0.5.0";\n`,
    }),
    [],
    "duplicate PACKAGE_VERSION exports must fail closed",
  );
  const canonicalCurrentMarker = `Current release: \`${PACKAGE_NAME}@${PACKAGE_VERSION}\``;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: `${snapshot.readme}\n${canonicalCurrentMarker}. Duplicate marker.\n` }),
    [],
    "a duplicate canonical Current release marker must fail",
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, readme: `${snapshot.readme}\nCurrent release: \`@wrong/rocky@9.9.9\`.\n` }),
    [],
    "an appended wrong Current release marker must fail",
  );
  const duplicateChangelogHeading = `${snapshot.changelog}\n## ${PACKAGE_VERSION} — duplicate section\nHistorical duplicate section.\n`;
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, changelog: duplicateChangelogHeading }),
    [],
    "duplicate expected-version CHANGELOG sections must fail",
  );
  assert.deepEqual(
    releaseCheck.validateReleaseTruth({
      ...snapshot,
      changelog: `${snapshot.changelog}\n## 0.4.0 — historical note\nThis historical section is unreleased and unpublished.\n`,
    }),
    [],
    "historical unreleased wording outside current section must remain allowed",
  );
  const currentSectionStart = snapshot.changelog.indexOf("## 0.5.0");
  const nextSectionStart = snapshot.changelog.indexOf("\n## 0.4.0", currentSectionStart);
  assert.ok(currentSectionStart >= 0 && nextSectionStart > currentSectionStart, "canonical changelog sections must exist");
  const currentSection = snapshot.changelog.slice(currentSectionStart, nextSectionStart);
  const lateUnreleasedStatus = snapshot.changelog.replace(
    currentSection,
    `${currentSection.slice(0, 900)}\nThis v0.5.0 release is unreleased.\n${currentSection.slice(900)}`,
  );
  assert.notDeepEqual(
    releaseCheck.validateReleaseTruth({ ...snapshot, changelog: lateUnreleasedStatus }),
    [],
    "stale status beyond the old short scan must fail",
  );

  const lock = object(snapshot.lock.packages, "lock packages");
  const lockRoot = object(lock[""], "lock root");
  for (const [field, value] of [
    ["peerDependencies", { peer: "^1.0.0" }],
    ["peerDependenciesMeta", { peer: { optional: true } }],
    ["bundledDependencies", ["runtime-package"]],
    ["bundleDependencies", ["runtime-package"]],
  ] as const) {
    assert.notDeepEqual(
      releaseCheck.validateReleaseTruth({
        ...snapshot,
        lock: { ...snapshot.lock, packages: { ...lock, "": { ...lockRoot, [field]: value } } },
      }),
      [],
      `lock root ${field} must not carry runtime metadata`,
    );
  }
  for (const [label, bin] of [
    ["missing", undefined],
    ["wrong path", { rocky: "./dist/index.js" }],
    ["extra key", { rocky: "dist/index.js", other: "dist/other.js" }],
    ["malformed", ["dist/index.js"]],
  ] as const) {
    const mutatedRoot = { ...lockRoot };
    if (bin === undefined) delete mutatedRoot.bin;
    else mutatedRoot.bin = bin;
    assert.notDeepEqual(
      releaseCheck.validateReleaseTruth({
        ...snapshot,
        lock: { ...snapshot.lock, packages: { ...lock, "": mutatedRoot } },
      }),
      [],
      `lock root bin ${label} must fail canonical validation`,
    );
  }
  const mutations: Array<[string, Record<string, unknown>]> = [
    ["package metadata", { ...snapshot, metadata: { ...snapshot.metadata, name: "@wrong/rocky" } }],
    ["lockfile", { ...snapshot, lock: { ...snapshot.lock, version: "9.9.9" } }],
    ["lock root", { ...snapshot, lock: { ...snapshot.lock, packages: { ...lock, "": { ...lockRoot, version: "9.9.9" } } } }],
    ["package-info", { ...snapshot, packageInfoSource: snapshot.packageInfoSource.replace('PACKAGE_VERSION = "0.5.0"', 'PACKAGE_VERSION = "9.9.9"') }],
    ["README", { ...snapshot, readme: snapshot.readme.replace("@poggufanz/rocky-cli@0.5.0", "@poggufanz/rocky-cli@9.9.9") }],
    ["README appended wrong current marker", { ...snapshot, readme: `${snapshot.readme}\nCurrent release: \`@wrong/rocky@9.9.9\`.\n` }],
    ["README duplicate current marker", { ...snapshot, readme: `${snapshot.readme}\n${canonicalCurrentMarker}. Duplicate marker.\n` }],
    ["README current roadmap", { ...snapshot, readme: snapshot.readme.replace("v0.4 — his diligence (implemented)", "v0.4 — his diligence (current release)") }],
    ["README roadmap v0.5.1", { ...snapshot, readme: snapshot.readme.replace("v0.5 — his curiosity", "v0.5.1 — his curiosity") }],
    ["README roadmap v0.5.0.1", { ...snapshot, readme: snapshot.readme.replace("v0.5 — his curiosity", "v0.5.0.1 — his curiosity") }],
    ["README roadmap v0.5-beta", { ...snapshot, readme: snapshot.readme.replace("v0.5 — his curiosity", "v0.5-beta — his curiosity") }],
    ["README second current marker", { ...snapshot, readme: snapshot.readme.replace("v0.4 — his diligence (implemented)", "v0.4 — his diligence (current release)") }],
    ["CHANGELOG", { ...snapshot, changelog: snapshot.changelog.replace("## 0.5.0", "## 9.9.9") }],
    ["CHANGELOG duplicate expected section", { ...snapshot, changelog: duplicateChangelogHeading }],
    ["README publication claim", { ...snapshot, readme: `${snapshot.readme}\nThe npm package was published to npm.\n` }],
    ["README bare publication claim", { ...snapshot, readme: `${snapshot.readme}\nThe package published to npm.\n` }],
    ["README publish-to-npm claim", { ...snapshot, readme: `${snapshot.readme}\nThe package publishes to npm.\n` }],
    ["README package live on npm claim", { ...snapshot, readme: `${snapshot.readme}\nThe package is live on npm.\n` }],
    ["CHANGELOG publication complete claim", { ...snapshot, changelog: `${snapshot.changelog}\nnpm publication is complete.\n` }],
    ["README npm publishes package claim", { ...snapshot, readme: `${snapshot.readme}\nnpm publishes this package.\n` }],
    ["README npm publish succeeded claim", { ...snapshot, readme: `${snapshot.readme}\nnpm publish succeeded.\n` }],
    ["README package available on npm claim", { ...snapshot, readme: `${snapshot.readme}\nThe package is available on npm.\n` }],
    ["CHANGELOG publication claim", { ...snapshot, changelog: `${snapshot.changelog}\nThe v0.5.0 package was published to npm.\n` }],
    ["help", { ...snapshot, helpStdout: snapshot.helpStdout.replace("@poggufanz/rocky-cli@0.5.0", "@poggufanz/rocky-cli@9.9.9") }],
    ["help wrong stream", { ...snapshot, helpStdout: "", helpStderr: snapshot.helpStdout }],
    ["help conflicting version", { ...snapshot, helpStdout: `${snapshot.helpStdout}\nversion: @poggufanz/rocky-cli@9.9.9\n` }],
    ["help conflicting package", { ...snapshot, helpStdout: snapshot.helpStdout.replace("version: @poggufanz/rocky-cli@0.5.0", "version: @wrong/rocky@0.5.0") }],
    ["version output", { ...snapshot, versionStdout: "9.9.9\n", versionOutput: "9.9.9\n" }],
    ["version wrong stream", { ...snapshot, versionStdout: "", versionStderr: snapshot.versionStdout }],
    ["version extra output", { ...snapshot, versionStdout: `${snapshot.versionStdout}0.5.1\n`, versionOutput: `${snapshot.versionStdout}0.5.1\n` }],
    ["help process", { ...snapshot, helpCompleted: false }],
    ["version process", { ...snapshot, versionCompleted: false }],
  ];
  for (const [label, mutated] of mutations) {
    assert.notDeepEqual(releaseCheck.validateReleaseTruth(mutated), [], `${label} drift must fail`);
  }
});
