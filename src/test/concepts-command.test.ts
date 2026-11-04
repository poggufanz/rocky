import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setVerbose } from "./verbose-switch.js";

test("concept alias add writes alias record; concepts lists it", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cc-")));
  const { conceptsCommand } = await import("../commands/concepts.js");
  assert.equal(conceptsCommand(["alias", "jangan jalan dua kali", "idempotency"]), 0);
  assert.equal(conceptsCommand([]), 0);          // list — smoke, output on stderr
  assert.equal(conceptsCommand(["idempotency"]), 0); // reverse lookup — smoke
  assert.equal(conceptsCommand(["alias", "x", "not-a-concept"]), 1); // unknown concept refused
});

test("concept alias retract removes alias; list still works", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cc-")));
  const { conceptsCommand } = await import("../commands/concepts.js");
  assert.equal(conceptsCommand(["alias", "jangan jalan dua kali", "idempotency"]), 0);
  assert.equal(conceptsCommand(["alias", "jangan jalan dua kali", "idempotency", "--retract"]), 0);
  assert.equal(conceptsCommand([]), 0);
});

test("concept alias refuses empty or one-letter phrase", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cc-")));
  const { conceptsCommand } = await import("../commands/concepts.js");
  assert.equal(conceptsCommand(["alias", "", "idempotency"]), 2);
  assert.equal(conceptsCommand(["alias", "x", "idempotency"]), 2);
});

test("concept alias refuses extra positional argument", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cc-")));
  const { conceptsCommand } = await import("../commands/concepts.js");
  assert.equal(conceptsCommand(["alias", "some phrase", "idempotency", "stray"]), 2);
});

/** Memory where one triple, one stated reason and one failure all mention the timeout concept. */
function memoryHearingTimeoutThreeWays(t: TestContext): void {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cc-kinds-")));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const now = Date.now();
  const records = [
    {
      kind: "triple", id: "t1", ts: now - 3_000, cwd: "/repo", schemaV: 1, agent: "claude-code", origin: "agent-hook",
      intent: { text: "timeout deadline abort in build" }, mechanism: { files: [], truncatedFiles: 0 },
    },
    {
      kind: "rationale", id: "r1", ts: now - 2_000, v: 1, cwd: "/repo", agent: "human",
      rationale_fidelity: "summary", source: "human", excerpt: "timeout deadline abort again",
    },
    {
      kind: "failure", id: "f1", ts: now - 1_000, cwd: "/repo", cmd: "npm test", exitCode: 1,
      fingerprint: "fp-timeout", signature: ["timeout deadline abort reached"], excerpt: "timeout",
    },
  ];
  writeFileSync(join(home, "memory.jsonl"), records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
}

async function heardLookup(conceptId: string): Promise<string[]> {
  const { conceptsCommand } = await import("../commands/concepts.js");
  const originalStderr = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(conceptsCommand([conceptId]), 0);
  } finally {
    process.stderr.write = originalStderr;
  }
  return stderr.split(/\r?\n/u);
}

test("concept lookup names each remembered kind in plain words by default", async (t) => {
  setVerbose(t, undefined);
  memoryHearingTimeoutThreeWays(t);
  const lines = await heardLookup("timeout");
  assert.deepEqual(lines.filter((line) => line.startsWith("just now")), [
    "just now  error  timeout deadline abort reached",
    "just now  reason  timeout deadline abort again",
    "just now  intent  timeout deadline abort in build",
  ]);
  assert.doesNotMatch(lines.join("\n"), /\b(?:triple|rationale|failure)\b/u);
});

test("concept lookup keeps the stored kind under ROCKY_VERBOSE", async (t) => {
  setVerbose(t, "1");
  memoryHearingTimeoutThreeWays(t);
  const lines = await heardLookup("timeout");
  assert.deepEqual(lines.filter((line) => line.startsWith("just now")), [
    "just now  failure  timeout deadline abort reached",
    "just now  rationale  timeout deadline abort again",
    "just now  triple  timeout deadline abort in build",
  ]);
});
