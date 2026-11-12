import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRepoRoot } from "../listening/repo-consent-read.js";
import { consentsPath } from "../listening/store-paths.js";
import { reconcileRepo } from "../listening/watcher.js";

test("a consented folder with an empty .git reports not-a-repo instead of a Git failure", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-not-repo-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const folder = join(root, "plain");
  mkdirSync(join(folder, ".git"), { recursive: true });
  writeFileSync(join(folder, "a.txt"), "x\n");
  mkdirSync(join(home, "listening"), { recursive: true });
  writeFileSync(consentsPath(home), JSON.stringify({ [normalizeRepoRoot(folder)]: true }));

  const out = reconcileRepo(folder, undefined, home);

  assert.equal(out.coverage, "unknown");
  assert.deepEqual(out.gaps, ["not-a-repo"]);
});
