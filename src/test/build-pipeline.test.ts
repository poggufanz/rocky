import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("copy-assets copies only sorted shell assets through Node", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky assets "));
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
});
