// Manifest-only platform packages carry the desktop app, its background
// process, and the hook as optional dependencies of @poggufanz/rocky-cli.
// npm installs a package whose os/cpu match; the root manifest stays free of
// dependencies, and the publish step injects the pins at the root version.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const PLATFORM_PACKAGES = Object.freeze([
  Object.freeze({
    id: "win32-x64",
    name: "@poggufanz/rocky-cli-win32-x64",
    os: "win32",
    cpu: "x64",
    dir: "platform/win32-x64",
  }),
  Object.freeze({
    id: "linux-x64",
    name: "@poggufanz/rocky-cli-linux-x64",
    os: "linux",
    cpu: "x64",
    dir: "platform/linux-x64",
  }),
]);

const PIN_NAMES = Object.freeze(PLATFORM_PACKAGES.map((platform) => platform.name).sort());
const CARRIED_ABSENT = ["scripts", "bin", "dependencies", "optionalDependencies", "main"];
const INHERITED = ["license", "repository", "homepage", "bugs", "author"];

class UsageError extends Error {}

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function readManifest(path) {
  return objectRecord(JSON.parse(readFileSync(path, "utf8")));
}

function errnoMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validatePlatformManifest(manifest, rootManifest, platform) {
  const label = `${platform.dir}/package.json`;
  if (manifest === undefined) return [`${label} is not a JSON object`];
  const problems = [];
  if (manifest.name !== platform.name) {
    problems.push(`${label} name must be ${platform.name}; found ${String(manifest.name)}`);
  }
  if (manifest.version !== rootManifest.version) {
    problems.push(`${label} version ${String(manifest.version)} does not match root version ${String(rootManifest.version)}`);
  }
  if (!isDeepStrictEqual(manifest.os, [platform.os])) {
    problems.push(`${label} os must be exactly ["${platform.os}"]`);
  }
  if (!isDeepStrictEqual(manifest.cpu, [platform.cpu])) {
    problems.push(`${label} cpu must be exactly ["${platform.cpu}"]`);
  }
  if (!isDeepStrictEqual(manifest.files, ["bin/", "LICENSE"])) {
    problems.push(`${label} files must be exactly ["bin/", "LICENSE"]`);
  }
  for (const key of INHERITED) {
    if (!isDeepStrictEqual(manifest[key], rootManifest[key])) {
      problems.push(`${label} ${key} must match the root package manifest`);
    }
  }
  if (!isDeepStrictEqual(manifest.publishConfig, { access: "public" })) {
    problems.push(`${label} publishConfig must be exactly { access: "public" }`);
  }
  for (const key of CARRIED_ABSENT) {
    if (Object.hasOwn(manifest, key)) problems.push(`${label} must not declare ${key}`);
  }
  return problems;
}

export function validatePlatformManifests(root) {
  let rootManifest;
  try {
    rootManifest = readManifest(join(root, "package.json"));
  } catch (error) {
    return [`package.json is unreadable: ${errnoMessage(error)}`];
  }
  if (rootManifest === undefined) return ["package.json is not a JSON object"];
  return PLATFORM_PACKAGES.flatMap((platform) => {
    let manifest;
    try {
      manifest = readManifest(join(root, platform.dir, "package.json"));
    } catch (error) {
      return [`${platform.dir}/package.json is unreadable: ${errnoMessage(error)}`];
    }
    return validatePlatformManifest(manifest, rootManifest, platform);
  });
}

export function withPlatformPins(manifest) {
  if (objectRecord(manifest) === undefined) {
    throw new TypeError("package manifest must be a JSON object");
  }
  for (const key of ["dependencies", "optionalDependencies"]) {
    if (Object.hasOwn(manifest, key)) {
      throw new Error(`package manifest already declares ${key}; pins replace the whole field`);
    }
  }
  if (typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("package manifest has no version to pin");
  }
  const optionalDependencies = {};
  for (const name of PIN_NAMES) optionalDependencies[name] = manifest.version;
  return { ...manifest, optionalDependencies };
}

export function validatePublishedManifest(manifest) {
  const value = objectRecord(manifest);
  if (value === undefined) return ["package manifest is not a JSON object"];
  const problems = [];
  if (Object.hasOwn(value, "dependencies")) {
    problems.push("package manifest must not declare dependencies");
  }
  const pins = objectRecord(value.optionalDependencies);
  if (pins === undefined) {
    return [...problems, `package manifest must pin optionalDependencies to ${PIN_NAMES.join(", ")}`];
  }
  const keys = Object.keys(pins).sort();
  if (!isDeepStrictEqual(keys, PIN_NAMES)) {
    problems.push(`package manifest optionalDependencies must be exactly ${PIN_NAMES.join(", ")}; found ${keys.join(", ") || "none"}`);
  }
  for (const name of PIN_NAMES) {
    if (pins[name] !== value.version) {
      problems.push(`package manifest pin for ${name} must be the exact root version ${String(value.version)}; found ${String(pins[name])}`);
    }
  }
  return problems;
}

async function main(argv) {
  const [command, target, ...rest] = argv;
  if ((command !== "inject" && command !== "check") || target === undefined || rest.length > 0) {
    throw new UsageError("usage: platform-packages <inject|check> <package.json>");
  }
  const path = resolve(target);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (command === "inject") {
    writeFileSync(path, `${JSON.stringify(withPlatformPins(manifest), null, 2)}\n`, "utf8");
    return 0;
  }
  const problems = validatePublishedManifest(manifest);
  if (problems.length === 0) return 0;
  process.stderr.write(`${problems.join("\n")}\n`);
  return 1;
}

const launchedAsScript = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (launchedAsScript) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${errnoMessage(error)}\n`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}
