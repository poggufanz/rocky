import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { resolveRockyPaths } from "../core/state-paths.js";

/**
 * Point ROCKY_HOME at a fresh temp directory for every test in the calling file.
 * Registers before/after hooks, asserts the active home is the temp dir, and
 * restores the previous value and removes the directory afterwards.
 */
export function useTempRockyHome(prefix = "rocky-home-"): { readonly dir: () => string } {
  let dir = "";
  let previous: string | undefined;
  before(() => {
    previous = process.env.ROCKY_HOME;
    dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    process.env.ROCKY_HOME = dir;
    assert.equal(resolveRockyPaths().home, dir);
  });
  after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir: () => dir };
}
