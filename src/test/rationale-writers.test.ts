import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("recordRationale caps excerpt head+tail and stamps envelope", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-rw-")));
  const { recordRationale, MAX_RATIONALE_EXCERPT_BYTES } = await import("../core/memory.js");
  const long = "why ".repeat(2000);
  const rec = recordRationale({ cwd: "/p", agent: "claude-code", rationale_fidelity: "raw", source: "log-thinking", text: long });
  assert.equal(rec.kind, "rationale");
  assert.equal(rec.v, 1);
  assert.ok(Buffer.byteLength(rec.excerpt, "utf8") <= MAX_RATIONALE_EXCERPT_BYTES);
  assert.ok(rec.excerpt.includes(" … "), "head+tail marker present when truncated");
  const line = readFileSync(join(process.env.ROCKY_HOME!, "memory.jsonl"), "utf8").trim();
  const stored = JSON.parse(line);
  assert.equal(stored.kind, "rationale");
  assert.equal(Object.hasOwn(stored, "expectedCommand"), false);
});

test("recordRationale round-trips expectedCommand and raw fidelity", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-rw-")));
  const { recordRationale } = await import("../core/memory.js");
  const { loadMemoryChecked } = await import("../core/memory-read.js");
  const input = {
    cwd: process.env.ROCKY_HOME,
    source: "mcp",
    rationale_fidelity: "raw",
    agent: "generic",
    text: "expect auth tests pass",
    links: { failureId: "f1" },
  } as const;

  recordRationale({ ...input, expectedCommand: "npm test -- auth" });
  recordRationale({ ...input, expectedCommand: "x".repeat(250) });
  const supplementaryCharacter = "\u{10348}";
  recordRationale({ ...input, expectedCommand: supplementaryCharacter.repeat(250) });
  for (const expectedCommand of ["", "bad\ncommand"]) {
    const stored = recordRationale({ ...input, expectedCommand });
    assert.equal(Object.hasOwn(stored, "expectedCommand"), false);
  }

  const { records } = loadMemoryChecked();
  const [first, second, third] = records;
  assert.equal(first?.kind, "rationale");
  assert.equal(first.expectedCommand, "npm test -- auth");
  assert.equal(first.source, "mcp");
  assert.equal(first.rationale_fidelity, "raw");
  assert.equal(second?.kind, "rationale");
  assert.equal(second.expectedCommand, "x".repeat(200));
  assert.equal(third?.kind, "rationale");
  assert.equal(third.expectedCommand, supplementaryCharacter.repeat(200));
});

test("recordAlias appends add and retract records", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-al-")));
  const { recordAlias } = await import("../core/memory.js");
  const add = recordAlias({ alias: "jangan jalan dua kali", concept: "idempotency", action: "add" });
  const retract = recordAlias({ alias: "jangan jalan dua kali", concept: "idempotency", action: "retract" });
  assert.equal(add.action, "add");
  assert.equal(retract.action, "retract");
});
