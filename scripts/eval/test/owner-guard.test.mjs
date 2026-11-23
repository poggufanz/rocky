import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { verdict } from "../analyze.mjs";
import { ownerBaseline, ownerCheck } from "../owner-guard.mjs";
import { BatchLeakError, runBatch, scanRunArtifactsForSecrets } from "../runner.mjs";

function makeIsolatedOwner(baseDir) {
  const ownerHome = join(baseDir, "owner-home");
  const ownerConfigDir = join(baseDir, "owner-config");
  const ownerRockyHome = join(ownerHome, ".rocky");
  mkdirSync(join(ownerHome, ".claude"), { recursive: true });
  mkdirSync(ownerConfigDir, { recursive: true });
  mkdirSync(ownerRockyHome, { recursive: true });
  return { ownerHome, ownerConfigDir, ownerRockyHome };
}

function makeFakeDeps(owner, overrides = {}) {
  return {
    ownerHome: owner.ownerHome,
    ownerConfigDir: owner.ownerConfigDir,
    ownerRockyHome: owner.ownerRockyHome,
    resolveCommit: (ref) => (
      ref === "31128bc"
        ? "31128bc000000000000000000000000000000001"
        : "aaaaaaa000000000000000000000000000000002"
    ),
    getHeadCommit: () => "bbbbbbb000000000000000000000000000000003",
    getClaudeVersion: () => "2.1.330 (Claude Code)",
    packArm: async (sha, dir) => join(dir, `rocky-${sha}.tgz`),
    createSandbox: async ({ runId, root }) => {
      const dir = join(root, runId);
      const home = join(dir, "home");
      const configDir = join(home, ".claude");
      const rockyHome = join(dir, "rocky-home");
      const taskDir = join(dir, "task");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(rockyHome, { recursive: true });
      mkdirSync(taskDir, { recursive: true });
      return { dir, home, configDir, rockyHome, taskDir, prefixBin: null, env: {} };
    },
    materializeTask: async (task, sandbox, arm) => {
      writeFileSync(join(sandbox.taskDir, "solution.txt"), `arm=${arm} task=${task.id}\n`, "utf8");
      return { runs: [], cards: 0 };
    },
    runClaude: async () => ({
      stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
      stderr: "clean stderr\n",
      exitCode: 0,
      timedOut: false,
    }),
    accept: async () => ({ solved: true, reason: "ok" }),
    destroySandbox: async (sandbox) => {
      rmSync(sandbox.dir, { recursive: true, force: true });
    },
    sweepStrays: async () => 0,
    assertRootClean: () => {},
    log: () => {},
    ...overrides,
  };
}

