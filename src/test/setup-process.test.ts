import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProcessRunner } from "../setup/process.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

test("bounded runner kills a TERM-ignoring child and still settles", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal behavior is not portable to Windows");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "rocky-term-ignore-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pidPath = join(root, "pid");
  const runner = createProcessRunner();
  // sh, not node: a node child can take longer than the 500ms timeout to
  // boot on a loaded runner, get killed before it ignores TERM, and never
  // test the escalation at all. `read` blocks on the runner's stdin pipe
  // with no child process and no CPU, so SIGKILL is the only way out.
  const running = runner.run("/bin/sh", [
    "-c",
    "trap '' TERM; echo $$ > \"$1\"; read -r _",
    "sh",
    pidPath,
  ], { timeoutMs: 500 });
  const raced = await Promise.race([
    running.then((result) => ({ settled: true as const, result })),
    delay(10_000).then(() => ({ settled: false as const })),
  ]);
  if (!raced.settled) {
    const pid = Number(readFileSync(pidPath, "utf8"));
    process.kill(pid, "SIGKILL");
    await running;
  }

  assert.equal(raced.settled, true);
  if (raced.settled) {
    assert.notEqual(raced.result.error, undefined);
    assert.match(raced.result.error?.message ?? "", /timeout/i);
    assert.ok(existsSync(pidPath), "child was killed before it ignored TERM; escalation untested");
    const pid = Number(readFileSync(pidPath, "utf8"));
    // The runner resolving and the OS reaping the killed child are two
    // different events. Asserting the second one instantly made this test fail
    // whenever the machine was busy — which is exactly when a kill escalation
    // matters — so wait for the process to actually disappear instead.
    assert.equal(await waitForExit(pid, 5_000), true, `pid ${pid} still alive after kill escalation`);
  }
});

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
    }
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
}
