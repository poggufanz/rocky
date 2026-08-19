import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { RationaleRecord } from "../core/memory-read.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");

function isRationale(record: { kind: string }): record is RationaleRecord {
  return record.kind === "rationale";
}

/** Isolate ROCKY_HOME for one test and register cleanup. */
function freshHome(t: TestContext): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gen-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.ROCKY_HOME = home;
  return home;
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = "";
  const original = process.stdout.write;
  (process.stdout as unknown as {
    write: (chunk: string, callback?: (error?: Error) => void) => boolean;
  }).write = (chunk: string, callback?: (error?: Error) => void) => {
    out += chunk;
    callback?.();
    return true;
  };
  try {
    return { code: await fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

test("generic agent-event with --rationale writes notify rationale, stdout {}", async (t) => {
  freshHome(t);
  const { agentEvent } = await import("../commands/agent-hook.js");
  const result = await captureStdout(() => agentEvent("generic", {
    rationale: "switched to exponential backoff",
    files: ["src/q.ts"],
  }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  const { loadMemory } = await import("../core/memory-read.js");
  const rec = loadMemory().find(isRationale);
  assert.ok(rec, "generic notify writes a rationale record");
  assert.equal(rec?.agent, "generic");
  assert.equal(rec?.source, "notify");
  assert.equal(rec?.rationale_fidelity, "summary");
  assert.equal(rec?.excerpt, "switched to exponential backoff");
});

test("generic agent-event without --rationale still exits 0 with {} and writes nothing", async (t) => {
  freshHome(t);
  const { agentEvent } = await import("../commands/agent-hook.js");
  const result = await captureStdout(() => agentEvent("generic", {}));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  const { loadMemory } = await import("../core/memory-read.js");
  assert.equal(loadMemory().length, 0, "no --rationale means no rationale record, but still fail-open");
});

test("generic agent-event weak-links to the nearest same-cwd failure within the window", async (t) => {
  freshHome(t);
  const { recordWatchFailure } = await import("../core/memory.js");
  const failure = recordWatchFailure("npm test", 1, "Error: boom");
  const { agentEvent } = await import("../commands/agent-hook.js");
  const result = await captureStdout(() => agentEvent("generic", { rationale: "retrying with backoff" }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  const { loadMemory } = await import("../core/memory-read.js");
  const rec = loadMemory().find(isRationale);
  assert.ok(rec);
  assert.equal(rec?.links?.failureId, failure.id);
});

test("claude-code agent-event with --rationale writes vendor-agent rationale in addition to existing behavior", async (t) => {
  freshHome(t);
  const { agentEvent } = await import("../commands/agent-hook.js");
  const submitPayload = JSON.stringify({
    session_id: "s1",
    prompt_id: "p1",
    hook_event_name: "UserPromptSubmit",
    cwd: "/w",
    prompt: "naikin",
  });
  const result = await captureStdout(() => agentEvent("claude-code", {
    stdin: async () => submitPayload,
    rationale: "explaining the change",
  }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  const { loadMemory } = await import("../core/memory-read.js");
  const rec = loadMemory().find(isRationale);
  assert.ok(rec, "a --rationale flag on claude-code writes a notify rationale record too");
  assert.equal(rec?.agent, "claude-code");
  assert.equal(rec?.source, "notify");
});

test("claude-code agent-event with --rationale still writes it when the vendor payload is malformed", async (t) => {
  freshHome(t);
  const { agentEvent } = await import("../commands/agent-hook.js");
  const result = await captureStdout(() => agentEvent("claude-code", {
    stdin: async () => "not json",
    rationale: "the argv reason survives a broken payload",
  }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  const { loadMemory } = await import("../core/memory-read.js");
  const rec = loadMemory().find(isRationale);
  assert.ok(rec, "a malformed vendor payload must not suppress the argv-supplied rationale");
  assert.equal(rec?.agent, "claude-code");
  assert.equal(rec?.source, "notify");
});

test("claude-code agent-event without --rationale is unchanged: no rationale record written", async (t) => {
  freshHome(t);
  const { agentEvent } = await import("../commands/agent-hook.js");
  const submitPayload = JSON.stringify({
    session_id: "s1",
    prompt_id: "p1",
    hook_event_name: "UserPromptSubmit",
    cwd: "/w",
    prompt: "naikin",
  });
  const result = await captureStdout(() => agentEvent("claude-code", { stdin: async () => submitPayload }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  const { loadMemory } = await import("../core/memory-read.js");
  assert.equal(loadMemory().find(isRationale), undefined, "no --rationale means existing behavior is untouched");
});

test("unknown adapter with --rationale present is still rejected at the vendor gate", async (t) => {
  freshHome(t);
  const { agentEvent } = await import("../commands/agent-hook.js");
  const result = await captureStdout(() => agentEvent("cursor", { rationale: "should not be written" }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  const { loadMemory } = await import("../core/memory-read.js");
  assert.equal(loadMemory().length, 0, "an unknown adapter never reaches rationale persistence");
});

test("CLI: rocky hook agent-event generic --rationale ... --files ... writes a notify rationale, stdout {}", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-gen-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Strip NODE_* IPC/channel env before spawning a real grandchild here: this
  // test file is itself a node:test child process, and forwarding the whole
  // environment risks leaking the test runner's own IPC plumbing into the
  // spawned rocky binary rather than a clean CLI invocation.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_")),
  );
  const result = spawnSync(process.execPath, [
    entry, "hook", "agent-event", "generic",
    "--rationale", "switched to exponential backoff",
    "--files", "src/q.ts,src/r.ts",
  ], {
    cwd: packageRoot,
    env: { ...cleanEnv, ROCKY_HOME: home },
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.equal(result.stderr, "");
});
