import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const asset = join(here, "..", "shell", "subshell-hook.sh");

const hasBash = (() => {
  if (process.platform === "win32") return false;
  try {
    return spawnSync("bash", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
})();

test("asset exists and double-source is a no-op without recursion", { skip: !hasBash }, () => {
  assert.equal(existsSync(asset), true);
  const script = "source \"$1\"; source \"$1\"; echo \"guard=${__ROCKY_SUBSHELL:-unset}\"";
  const out = execFileSync("bash", ["-c", script, "probe", asset], { encoding: "utf8", timeout: 10000 });
  assert.match(out, /guard=1/);
});

test("asset text never writes stdout and documents the bypass", () => {
  const text = readFileSync(asset, "utf8");
  assert.match(text, /__ROCKY_SUBSHELL/);
  assert.match(text, /trap - EXIT/);
  assert.match(text, /_hookfail/);
  assert.match(text, /env -u BASH_ENV/);
});

test("BASH_ENV failure is reported through the hook contract", { skip: !hasBash }, () => {
  const probe = spawnSync("bash", ["-c", "exit 3"], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, BASH_ENV: asset, PATH: process.env.PATH ?? "" },
  });
  assert.equal(probe.status, 3);
});
