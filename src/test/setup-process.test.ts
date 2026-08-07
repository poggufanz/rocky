import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const running = runner.run(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  ], { timeoutMs: 100 });
  const raced = await Promise.race([
    running.then((result) => ({ settled: true as const, result })),
    delay(750).then(() => ({ settled: false as const })),
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
    const pid = Number(readFileSync(pidPath, "utf8"));
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ESRCH",
    );
  }
});
