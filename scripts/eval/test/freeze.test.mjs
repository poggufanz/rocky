import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeLine } from "../../../dist/core/fingerprint.js";
import * as freezeMod from "../freeze.mjs";

const { computeManifest, validateTaskBehaviors } = freezeMod;
const PINNED_V1_SHA256 = "3bf31ff00c6337c38646b83112576e37e545a2298f6302ddcadd7d4cf0e2d62a";
const tasksJsonPath = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "tasks", "tasks.json");

function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function writeTempFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function createTempCaseFixture(tasksDir, fixtureName, { initialLine, wrong1Line, wrong2Line }) {
  const fixtureDir = join(tasksDir, fixtureName);
  const pkgJson = JSON.stringify(
    {
      name: `eval-${fixtureName}`,
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { test: "node test/run.mjs" },
    },
    null,
    2,
  ) + "\n";
  const testRun = [
    'import { mode } from "../src/impl.js";',
    `if (mode === "initial") { process.stderr.write(${JSON.stringify(`${initialLine}\n`)}); process.exit(1); }`,
    `if (mode === "wrong-1") { process.stderr.write(${JSON.stringify(`${wrong1Line}\n`)}); process.exit(1); }`,
    `if (mode === "wrong-2") { process.stderr.write(${JSON.stringify(`${wrong2Line}\n`)}); process.exit(1); }`,
    `process.stdout.write("eval-accept: ${fixtureName} ok\\n");`,
    "",
  ].join("\n");

  writeTempFile(join(fixtureDir, "repo", "package.json"), pkgJson);
  writeTempFile(join(fixtureDir, "repo", "test", "run.mjs"), testRun);
  writeTempFile(join(fixtureDir, "repo", "src", "impl.js"), 'export const mode = "initial";\n');
  writeTempFile(join(fixtureDir, "patches", "wrong-1", "src", "impl.js"), 'export const mode = "wrong-1";\n');
  writeTempFile(join(fixtureDir, "patches", "wrong-2", "src", "impl.js"), 'export const mode = "wrong-2";\n');
  writeTempFile(join(fixtureDir, "patches", "fix", "src", "impl.js"), 'export const mode = "fix";\n');

  const task = {
    id: "W99",
    set: "v2",
    kind: "trap",
    fixture: fixtureName,
    prompt: "npm test fails in this repository. Find the cause and fix it so `npm test` passes. Do not edit files under test/.",
    target: {
      command: "npm test",
      aliases: ["^npm (run )?test\\b", "^node test/run\\.mjs\\b"],
    },
    trapLine: initialLine,
    normalizedTrapLine: normalizeLine(initialLine),
    acceptLine: `eval-accept: ${fixtureName} ok`,
    history: {
      wrong: ["wrong-1", "wrong-2"],
      fix: "fix",
    },
    protected: ["test/"],
  };

  return {
    v: 1,
    tasks: [task],
    files: {
      [`${fixtureName}/repo/test/run.mjs`]: sha256Text(testRun),
    },
  };
}

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

  test("freeze rejects a case table whose successive failures normalise differently", async () => {
    const tempTasksDir = mkdtempSync(join(tmpdir(), "rocky-freeze-norm-test-"));
    try {
      const initialLine = "AssertionError: case 1: expected 10 got 9";
      const wrong1WordDiff = "AssertionError: case 2: expected total got 9";
      const wrong2NumDiff = "AssertionError: case 3: expected 30 got 29";

      const badManifest = createTempCaseFixture(tempTasksDir, "word-drift", {
        initialLine,
        wrong1Line: wrong1WordDiff,
        wrong2Line: wrong2NumDiff,
      });

      const expectedNormA = normalizeLine(initialLine);
      const expectedNormB = normalizeLine(wrong1WordDiff);
      await assert.rejects(
        () => validateTaskBehaviors(badManifest, { tasksDir: tempTasksDir }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(msg.includes("W99"), `expected task id in error, got: ${msg}`);
          assert.ok(msg.includes(expectedNormA), `expected initial normalized line in error, got: ${msg}`);
          assert.ok(msg.includes(expectedNormB), `expected wrong-1 normalized line in error, got: ${msg}`);
          return true;
        },
      );

      const goodManifest = createTempCaseFixture(tempTasksDir, "number-only-drift", {
        initialLine,
        wrong1Line: "AssertionError: case 2: expected 20 got 19",
        wrong2Line: wrong2NumDiff,
      });
      await validateTaskBehaviors(goodManifest, { tasksDir: tempTasksDir });
    } finally {
      rmSync(tempTasksDir, { recursive: true, force: true });
    }
  });

  test("freeze rejects a v2 trap whose wrong overlay keeps the same raw failing line", async () => {
    const tempTasksDir = mkdtempSync(join(tmpdir(), "rocky-freeze-raw-test-"));
    try {
      const sameLineManifest = createTempCaseFixture(tempTasksDir, "static-case", {
        initialLine: "AssertionError: case 1: expected 10 got 9",
        wrong1Line: "AssertionError: case 1: expected 10 got 9",
        wrong2Line: "AssertionError: case 2: expected 20 got 19",
      });
      await assert.rejects(
        () => validateTaskBehaviors(sameLineManifest, { tasksDir: tempTasksDir }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(msg.includes("W99"), `expected task id in error, got: ${msg}`);
          assert.ok(msg.includes("wrong-1"), `expected wrong-1 in error, got: ${msg}`);
          assert.ok(
            msg.includes("raw failing line did not change"),
            `expected raw-change diagnostic in error, got: ${msg}`,
          );
          return true;
        },
      );

      const sameWrong2Manifest = createTempCaseFixture(tempTasksDir, "static-case-2", {
        initialLine: "AssertionError: case 1: expected 10 got 9",
        wrong1Line: "AssertionError: case 2: expected 20 got 19",
        wrong2Line: "AssertionError: case 2: expected 20 got 19",
      });
      await assert.rejects(
        () => validateTaskBehaviors(sameWrong2Manifest, { tasksDir: tempTasksDir }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(msg.includes("W99"), `expected task id in error, got: ${msg}`);
          assert.ok(msg.includes("wrong-2"), `expected wrong-2 in error, got: ${msg}`);
          assert.ok(
            msg.includes("raw failing line did not change"),
            `expected raw-change diagnostic in error, got: ${msg}`,
          );
          return true;
        },
      );
    } finally {
      rmSync(tempTasksDir, { recursive: true, force: true });
    }
  });

  test("freeze rejects a v2 trap whose wrong overlay does not advance the case index", async () => {
    const tempTasksDir = mkdtempSync(join(tmpdir(), "rocky-freeze-case-index-test-"));
    try {
      const sameCaseChangedValueManifest = createTempCaseFixture(tempTasksDir, "same-index-changed-value", {
        initialLine: "AssertionError: case 2: expected 10 got 9",
        wrong1Line: "AssertionError: case 2: expected 10 got 8",
        wrong2Line: "AssertionError: case 3: expected 20 got 19",
      });
      await assert.rejects(
        () => validateTaskBehaviors(sameCaseChangedValueManifest, { tasksDir: tempTasksDir }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(msg.includes("W99"), `expected task id in error, got: ${msg}`);
          assert.ok(msg.includes("wrong-1"), `expected wrong-1 in error, got: ${msg}`);
          assert.ok(
            msg.includes("case index did not advance"),
            `expected case-index-advance diagnostic in error, got: ${msg}`,
          );
          return true;
        },
      );

      const sameCaseWrong2Manifest = createTempCaseFixture(tempTasksDir, "same-index-wrong-2", {
        initialLine: "AssertionError: case 2: expected 10 got 9",
        wrong1Line: "AssertionError: case 3: expected 20 got 19",
        wrong2Line: "AssertionError: case 3: expected 20 got 18",
      });
      await assert.rejects(
        () => validateTaskBehaviors(sameCaseWrong2Manifest, { tasksDir: tempTasksDir }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(msg.includes("W99"), `expected task id in error, got: ${msg}`);
          assert.ok(msg.includes("wrong-2"), `expected wrong-2 in error, got: ${msg}`);
          assert.ok(
            msg.includes("case index did not advance"),
            `expected case-index-advance diagnostic in error, got: ${msg}`,
          );
          return true;
        },
      );

      const lowerCaseManifest = createTempCaseFixture(tempTasksDir, "lower-index", {
        initialLine: "AssertionError: case 2: expected 10 got 9",
        wrong1Line: "AssertionError: case 1: expected 5 got 4",
        wrong2Line: "AssertionError: case 3: expected 20 got 19",
      });
      await assert.rejects(
        () => validateTaskBehaviors(lowerCaseManifest, { tasksDir: tempTasksDir }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(msg.includes("W99"), `expected task id in error, got: ${msg}`);
          assert.ok(msg.includes("wrong-1"), `expected wrong-1 in error, got: ${msg}`);
          assert.ok(
            msg.includes("case index did not advance"),
            `expected case-index-advance diagnostic in error, got: ${msg}`,
          );
          return true;
        },
      );
    } finally {
      rmSync(tempTasksDir, { recursive: true, force: true });
    }
  });
});
