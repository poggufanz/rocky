import { rmSync } from "node:fs";
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
