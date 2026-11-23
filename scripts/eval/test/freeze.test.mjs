import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { computeManifest } from "../freeze.mjs";

const PINNED_V1_SHA256 = "3bf31ff00c6337c38646b83112576e37e545a2298f6302ddcadd7d4cf0e2d62a";

describe("freeze manifest task sets", () => {
  test("v1 hash is unchanged by the set field", () => {
    const manifest = computeManifest();
    assert.ok(manifest.taskSets && typeof manifest.taskSets === "object");
    assert.equal(manifest.taskSets.v1, PINNED_V1_SHA256);
    assert.equal(manifest.taskSetSha256, PINNED_V1_SHA256);
    assert.equal(typeof manifest.taskSets.v2, "string");
    assert.match(manifest.taskSets.v2, /^[0-9a-f]{64}$/);
    assert.notEqual(manifest.taskSets.v2, manifest.taskSets.v1);

    const v1Tasks = manifest.tasks.filter((task) => task.set === "v1");
    assert.equal(v1Tasks.length, 21);
  });
});
