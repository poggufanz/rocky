import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  BINARY_NAMES,
  binariesRecordPath,
  binaryFileName,
  platformPackageName,
  resolvePlatformPackage,
  syncBinaries,
  type BinaryName,
} from "../setup/auto/binaries.js";

// macOS CI has no platform package; its filesystem behavior is the POSIX path.
const PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : "linux";

const DEFAULT_BYTES: Record<BinaryName, string> = {
  rockyd: "rockyd-v9",
  "rocky-desk": "desk-v9",
  "rocky-hook": "hook-v9",
};

function sandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-desk-binaries-"));
  t.after(() => removeTree(root));
  return root;
}

/** A just-killed child can hold its renamed image briefly on win32. */
function removeTree(path: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

interface InstalledPackage {
  resolve: (id: string) => string;
}

function installedPackage(
  t: TestContext,
  bytes: Partial<Record<BinaryName, string>> = DEFAULT_BYTES,
  version = "9.1.0",
): InstalledPackage {
  const nodeModules = join(sandbox(t), "node_modules");
  const packageDir = join(nodeModules, "@poggufanz", `rocky-cli-${PLATFORM}-x64`);
  const bin = join(packageDir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "fake-package", version }), "utf8");
  for (const name of BINARY_NAMES) {
    const content = bytes[name];
    if (content !== undefined) writeFileSync(join(bin, binaryFileName(name, PLATFORM)), content);
  }
  return { resolve: (id) => join(nodeModules, id) };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  // Anti-hang guard only: a wedged child must not stall the suite.
  await Promise.race([once(child, "exit"), once(AbortSignal.timeout(10_000), "abort")]);
}

test("binaries: platformPackageName covers win32-x64 and linux-x64 only", () => {
  assert.equal(platformPackageName("win32", "x64"), "@poggufanz/rocky-cli-win32-x64");
  assert.equal(platformPackageName("linux", "x64"), "@poggufanz/rocky-cli-linux-x64");
  assert.equal(platformPackageName("darwin", "arm64"), undefined);
  assert.equal(platformPackageName("linux", "arm64"), undefined);
});

test("binaries: resolve returns undefined when the package is absent", () => {
  const resolve = (id: string): string => {
    throw new Error(`cannot find module ${id}`);
  };
  assert.equal(resolvePlatformPackage(PLATFORM, "x64", resolve), undefined);
});

test("binaries: resolve rejects a package missing one binary", (t) => {
  const source = installedPackage(t, { rockyd: "rockyd", "rocky-desk": "desk" });
  assert.equal(resolvePlatformPackage(PLATFORM, "x64", source.resolve), undefined);
});

test("binaries: sync installs all three binaries and writes binaries.json last", (t) => {
  const rockyHome = join(sandbox(t), "home");
  const source = installedPackage(t);
  const pkg = resolvePlatformPackage(PLATFORM, "x64", source.resolve);
  assert.ok(pkg);

  assert.deepEqual(syncBinaries(rockyHome, pkg, PLATFORM), { state: "installed" });
  for (const name of BINARY_NAMES) {
    const target = join(rockyHome, "bin", binaryFileName(name, PLATFORM));
    assert.equal(readFileSync(target, "utf8"), DEFAULT_BYTES[name]);
    if (PLATFORM !== "win32") assert.equal(statSync(target).mode & 0o777, 0o755);
  }
  assert.deepEqual(JSON.parse(readFileSync(binariesRecordPath(rockyHome), "utf8")), {
    v: 1,
    version: "9.1.0",
  });
});

test("binaries: sync is unchanged when version and files match", (t) => {
  const rockyHome = join(sandbox(t), "home");
  const source = installedPackage(t);
  const pkg = resolvePlatformPackage(PLATFORM, "x64", source.resolve);
  assert.ok(pkg);

  assert.deepEqual(syncBinaries(rockyHome, pkg, PLATFORM), { state: "installed" });
  const targets = BINARY_NAMES.map((name) => join(rockyHome, "bin", binaryFileName(name, PLATFORM)));
  const before = targets.map((target) => statSync(target).mtimeMs);

  assert.deepEqual(syncBinaries(rockyHome, pkg, PLATFORM), { state: "unchanged" });
  assert.deepEqual(targets.map((target) => statSync(target).mtimeMs), before);
});

test("binaries: sync recovers from stale temp files and a missing record", (t) => {
  const rockyHome = join(sandbox(t), "home");
  const bin = join(rockyHome, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, `${binaryFileName("rocky-hook", PLATFORM)}.99999.new`), "garbage");
  writeFileSync(join(bin, `${binaryFileName("rocky-desk", PLATFORM)}.old`), "garbage");
  const source = installedPackage(t);
  const pkg = resolvePlatformPackage(PLATFORM, "x64", source.resolve);
  assert.ok(pkg);

  assert.deepEqual(syncBinaries(rockyHome, pkg, PLATFORM), { state: "installed" });
  assert.deepEqual(readdirSync(bin).filter((entry) => entry.endsWith(".new")), []);
  for (const name of BINARY_NAMES) {
    assert.equal(readFileSync(join(bin, binaryFileName(name, PLATFORM)), "utf8"), DEFAULT_BYTES[name]);
  }
});

test("binaries: sync replaces a binary that is running", async (t) => {
  const rockyHome = join(sandbox(t), "home");
  const bin = join(rockyHome, "bin");
  mkdirSync(bin, { recursive: true });
  const running = join(bin, binaryFileName("rocky-hook", PLATFORM));
  copyFileSync(process.execPath, running);
  if (PLATFORM !== "win32") chmodSync(running, 0o755);
  const child = spawn(running, ["-e", "setTimeout(() => {}, 20000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await once(child, "spawn");
    const source = installedPackage(t, { ...DEFAULT_BYTES, "rocky-hook": "hook-v10" });
    const pkg = resolvePlatformPackage(PLATFORM, "x64", source.resolve);
    assert.ok(pkg);

    assert.deepEqual(syncBinaries(rockyHome, pkg, PLATFORM), { state: "installed" });
    assert.equal(readFileSync(running, "utf8"), "hook-v10");
  } finally {
    await stop(child);
  }
});

test("binaries: sync reports error and leaves the record alone when bin cannot be created", (t) => {
  const rockyHome = join(sandbox(t), "home");
  mkdirSync(rockyHome, { recursive: true });
  writeFileSync(join(rockyHome, "bin"), "not a directory");
  const source = installedPackage(t);
  const pkg = resolvePlatformPackage(PLATFORM, "x64", source.resolve);
  assert.ok(pkg);

  const result = syncBinaries(rockyHome, pkg, PLATFORM);
  if (result.state !== "error") assert.fail(`expected error, got ${result.state}`);
  assert.ok(result.detail.length > 0);
  assert.equal(existsSync(binariesRecordPath(rockyHome)), false);
});
