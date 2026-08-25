import test from "node:test";
import assert from "node:assert/strict";
import { searchKnowledge } from "../core/memory-query.js";
import { labelFor } from "../core/record-label.js";
import type { MemoryRecord } from "../core/memory-read.js";

const NOW = 1_756_000_000_000;

function triple(id: string, intentText: string, tags: readonly string[] = []): MemoryRecord {
  return {
    kind: "triple", id, ts: NOW - 60_000, cwd: "/p", schemaV: 1,
    agent: "claude-code", origin: "agent-hook",
    intent: { text: intentText },
    rationale: tags.length > 0 ? { text: "why noted", tags: [...tags] } : undefined,
    mechanism: { files: [], truncatedFiles: 0 },
  } as unknown as MemoryRecord;
}

const ENVELOPE =
  "<task-notification>\n<task-id>a94f069</task-id>\ndeploy pipeline failed with timeout while waiting for staging\n</task-notification>";

test("searchKnowledge does not match a triple through agent-envelope intent text", () => {
  const hits = searchKnowledge([triple("t1", ENVELOPE)], { query: "deploy pipeline timeout staging", now: NOW });
  assert.equal(hits.length, 0);
});

test("searchKnowledge still matches a genuine intent", () => {
  const hits = searchKnowledge(
    [triple("t2", "deploy pipeline timeout while waiting for staging")],
    { query: "deploy pipeline timeout staging", now: NOW },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "t2");
});

test("an envelope triple stays findable through rationale tags", () => {
  const hits = searchKnowledge([triple("t3", ENVELOPE, ["deploy", "timeout"])], { query: "deploy timeout", now: NOW });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "t3");
});

test("labelFor skips envelope intent text and falls back", () => {
  const label = labelFor(triple("t4", ENVELOPE, ["deploy"]));
  assert.ok(!label.includes("task-notification"), `label leaked envelope: ${label}`);
});
