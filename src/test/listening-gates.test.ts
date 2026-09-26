import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "../listening/types.js";
import { HARNESS_IDS } from "../listening/types.js";
import { appendListeningEvent } from "../listening/event-log.js";
import { eventsPath } from "../listening/store-paths.js";
import { projectGraph } from "../listening/graph-store.js";
import { loadEventsForProjection as loadEvents } from "../listening/event-log-read.js";
import { setRepoCapture } from "../listening/consent.js";

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

test("closed registry holds exactly 11 ids", () => {
  assert.equal(HARNESS_IDS.length, 11);
});

test("projection drops a crafted runtime_observed envelope from durable JSON", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-gates-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gates-repo-")));
  mkdirSync(join(root, ".git"));
  assert.equal(setRepoCapture(root, true, { yes: true, actor: "cli" }, home).ok, true);
  appendListeningEvent(
    root,
    envelope({ eventId: "ok", edge: { kind: "read_from", from: "a", to: "b", basis: "direct" } }),
    undefined,
    home,
  );
  appendFileSync(
    eventsPath(root, home),
    `${JSON.stringify(envelope({ eventId: "evil", edge: { kind: "read_from", from: "a", to: "c", basis: "runtime_observed" as never } }))}\n`,
  );
  const g = projectGraph(root, { limit: 50 }, home);
  assert.ok(g.edges.every((e) => e.basis !== "runtime_observed"));
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].basis, "direct");
  assert.ok(loadEvents(root, home).events.every((e) => e.edge === undefined || (e.edge.basis as string) !== "runtime_observed"));
});

test("listening source tree opens no network surface", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "listening");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(join(dir, name), "utf8");
    assert.ok(!source.includes("node:net"), `${name} must not import node:net`);
    assert.ok(!source.includes("node:http"), `${name} must not import node:http`);
    assert.ok(!source.includes("fetch("), `${name} must not fetch`);
  }
});
