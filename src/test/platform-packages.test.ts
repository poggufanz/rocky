import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface JsonObject {
  [key: string]: unknown;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const platformPackages = await import(pathToFileURL(join(packageRoot, "scripts", "platform-packages.mjs")).href) as {
  PLATFORM_PACKAGES: readonly { id: string; name: string; os: string; cpu: string; dir: string }[];
  validatePlatformManifests(root: string): string[];
  withPlatformPins(manifest: JsonObject): JsonObject;
  validatePublishedManifest(manifest: unknown): string[];
};
const { PLATFORM_PACKAGES, validatePlatformManifests, withPlatformPins, validatePublishedManifest } = platformPackages;
const root = readJson(join(packageRoot, "package.json"));

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

test("platform manifests match the root package identity and version", () => {
  assert.deepEqual(validatePlatformManifests(packageRoot), []);
  for (const platform of PLATFORM_PACKAGES) {
    const manifest = readJson(join(packageRoot, platform.dir, "package.json"));
    assert.equal(manifest.name, platform.name);
    assert.equal(manifest.version, root.version);
    for (const key of ["license", "repository", "homepage", "bugs", "author"]) {
      assert.deepEqual(manifest[key], root[key]);
    }
    assert.deepEqual(manifest.publishConfig, { access: "public" });
  }
});

test("platform manifests pin os, cpu, files, and carry no scripts or dependencies", () => {
  for (const platform of PLATFORM_PACKAGES) {
    const manifest = readJson(join(packageRoot, platform.dir, "package.json"));
    assert.deepEqual([manifest.os, manifest.cpu, manifest.files], [[platform.os], [platform.cpu], ["bin/", "LICENSE"]]);
    for (const key of ["scripts", "bin", "dependencies", "optionalDependencies", "main"]) {
      assert.equal(manifest[key], undefined);
    }
  }
});

test("withPlatformPins adds exactly both platform packages at the root version", () => {
  const out = withPlatformPins({ name: "@poggufanz/rocky-cli", version: "9.1.0" });
  assert.deepEqual(out.optionalDependencies, {
    "@poggufanz/rocky-cli-linux-x64": "9.1.0",
    "@poggufanz/rocky-cli-win32-x64": "9.1.0",
  });
  assert.deepEqual(validatePublishedManifest(out), []);
});

test("withPlatformPins refuses a manifest that already declares dependencies", () => {
  assert.throws(() => withPlatformPins({ version: "1.0.0", dependencies: { a: "1" } }));
  assert.throws(() => withPlatformPins({ version: "1.0.0", optionalDependencies: {} }));
});

test("validatePublishedManifest rejects a missing, extra, ranged, or mismatched pin", () => {
  const good = withPlatformPins({ name: "@poggufanz/rocky-cli", version: "9.1.0" });
  const pins = good.optionalDependencies as JsonObject;
  for (const bad of [
    { ...pins, "@poggufanz/rocky-cli-linux-x64": undefined },
    { ...pins, extra: "9.1.0" },
    { ...pins, "@poggufanz/rocky-cli-win32-x64": "^9.1.0" },
    { ...pins, "@poggufanz/rocky-cli-win32-x64": "9.0.0" },
  ]) {
    assert.notDeepEqual(
      validatePublishedManifest({ ...good, optionalDependencies: JSON.parse(JSON.stringify(bad)) }),
      [],
    );
  }
  assert.notDeepEqual(validatePublishedManifest({ ...good, dependencies: { a: "1" } }), []);
});

test("release truth fails when a platform manifest version drifts", (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "rocky-platform-packages-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  writeFileSync(join(tempRoot, "package.json"), JSON.stringify(root));
  for (const platform of PLATFORM_PACKAGES) {
    mkdirSync(join(tempRoot, platform.dir), { recursive: true });
    const manifest = readJson(join(packageRoot, platform.dir, "package.json"));
    const drifted = platform.id === "win32-x64" ? { ...manifest, version: "0.0.1" } : manifest;
    writeFileSync(join(tempRoot, platform.dir, "package.json"), JSON.stringify(drifted));
  }
  assert.match(validatePlatformManifests(tempRoot).join("\n"), /version/);
});

test("platform package CLI injects sorted pins and fails check on drift", (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "rocky-platform-pins-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const manifestPath = join(tempRoot, "package.json");
  const script = join(packageRoot, "scripts", "platform-packages.mjs");
  writeFileSync(manifestPath, JSON.stringify({ name: "@poggufanz/rocky-cli", version: "3.2.1" }));

  const injected = spawnSync(process.execPath, [script, "inject", manifestPath], { encoding: "utf8" });
  assert.equal(injected.status, 0, injected.stderr);
  const text = readFileSync(manifestPath, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.match(text, /^  "optionalDependencies": \{\n    "@poggufanz\/rocky-cli-linux-x64": "3\.2\.1",\n    "@poggufanz\/rocky-cli-win32-x64": "3\.2\.1"\n  \}\n\}$/m);
  assert.deepEqual(validatePublishedManifest(readJson(manifestPath)), []);

  writeFileSync(manifestPath, JSON.stringify({ ...readJson(manifestPath), version: "3.0.0" }));
  const checked = spawnSync(process.execPath, [script, "check", manifestPath], { encoding: "utf8" });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /pin for @poggufanz\/rocky-cli-win32-x64 must be the exact root version/);
});
