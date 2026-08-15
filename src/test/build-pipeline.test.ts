import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("copy-assets copies only LF shell assets through Node", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky assets "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "z.sh"), "z\n", "utf8");
  writeFileSync(join(source, "a.bash"), "a\n", "utf8");
  writeFileSync(join(source, "ignored.txt"), "no\n", "utf8");

  const result = spawnSync(process.execPath, [
    join(repoRoot, "scripts", "copy-assets.mjs"),
    "--from", source,
    "--to", destination,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(destination, "a.bash"), "utf8"), "a\n");
  assert.equal(readFileSync(join(destination, "z.sh"), "utf8"), "z\n");
  assert.throws(() => readFileSync(join(destination, "ignored.txt"), "utf8"));

  writeFileSync(join(source, "bad.sh"), "bad\r\n", "utf8");
  const rejected = spawnSync(process.execPath, [
    join(repoRoot, "scripts", "copy-assets.mjs"),
    "--from", source,
    "--to", destination,
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /shell asset contains CR: bad\.sh/);
});

test("shell assets pass Bash syntax when Bash is available", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows has no guaranteed Bash path bridge; Linux CI owns Bash syntax coverage");
    return;
  }
  const probe = spawnSync("bash", ["--version"], { stdio: "ignore" });
  if (probe.error !== undefined || probe.status !== 0) {
    if (process.platform === "linux") assert.fail("Bash executable unavailable on Linux; shell syntax was not evaluated");
    t.skip("Bash executable unavailable; shell syntax was not evaluated");
    return;
  }
  const assets = [
    ...[join(repoRoot, "src", "shell"), join(repoRoot, "dist", "shell")].flatMap((directory) => {
      const names = readdirSync(directory).filter((name) => name.endsWith(".bash") || name.endsWith(".sh"));
      assert.ok(names.length > 0, `${directory} has no shell assets`);
      return names.map((name) => join(directory, name));
    }),
    join(repoRoot, "test", "hook-smoke.bash"),
  ];
  for (const asset of assets) {
    assert.equal(readFileSync(asset).includes(13), false, `${asset} contains CR bytes`);
    const result = spawnSync("bash", ["-n", asset], { encoding: "utf8" });
    assert.equal(result.status, 0, `${asset}: ${result.stderr}`);
  }
});