describe("owner-guard unit checks", () => {
  test("records appended under the eval root are a leak, others are not", () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-owner-guard-mem-"));
    try {
      const { ownerHome } = makeIsolatedOwner(baseTmp);
      const memPath = join(ownerHome, ".rocky", "memory.jsonl");
      const evalRoot = join(baseTmp, "eval-root");
      const siblingRoot = join(baseTmp, "eval-root-other");
      mkdirSync(evalRoot, { recursive: true });

      // Pre-existing record under evalRoot before baseline must NOT be counted.
      writeFileSync(
        memPath,
        `${JSON.stringify({ kind: "failure", cwd: join(evalRoot, "old-run", "task") })}\n`,
        "utf8",
      );

      const baseline = ownerBaseline({ ownerHome });
      assert.equal(baseline.memoryPath, memPath);
      assert.ok(baseline.memoryBytes > 0);
      // Baseline stores metadata only, never file contents.
      assert.equal(JSON.stringify(baseline).includes("old-run"), false);

      // Append 1 record outside evalRoot (including sibling prefix) -> not a leak.
      const outsideLine = `${JSON.stringify({ kind: "failure", cwd: join(siblingRoot, "r1", "task") })}\n`;
      writeFileSync(memPath, readFileSync(memPath, "utf8") + outsideLine, "utf8");

      const cleanCheck = ownerCheck(baseline, { evalRoot });
      assert.equal(cleanCheck.appendedTotal, 1);
      assert.equal(cleanCheck.appendedUnderEvalRoot, 0);
      assert.equal(cleanCheck.memoryTruncated, false);
      assert.deepEqual(cleanCheck.settingsChanged, []);
      assert.deepEqual(cleanCheck.settingsTouched, []);
      assert.equal(cleanCheck.leak, false);

      // Append 1 record under evalRoot -> total 2, underEvalRoot 1, leak true.
      const leakLine = `${JSON.stringify({ kind: "failure", cwd: join(evalRoot, "r1", "task") })}\n`;
      writeFileSync(memPath, readFileSync(memPath, "utf8") + leakLine, "utf8");

      const leakCheck = ownerCheck(baseline, { evalRoot });
      assert.equal(leakCheck.appendedTotal, 2);
      assert.equal(leakCheck.appendedUnderEvalRoot, 1);
      assert.equal(leakCheck.memoryTruncated, false);
      assert.equal(leakCheck.leak, true);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("win32 comparison ignores case and the short-path form", () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-owner-guard-win32-"));
    try {
      const { ownerHome } = makeIsolatedOwner(baseTmp);
      const memPath = join(ownerHome, ".rocky", "memory.jsonl");
      writeFileSync(memPath, "", "utf8");

      const baseline = ownerBaseline({ ownerHome });

      // Case-insensitive match on win32.
      writeFileSync(
        memPath,
        `${JSON.stringify({ kind: "failure", cwd: "C:\\USERS\\X\\APPDATA\\LOCAL\\TEMP\\eval\\r1\\task" })}\n`,
        "utf8",
      );
      const caseRes = ownerCheck(baseline, {
        evalRoot: "c:\\Users\\x\\AppData\\Local\\Temp\\eval",
        platform: "win32",
      });
      assert.equal(caseRes.appendedTotal, 1);
      assert.equal(caseRes.appendedUnderEvalRoot, 1);
      assert.equal(caseRes.leak, true);

      // Short-path form (8.3) resolved via realpathSync.native-style resolver:
      // evalRoot in short form vs cwd in long form, and cwd in short form vs evalRoot in long form.
      const fakeRealpath = (p) => {
        const lower = String(p).toLowerCase();
        if (lower === "c:\\users\\runner~1\\appdata\\local\\temp\\eval") {
          return "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\eval";
        }
        if (lower === "c:\\users\\runneradmin\\appdata\\local\\temp\\eval") {
          return "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\eval";
        }
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      };

      // Long cwd vs short evalRoot.
      writeFileSync(
        memPath,
        `${JSON.stringify({ kind: "failure", cwd: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\eval\\r2\\task" })}\n`,
        "utf8",
      );
      const shortRootRes = ownerCheck(baseline, {
        evalRoot: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\eval",
        platform: "win32",
        realpath: fakeRealpath,
      });
      assert.equal(shortRootRes.appendedUnderEvalRoot, 1);
      assert.equal(shortRootRes.leak, true);

      // Short cwd (deleted leaf dir) vs long evalRoot.
      writeFileSync(
        memPath,
        `${JSON.stringify({ kind: "failure", cwd: "C:\\USERS\\RUNNER~1\\APPDATA\\LOCAL\\TEMP\\EVAL\\r3\\task" })}\n`,
        "utf8",
      );
      const shortCwdRes = ownerCheck(baseline, {
        evalRoot: "c:\\Users\\runneradmin\\AppData\\Local\\Temp\\eval",
        platform: "win32",
        realpath: fakeRealpath,
      });
      assert.equal(shortCwdRes.appendedUnderEvalRoot, 1);
      assert.equal(shortCwdRes.leak, true);

      // POSIX comparison stays case-sensitive.
      writeFileSync(
        memPath,
        `${JSON.stringify({ kind: "failure", cwd: "/TMP/EVAL/r1/task" })}\n`,
        "utf8",
      );
      const posixRes = ownerCheck(baseline, {
        evalRoot: "/tmp/eval",
        platform: "linux",
        realpath: fakeRealpath,
      });
      assert.equal(posixRes.appendedTotal, 1);
      assert.equal(posixRes.appendedUnderEvalRoot, 0);
      assert.equal(posixRes.leak, false);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("settings content change is a leak, mtime-only touch is not", () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-owner-guard-settings-"));
    try {
      const { ownerHome, ownerConfigDir } = makeIsolatedOwner(baseTmp);
      const homeSettings = join(ownerHome, ".claude", "settings.json");
      const envSettings = join(ownerConfigDir, "settings.json");
      const evalRoot = join(baseTmp, "eval-root");

      writeFileSync(homeSettings, '{"theme":"dark","token":"never-store-in-baseline"}\n', "utf8");
      writeFileSync(envSettings, '{"hooks":{}}\n', "utf8");

      const baseline = ownerBaseline({ ownerHome, ownerConfigDir });
      assert.equal(baseline.settings.length, 2);
      assert.equal(JSON.stringify(baseline).includes("never-store-in-baseline"), false);

      // Touch mtime only on homeSettings -> reported in settingsTouched, NOT a leak.
      const future = new Date(Date.now() + 60_000);
      utimesSync(homeSettings, future, future);

      const touched = ownerCheck(baseline, { evalRoot });
      assert.deepEqual(touched.settingsChanged, []);
      assert.deepEqual(touched.settingsTouched, [homeSettings]);
      assert.equal(touched.leak, false);

      // Modify content of envSettings -> reported in settingsChanged, leak = true.
      writeFileSync(envSettings, '{"hooks":{"SessionStart":[]}}\n', "utf8");

      const changed = ownerCheck(baseline, { evalRoot });
      assert.deepEqual(changed.settingsChanged, [envSettings]);
      assert.deepEqual(changed.settingsTouched, [homeSettings]);
      assert.equal(changed.leak, true);

      // Deleting a baselined settings file or creating a previously absent one is also a leak.
      rmSync(envSettings, { force: true });
      const deleted = ownerCheck(baseline, { evalRoot });
      assert.deepEqual(deleted.settingsChanged, [envSettings]);
      assert.equal(deleted.leak, true);

      const absentConfigDir = join(baseTmp, "absent-config");
      const absentSettings = join(absentConfigDir, "settings.json");
      const baselineAbsent = ownerBaseline({ ownerHome, ownerConfigDir: absentConfigDir });
      assert.equal(ownerCheck(baselineAbsent, { evalRoot }).leak, false);
      mkdirSync(absentConfigDir, { recursive: true });
      writeFileSync(absentSettings, '{"created":true}\n', "utf8");
      const created = ownerCheck(baselineAbsent, { evalRoot });
      assert.deepEqual(created.settingsChanged, [absentSettings]);
      assert.equal(created.leak, true);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("handles partial trailing line, truncation/rotation, chunked reads, and ownerRockyHome", () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-owner-guard-edges-"));
    try {
      const { ownerHome } = makeIsolatedOwner(baseTmp);
      const customRocky = join(baseTmp, "custom-rocky-home");
      mkdirSync(customRocky, { recursive: true });
      const memPath = join(customRocky, "memory.jsonl");
      const evalRoot = join(baseTmp, "eval-root");

      const initialContent = `${JSON.stringify({ kind: "failure", cwd: join(baseTmp, "elsewhere"), pad: "x".repeat(200) })}\n`;
      writeFileSync(memPath, initialContent, "utf8");

      const baseline = ownerBaseline({ ownerHome, ownerRockyHome: customRocky });
      assert.equal(baseline.memoryPath, memPath);

      // Append a partial (non-newline-terminated) line under evalRoot -> ignored.
      const partial = JSON.stringify({ kind: "failure", cwd: join(evalRoot, "r1", "task") });
      writeFileSync(memPath, initialContent + partial, "utf8");
      const partialRes = ownerCheck(baseline, { evalRoot });
      assert.equal(partialRes.appendedTotal, 0);
      assert.equal(partialRes.appendedUnderEvalRoot, 0);
      assert.equal(partialRes.memoryTruncated, false);
      assert.equal(partialRes.leak, false);

      // Terminate the line with newline -> now detected.
      writeFileSync(memPath, `${initialContent}${partial}\n`, "utf8");
      const completeRes = ownerCheck(baseline, { evalRoot });
      assert.equal(completeRes.appendedTotal, 1);
      assert.equal(completeRes.appendedUnderEvalRoot, 1);
      assert.equal(completeRes.leak, true);

      // Truncate/rotate to smaller file with NO evalRoot records -> memoryTruncated: true, leak: false.
      const rotatedClean = `${JSON.stringify({ kind: "failure", cwd: join(baseTmp, "owner-work") })}\n`;
      assert.ok(Buffer.byteLength(rotatedClean, "utf8") < baseline.memoryBytes);
      writeFileSync(memPath, rotatedClean, "utf8");
      const truncClean = ownerCheck(baseline, { evalRoot });
      assert.equal(truncClean.memoryTruncated, true);
      assert.equal(truncClean.appendedTotal, 1);
      assert.equal(truncClean.appendedUnderEvalRoot, 0);
      assert.equal(truncClean.leak, false);

      // Truncate/rotate to smaller file WITH evalRoot record -> memoryTruncated: true, leak: true.
      const rotatedLeak = `${JSON.stringify({ kind: "failure", cwd: join(evalRoot, "r2") })}\n`;
      assert.ok(Buffer.byteLength(rotatedLeak, "utf8") < baseline.memoryBytes);
      writeFileSync(memPath, rotatedLeak, "utf8");
      const truncLeak = ownerCheck(baseline, { evalRoot });
      assert.equal(truncLeak.memoryTruncated, true);
      assert.equal(truncLeak.appendedUnderEvalRoot, 1);
      assert.equal(truncLeak.leak, true);

      // Chunked reading across > 64 KiB boundary.
      const bigPad = "z".repeat(40_000);
      const chunkLines = [
        JSON.stringify({ kind: "failure", cwd: join(baseTmp, "other1"), pad: bigPad }),
        JSON.stringify({ kind: "failure", cwd: join(baseTmp, "other2"), pad: bigPad }),
        JSON.stringify({ kind: "failure", cwd: join(evalRoot, "r-big", "task"), pad: "ok" }),
      ].join("\n") + "\n";
      writeFileSync(memPath, initialContent + chunkLines, "utf8");
      const chunkRes = ownerCheck(baseline, { evalRoot });
      assert.equal(chunkRes.memoryTruncated, false);
      assert.equal(chunkRes.appendedTotal, 3);
      assert.equal(chunkRes.appendedUnderEvalRoot, 1);
      assert.equal(chunkRes.leak, true);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });
});

describe("runner token-scan finally path, scanErrors, stop-on-leak, and owner-guard wiring", () => {
  test("copy throwing after a token-bearing file was copied marks token_leak (not harness_crash) and stops batch with exit 3", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-copy-throw-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-copy-throw-secret-11111";
    const startedRuns = [];
    const logs = [];

    try {
      const deps = makeFakeDeps(owner, {
        materializeTask: async (task, sandbox, arm) => {
          writeFileSync(join(sandbox.taskDir, "a-token.txt"), `leaked=${token}\n`, "utf8");
          writeFileSync(join(sandbox.taskDir, "b-fail.txt"), `arm=${arm} task=${task.id}\n`, "utf8");
          return { runs: [], cards: 0 };
        },
        runClaude: async ({ runId }) => {
          startedRuns.push(runId);
          return {
            stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        },
        copyFileSync: (src, dest) => {
          if (String(src).endsWith("b-fail.txt")) {
            const err = new Error("EIO: simulated copy failure after token file");
            err.code = "EIO";
            throw err;
          }
          return copyFileSync(src, dest);
        },
        log: (line) => logs.push(line),
      });

      let caught = null;
      try {
        await runBatch(
          {
            outDir,
            rootDir,
            cacheDir,
            beforeRef: "31128bc",
            afterRef: "origin/main",
            auth: { kind: "token" },
            secrets: [token],
            concurrency: 1,
            k: 1,
            seed: 7,
            only: ["SMOKE"],
          },
          deps,
        );
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof BatchLeakError, `expected BatchLeakError, got ${String(caught)}`);
      assert.equal(caught.exitCode, 3);
      assert.equal(startedRuns.length, 1, `leak must stop new runs, started: ${JSON.stringify(startedRuns)}`);

      const firstRunId = startedRuns[0];
      const runJson = JSON.parse(readFileSync(join(outDir, "runs", firstRunId, "run.json"), "utf8"));
      assert.equal(runJson.invalid, "token_leak");
      assert.match(runJson.error, /simulated copy failure/);
      assert.ok(
        logs.some((line) => line.includes(firstRunId) && /token_leak/i.test(line)),
        `expected stderr line naming ${firstRunId}, got ${JSON.stringify(logs)}`,
      );

      // --retry-invalid must NEVER retry token_leak.
      const beforeRetryCount = startedRuns.length;
      const retryDeps = makeFakeDeps(owner, {
        runClaude: async ({ runId }) => {
          startedRuns.push(runId);
          return {
            stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        },
      });
      await runBatch(
        {
          outDir,
          rootDir,
          cacheDir,
          beforeRef: "31128bc",
          afterRef: "origin/main",
          auth: { kind: "token" },
          secrets: [token],
          concurrency: 1,
          k: 1,
          seed: 7,
          only: ["SMOKE"],
          retryInvalid: true,
        },
        retryDeps,
      );
      assert.equal(
        startedRuns.filter((id) => id === firstRunId).length,
        beforeRetryCount,
        "token_leak run must never be retried by --retry-invalid",
      );
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("scan read error on one file is recorded in run.json.scanErrors and still finds token in a later file", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-scan-err-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-later-file-secret-22222";
    const startedRuns = [];

    try {
      // Direct check on scanRunArtifactsForSecrets.
      const directDir = join(baseTmp, "direct-scan");
      mkdirSync(join(directDir, "final"), { recursive: true });
      writeFileSync(join(directDir, "final", "a-bad.txt"), "unreadable\n", "utf8");
      writeFileSync(join(directDir, "final", "b-leak.txt"), `here=${token}\n`, "utf8");

      const directRes = await scanRunArtifactsForSecrets(directDir, "none", [token], {
        openFile: async (filePath, flags) => {
          if (String(filePath).endsWith("a-bad.txt")) {
            const err = new Error("EACCES: permission denied");
            err.code = "EACCES";
            throw err;
          }
          return openFile(filePath, flags);
        },
      });
      assert.equal(directRes.leaked, true);
      assert.deepEqual(directRes.scanErrors, ["final/a-bad.txt"]);

      // End-to-end through runBatch: records scanErrors and marks token_leak.
      const deps = makeFakeDeps(owner, {
        materializeTask: async (_task, sandbox) => {
          writeFileSync(join(sandbox.taskDir, "a-unreadable.txt"), "blocked\n", "utf8");
          writeFileSync(join(sandbox.taskDir, "b-leaked.txt"), `tok=${token}\n`, "utf8");
          return { runs: [], cards: 0 };
        },
        runClaude: async ({ runId }) => {
          startedRuns.push(runId);
          return {
            stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        },
        openFile: async (filePath, flags) => {
          if (String(filePath).endsWith("a-unreadable.txt")) {
            const err = new Error("EACCES: simulated read failure");
            err.code = "EACCES";
            throw err;
          }
          return openFile(filePath, flags);
        },
      });

      let caught = null;
      try {
        await runBatch(
          {
            outDir,
            rootDir,
            cacheDir,
            beforeRef: "31128bc",
            afterRef: "origin/main",
            auth: { kind: "token" },
            secrets: [token],
            concurrency: 1,
            k: 1,
            seed: 7,
            only: ["SMOKE"],
          },
          deps,
        );
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof BatchLeakError);
      assert.equal(caught.exitCode, 3);
      assert.equal(startedRuns.length, 1);

      const firstRunId = startedRuns[0];
      const runJson = JSON.parse(readFileSync(join(outDir, "runs", firstRunId, "run.json"), "utf8"));
      assert.equal(runJson.invalid, "token_leak");
      assert.deepEqual(runJson.scanErrors, ["final/a-unreadable.txt"]);

      // Also verify token_leak overrides timeout when a timed-out run leaves a token in final/.
      const outTimeout = join(baseTmp, "out-timeout");
      const timeoutRuns = [];
      let timeoutCaught = null;
      try {
        await runBatch(
          {
            outDir: outTimeout,
            rootDir,
            cacheDir,
            beforeRef: "31128bc",
            afterRef: "origin/main",
            auth: { kind: "token" },
            secrets: [token],
            concurrency: 1,
            k: 1,
            seed: 7,
            only: ["SMOKE"],
          },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "timeout-leak.txt"), `tok=${token}\n`, "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId }) => {
              timeoutRuns.push(runId);
              return {
                stdout: "",
                stderr: "timed out\n",
                exitCode: null,
                timedOut: true,
              };
            },
          }),
        );
      } catch (error) {
        timeoutCaught = error;
      }
      assert.ok(timeoutCaught instanceof BatchLeakError);
      assert.equal(timeoutCaught.exitCode, 3);
      assert.equal(timeoutRuns.length, 1);
      const timeoutRunJson = JSON.parse(readFileSync(join(outTimeout, "runs", timeoutRuns[0], "run.json"), "utf8"));
      assert.equal(timeoutRunJson.timedOut, true);
      assert.equal(timeoutRunJson.invalid, "token_leak");
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("token_leak stops new runs while letting in-flight runs finish and publish", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-inflight-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-inflight-secret-33333";
    const startedRuns = [];
    const logs = [];

    try {
      const deps = makeFakeDeps(owner, {
        runClaude: async ({ runId }) => {
          const order = startedRuns.push(runId);
          if (order === 1) {
            await new Promise((r) => setTimeout(r, 20));
            return {
              stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
              stderr: `oops ${token}\n`,
              exitCode: 0,
              timedOut: false,
            };
          }
          // Second concurrent run stays in-flight slightly longer than the first.
          await new Promise((r) => setTimeout(r, 90));
          return {
            stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            stderr: "clean\n",
            exitCode: 0,
            timedOut: false,
          };
        },
        log: (line) => logs.push(line),
      });

      let caught = null;
      try {
        await runBatch(
          {
            outDir,
            rootDir,
            cacheDir,
            beforeRef: "31128bc",
            afterRef: "origin/main",
            auth: { kind: "token" },
            secrets: [token],
            concurrency: 2,
            k: 2,
            seed: 7,
            only: ["SMOKE"],
          },
          deps,
        );
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof BatchLeakError);
      assert.equal(caught.exitCode, 3);
      // Exactly the 2 concurrent runs started; the remaining 4 never started.
      assert.equal(startedRuns.length, 2, `expected only 2 in-flight runs, got ${JSON.stringify(startedRuns)}`);

      const firstRun = JSON.parse(readFileSync(join(outDir, "runs", startedRuns[0], "run.json"), "utf8"));
      const secondRun = JSON.parse(readFileSync(join(outDir, "runs", startedRuns[1], "run.json"), "utf8"));
      assert.equal(firstRun.invalid, "token_leak");
      assert.equal(secondRun.invalid, null);
      assert.ok(logs.some((line) => line.includes(startedRuns[0])));
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("runner stores ownerBaseline once, reuses it on resume, writes ownerCheck to batch.json, and stops on owner leak (exit 3)", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-batch-owner-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const memPath = join(owner.ownerRockyHome, "memory.jsonl");
    const settingsPath = join(owner.ownerHome, ".claude", "settings.json");

    writeFileSync(memPath, '{"kind":"failure","cwd":"/prior/work"}\n', "utf8");
    writeFileSync(settingsPath, '{"theme":"dark"}\n', "utf8");

    try {
      let baselineCalls = 0;
      let checkCalls = 0;
      const startedRuns = [];

      const commonOpts = {
        outDir,
        rootDir,
        cacheDir,
        beforeRef: "31128bc",
        afterRef: "origin/main",
        auth: { kind: "token" },
        secrets: [],
        concurrency: 1,
        k: 1,
        seed: 7,
        only: ["SMOKE"],
      };

      const trackingDeps = (extra = {}) => makeFakeDeps(owner, {
        ownerBaseline: (arg) => {
          baselineCalls += 1;
          return ownerBaseline(arg);
        },
        ownerCheck: (base, arg) => {
          checkCalls += 1;
          return ownerCheck(base, arg);
        },
        ...extra,
      });

      // Clean batch: baseline taken once, ownerCheck run after each run (3) + batch end (1) = 4.
      await runBatch(commonOpts, trackingDeps({
        runClaude: async ({ runId }) => {
          startedRuns.push(runId);
          return {
            stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        },
      }));

      assert.equal(baselineCalls, 1);
      assert.equal(checkCalls, 4);
      const batchAfterClean = JSON.parse(readFileSync(join(outDir, "batch.json"), "utf8"));
      assert.equal(batchAfterClean.ownerBaseline.memoryPath, memPath);
      assert.equal(batchAfterClean.ownerCheck.leak, false);
      assert.equal(batchAfterClean.ownerCheck.appendedUnderEvalRoot, 0);

      // Resume must NOT take a new baseline; reuses the stored one even if memory grew outside evalRoot.
      writeFileSync(
        memPath,
        readFileSync(memPath, "utf8") + `${JSON.stringify({ kind: "failure", cwd: join(baseTmp, "owner-other") })}\n`,
        "utf8",
      );
      await runBatch(commonOpts, trackingDeps());
      assert.equal(baselineCalls, 1, "resume must reuse stored ownerBaseline without taking a new one");
      const batchAfterResume = JSON.parse(readFileSync(join(outDir, "batch.json"), "utf8"));
      assert.equal(batchAfterResume.ownerBaseline.memoryBytes, batchAfterClean.ownerBaseline.memoryBytes);
      assert.equal(batchAfterResume.ownerCheck.appendedTotal, 1);
      assert.equal(batchAfterResume.ownerCheck.leak, false);

      // Now test owner leak mid-batch in a fresh batch: stops after the leaking run with exit 3.
      const outDirLeak = join(baseTmp, "out-leak");
      const startedLeakRuns = [];
      let caught = null;
      try {
        await runBatch(
          { ...commonOpts, outDir: outDirLeak },
          makeFakeDeps(owner, {
            runClaude: async ({ runId, sandbox }) => {
              startedLeakRuns.push(runId);
              if (startedLeakRuns.length === 1) {
                // Simulate a leaked write into the owner's memory.jsonl with cwd inside evalRoot.
                writeFileSync(
                  memPath,
                  readFileSync(memPath, "utf8") + `${JSON.stringify({ kind: "failure", cwd: sandbox.taskDir })}\n`,
                  "utf8",
                );
              }
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
          }),
        );
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof BatchLeakError, `expected BatchLeakError, got ${String(caught)}`);
      assert.equal(caught.exitCode, 3);
      assert.equal(startedLeakRuns.length, 1, "owner leak must stop subsequent runs");

      const leakedBatch = JSON.parse(readFileSync(join(outDirLeak, "batch.json"), "utf8"));
      assert.equal(leakedBatch.ownerCheck.leak, true);
      assert.equal(leakedBatch.ownerCheck.appendedUnderEvalRoot, 1);
      assert.equal(existsSync(join(outDirLeak, "runs", startedLeakRuns[0], "run.json")), true);

      // verdict() marks the batch invalid when reading ownerCheck from batch.json provenance.
      const v = verdict({
        runs: [
          {
            taskId: "T01",
            arm: "none",
            block: 1,
            invalid: null,
            solved: true,
            repeatFailures: 0,
            turnsToPass: 2,
            numTurns: 3,
            wallMs: 500,
            noteBytes: 0,
            noteDelivered: null,
            staleRepeat: null,
            leak: [],
          },
        ],
        provenance: leakedBatch,
        resamples: 100,
      });
      assert.equal(v.batchValid, false);
      assert.equal(v.leaks.ownerLeak, true);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });
});
