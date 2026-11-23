import assert from "node:assert/strict";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { verdict } from "../analyze.mjs";
import { evaluateBatch } from "../evaluate.mjs";
import { ownerBaseline, ownerCheck } from "../owner-guard.mjs";
import {
  BatchLeakError,
  ProvenanceMismatchError,
  runBatch,
  scanRunArtifactsForSecrets,
} from "../runner.mjs";

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
      assert.equal(existsSync(join(outDir, "runs", firstRunId, "final", "a-token.txt")), false);
      assert.deepEqual(runJson.quarantined, ["final/a-token.txt"]);
      assert.match(runJson.error, /simulated copy failure/);
      assert.ok(
        logs.some((line) => line.includes(firstRunId) && /token_leak/i.test(line)),
        `expected stderr line naming ${firstRunId}, got ${JSON.stringify(logs)}`,
      );

      const haltedBatch = JSON.parse(readFileSync(join(outDir, "batch.json"), "utf8"));
      assert.equal(haltedBatch.halted?.reason, "token_leak");
      assert.equal(haltedBatch.halted?.runId, firstRunId);
      assert.equal(typeof haltedBatch.halted?.at, "string");

      // Resume of a halted batch (even with --retry-invalid) exits 3 before packing, starting zero runs.
      const beforeRetryCount = startedRuns.length;
      let resumePackCalls = 0;
      const resumeLogs = [];
      const retryDeps = makeFakeDeps(owner, {
        packArm: async (sha, dir) => {
          resumePackCalls += 1;
          return join(dir, `rocky-${sha}.tgz`);
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
        log: (line) => resumeLogs.push(line),
      });
      await assert.rejects(
        () => runBatch(
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
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );
      assert.equal(resumePackCalls, 0, "halted resume must not pack arms");
      assert.equal(
        startedRuns.length,
        beforeRetryCount,
        "halted resume must start zero runs",
      );
      assert.ok(
        resumeLogs.some((line) => /token_leak/.test(line)),
        `expected halted resume stderr naming token_leak, got ${JSON.stringify(resumeLogs)}`,
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
      assert.deepEqual(directRes.quarantined, ["final/b-leak.txt"]);
      assert.deepEqual(directRes.scanErrors, ["final/a-bad.txt"]);
      assert.equal(existsSync(join(directDir, "final", "b-leak.txt")), false);

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
      assert.deepEqual(runJson.quarantined, ["final/b-leaked.txt"]);
      assert.equal(existsSync(join(outDir, "runs", firstRunId, "final", "b-leaked.txt")), false);
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
      assert.deepEqual(timeoutRunJson.quarantined, ["final/timeout-leak.txt"]);
      assert.equal(existsSync(join(outTimeout, "runs", timeoutRuns[0], "final", "timeout-leak.txt")), false);
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
      assert.equal(leakedBatch.ownerLeakLatched, true);
      assert.equal(leakedBatch.halted?.reason, "owner_leak");

      // Resume of the owner-leak halted batch exits 3 before packing, starting zero runs.
      let packCallsOnHalted = 0;
      const resumedRuns = [];
      const resumeLogs = [];
      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outDirLeak },
          makeFakeDeps(owner, {
            packArm: async (sha, dir) => {
              packCallsOnHalted += 1;
              return join(dir, `rocky-${sha}.tgz`);
            },
            runClaude: async ({ runId }) => {
              resumedRuns.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            log: (line) => resumeLogs.push(line),
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );
      assert.equal(packCallsOnHalted, 0);
      assert.equal(resumedRuns.length, 0);
      assert.ok(resumeLogs.some((line) => /owner_leak/.test(line)));
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("scans and quarantines copied artifacts before grading even when acceptance command would delete the file", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-pregrade-scan-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-pregrade-delete-secret-44444";
    const startedRuns = [];
    let sawTokenFileInGrader = null;
    let graderCalled = false;

    try {
      const deps = makeFakeDeps(owner, {
        materializeTask: async (_task, sandbox) => {
          writeFileSync(join(sandbox.taskDir, "ephemeral-token.txt"), `secret=${token}\n`, "utf8");
          writeFileSync(join(sandbox.taskDir, "clean.txt"), "ok\n", "utf8");
          return { runs: [], cards: 0 };
        },
        runClaude: async ({ runId, stdoutPath, stderrPath }) => {
          startedRuns.push(runId);
          // Also verify that if a raw token somehow landed in stderr.txt unredacted, it is quarantined too.
          writeFileSync(
            stdoutPath,
            `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
            "utf8",
          );
          writeFileSync(stderrPath, `raw-unredacted=${token}\n`, "utf8");
          return {
            exitCode: 0,
            timedOut: false,
            streamed: true,
            tokenLeaked: false,
            transcript: {
              nonEmptyLines: 1,
              malformedLineCount: 0,
              oversizedLineCount: 0,
              lastResult: { subtype: "success", is_error: false },
            },
          };
        },
        accept: async (_task, finalDir) => {
          graderCalled = true;
          const target = join(finalDir, "ephemeral-token.txt");
          sawTokenFileInGrader = existsSync(target);
          // Acceptance command attempts to delete the file; under the old order this hid the leak.
          rmSync(target, { force: true });
          return { solved: true, reason: "ok" };
        },
      });

      await assert.rejects(
        () => runBatch(
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
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(startedRuns.length, 1);
      assert.equal(graderCalled, true, "grader should still run after pre-grade scan");
      assert.equal(
        sawTokenFileInGrader,
        false,
        "leaking file must be quarantined BEFORE acceptance grader runs",
      );

      const firstRunDir = join(outDir, "runs", startedRuns[0]);
      const runJson = JSON.parse(readFileSync(join(firstRunDir, "run.json"), "utf8"));
      assert.equal(runJson.invalid, "token_leak");
      assert.equal("error" in runJson, false, "quarantined stderr.txt must not trigger incomplete-artifacts error");
      assert.deepEqual(runJson.quarantined, ["stderr.txt", "final/ephemeral-token.txt"]);
      assert.equal(existsSync(join(firstRunDir, "stderr.txt")), false);
      assert.equal(existsSync(join(firstRunDir, "final", "ephemeral-token.txt")), false);
      assert.equal(existsSync(join(firstRunDir, "final", "clean.txt")), true);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("resume refuses a batch with a published token_leak run even when batch.json.halted is absent", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-resume-published-leak-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-resume-published-55555";

    try {
      const commonOpts = {
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
      };

      // Run a leaking batch, then remove `halted` from batch.json to simulate a crash before batch.json update.
      await assert.rejects(
        () => runBatch(
          commonOpts,
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "leak.txt"), `tok=${token}\n`, "utf8");
              return { runs: [], cards: 0 };
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      const batchPath = join(outDir, "batch.json");
      const tampered = JSON.parse(readFileSync(batchPath, "utf8"));
      delete tampered.halted;
      writeFileSync(batchPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

      let packCalls = 0;
      const startedRuns = [];
      const logs = [];
      await assert.rejects(
        () => runBatch(
          commonOpts,
          makeFakeDeps(owner, {
            packArm: async (sha, dir) => {
              packCalls += 1;
              return join(dir, `rocky-${sha}.tgz`);
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
            log: (line) => logs.push(line),
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(packCalls, 0);
      assert.equal(startedRuns.length, 0);
      assert.ok(logs.some((line) => /token_leak/.test(line)));
      const recovered = JSON.parse(readFileSync(batchPath, "utf8"));
      assert.equal(recovered.halted?.reason, "token_leak");
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("dirty ownerCheck followed by a clean final check latches ownerLeakLatched and verdict marks batch invalid", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-latched-owner-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const settingsPath = join(owner.ownerHome, ".claude", "settings.json");
    const originalSettings = '{"theme":"dark"}\n';
    writeFileSync(settingsPath, originalSettings, "utf8");

    try {
      let checkCount = 0;
      const startedRuns = [];

      await assert.rejects(
        () => runBatch(
          {
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
          },
          makeFakeDeps(owner, {
            runClaude: async ({ runId }) => {
              startedRuns.push(runId);
              // Dirty settings during run 1.
              writeFileSync(settingsPath, '{"theme":"tampered"}\n', "utf8");
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            ownerCheck: (base, arg) => {
              checkCount += 1;
              if (checkCount === 2) {
                // Restore original settings before the final batch-end check so latest snapshot is clean.
                writeFileSync(settingsPath, originalSettings, "utf8");
              }
              return ownerCheck(base, arg);
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(startedRuns.length, 1);
      assert.equal(checkCount, 2);

      const batchJson = JSON.parse(readFileSync(join(outDir, "batch.json"), "utf8"));
      // Latest snapshot is clean, while ownerLeakLatched preserves the earlier confirmed leak.
      assert.equal(batchJson.ownerCheck.leak, false);
      assert.equal(batchJson.ownerLeakLatched, true);
      assert.equal(batchJson.halted?.reason, "owner_leak");

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
        provenance: batchJson,
        resamples: 100,
      });
      assert.equal(v.batchValid, false);
      assert.equal(v.leaks.ownerLeak, true);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("ownerCheck throw or persistence failure stops scheduling, records error, sets halt, and keeps exit 3 even after a known leak", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-check-err-"));
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-owner-err-secret-66666";

    try {
      const commonOpts = {
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
      };

      // Case 1: injected ownerCheck throw stops scheduling after run 1, records redacted error, sets halted, exits 3.
      const outThrow = join(baseTmp, "out-throw");
      const startedThrow = [];
      const throwLogs = [];
      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outThrow },
          makeFakeDeps(owner, {
            runClaude: async ({ runId }) => {
              startedThrow.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            ownerCheck: () => {
              throw new Error(`EACCES reading owner memory (${token})`);
            },
            log: (line) => throwLogs.push(line),
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(startedThrow.length, 1, "ownerCheck throw must stop further runs from starting");
      const throwBatch = JSON.parse(readFileSync(join(outThrow, "batch.json"), "utf8"));
      assert.equal(throwBatch.ownerCheckError, "EACCES reading owner memory (<redacted>)");
      assert.equal(throwBatch.halted?.reason, "owner_check_error");
      assert.equal(throwBatch.halted?.runId, startedThrow[0]);
      assert.equal(typeof throwBatch.halted?.at, "string");
      assert.ok(throwLogs.some((line) => /owner_check_error/.test(line)));

      // Resuming the owner_check_error halted batch starts zero runs and exits 3.
      let resumePackCalls = 0;
      const resumeStarted = [];
      const resumeLogs = [];
      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outThrow },
          makeFakeDeps(owner, {
            packArm: async (sha, dir) => {
              resumePackCalls += 1;
              return join(dir, `rocky-${sha}.tgz`);
            },
            runClaude: async ({ runId }) => {
              resumeStarted.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            log: (line) => resumeLogs.push(line),
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );
      assert.equal(resumePackCalls, 0);
      assert.equal(resumeStarted.length, 0);
      assert.ok(resumeLogs.some((line) => /owner_check_error/.test(line)));

      // Case 2: persisting ownerCheck fails once -> stops scheduling, records error + halt, exits 3.
      const outPersist = join(baseTmp, "out-persist");
      const startedPersist = [];
      let batchWriteCount = 0;
      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outPersist },
          makeFakeDeps(owner, {
            runClaude: async ({ runId }) => {
              startedPersist.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            writeBatchJson: (targetPath, data) => {
              batchWriteCount += 1;
              if (batchWriteCount === 2) {
                // Fail the first post-run ownerCheck persistence; allow the error-halt persist afterward.
                throw new Error("ENOSPC: simulated batch.json write error");
              }
              mkdirSync(join(targetPath, ".."), { recursive: true });
              writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );
      assert.equal(startedPersist.length, 1, "ownerCheck persist failure must stop further runs");
      const persistBatch = JSON.parse(readFileSync(join(outPersist, "batch.json"), "utf8"));
      assert.match(persistBatch.ownerCheckError, /ENOSPC/);
      assert.equal(persistBatch.halted?.reason, "owner_check_error");

      // Case 3: already-known token_leak followed by batch-end ownerCheck throw keeps exit 3 and token_leak halt.
      const outLeakThenErr = join(baseTmp, "out-leak-then-err");
      let leakCheckCalls = 0;
      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outLeakThenErr },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "leak.txt"), `tok=${token}\n`, "utf8");
              return { runs: [], cards: 0 };
            },
            ownerCheck: (base, arg) => {
              leakCheckCalls += 1;
              if (leakCheckCalls >= 2) {
                throw new Error("EIO on batch-end ownerCheck");
              }
              return ownerCheck(base, arg);
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );
      const leakErrBatch = JSON.parse(readFileSync(join(outLeakThenErr, "batch.json"), "utf8"));
      assert.equal(leakErrBatch.halted?.reason, "token_leak");
      assert.equal(leakErrBatch.ownerCheckError, "EIO on batch-end ownerCheck");
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("undeletable leaking file is truncated to zero bytes (or renamed to .quarantined and truncated), recorded with removed:false, and warned on stderr", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-undeletable-"));
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-undeletable-secret-77777";

    try {
      const commonOpts = {
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
      };

      // Case 1: rm always throws EPERM after retries -> direct truncate to 0 bytes.
      const outTrunc = join(baseTmp, "out-trunc");
      const startedTrunc = [];
      const logsTrunc = [];
      let rmAttempts = 0;

      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outTrunc },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "locked-leak.txt"), `secret=${token}\n`, "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId }) => {
              startedTrunc.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            rmSync: () => {
              rmAttempts += 1;
              const err = new Error(`EPERM: locked file (${token})`);
              err.code = "EPERM";
              throw err;
            },
            log: (line) => logsTrunc.push(line),
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(startedTrunc.length, 1);
      assert.equal(rmAttempts, 6, "deletion retries must be exhausted before fallback");
      const truncRunDir = join(outTrunc, "runs", startedTrunc[0]);
      const truncFile = join(truncRunDir, "final", "locked-leak.txt");
      assert.equal(existsSync(truncFile), true);
      assert.equal(readFileSync(truncFile, "utf8"), "", "undeletable leaking file must be truncated to zero bytes");
      assert.equal(lstatSync(truncFile).size, 0);

      const truncRunJson = JSON.parse(readFileSync(join(truncRunDir, "run.json"), "utf8"));
      assert.equal(truncRunJson.invalid, "token_leak");
      assert.equal(Array.isArray(truncRunJson.quarantined), true);
      assert.equal(truncRunJson.quarantined.length, 1);
      assert.equal(truncRunJson.quarantined[0].path, "final/locked-leak.txt");
      assert.equal(truncRunJson.quarantined[0].removed, false);
      assert.equal(truncRunJson.quarantined[0].error, "EPERM: locked file (<redacted>)");
      assert.equal(truncRunJson.quarantined[0].error.includes("\n"), false, "error must be message only");

      const truncBatchJson = JSON.parse(readFileSync(join(outTrunc, "batch.json"), "utf8"));
      assert.equal(truncBatchJson.halted?.reason, "token_leak");
      assert.ok(
        logsTrunc.some(
          (line) => line.includes("final/locked-leak.txt") && /delete/i.test(line) && !line.includes(token),
        ),
        `expected stderr naming file and asking owner to delete it, got ${JSON.stringify(logsTrunc)}`,
      );

      // Case 2: rm throws AND direct truncate throws -> rename to unique <name>.quarantined-<pid>-<random> and truncate to 0 bytes.
      const outRename = join(baseTmp, "out-rename");
      const startedRename = [];
      const logsRename = [];
      const quarantinedSuffixRe = /\.quarantined-\d+-[0-9a-f]+$/;

      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outRename },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "locked-leak.txt"), `secret=${token}\n`, "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId }) => {
              startedRename.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            rmSync: () => {
              const err = new Error("EIO: unlink denied");
              err.code = "EIO";
              throw err;
            },
            truncateSync: (targetPath, len) => {
              if (!quarantinedSuffixRe.test(String(targetPath))) {
                const err = new Error("EACCES: cannot truncate in place");
                err.code = "EACCES";
                throw err;
              }
              return truncateSync(targetPath, len);
            },
            log: (line) => logsRename.push(line),
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(startedRename.length, 1);
      const renameRunDir = join(outRename, "runs", startedRename[0]);
      const origFile = join(renameRunDir, "final", "locked-leak.txt");
      const renameRunJson = JSON.parse(readFileSync(join(renameRunDir, "run.json"), "utf8"));
      assert.equal(renameRunJson.invalid, "token_leak");
      assert.equal(renameRunJson.quarantined.length, 1);
      const renamedRelPath = renameRunJson.quarantined[0].path;
      assert.match(renamedRelPath, /^final\/locked-leak\.txt\.quarantined-\d+-[0-9a-f]+$/);
      const renamedFile = join(renameRunDir, renamedRelPath);
      assert.equal(existsSync(origFile), false, "original file should be renamed to unique quarantined target");
      assert.equal(existsSync(renamedFile), true, "renamed quarantined file should exist inside the run dir");
      assert.equal(readFileSync(renamedFile, "utf8"), "", "renamed quarantined file must be truncated to zero bytes");
      assert.equal(lstatSync(renamedFile).size, 0);
      assert.equal(renameRunJson.quarantined[0].removed, false);
      assert.match(renameRunJson.quarantined[0].error, /unlink denied/);
      assert.match(renameRunJson.quarantined[0].error, /cannot truncate in place/);

      const renameBatchJson = JSON.parse(readFileSync(join(outRename, "batch.json"), "utf8"));
      assert.equal(renameBatchJson.halted?.reason, "token_leak");
      assert.ok(
        logsRename.some(
          (line) => line.includes(renamedRelPath) && /delete/i.test(line),
        ),
        `expected stderr naming unique quarantined file and asking owner to delete it, got ${JSON.stringify(logsRename)}`,
      );

      // Case 3: artifact already named x.quarantined whose delete and in-place truncate fail ->
      // still renamed to a fresh unique name and truncated (no suffix guard).
      const outAlreadySuffixed = join(baseTmp, "out-already-suffixed");
      const startedSuffixed = [];

      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outAlreadySuffixed },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "x.quarantined"), `secret=${token}\n`, "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId }) => {
              startedSuffixed.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            rmSync: () => {
              const err = new Error("EIO: unlink denied");
              err.code = "EIO";
              throw err;
            },
            truncateSync: (targetPath, len) => {
              if (!quarantinedSuffixRe.test(String(targetPath))) {
                const err = new Error("EACCES: cannot truncate in place");
                err.code = "EACCES";
                throw err;
              }
              return truncateSync(targetPath, len);
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(startedSuffixed.length, 1);
      const suffixedRunDir = join(outAlreadySuffixed, "runs", startedSuffixed[0]);
      const origSuffixed = join(suffixedRunDir, "final", "x.quarantined");
      const suffixedRunJson = JSON.parse(readFileSync(join(suffixedRunDir, "run.json"), "utf8"));
      assert.equal(suffixedRunJson.invalid, "token_leak");
      assert.equal(suffixedRunJson.quarantined.length, 1);
      const freshSuffixedRel = suffixedRunJson.quarantined[0].path;
      assert.match(freshSuffixedRel, /^final\/x\.quarantined\.quarantined-\d+-[0-9a-f]+$/);
      const freshSuffixedPath = join(suffixedRunDir, freshSuffixedRel);
      assert.equal(existsSync(origSuffixed), false, "x.quarantined must be renamed to a fresh unique path");
      assert.equal(existsSync(freshSuffixedPath), true);
      assert.equal(readFileSync(freshSuffixedPath, "utf8"), "", "fresh renamed file must be truncated to zero bytes");
      assert.equal(lstatSync(freshSuffixedPath).size, 0);
      assert.equal(suffixedRunJson.quarantined[0].removed, false);

      // Case 4: an existing report.txt.quarantined sibling is untouched when report.txt is quarantined.
      const outSibling = join(baseTmp, "out-sibling");
      const startedSibling = [];
      const siblingContent = "precious-existing-sibling-artifact\n";

      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outSibling },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "report.txt"), `secret=${token}\n`, "utf8");
              writeFileSync(join(sandbox.taskDir, "report.txt.quarantined"), siblingContent, "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId }) => {
              startedSibling.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            rmSync: () => {
              const err = new Error("EIO: unlink denied");
              err.code = "EIO";
              throw err;
            },
            truncateSync: (targetPath, len) => {
              if (!quarantinedSuffixRe.test(String(targetPath))) {
                const err = new Error("EACCES: cannot truncate in place");
                err.code = "EACCES";
                throw err;
              }
              return truncateSync(targetPath, len);
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(startedSibling.length, 1);
      const siblingRunDir = join(outSibling, "runs", startedSibling[0]);
      const siblingFile = join(siblingRunDir, "final", "report.txt.quarantined");
      assert.equal(existsSync(join(siblingRunDir, "final", "report.txt")), false);
      assert.equal(existsSync(siblingFile), true, "existing report.txt.quarantined sibling must remain");
      assert.equal(
        readFileSync(siblingFile, "utf8"),
        siblingContent,
        "existing report.txt.quarantined sibling must not be overwritten or truncated",
      );
      const siblingRunJson = JSON.parse(readFileSync(join(siblingRunDir, "run.json"), "utf8"));
      assert.equal(siblingRunJson.invalid, "token_leak");
      assert.equal(siblingRunJson.quarantined.length, 1);
      const reportFreshRel = siblingRunJson.quarantined[0].path;
      assert.match(reportFreshRel, /^final\/report\.txt\.quarantined-\d+-[0-9a-f]+$/);
      assert.equal(readFileSync(join(siblingRunDir, reportFreshRel), "utf8"), "");

      // Case 5: direct collision retry — if first candidate target exists, picks another without overwriting.
      const collisionDir = join(baseTmp, "direct-collision");
      mkdirSync(join(collisionDir, "final"), { recursive: true });
      writeFileSync(join(collisionDir, "final", "collide.txt"), `tok=${token}\n`, "utf8");
      let simulatedCollisionChecks = 0;
      const collisionRes = await scanRunArtifactsForSecrets(collisionDir, "none", [token], {
        rmSync: () => {
          const err = new Error("EIO: unlink denied");
          err.code = "EIO";
          throw err;
        },
        truncateSync: (targetPath, len) => {
          if (!quarantinedSuffixRe.test(String(targetPath))) {
            const err = new Error("EACCES: in-place truncate denied");
            err.code = "EACCES";
            throw err;
          }
          return truncateSync(targetPath, len);
        },
        lstatSync: (targetPath) => {
          if (quarantinedSuffixRe.test(String(targetPath))) {
            simulatedCollisionChecks += 1;
            if (simulatedCollisionChecks === 1) {
              // Pretend the first randomly generated candidate already exists.
              return lstatSync(join(collisionDir, "final", "collide.txt"));
            }
          }
          return lstatSync(targetPath);
        },
      });
      assert.equal(simulatedCollisionChecks, 2, "must skip occupied candidate and retry with a fresh random name");
      assert.equal(collisionRes.leaked, true);
      assert.equal(collisionRes.quarantined.length, 1);
      assert.match(collisionRes.quarantined[0].path, /^final\/collide\.txt\.quarantined-\d+-[0-9a-f]+$/);
      assert.equal(readFileSync(join(collisionDir, collisionRes.quarantined[0].path), "utf8"), "");
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("resume checks halt before provenance mismatch, scans scheduled runs read-only without deleting stale .prev, and leaves unrelated entries untouched", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-resume-readonly-"));
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-resume-readonly-88888";

    try {
      const commonOpts = {
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
      };

      // Case 1: halted batch + changed evaluator commit -> exit 3 (BatchLeakError), NOT exit 2 (ProvenanceMismatchError).
      const outHaltedMismatch = join(baseTmp, "out-halted-mismatch");
      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outHaltedMismatch },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "leak.txt"), `tok=${token}\n`, "utf8");
              return { runs: [], cards: 0 };
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      let mismatchPackCalls = 0;
      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outHaltedMismatch },
          makeFakeDeps(owner, {
            getHeadCommit: () => "ccccccc000000000000000000000000000000099",
            packArm: async (sha, dir) => {
              mismatchPackCalls += 1;
              return join(dir, `rocky-${sha}.tgz`);
            },
          }),
        ),
        (err) => {
          assert.equal(err instanceof ProvenanceMismatchError, false);
          return err instanceof BatchLeakError && err.exitCode === 3;
        },
      );
      assert.equal(mismatchPackCalls, 0);

      // Case 2: published leak (no saved halt) next to a stale .prev whose cleanup/access would fail,
      // plus changed evaluator commit and an unrelated directory entry with a .prev neighbour ->
      // still exits 3, writes halted, and deletes/moves nothing.
      const outStalePrev = join(baseTmp, "out-stale-prev");
      const leakStarted = [];
      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outStalePrev },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              writeFileSync(join(sandbox.taskDir, "leak.txt"), `tok=${token}\n`, "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId }) => {
              leakStarted.push(runId);
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      const leakedRunId = leakStarted[0];
      const stalePrevBatchPath = join(outStalePrev, "batch.json");
      const strippedBatch = JSON.parse(readFileSync(stalePrevBatchPath, "utf8"));
      delete strippedBatch.halted;
      writeFileSync(stalePrevBatchPath, `${JSON.stringify(strippedBatch, null, 2)}\n`, "utf8");

      const stalePrevDir = join(outStalePrev, "runs", `${leakedRunId}.prev`);
      const stalePrevFile = join(stalePrevDir, "stale.txt");
      mkdirSync(stalePrevDir, { recursive: true });
      writeFileSync(stalePrevFile, "keep-stale-prev\n", "utf8");

      const unrelatedDir = join(outStalePrev, "runs", "unrelated-entry");
      const unrelatedPrevDir = join(outStalePrev, "runs", "unrelated-entry.prev");
      const unrelatedPrevFile = join(unrelatedPrevDir, "keep.txt");
      mkdirSync(unrelatedDir, { recursive: true });
      mkdirSync(unrelatedPrevDir, { recursive: true });
      writeFileSync(unrelatedPrevFile, "keep-unrelated\n", "utf8");

      // Hold an open file handle on stalePrevFile (causes rmSync to fail on win32) AND throw EACCES on lstatSync for .prev.
      const heldFd = openSync(stalePrevFile, "r");
      let stalePackCalls = 0;
      const staleResumedRuns = [];
      try {
        await assert.rejects(
          () => runBatch(
            { ...commonOpts, outDir: outStalePrev },
            makeFakeDeps(owner, {
              getHeadCommit: () => "ddddddd000000000000000000000000000000088",
              packArm: async (sha, dir) => {
                stalePackCalls += 1;
                return join(dir, `rocky-${sha}.tgz`);
              },
              lstatSync: (targetPath) => {
                if (String(targetPath).includes(`${leakedRunId}.prev`)) {
                  const err = new Error(`EACCES: simulated stale .prev error for ${targetPath}`);
                  err.code = "EACCES";
                  throw err;
                }
                return lstatSync(targetPath);
              },
              runClaude: async ({ runId }) => {
                staleResumedRuns.push(runId);
                return {
                  stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                  stderr: "",
                  exitCode: 0,
                  timedOut: false,
                };
              },
            }),
          ),
          (err) => err instanceof BatchLeakError && err.exitCode === 3,
        );
      } finally {
        closeSync(heldFd);
      }

      assert.equal(stalePackCalls, 0);
      assert.equal(staleResumedRuns.length, 0);
      assert.equal(existsSync(stalePrevFile), true, "stale .prev must not be deleted during read-only leak check");
      assert.equal(readFileSync(stalePrevFile, "utf8"), "keep-stale-prev\n");
      assert.equal(existsSync(unrelatedPrevFile), true, "unrelated .prev neighbour must stay untouched");
      assert.equal(readFileSync(unrelatedPrevFile, "utf8"), "keep-unrelated\n");
      const haltedAfterStale = JSON.parse(readFileSync(stalePrevBatchPath, "utf8"));
      assert.equal(haltedAfterStale.halted?.reason, "token_leak");
      assert.equal(haltedAfterStale.halted?.runId, leakedRunId);

      // Case 3: published leak sitting inside <runDir>.prev/run.json (interrupted swap) is detected read-only.
      const outPrevLeak = join(baseTmp, "out-prev-leak");
      await runBatch(
        { ...commonOpts, outDir: outPrevLeak, secrets: [] },
        makeFakeDeps(owner),
      );
      const prevLeakRunId = "SMOKE-none-b1";
      const prevLeakDir = join(outPrevLeak, "runs", `${prevLeakRunId}.prev`);
      mkdirSync(prevLeakDir, { recursive: true });
      writeFileSync(
        join(prevLeakDir, "run.json"),
        `${JSON.stringify({
          runId: prevLeakRunId,
          taskId: "SMOKE",
          arm: "none",
          block: 1,
          invalid: "token_leak",
          retries: 0,
        })}\n`,
        "utf8",
      );
      await assert.rejects(
        () => runBatch({ ...commonOpts, outDir: outPrevLeak, secrets: [] }, makeFakeDeps(owner)),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );
      assert.equal(existsSync(join(prevLeakDir, "run.json")), true, ".prev leak must not be deleted or moved");

      // Case 4: on a clean (non-halted) resume, an unrelated entry with a .prev neighbour remains untouched,
      // while swap recovery runs for every scheduled runId (settling skipped runs too).
      const outCleanResume = join(baseTmp, "out-clean-resume");
      await runBatch(
        { ...commonOpts, outDir: outCleanResume, secrets: [] },
        makeFakeDeps(owner),
      );
      const cleanUnrelatedDir = join(outCleanResume, "runs", "notes");
      const cleanUnrelatedPrev = join(outCleanResume, "runs", "notes.prev");
      const skippedRunPrev = join(outCleanResume, "runs", "SMOKE-none-b1.prev");
      mkdirSync(cleanUnrelatedDir, { recursive: true });
      mkdirSync(cleanUnrelatedPrev, { recursive: true });
      mkdirSync(skippedRunPrev, { recursive: true });
      writeFileSync(join(cleanUnrelatedPrev, "keep.txt"), "unrelated-intact\n", "utf8");
      writeFileSync(join(skippedRunPrev, "keep.txt"), "stale-scheduled-prev\n", "utf8");

      const cleanSummary = await runBatch(
        { ...commonOpts, outDir: outCleanResume, secrets: [] },
        makeFakeDeps(owner),
      );
      assert.equal(cleanSummary.ran, 0);
      assert.equal(existsSync(join(cleanUnrelatedPrev, "keep.txt")), true, "unrelated .prev must stay untouched");
      assert.equal(existsSync(skippedRunPrev), false, "scheduled run stale .prev must be removed on clean resume");
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("clean resume settles interrupted swaps for skipped scheduled runs so canonical dir and metrics use .next", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-swap-settle-"));
    const outDir = join(baseTmp, "out");
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);

    try {
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

      await runBatch(commonOpts, makeFakeDeps(owner));

      // Simulate an interrupted retry swap for SMOKE-none-b1:
      // canonical missing + .next (success) + .prev (older failure).
      const targetRunId = "SMOKE-none-b1";
      const canonicalDir = join(outDir, "runs", targetRunId);
      const nextDir = `${canonicalDir}.next`;
      const prevDir = `${canonicalDir}.prev`;
      rmSync(canonicalDir, { recursive: true, force: true });

      mkdirSync(join(nextDir, "final"), { recursive: true });
      writeFileSync(
        join(nextDir, "run.json"),
        `${JSON.stringify({
          runId: targetRunId,
          taskId: "SMOKE",
          arm: "none",
          block: 1,
          invalid: null,
          accept: { solved: true, reason: "promoted-from-next" },
          retries: 1,
          noneRockyHomeEntries: [],
        }, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        join(nextDir, "transcript.jsonl"),
        `${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 100 })}\n`,
        "utf8",
      );
      writeFileSync(join(nextDir, "stderr.txt"), "", "utf8");
      writeFileSync(join(nextDir, "final", "marker.txt"), "from-next\n", "utf8");

      mkdirSync(join(prevDir, "final"), { recursive: true });
      writeFileSync(
        join(prevDir, "run.json"),
        `${JSON.stringify({
          runId: targetRunId,
          taskId: "SMOKE",
          arm: "none",
          block: 1,
          invalid: "api_error",
          accept: { solved: false, reason: "stale-prev-failure" },
          retries: 0,
          noneRockyHomeEntries: [],
        }, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        join(prevDir, "transcript.jsonl"),
        `${JSON.stringify({ type: "result", subtype: "error_api", is_error: true, num_turns: 1, duration_ms: 100 })}\n`,
        "utf8",
      );
      writeFileSync(join(prevDir, "stderr.txt"), "old failure\n", "utf8");
      writeFileSync(join(prevDir, "final", "marker.txt"), "from-prev\n", "utf8");

      // Resume (even without re-running SMOKE-none-b1) must settle the swap after halt/leak checks pass.
      const summary = await runBatch(commonOpts, makeFakeDeps(owner));
      assert.equal(summary.ran, 0);
      assert.equal(summary.skipped, 3);
      assert.equal(existsSync(canonicalDir), true, "canonical run dir must be promoted from .next");
      assert.equal(existsSync(nextDir), false, ".next must be promoted away");
      assert.equal(existsSync(prevDir), false, "stale .prev must be removed");
      assert.equal(readFileSync(join(canonicalDir, "final", "marker.txt"), "utf8"), "from-next\n");

      const promotedRun = JSON.parse(readFileSync(join(canonicalDir, "run.json"), "utf8"));
      assert.equal(promotedRun.invalid, null);
      assert.equal(promotedRun.accept?.solved, true);
      assert.equal(promotedRun.accept?.reason, "promoted-from-next");

      const { metrics } = evaluateBatch(outDir);
      assert.equal(metrics[targetRunId].invalid, null);
      assert.equal(metrics[targetRunId].solved, true);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  test("pre-grade and finally scans set scheduler stop immediately on leak so a concurrent worker claims no new run", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "rocky-guard-early-stop-"));
    const rootDir = join(baseTmp, "sbx");
    const cacheDir = join(baseTmp, "cache");
    const owner = makeIsolatedOwner(baseTmp);
    const token = "sk-ant-oat01-early-stop-secret-99999";

    const deferred = () => {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    try {
      const commonOpts = {
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
      };

      // Case 1: pre-grade scan sets stopBatch BEFORE accept() finishes.
      const outPreGrade = join(baseTmp, "out-pregrade");
      const startedPre = [];
      const createdSandboxesPre = [];
      const bothStartedPre = deferred();
      const leakHitInGrader = deferred();
      const allowGraderFinish = deferred();
      let leakingSandboxPre = null;
      let firstRunIdPre = null;
      let ownerCheckCallsPre = 0;

      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outPreGrade },
          makeFakeDeps(owner, {
            createSandbox: async ({ runId, root }) => {
              createdSandboxesPre.push(runId);
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
            materializeTask: async (_task, sandbox) => {
              if (!leakingSandboxPre) {
                leakingSandboxPre = sandbox.dir;
                writeFileSync(join(sandbox.taskDir, "leaked.txt"), `tok=${token}\n`, "utf8");
              }
              writeFileSync(join(sandbox.taskDir, "clean.txt"), "ok\n", "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId, sandbox }) => {
              const count = startedPre.push(runId);
              if (count === 2) {
                bothStartedPre.resolve();
              }
              if (sandbox.dir === leakingSandboxPre) {
                firstRunIdPre = runId;
                await bothStartedPre.promise;
              } else if (count <= 2) {
                // Wait until the leaking run has completed its pre-grade scan and is paused inside accept().
                await leakHitInGrader.promise;
              }
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            accept: async (_task, finalDir) => {
              if (firstRunIdPre && finalDir.includes(firstRunIdPre)) {
                // Pre-grade scan has already run and set stopBatch; let worker 2 finish now while worker 1 stays in accept().
                leakHitInGrader.resolve();
                await allowGraderFinish.promise;
              }
              return { solved: true, reason: "ok" };
            },
            ownerCheck: (base, arg) => {
              const res = ownerCheck(base, arg);
              ownerCheckCallsPre += 1;
              // First ownerCheck belongs to worker 2 finishing; yield a turn so its worker loop checks stopBatch before releasing worker 1.
              if (ownerCheckCallsPre === 1) {
                setImmediate(() => allowGraderFinish.resolve());
              }
              return res;
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(
        startedPre.length,
        2,
        `worker 2 must claim no new run after pre-grade scan hit, started=${JSON.stringify(startedPre)}`,
      );
      assert.equal(createdSandboxesPre.length, 2);
      const firstRunPre = JSON.parse(readFileSync(join(outPreGrade, "runs", firstRunIdPre, "run.json"), "utf8"));
      assert.equal(firstRunPre.invalid, "token_leak");
      assert.deepEqual(firstRunPre.quarantined, ["final/leaked.txt"]);

      // Case 2: finally scan (after copy throws) sets stopBatch BEFORE destroySandbox finishes.
      const outFinally = join(baseTmp, "out-finally");
      const startedFin = [];
      const bothStartedFin = deferred();
      const leakHitInCleanup = deferred();
      const allowCleanupFinish = deferred();
      let leakingSandboxFin = null;
      let firstRunIdFin = null;
      let ownerCheckCallsFin = 0;

      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outFinally },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              if (!leakingSandboxFin) {
                leakingSandboxFin = sandbox.dir;
                writeFileSync(join(sandbox.taskDir, "a-token.txt"), `tok=${token}\n`, "utf8");
                writeFileSync(join(sandbox.taskDir, "b-fail.txt"), "trigger-copy-throw\n", "utf8");
              }
              writeFileSync(join(sandbox.taskDir, "clean.txt"), "ok\n", "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId, sandbox }) => {
              const count = startedFin.push(runId);
              if (count === 2) {
                bothStartedFin.resolve();
              }
              if (sandbox.dir === leakingSandboxFin) {
                firstRunIdFin = runId;
                await bothStartedFin.promise;
              } else if (count <= 2) {
                await leakHitInCleanup.promise;
              }
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            copyFileSync: (src, dest) => {
              if (String(src).endsWith("b-fail.txt")) {
                const err = new Error("EIO: copy failed after leaking file");
                err.code = "EIO";
                throw err;
              }
              return copyFileSync(src, dest);
            },
            destroySandbox: async (sandbox) => {
              if (leakingSandboxFin && sandbox.dir === leakingSandboxFin) {
                // finally scan already ran before destroySandbox; let worker 2 finish while worker 1 pauses in cleanup.
                leakHitInCleanup.resolve();
                await allowCleanupFinish.promise;
              }
              rmSync(sandbox.dir, { recursive: true, force: true });
            },
            ownerCheck: (base, arg) => {
              const res = ownerCheck(base, arg);
              ownerCheckCallsFin += 1;
              if (ownerCheckCallsFin === 1) {
                setImmediate(() => allowCleanupFinish.resolve());
              }
              return res;
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(
        startedFin.length,
        2,
        `worker 2 must claim no new run after finally scan hit, started=${JSON.stringify(startedFin)}`,
      );
      const firstRunFin = JSON.parse(readFileSync(join(outFinally, "runs", firstRunIdFin, "run.json"), "utf8"));
      assert.equal(firstRunFin.invalid, "token_leak");
      assert.deepEqual(firstRunFin.quarantined, ["final/a-token.txt"]);

      // Case 3: scanner fires onHit synchronously at the FIRST token match before reading any further file;
      // while a slow read on a subsequent file is held pending, worker 2 finishes and claims no new run.
      const directHitDir = join(baseTmp, "direct-onhit");
      mkdirSync(join(directHitDir, "final"), { recursive: true });
      writeFileSync(join(directHitDir, "final", "a-hit.txt"), `tok=${token}\n`, "utf8");
      writeFileSync(join(directHitDir, "final", "b-next.txt"), "clean-second-file\n", "utf8");
      const directEvents = [];
      await scanRunArtifactsForSecrets(directHitDir, "none", [token], {
        openFile: async (filePath, flags) => {
          if (String(filePath).endsWith("a-hit.txt")) directEvents.push("open:a-hit");
          if (String(filePath).endsWith("b-next.txt")) directEvents.push("open:b-next");
          return openFile(filePath, flags);
        },
        onHit: (relPath) => {
          directEvents.push(`onHit:${relPath}`);
        },
      });
      assert.deepEqual(directEvents, ["open:a-hit", "onHit:final/a-hit.txt", "open:b-next"]);

      const outSlowScan = join(baseTmp, "out-slow-scan");
      const startedSlow = [];
      const bothStartedSlow = deferred();
      const slowReadEntered = deferred();
      const allowSlowReadFinish = deferred();
      let leakingSandboxSlow = null;
      let firstRunIdSlow = null;
      let slowReadWasPending = false;
      let worker2FinishedWhileScanPending = false;
      let slowReadReleased = false;
      let ownerCheckCallsSlow = 0;

      await assert.rejects(
        () => runBatch(
          { ...commonOpts, outDir: outSlowScan },
          makeFakeDeps(owner, {
            materializeTask: async (_task, sandbox) => {
              if (!leakingSandboxSlow) {
                leakingSandboxSlow = sandbox.dir;
                writeFileSync(join(sandbox.taskDir, "a-hit.txt"), `tok=${token}\n`, "utf8");
                writeFileSync(join(sandbox.taskDir, "b-slow.txt"), "clean-but-slow\n", "utf8");
              }
              writeFileSync(join(sandbox.taskDir, "clean.txt"), "ok\n", "utf8");
              return { runs: [], cards: 0 };
            },
            runClaude: async ({ runId, sandbox }) => {
              const count = startedSlow.push(runId);
              if (count === 2) {
                bothStartedSlow.resolve();
              }
              if (sandbox.dir === leakingSandboxSlow) {
                firstRunIdSlow = runId;
                await bothStartedSlow.promise;
              } else if (count <= 2) {
                // Hold worker 2 until worker 1 has hit a-hit.txt and is suspended reading b-slow.txt.
                await slowReadEntered.promise;
              }
              return {
                stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
            },
            openFile: async (filePath, flags) => {
              if (
                !slowReadWasPending
                && firstRunIdSlow
                && String(filePath).includes(firstRunIdSlow)
                && String(filePath).endsWith("b-slow.txt")
              ) {
                slowReadWasPending = true;
                // Release worker 2 while worker 1's scan is STILL in flight on b-slow.txt.
                slowReadEntered.resolve();
                await allowSlowReadFinish.promise;
              }
              return openFile(filePath, flags);
            },
            ownerCheck: (base, arg) => {
              const res = ownerCheck(base, arg);
              ownerCheckCallsSlow += 1;
              if (ownerCheckCallsSlow === 1) {
                // Worker 2 just completed while worker 1's scan is still suspended on b-slow.txt.
                if (!slowReadReleased) {
                  worker2FinishedWhileScanPending = true;
                }
                setImmediate(() => {
                  slowReadReleased = true;
                  allowSlowReadFinish.resolve();
                });
              }
              return res;
            },
          }),
        ),
        (err) => err instanceof BatchLeakError && err.exitCode === 3,
      );

      assert.equal(slowReadWasPending, true, "slow read after first hit must be exercised");
      assert.equal(
        worker2FinishedWhileScanPending,
        true,
        "worker 2 must finish and re-check the scheduler while worker 1 is still reading b-slow.txt",
      );
      assert.equal(
        startedSlow.length,
        2,
        `worker 2 must claim no new run while scan is still reading b-slow.txt, started=${JSON.stringify(startedSlow)}`,
      );
      const firstRunSlow = JSON.parse(readFileSync(join(outSlowScan, "runs", firstRunIdSlow, "run.json"), "utf8"));
      assert.equal(firstRunSlow.invalid, "token_leak");
      assert.deepEqual(firstRunSlow.quarantined, ["final/a-hit.txt"]);
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
  });
});
