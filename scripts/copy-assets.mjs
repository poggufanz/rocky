import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function copyShellAssets(
  sourceDir = join(packageRoot, "src", "shell"),
  destinationDir = join(packageRoot, "dist", "shell"),
) {
  if (!existsSync(sourceDir)) return;
  mkdirSync(destinationDir, { recursive: true });
  const names = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".bash") || name.endsWith(".sh"))
    .sort();
  for (const name of names) copyFileSync(join(sourceDir, name), join(destinationDir, name));
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  copyShellAssets(option("--from"), option("--to"));
}
