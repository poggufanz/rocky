import test from "node:test";
import assert from "node:assert/strict";
import { createHarnessMcpAdapters } from "../setup/harness-mcp-dispatch.js";
import type { HarnessId } from "../setup/harness-registry.js";

function fakeDeps() {
  return {
    runner: { run: () => Promise.resolve({ status: 1, stdout: "", stderr: "" }) },
    platform: {
      platform: "linux" as const,
      home: "/home/tester",
      isWsl: false,
      resolveExecutable: () => undefined,
      fileExists: () => false,
      hasClaudeDesktop: () => false,
      hasBashHook: () => false,
    },
  };
}

test("dispatch maps each P1-A id to exactly one adapter with the same id", () => {
  const ids: readonly HarnessId[] = ["claude-code", "codex", "opencode", "gemini-cli", "copilot-cli"];
  const adapters = createHarnessMcpAdapters(ids, fakeDeps() as never);
  assert.deepEqual(adapters.map((a) => a.id), [...ids]);
});

test("dispatch deduplicates repeated ids and drops batch B/C ids without claiming them", () => {
  const adapters = createHarnessMcpAdapters(
    ["codex", "codex", "cursor", "vscode"] as HarnessId[],
    fakeDeps() as never,
  );
  assert.deepEqual(adapters.map((a) => a.id), ["codex"]);
});

test("not-found harness adapter writes nothing on configure", async () => {
  const adapters = createHarnessMcpAdapters(["gemini-cli"], fakeDeps() as never);
  assert.equal(adapters.length, 1);
  const result = await adapters[0]!.configure(
    { name: "rocky", command: "/bin/node", args: ["mcp"], env: {} },
    false,
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.client, "gemini-cli");
});
