import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDist = join(packageRoot, ".test-dist");
const filters = process.argv.slice(2);

class CommandFailed extends Error {
  constructor(status) {
    super(`command failed with status ${status}`);
    this.status = status;
  }
}

function run(file, args) {
  const result = spawnSync(file, args, { cwd: packageRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new CommandFailed(result.status ?? 1);
}

try {
  run(process.execPath, [join(packageRoot, "scripts", "build.mjs")]);
  rmSync(testDist, { recursive: true, force: true });
  run(process.execPath, [
    join(packageRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(packageRoot, "tsconfig.test.json"),
  ]);
  const allTests = readdirSync(join(testDist, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(testDist, "test", name));
  const selected = filters.length === 0
    ? allTests
    : allTests.filter((file) => filters.some((filter) => file.includes(filter)));
  if (selected.length === 0) throw new Error(`no tests match: ${filters.join(", ")}`);
  run(process.execPath, ["--test", ...selected]);

  const smoke = join(packageRoot, "test", "hook-smoke.bash");
  const smokeRequested = process.platform === "linux" || process.env.ROCKY_RUN_HOOK_SMOKE === "1";
  if (filters.length === 0 && smokeRequested && existsSync(smoke)) {
    const probe = spawnSync("bash", ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) run("bash", [smoke]);
  }
} catch (error) {
  if (!(error instanceof CommandFailed)) console.error(error);
  process.exitCode = error instanceof CommandFailed ? error.status : 1;
} finally {
  rmSync(testDist, { recursive: true, force: true });
}
