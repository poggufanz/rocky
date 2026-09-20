import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGui, type GuiHandle } from "../gui/server.js";
import { decisionLogPath } from "../ai/decision-log.js";

function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-chat-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-chat-root-"));
  process.env.ROCKY_HOME = home;
  return { home, root };
}

function seedMemory(home: string, records: unknown[]): void {
  writeFileSync(join(home, "memory.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function seedConfig(home: string, config: unknown): void {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
}

async function withGui(root: string, run: (handle: GuiHandle) => Promise<void>): Promise<void> {
  const handle = await startGui({ port: 0, root });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

interface ChatTraceWire {
  engine: string;
  status: string;
  confidence: number | null;
  evidenceRefs: string[];
  latencyMs: number;
}

interface ChatWire {
  text: string;
  evidenceCards: { ref: string; kind: string; snippet: string }[];
  decisionTrace: ChatTraceWire;
}

function readWire(value: unknown): ChatWire {
  assert.ok(typeof value === "object" && value !== null);
  const body = value as { text?: unknown; evidenceCards?: unknown; decisionTrace?: unknown };
  assert.equal(typeof body.text, "string");
  assert.ok(Array.isArray(body.evidenceCards));
  assert.ok(typeof body.decisionTrace === "object" && body.decisionTrace !== null);
  const trace = body.decisionTrace as {
    engine: unknown; status: unknown; confidence: unknown; evidenceRefs: unknown; latencyMs: unknown;
  };
  if (typeof trace.engine !== "string") throw new Error("trace engine is not a string");
  if (typeof trace.status !== "string") throw new Error("trace status is not a string");
  if (trace.confidence !== null && typeof trace.confidence !== "number") throw new Error("trace confidence shape");
  if (!Array.isArray(trace.evidenceRefs)) throw new Error("trace refs are not an array");
  if (typeof trace.latencyMs !== "number") throw new Error("trace latency is not a number");
  if (typeof body.text !== "string") throw new Error("chat text is not a string");
  return {
    text: body.text,
    evidenceCards: body.evidenceCards as ChatWire["evidenceCards"],
    decisionTrace: {
      engine: trace.engine,
      status: trace.status,
      confidence: trace.confidence,
      evidenceRefs: trace.evidenceRefs as string[],
      latencyMs: trace.latencyMs,
    },
  };
}

const post = async (handle: GuiHandle, body: unknown): Promise<{ status: number; wire: ChatWire | null }> => {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
    method: "POST",
    headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => null);
  return { status: response.status, wire: parsed === null ? null : readWireLoose(parsed) };
};

function readWireLoose(parsed: unknown): ChatWire | null {
  try {
    return readWire(parsed);
  } catch {
    return null;
  }
}

const failureRecord = (id: string, cmd: string): unknown => ({
  kind: "failure",
  id,
  ts: Date.now() - 1000,
  cwd: "/private/one",
  cmd,
  exitCode: 1,
  fingerprint: "a1b2c3d4e5f60718",
  signature: [cmd],
  excerpt: "plain excerpt",
});

test("chat works offline with heuristic and no key", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  delete process.env.TYPESAFE_API_KEY;
  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "npm run build" });
    assert.equal(answer.status, 200);
    assert.ok(answer.wire !== null);
    assert.equal(answer.wire?.decisionTrace.engine, "heuristic");
    assert.equal(answer.wire?.decisionTrace.status, "used");
    assert.equal(answer.wire?.decisionTrace.confidence, null);
    assert.equal(typeof answer.wire?.decisionTrace.latencyMs, "number");
    assert.ok(Array.isArray(answer.wire?.decisionTrace.evidenceRefs));
    const lines = readFileSync(decisionLogPath(), "utf8").trim().split("\n");
    const last = lines[lines.length - 1];
    assert.ok(typeof last === "string" && last.length > 0);
    const entry = JSON.parse(last) as { engine?: unknown; outcome?: unknown };
    assert.equal(entry.engine, "heuristic");
    assert.equal(entry.outcome, "chat");
  });
});

test("chat with jev configured but no key reports disabled plus baseline", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  seedConfig(home, { version: 1, ai: { enabled: false }, decision: { engine: "jev" } });
  delete process.env.TYPESAFE_API_KEY;
  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "npm run build" });
    assert.equal(answer.status, 200);
    assert.equal(answer.wire?.decisionTrace.engine, "jev");
    assert.equal(answer.wire?.decisionTrace.status, "disabled");
    assert.equal(answer.wire?.decisionTrace.confidence, null);
    assert.ok(String(answer.wire?.text ?? "").includes("disabled"));
  });
});

test("chat validates its input and keeps the token gate", async () => {
  const { root } = hermetic();
  await withGui(root, async (handle) => {
    assert.equal((await post(handle, { message: "   " })).status, 400);
    const noToken = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.equal(noToken.status, 403);
  });
});

test("chat on empty memory holds with a visible trace", async () => {
  const { root } = hermetic();
  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "something never heard" });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.wire?.evidenceCards, []);
    assert.deepEqual(answer.wire?.decisionTrace.evidenceRefs, []);
    assert.ok(String(answer.wire?.text ?? "").includes("heard nothing"));
  });
});
