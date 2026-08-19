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
  assert.equal(JSON.parse(line).kind, "rationale");
});

test("recordAlias appends add and retract records", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-al-")));
  const { recordAlias } = await import("../core/memory.js");
  const add = recordAlias({ alias: "jangan jalan dua kali", concept: "idempotency", action: "add" });
  const retract = recordAlias({ alias: "jangan jalan dua kali", concept: "idempotency", action: "retract" });
  assert.equal(add.action, "add");
  assert.equal(retract.action, "retract");
});
