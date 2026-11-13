import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalPath } from "../core/memory-read.js";
import { repoSlug } from "../listening/store-paths.js";

interface RepoIdVector {
  readonly input: string;
  readonly platform: "win32" | "linux";
  readonly canonical: string;
  readonly id: string;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vectors: readonly RepoIdVector[] = JSON.parse(
  readFileSync(join(packageRoot, "fixtures", "paths", "repo-id.json"), "utf8"),
) as readonly RepoIdVector[];

test("repo id vectors match canonicalPath and repoSlug", () => {
  assert.ok(vectors.length >= 10);
  for (const vector of vectors) {
    const canonical = canonicalPath(vector.input, { platform: vector.platform });
    assert.equal(canonical, vector.canonical, `canonicalPath mismatch for ${vector.input} (${vector.platform})`);

    const digestSlug = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
    assert.equal(digestSlug, vector.id, `id mismatch for ${vector.input} (${vector.platform})`);

    // repoSlug re-runs canonicalPath with process.platform, so it matches whenever
    // the canonical spelling is unchanged under the host platform's policy.
    if (canonicalPath(canonical) === canonical) {
      assert.equal(repoSlug(canonical), vector.id, `repoSlug mismatch for ${vector.input} (${vector.platform})`);
    }
  }
});
