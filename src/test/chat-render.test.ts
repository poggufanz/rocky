import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_RENDER_ORDER,
  RAW_CHAT_TEXT,
  RAW_CHAT_TRACE,
  renderChatText,
  renderChatTrace,
  safeRenderChatText,
  safeRenderChatTrace,
  validateRenderedClaims,
  type ChatRenderFact,
} from "../ai/chat-render.js";
import { startGui } from "../gui/server.js";
import { validateOutputLine } from "../ui/phrases.js";

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u;
const RECORD_UUID = "3f2b8c1e-9d4a-4b7e-8a1c-5e6f7a8b9c0d";
const TRACE_PREFIXES = ["top: ", "decision: ", "detail: ", "memory coverage incomplete: ", "renderer: "];

const JEV_FACT: ChatRenderFact = {
  topRef: "failure-aaa",
  topKind: "failure",
  topLabel: "npm run build",
  topScore: 0.9,
  engine: "jev",
  status: "used",
  evidenceCount: 2,
  latencyMs: 12,
};

test("template text names the top record by label, and its id stays in the trace", () => {
  const text = renderChatText(JEV_FACT);
  assert.equal(text, "Found 2 records.\nBest match: `npm run build` (failure). Remembered, not proven.");
  assert.deepEqual(validateOutputLine(text), []);
  assert.deepEqual(renderChatTrace(JEV_FACT), [
    "top: failure-aaa (failure). remembered, not proven.",
    "decision: jev used, top score 0.90, 12ms.",
  ]);
});

test("template text never carries a record id, whatever the id looks like", () => {
  const fact: ChatRenderFact = { ...JEV_FACT, topRef: RECORD_UUID };
  const text = renderChatText(fact);
  assert.doesNotMatch(text, UUID_SHAPE);
  assert.ok(!text.includes(RECORD_UUID));
  for (const prefix of TRACE_PREFIXES) assert.ok(!text.includes(prefix), `${prefix}stays out of the answer text`);
  assert.ok(renderChatTrace(fact).includes(`top: ${RECORD_UUID} (failure). remembered, not proven.`));
});

test("best match shows the label as a code span, so inline markdown cannot change it", () => {
  const labels = ["pytest tests/test_a_b.py", "rm -rf *.log *.tmp", "echo __init__ and **bold**", "ls [failure-aaa] _x_"];
  for (const label of labels) {
    const text = renderChatText({ ...JEV_FACT, topLabel: label });
    assert.ok(text.includes(`Best match: \`${label}\` (failure). Remembered, not proven.`), text);
  }
});

test("a backtick in the label cannot end the code span, and a line break cannot split it", () => {
  const text = renderChatText({ ...JEV_FACT, topLabel: "echo `date`\n  now" });
  assert.equal(text, "Found 2 records.\nBest match: `echo 'date' now` (failure). Remembered, not proven.");
});

test("a model cannot pass an uncited best match line through the claims gate", () => {
  const check = validateRenderedClaims("Best match: `rm -rf /` (failure). Remembered, not proven.", ["failure-aaa"]);
  assert.equal(check.dropped, 1);
  assert.equal(check.stripped, "");
});

test("a top record without a label is named by kind, never by id", () => {
  const fact: ChatRenderFact = { topRef: RECORD_UUID, topKind: "failure", engine: "heuristic", status: "used", evidenceCount: 1, latencyMs: 0 };
  const text = renderChatText(fact);
  assert.equal(text, "Found 1 record.\nBest match: failure record. Remembered, not proven.");
  assert.deepEqual(validateOutputLine(text), []);
  const bare = renderChatText({ engine: "heuristic", status: "used", evidenceCount: 1, latencyMs: 0 });
  assert.equal(bare, "Found 1 record.");
});

test("no records found says so in the text and keeps the decision in the trace", () => {
  const fact: ChatRenderFact = { engine: "heuristic", status: "low_confidence", evidenceCount: 0, latencyMs: 4 };
  assert.equal(renderChatText(fact), "No records were found. Nothing was ranked.");
  assert.deepEqual(renderChatTrace(fact), ["decision: heuristic low_confidence, baseline kept, 4ms."]);
});

