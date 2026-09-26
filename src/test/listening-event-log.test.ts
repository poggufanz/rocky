import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "../listening/types.js";
import { appendHostEvent, appendListeningEvent, storeListeningObject } from "../listening/event-log.js";
import { loadEventsForProjection, readListeningTail } from "../listening/event-log-read.js";
import { setRepoCapture } from "../listening/consent.js";
import { eventsPath } from "../listening/store-paths.js";

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-log-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

function grantedRepo(home: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-repo-")));
  mkdirSync(join(root, ".git"));
  const granted = setRepoCapture(root, true, { yes: true, actor: "cli" }, home);
  assert.equal(granted.ok, true);
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

test("append then tail roundtrips in order", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  appendListeningEvent(root, envelope({ eventId: "e1", ts: 1 }), undefined, home);
  appendListeningEvent(root, envelope({ eventId: "e2", ts: 2 }), undefined, home);
  const tail = readListeningTail(root, { limit: 10 }, home);
  assert.deepEqual(tail.events.map((e) => e.eventId), ["e1", "e2"]);
  assert.equal(tail.events[1].eventId, tail.nextCursor);
  assert.equal(tail.coverage, "complete");
});

test("nativeId append is idempotent and keeps the first id", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  const first = appendListeningEvent(root, envelope({ eventId: "first", nativeId: "n1" }), undefined, home);
  assert.equal(first.ok, true);
  const again = appendListeningEvent(root, envelope({ eventId: "other", nativeId: "n1" }), undefined, home);
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.eventId, "first");
  const { events } = loadEventsForProjection(root, home);
  assert.equal(events.length, 1);
});

test("forbidden v1 basis is refused, not stored", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  const out = appendListeningEvent(
    root,
    envelope({ edge: { kind: "read_from", from: "a", to: "b", basis: "runtime_observed" as never } }),
    undefined,
    home,
  );
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "forbidden-basis");
  assert.equal(loadEventsForProjection(root, home).events.length, 0);
});

test("oversized object is refused with repo consent intact", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  const big = new Uint8Array(1 * 1024 * 1024 + 1);
  const out = storeListeningObject(root, big, home);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "object-oversized");
});

test("append without repo consent is refused", () => {
  const home = freshHome();
  const out = appendListeningEvent("/repo/never-granted", envelope(), undefined, home);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "repo-consent-required");
});

test("malformed lines are skipped on read", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  appendListeningEvent(root, envelope({ eventId: "good" }), undefined, home);
  appendFileSync(eventsPath(root, home), "not json\n");
  const { events, malformed } = loadEventsForProjection(root, home);
  assert.equal(events.length, 1);
  assert.equal(malformed, 1);
  const tail = readListeningTail(root, { limit: 10 }, home);
  assert.equal(tail.coverage, "partial");
});

test("test_run without a complete claim is refused", () => {
  const home = freshHome();
  const root = grantedRepo(home);
  const out = appendListeningEvent(root, envelope({ node: "test_run", nodeId: "tr1" }), undefined, home);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "test-claim-required");
});

test("host events append without repo consent under host consent", () => {
  const home = freshHome();
  const out = appendHostEvent("codex", envelope({ nativeId: "h1" }), home, true);
  assert.equal(out.ok, true);
  const denied = appendHostEvent("codex", envelope({ nativeId: "h2" }), home, false);
  assert.equal(denied.ok, false);
});
