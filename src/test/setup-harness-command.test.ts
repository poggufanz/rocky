import test from "node:test";
import assert from "node:assert/strict";
import type { SetupClientAdapter, McpRegistration, InspectionResult, SetupResult } from "../setup/clients.js";
import { setup, type SetupDependencies } from "../commands/setup.js";
import type { ProcessRunner } from "../setup/process.js";
import type { PlatformServices } from "../setup/platform.js";

class FakeAdapter implements SetupClientAdapter {
  calls: string[] = [];
  constructor(readonly id: "codex" = "codex") {}
  async inspect(): Promise<InspectionResult> { this.calls.push("inspect"); return { state: "absent" }; }
  async configure(): Promise<SetupResult> { this.calls.push("configure"); return { client: this.id, status: "configured" }; }
  async check(): Promise<SetupResult> { this.calls.push("check"); return { client: this.id, status: "healthy" }; }
  async remove(): Promise<SetupResult> { this.calls.push("remove"); return { client: this.id, status: "removed" }; }
}

const stubRunner = {
  async run(): Promise<never> { throw new Error("unused"); },
  async openSession(): Promise<never> { throw new Error("unused"); },
} as unknown as ProcessRunner;

function deps(adapter: FakeAdapter, isTTY: boolean): SetupDependencies {
  return {
    runner: stubRunner,
    platform: { home: "/tmp/rocky-harness-test" } as unknown as PlatformServices,
    adapters: [adapter],
    confirmation: { confirm: async () => true },
    nodePath: process.execPath,
    entryPath: process.execPath,
    rockyHome: "/tmp/rocky-harness-test",
    isTTY,
  };
}

test("broad non-TTY setup --yes fails with migration guidance before touching adapters", async () => {
  const adapter = new FakeAdapter();
  const code = await setup(["--yes"], deps(adapter, false));
  assert.equal(code, 2);
  assert.deepEqual(adapter.calls, []);
});

test("non-TTY check without harness fails before adapters run", async () => {
  const adapter = new FakeAdapter();
  const code = await setup(["--check"], deps(adapter, false));
  assert.equal(code, 2);
  assert.deepEqual(adapter.calls, []);
});

test("TTY without harness keeps the legacy consent path", async () => {
  const adapter = new FakeAdapter();
  const code = await setup([], deps(adapter, true));
  assert.equal(code, 0);
  assert.ok(adapter.calls.includes("configure"));
});

test("non-TTY voice-skill-only bypasses the harness guard and reaches the legacy voice path", async () => {
  const adapter = new FakeAdapter();
  const code = await setup(["--voice-skill"], deps(adapter, false));
  assert.equal(code, 1);
  assert.ok(adapter.calls.includes("configure"));
});

test("non-TTY agent-hooks actions are not forced into harness scope", async () => {
  const adapter = new FakeAdapter();
  const code = await setup(["--agent-hooks"], deps(adapter, false));
  assert.notEqual(code, 2);
});
