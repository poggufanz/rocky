import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCheckInput } from "../commands/check.js";
import {
  HOOK_END,
  HOOK_START,
  classifyExisting,
  installPrePush,
  renderPrePushScript,
} from "../check/pre-push.js";

function temporaryDirectory(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "rocky-pre-push-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("an open pre-push input times out instead of holding the push", async () => {
  const input = new PassThrough();
  input.write(" ");

  await assert.rejects(
    readCheckInput(input, 20),
    /pre-push input timed out.*not inspected/i,
  );
});

test("renderPrePushScript fences the hook and blocks only Rocky exit 3", () => {
  const script = renderPrePushScript();

  assert.ok(script.startsWith("#!/bin/sh"));
  assert.ok(script.includes(HOOK_START));
  assert.ok(script.includes(HOOK_END));
  assert.ok(script.includes("command -v rocky >/dev/null 2>&1 || exit 0"));
  assert.ok(script.includes('rocky check --pre-push "$@"'));
  assert.ok(script.includes('[ "$rc" -eq 3 ] && exit 1'));
  assert.equal(script.includes('[ "$rc" -eq 1 ] && exit 1'), false);
  assert.ok(script.trimEnd().endsWith("exit 0") || script.includes("exit 0"));
});

test("rendered hook only turns Rocky exit 3 into a blocked push", (t) => {
  if (process.platform === "win32") return;

  const directory = temporaryDirectory(t);
  const scriptPath = join(directory, "pre-push");
  const binDirectory = join(directory, "bin");
  const rockyPath = join(binDirectory, "rocky");
  mkdirSync(binDirectory);
  writeFileSync(scriptPath, renderPrePushScript(), "utf8");
  writeFileSync(rockyPath, "#!/bin/sh\nexit \"$ROCKY_TEST_EXIT\"\n", "utf8");
  chmodSync(rockyPath, 0o755);

  for (const rockyExit of [3, 1, 0, 127]) {
    const result = spawnSync("sh", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        ROCKY_TEST_EXIT: String(rockyExit),
      },
    });
    assert.equal(result.status, rockyExit === 3 ? 1 : 0, `Rocky exit ${rockyExit}`);
  }
});

test("rendered hook allows a push when Rocky is unavailable", (t) => {
  if (process.platform === "win32") return;

  const directory = temporaryDirectory(t);
  const scriptPath = join(directory, "pre-push");
  const emptyPath = join(directory, "empty-path");
  mkdirSync(emptyPath);
  writeFileSync(scriptPath, renderPrePushScript(), "utf8");

  const result = spawnSync("/bin/sh", [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, PATH: emptyPath },
  });

  assert.equal(result.status, 0);
});

test("classifyExisting distinguishes absent, ours, and foreign", () => {
  assert.equal(classifyExisting(null), "absent");
  assert.equal(classifyExisting(renderPrePushScript()), "ours");
  assert.equal(classifyExisting("#!/bin/sh\nexec husky pre-push\n"), "foreign");
});

test("installPrePush writes an empty hooks directory and refuses a foreign hook", (t) => {
  const directory = temporaryDirectory(t);
  const gitDirectory = join(directory, ".git");
  const hooksDirectory = join(gitDirectory, "hooks");
  const hookPath = join(hooksDirectory, "pre-push");
  mkdirSync(hooksDirectory, { recursive: true });

  const installed = installPrePush(hookPath);
  assert.equal(installed.status, "installed");
  assert.equal(existsSync(hookPath), true);
  assert.ok(readFileSync(hookPath, "utf8").includes(HOOK_START));
  if (process.platform !== "win32") accessSync(hookPath, constants.X_OK);

  const repeated = installPrePush(hookPath);
  assert.equal(repeated.status, "already-installed");

  const foreign = "#!/bin/sh\nexec husky pre-push\n";
  writeFileSync(hookPath, foreign, "utf8");
  const refused = installPrePush(hookPath);
  assert.equal(refused.status, "refused");
  assert.equal(readFileSync(hookPath, "utf8"), foreign);
  assert.ok(refused.detail.includes(hookPath));
});

test("installPrePush settles a stale transaction before refusing its restored foreign hook", (t) => {
  const directory = temporaryDirectory(t);
  const gitDirectory = join(directory, ".git");
  const hooksDirectory = join(gitDirectory, "hooks");
  const hookPath = join(hooksDirectory, "pre-push");
  const transactionDirectory = join(hooksDirectory, ".pre-push.transaction-4242-0123456789abcdef");
  const displacedPath = join(transactionDirectory, "displaced");
  const foreign = "#!/bin/sh\nexec husky pre-push\n";
  mkdirSync(transactionDirectory, { recursive: true });
  writeFileSync(
    join(transactionDirectory, "manifest.json"),
    `${JSON.stringify({ version: 1, state: "displaced", target: hookPath })}\n`,
    "utf8",
  );
  writeFileSync(displacedPath, foreign, "utf8");

  const result = installPrePush(hookPath);

  assert.equal(result.status, "refused");
  assert.equal(readFileSync(hookPath, "utf8"), foreign);
  assert.equal(result.recoveryPath, displacedPath);
  assert.ok(result.detail.includes(displacedPath));
});

test("installPrePush refuses an unresolved transaction before writing an absent hook", (t) => {
  const directory = temporaryDirectory(t);
  const gitDirectory = join(directory, ".git");
  const hooksDirectory = join(gitDirectory, "hooks");
  const hookPath = join(hooksDirectory, "pre-push");
  const transactionDirectory = join(hooksDirectory, ".pre-push.transaction-4242-0123456789abcdef");
  mkdirSync(transactionDirectory, { recursive: true });
  writeFileSync(join(transactionDirectory, "manifest.json"), "not valid JSON\n", "utf8");

  const result = installPrePush(hookPath);

  assert.equal(result.status, "refused");
  assert.equal(existsSync(hookPath), false);
  assert.equal(result.recoveryPath, transactionDirectory);
  assert.ok(result.detail.includes("unresolved"));
  assert.ok(result.detail.includes(transactionDirectory));
  assert.ok(result.detail.includes("Recovery artifact"));
  assert.equal(result.detail.includes("Recovery copy"), false);
});
