import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemoryChecked } from "../core/memory-read.js";

test("reader loads rationale and alias kinds and keeps unknown kinds tolerant", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-schema-")));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const lines = [
      JSON.stringify({ kind: "rationale", id: "r1", ts: 1000, v: 1, cwd: "/p", agent: "claude-code", rationale_fidelity: "raw", source: "log-thinking", excerpt: "retry lacked backoff" }),
      JSON.stringify({ kind: "alias", id: "a1", ts: 1001, v: 1, alias: "jangan jalan dua kali", concept: "idempotency", action: "add" }),
      JSON.stringify({ kind: "mystery-future", id: "x1", ts: 1002 }),
    ];
    writeFileSync(join(home, "memory.jsonl"), lines.join("\n") + "\n");
    const records = loadMemoryChecked(join(home, "memory.jsonl")).records;
    const rationale = records.find((r) => (r as { kind: string }).kind === "rationale");
    const alias = records.find((r) => (r as { kind: string }).kind === "alias");
    assert.ok(rationale, "rationale kind must load");
    assert.ok(alias, "alias kind must load");
    assert.equal((rationale as unknown as { rationale_fidelity: string }).rationale_fidelity, "raw");
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});
