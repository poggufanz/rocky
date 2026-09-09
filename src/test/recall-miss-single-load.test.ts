import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall } from "../commands/recall.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { memoryReadMetrics } from "../core/memory-read.js";
import { disabledRecallWithAi } from "../ai/port.js";

function failureLine(id: string): string {
  return JSON.stringify({
    kind: "failure",
    id,
    ts: 1_700_000_000_000,
    cwd: "/tmp/recall-miss",
    cmd: "false",
    exitCode: 1,
    fingerprint: id.padStart(16, "0"),
    signature: ["false"],
    excerpt: "false",
  });
}

async function capture(run: () => Promise<number>): Promise<{ code: number; stderr: string; stdout: string }> {
  const originalStderr = process.stderr.write;
  const originalStdout = process.stdout.write;
  let stderr = "";
  let stdout = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(), stderr, stdout };
  } finally {
    process.stderr.write = originalStderr;
    process.stdout.write = originalStdout;
  }
}

function freshHome(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-recall-miss-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  return home;
}

test("recall miss on durable memory loads once and keeps no-match message", async (t) => {
  const home = freshHome(t);
  writeFileSync(join(home, "memory.jsonl"), `${failureLine("0000000000000001")}\n`, "utf8");

  const before = memoryReadMetrics();
  const output = await capture(() =>
    recall(["totally-unrelated-xyzzy-no-match-98765"], {
      memory: createMemoryQueries(),
      recallWithAi: disabledRecallWithAi,
    }),
  );
  const after = memoryReadMetrics();

  assert.equal(output.code, 1);
  assert.match(output.stderr, /nothing match/);
  assert.equal(output.stdout, "");
  assert.equal(after.parses - before.parses, 1);
  assert.equal(after.cacheHits - before.cacheHits, 0);
});

test("recall empty durable memory keeps empty message", async (t) => {
  freshHome(t);

  const output = await capture(() =>
    recall(["totally-unrelated-xyzzy-no-match-98765"], {
      memory: createMemoryQueries(),
      recallWithAi: disabledRecallWithAi,
    }),
  );

  assert.equal(output.code, 0);
  assert.match(output.stderr, /memory is empty/);
  assert.equal(output.stdout, "");
});

test("recall incomplete durable coverage keeps incomplete message", async (t) => {
  const home = freshHome(t);
  writeFileSync(
    join(home, "memory.jsonl"),
    `${failureLine("0000000000000002")}\n{not-json}\n`,
    "utf8",
  );

  const output = await capture(() =>
    recall(["totally-unrelated-xyzzy-no-match-98765"], {
      memory: createMemoryQueries(),
      recallWithAi: disabledRecallWithAi,
    }),
  );

  assert.equal(output.code, 1);
  assert.match(output.stderr, /memory coverage incomplete/);
  assert.equal(output.stdout, "");
});