test("trace keeps top, decision, detail, then the coverage line, and none reach the text", () => {
  const coverageLine = "memory coverage incomplete: 1 line could not be used.";
  const fact: ChatRenderFact = {
    topRef: "failure-aaa",
    topKind: "failure",
    topLabel: "npm run build",
    engine: "heuristic",
    status: "unavailable",
    evidenceCount: 1,
    latencyMs: 3,
    detail: "jev key missing",
    coverageLine,
  };
  assert.deepEqual(renderChatTrace(fact), [
    "top: failure-aaa (failure). remembered, not proven.",
    "decision: heuristic unavailable, baseline kept, 3ms.",
    "detail: jev key missing",
    coverageLine,
  ]);
  const text = renderChatText(fact);
  for (const prefix of TRACE_PREFIXES) assert.ok(!text.includes(prefix), `${prefix}stays out of the answer text`);
  assert.ok(!text.includes("jev key missing"));
});

test("claim without a cited ref is stripped and counted", () => {
  const text = renderChatText({
    engine: "heuristic",
    status: "used",
    evidenceCount: 1,
    latencyMs: 3,
  });
  const tainted = `${text}\nThe cache bug is definitely caused by stale DNS.`;
  const check = validateRenderedClaims(tainted, ["failure-aaa"]);
  assert.ok(check.dropped > 0);
  assert.ok(!check.stripped.includes("stale DNS"));
  assert.ok(check.stripped.includes("Found 1 record."));
});

test("only the exact count line passes the claims gate without a citation", () => {
  const kept = validateRenderedClaims("Found 3 records.", ["failure-aaa"]);
  assert.equal(kept.dropped, 0);
  assert.equal(kept.stripped, "Found 3 records.");
  const claim = validateRenderedClaims("Found the cause in a stale cache.", ["failure-aaa"]);
  assert.equal(claim.dropped, 1);
  assert.equal(claim.stripped, "");
});

test("cited answer id survives the claims gate", () => {
  const text = "q_failure-aaa ranks first with noul 0.9.";
  const check = validateRenderedClaims(text, ["failure-aaa"]);
  assert.equal(check.dropped, 0);
  assert.ok(check.stripped.includes("q_failure-aaa"));
});

test("chat payload carries the evidence-first renderOrder and the trace apart from the text", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-render-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-render-root-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    writeFileSync(
      join(home, "memory.jsonl"),
      `${JSON.stringify({ kind: "failure", id: "failure-aaa", ts: Date.now() - 1000, cwd: "/private/one", cmd: "npm run build", exitCode: 1, fingerprint: "a1b2c3d4e5f60718", signature: ["npm run build"], excerpt: "plain excerpt" })}\n`,
    );
    const handle = await startGui({ port: 0, root });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
        method: "POST",
        headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "npm run build" }),
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(payload.renderOrder, ["evidenceCards", "text", "decisionTrace"]);
      assert.ok(Array.isArray(payload.evidenceCards));
      assert.equal(typeof payload.text, "string");
      assert.ok(Array.isArray(payload.trace));
      assert.ok((payload.trace as string[]).some((line) => line.startsWith("top: failure-aaa")));
    } finally {
      await handle.close();
    }
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("renderer failure degrades to the raw template, text and trace alike", () => {
  const hostile = {
    engine: "heuristic",
    status: "used",
    latencyMs: 0,
    get evidenceCount(): number {
      throw new Error("renderer input could not be read");
    },
  } as unknown as ChatRenderFact;
  assert.equal(safeRenderChatText(hostile), RAW_CHAT_TEXT);
  assert.deepEqual(safeRenderChatTrace(hostile), RAW_CHAT_TRACE);
  for (const prefix of TRACE_PREFIXES) assert.ok(!RAW_CHAT_TEXT.includes(prefix), `${prefix}stays out of the raw text`);
  assert.deepEqual(validateOutputLine(RAW_CHAT_TEXT), []);
});

test("an odd fact still renders to strings", () => {
  const odd: ChatRenderFact = {
    topRef: "a",
    engine: "hev" as never,
    status: "used",
    evidenceCount: Number.NaN,
    latencyMs: 1,
  };
  assert.equal(typeof safeRenderChatText(odd), "string");
  assert.ok(safeRenderChatText(odd).length > 0);
  assert.ok(safeRenderChatTrace(odd).every((line) => typeof line === "string"));
});

test("evidence-first render order is documented and stable", () => {
  assert.deepEqual([...CHAT_RENDER_ORDER], ["evidenceCards", "text", "decisionTrace"]);
});
