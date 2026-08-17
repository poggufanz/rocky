import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { copyShellAssets } from "./copy-assets.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");
const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.build.json")], {
  cwd: packageRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
copyShellAssets();

// tsc writes the entry at the default file mode, which drops the executable
// bit npm set when the bin was linked — so a rebuild silently breaks an
// already-linked global `rocky` until the next npm link. Windows has no
// POSIX mode bits to set.
if (process.platform !== "win32") chmodSync(join(dist, "index.js"), 0o755);
