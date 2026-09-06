import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEvent } from "../commands/agent-hook.js";
import { loadMemory } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";

async function withSandboxHome<T>(fn: () => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "rocky-garbage-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
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

test("one-word rationale records nothing but still exits 0", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const result = await captureStdout(() => agentEvent("generic", { rationale: "fix stuff", files: ["src/a.ts"], paths } as never));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 0);
  });
});

test("explain pair with a short side records nothing", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const result = await captureStdout(() => agentEvent("generic", {
      explainCode: "idk", explainBusiness: "serves the business concern fully stated", files: ["src/b.ts"], paths,
    } as never));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 0);
  });
});

test("real rationale plus real explain pair both record", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const first = await captureStdout(() => agentEvent("generic", { rationale: "switch retry to idempotency key after duplicate settlement", files: ["src/c.ts"], paths } as never));
    const second = await captureStdout(() => agentEvent("generic", {
      explainCode: "retry keyed by idempotency token so replays collapse", explainBusiness: "prevents double charge on settlement retries", files: ["src/c.ts"], paths,
    } as never));
    assert.equal(first.code, 0);
    assert.equal(first.out, "{}");
    assert.equal(second.code, 0);
    assert.equal(second.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 2);
  });
});

test("rationale with >= 3 words but < 12 chars records nothing", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const result = await captureStdout(() => agentEvent("generic", { rationale: "a b c d", files: ["src/a.ts"], paths } as never));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 0);
  });
});

test("rationale with >= 12 chars but < 3 words records nothing", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const result = await captureStdout(() => agentEvent("generic", { rationale: "extraordinary accomplishment", files: ["src/a.ts"], paths } as never));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 0);
  });
});

test("explain pair with short business side records nothing", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const result = await captureStdout(() => agentEvent("generic", {
      explainCode: "serves the code concern fully stated", explainBusiness: "short", files: ["src/b.ts"], paths,
    } as never));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 0);
  });
});

test("exact duplicate rationale in last 3 records is rejected", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const first = await captureStdout(() => agentEvent("generic", { rationale: "switch retry to idempotency key after duplicate settlement", files: ["src/c.ts"], paths } as never));
    assert.equal(first.code, 0);
    assert.equal(loadMemory(paths.memory, Date.now()).length, 1);

    const dup = await captureStdout(() => agentEvent("generic", { rationale: "switch retry to idempotency key after duplicate settlement", files: ["src/c.ts"], paths } as never));
    assert.equal(dup.code, 0);
    assert.equal(dup.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 1);
  });
});

test("exact duplicate explain pair in last 3 records is rejected", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const first = await captureStdout(() => agentEvent("generic", {
      explainCode: "retry keyed by idempotency token so replays collapse", explainBusiness: "prevents double charge on settlement retries", files: ["src/c.ts"], paths,
    } as never));
    assert.equal(first.code, 0);
    assert.equal(loadMemory(paths.memory, Date.now()).length, 1);

    const dup = await captureStdout(() => agentEvent("generic", {
      explainCode: "retry keyed by idempotency token so replays collapse", explainBusiness: "prevents double charge on settlement retries", files: ["src/c.ts"], paths,
    } as never));
    assert.equal(dup.code, 0);
    assert.equal(dup.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 1);
  });
});

test("vendor mode also respects anti-garbage floors", async () => {
  await withSandboxHome(async () => {
    const paths = resolveRockyPaths();
    const result = await captureStdout(() => agentEvent("claude-code", {
      stdin: async () => "{}",
      rationale: "fix stuff",
      files: ["src/a.ts"],
      paths,
    } as never));
    assert.equal(result.code, 0);
    assert.equal(result.out, "{}");
    assert.equal(loadMemory(paths.memory, Date.now()).length, 0);
  });
});
