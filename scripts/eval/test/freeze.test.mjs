import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as freezeMod from "../freeze.mjs";

const { computeManifest } = freezeMod;
const PINNED_V1_SHA256 = "3bf31ff00c6337c38646b83112576e37e545a2298f6302ddcadd7d4cf0e2d62a";
const tasksJsonPath = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "tasks", "tasks.json");

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

  test("unrelated top-level file keeps v1 and v2 hashes unchanged", () => {
    const base = computeManifest();
    const withExtra = computeManifest({
      extraFiles: {
        "new-task-catalog.json": "0".repeat(64),
        "NOTES.txt": "1".repeat(64),
        "unreferenced-fixture/repo/index.js": "2".repeat(64),
      },
    });
    assert.equal(withExtra.files["new-task-catalog.json"], "0".repeat(64));
    assert.equal(withExtra.taskSets.v1, PINNED_V1_SHA256);
    assert.equal(withExtra.taskSetSha256, PINNED_V1_SHA256);
    assert.equal(withExtra.taskSets.v2, base.taskSets.v2);

    const rawTasks = JSON.parse(readFileSync(tasksJsonPath, "utf8"));
    const injectedFiles = {
      ...base.files,
      "new-task-catalog.json": "0".repeat(64),
    };
    const injectedDiskFiles = Object.keys(injectedFiles).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.equal(typeof freezeMod.computeTaskSetSha256, "function");
    assert.equal(
      freezeMod.computeTaskSetSha256("v1", rawTasks, injectedDiskFiles, injectedFiles),
      PINNED_V1_SHA256,
    );
    assert.equal(
      freezeMod.computeTaskSetSha256("v2", rawTasks, injectedDiskFiles, injectedFiles),
      base.taskSets.v2,
    );
  });
});
