import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "../listening/types.js";
import { appendListeningEvent } from "../listening/event-log.js";
import { findTemporalCandidates, projectGraph } from "../listening/graph-store.js";
import { setRepoCapture } from "../listening/consent.js";

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-run-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

function setupRepo(home: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-run-repo-")));
  mkdirSync(join(root, ".git"));
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli" }, home).ok, true);
  return root;
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    v: 1,
    eventId: randomUUID(),
    source: "hook",
    ts: 1_700_000_000_000,
    adapterVersion: "test/1",
    consent: { host: true, repo: true, rawTrace: false },
    redaction: { applied: false, truncated: false },
    coverage: "complete",
    refs: {},
    ...overrides,
  };
}

test("unverified test_run and dangling validated_by are dropped", () => {
  const home = freshHome();
  const root = setupRepo(home);
  appendListeningEvent(root, envelope({ eventId: "tr-bare", node: "test_run", nodeId: "tr1" }), undefined, home);
  appendListeningEvent(
    root,
    envelope({ eventId: "val-dangle", edge: { kind: "validated_by", from: "h1", to: "tr1", basis: "unknown" } }),
    undefined,
    home,
  );
  const g = projectGraph(root, { limit: 50 }, home);
  assert.equal(g.nodes.length, 0);
  assert.equal(g.edges.length, 0);
  assert.ok(g.coverage.reasons.length > 0);
});

test("verified claim keeps test_run and its validation edge", () => {
  const home = freshHome();
  const root = setupRepo(home);
  appendListeningEvent(
    root,
    envelope({
      eventId: "tr-ok",
      node: "test_run",
      nodeId: "tr-ok",
      testClaim: { commandIdentity: "npm-test", outcome: "pass", testedVersion: "vvv1" },
      refs: { version: "vvv1" },
    }),
    undefined,
    home,
  );
  appendListeningEvent(
    root,
    envelope({ eventId: "val-ok", edge: { kind: "validated_by", from: "h1", to: "tr-ok", basis: "direct" }, refs: { version: "tr-ok" } }),
    undefined,
    home,
  );
  const g = projectGraph(root, { limit: 50 }, home);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.edges.length, 1);
});

test("candidate links pass through weak and never promoted", () => {
  const home = freshHome();
  const root = setupRepo(home);
  appendListeningEvent(
    root,
    envelope({ eventId: "c1", edge: { kind: "read_from", from: "a", to: "b", basis: "candidate_link" } }),
    undefined,
    home,
  );
  const g = projectGraph(root, { limit: 50 }, home);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].basis, "candidate_link");
  assert.equal(g.edges[0].weak, true);
});

test("query filters and limit truncation hold", () => {
  const home = freshHome();
  const root = setupRepo(home);
  appendListeningEvent(root, envelope({ eventId: "f1", node: "tool_action", nodeId: "t1", refs: { fileRel: "a.txt" } }), undefined, home);
  appendListeningEvent(root, envelope({ eventId: "f2", node: "tool_action", nodeId: "t2", refs: { fileRel: "b.txt" } }), undefined, home);
  const filtered = projectGraph(root, { limit: 50, file: "a.txt" }, home);
  assert.equal(filtered.nodes.length, 1);
  const truncated = projectGraph(root, { limit: 1 }, home);
  assert.equal(truncated.truncated, true);
});

test("temporal candidates are bounded, sorted, and non-causal", () => {
  const base = 1_700_000_000_000;
  const events = [0, 5_000, 60_000, 60 * 60_000].map((dt, i) => envelope({ eventId: `e${i}`, ts: base + dt }));
  const out = findTemporalCandidates(base, events, 10 * 60_000, 8);
  assert.deepEqual(out.map((c) => c.eventId), ["e0", "e1", "e2"]);
  const capped = findTemporalCandidates(base, events, 10 * 60_000, 1);
  assert.equal(capped.length, 1);
});
