import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_ASSET_EXTENSIONS = [".bash", ".sh", ".ps1"];

function isShellAsset(name: string): boolean {
  return SHELL_ASSET_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * `.test-dist/shell/` is a path shared by every test file that exercises
 * `hookInstall`/`hookUninstall`/`hookStatus` (hook-block.test.ts,
 * hook-install.test.ts, hook-powershell.test.ts) -- `node --test` runs test
 * files concurrently, each in its own process, and Windows returns EBUSY when
 * two of those processes try to open the same destination file for writing
 * at once (each file used to stage this directory itself). `scripts/test.mjs`
 * now stages it exactly once, in a single process, before any test file is
 * spawned (see `copyShellAssets` in `scripts/copy-assets.mjs`), so every
 * consumer here only ever needs to verify the staging already happened --
 * never write it themselves. A read-only check cannot race another read-only
 * check; there is nothing left here for two concurrent processes to collide
 * on.
 *
 * Deliberately fails loudly (not a silent skip) when the destination is
 * missing a file the source has: a missing asset here means `scripts/test.mjs`
 * itself didn't stage it (e.g. it was invoked incorrectly, or the staging
 * step regressed), and every real behavioral assertion downstream would
 * otherwise fail with a much more confusing "file not found" deep inside
 * `hookInstall`.
 */
export function verifyShellAssetsStaged(): void {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const source = join(packageRoot, "src", "shell");
  const destination = join(packageRoot, ".test-dist", "shell");
  const expected = readdirSync(source).filter(isShellAsset).sort();
  const missing = expected.filter((name) => !existsSync(join(destination, name)));
  if (missing.length > 0) {
    throw new Error(
      `shell assets missing from ${destination}: ${missing.join(", ")} -- ` +
        "run tests via `node scripts/test.mjs`, which stages .test-dist/shell " +
        "once, in a single process, before any test file loads (invoking " +
        "`node --test` directly on compiled test output skips that staging step).",
    );
  }
}
