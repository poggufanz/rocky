import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { copyShellAssets } from "./copy-assets.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDist = join(packageRoot, ".test-dist");
const filters = process.argv.slice(2).map((filter) => filter.replaceAll("\\", "/"));

class CommandFailed extends Error {
  constructor(status) {
    super(`command failed with status ${status}`);
    this.status = status;
  }
}

function run(file, args) {
  // An inherited CLAUDE_CONFIG_DIR would aim settings writes at a real
  // profile, and inherited agent or attempt-note variables would stamp test
  // records or alter arm/seam behavior. Node drops undefined values from the
  // child environment, and tests that need any of these variables set them in
  // their own env objects.
  const result = spawnSync(file, args, {
    cwd: packageRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: undefined,
      CLAUDECODE: undefined,
      ROCKY_AGENT_SESSION: undefined,
      ROCKY_ATTEMPT_ADVISORY: undefined,
      ROCKY_ATTEMPT_ARM: undefined,
      ROCKY_TEST_SEAMS: undefined,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new CommandFailed(result.status ?? 1);
}

function findTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTests(path);
    return entry.isFile() && entry.name.endsWith(".test.js") ? [path] : [];
  });
}

try {
  run(process.execPath, [join(packageRoot, "scripts", "build.mjs")]);
  rmSync(testDist, { recursive: true, force: true });
  run(process.execPath, [
    join(packageRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(packageRoot, "tsconfig.test.json"),
  ]);
  // Stage shell assets into .test-dist/shell/ exactly once, in this single
  // parent process, before any test file (each running in its own concurrent
  // child under `node --test`) can load and try to stage the same shared
  // path itself. See src/test/shell-assets-fixture.ts for the read-only
  // verification every consumer does instead of writing.
  copyShellAssets(join(packageRoot, "src", "shell"), join(testDist, "shell"));
  const allTests = findTests(join(testDist, "test")).sort();
  const selected = filters.length === 0
    ? allTests
    : allTests.filter((file) => {
      const path = file.replaceAll("\\", "/");
      return filters.some((filter) => path.includes(filter));
    });
  if (selected.length === 0) throw new Error(`no tests match: ${filters.join(", ")}`);
  run(process.execPath, ["--test", ...selected]);

  const smoke = join(packageRoot, "test", "hook-smoke.bash");
  const explicitlyRequested = process.env.ROCKY_RUN_HOOK_SMOKE === "1";
  const smokeRequested = process.platform === "linux" || explicitlyRequested;
  if (filters.length > 0) {
    console.log("[hook-smoke] skipped: focused Node test selection; hook compatibility was not evaluated.");
  } else if (!smokeRequested) {
    console.log(
      `[hook-smoke] skipped on ${process.platform}: current smoke uses GNU script -qec; ` +
      "Node tests passed, but this skip is not a Bash hook incompatibility result.",
    );
  } else if (!existsSync(smoke)) {
    throw new Error(`hook smoke fixture is missing: ${smoke}`);
  } else {
    const probe = spawnSync("bash", ["--version"], { stdio: "ignore" });
    if (probe.error || probe.status !== 0) {
      if (process.platform === "linux") {
        throw new Error("[hook-smoke] Bash executable unavailable on Linux; hook compatibility was not evaluated.");
      }
      console.log(`[hook-smoke] skipped on ${process.platform}: Bash executable unavailable; hook compatibility was not evaluated.`);
    } else {
      console.log(`[hook-smoke] running (${explicitlyRequested ? "explicit request" : "Linux default"}).`);
      run("bash", [smoke]);
      console.log("[hook-smoke] passed.");
    }
  }
} catch (error) {
  if (!(error instanceof CommandFailed)) console.error(error);
  process.exitCode = error instanceof CommandFailed ? error.status : 1;
} finally {
  rmSync(testDist, { recursive: true, force: true });
}
