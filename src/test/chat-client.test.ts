import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { renderChatText } from "../ai/chat-render.js";

/**
 * chat.js is a browser script, so there is no page to drive here. These tests
 * lift a few of its pure helpers out of the source text and run them against a
 * stub DOM, to pin how the client reads what the server sends.
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "gui", "chat.js"), "utf8")
  .replace(/\r\n/gu, "\n"); // a Windows checkout may hold CRLF; the lookups below read LF

/** A top-level declaration of chat.js: a `function` runs to its closing brace at column 0, a `const` to the end of its line. */
function declaration(name: string): string {
  const start = source.search(new RegExp(`^(?:function ${name}\\(|const ${name} = )`, "m"));
  assert.ok(start >= 0, `chat.js no longer declares ${name}`);
  const rest = source.slice(start);
  const isFunction = rest.startsWith("function");
  const stop = rest.indexOf(isFunction ? "\n}\n" : "\n");
  assert.ok(stop >= 0, `chat.js ends the declaration of ${name} where this test does not expect`);
  return rest.slice(0, isFunction ? stop + 2 : stop);
}

interface StubNode {
  readonly tag: string;
  className: string;
  textContent: string;
  readonly children: StubNode[];
  append(...nodes: StubNode[]): void;
}

function stubNode(tag: string, textContent = ""): StubNode {
  const node: StubNode = { tag, className: "", textContent, children: [], append: (...nodes) => { node.children.push(...nodes); } };
  return node;
}

const stubDocument = {
  createDocumentFragment: () => stubNode("#fragment"),
  createElement: (tag: string) => stubNode(tag),
  createTextNode: (text: string) => stubNode("#text", text),
};

/** The named declarations, run together in a fresh context that has only the stub document. */
function load<T>(names: readonly string[]): T {
  const script = [...names.map(declaration), `({ ${names.join(", ")} })`].join("\n");
  return runInNewContext(script, { document: stubDocument }) as T;
}

/** Values built inside the context carry its own prototypes: compare them as JSON. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface AnswerParts {
  answerParts(body: unknown): { text: string; trace: string[] };
}

const BEST_MATCH_LABELS = ["pytest tests/test_a_b.py", "rm -rf *.log *.tmp", "echo __init__ and **bold**"];

test("inline markdown shows a best match label exactly as the server wrote it", () => {
  const { formatInlineNodes } = load<{ formatInlineNodes(text: string): StubNode }>(["str", "el", "formatInlineNodes"]);
  const shape = (text: string): string[][] => formatInlineNodes(text).children.map((node) => [node.tag, node.textContent]);

  for (const label of BEST_MATCH_LABELS) {
    const text = renderChatText({ topRef: "failure-aaa", topKind: "failure", topLabel: label, engine: "heuristic", status: "used", evidenceCount: 1 });
    const line = text.split("\n").find((candidate) => candidate.startsWith("Best match:"));
    assert.ok(line !== undefined, text);
    assert.deepEqual(
      plain(shape(line)),
      [["#text", "Best match: "], ["code", label], ["#text", " (failure). Remembered, not proven."]],
      `${label} reaches the page unchanged`,
    );
  }

  // Why the server writes a code span: this parser has no escapes, so a bare label is eaten.
  const bare = shape("Best match: pytest tests/test_a_b.py (failure). Remembered, not proven.");
  assert.ok(bare.some(([tag]) => tag === "em"), "a bare label would be italicised");
});

test("a turn saved with a trace keeps its answer text whole, and one saved without it is split", () => {
  const { answerParts } = load<AnswerParts>(["str", "INLINE_TRACE_LINE", "answerParts"]);

  const fresh = plain(answerParts({ text: "detail: this is the answer\nFound 1 record.", trace: ["top: x (failure). remembered, not proven.", 7, "renderer: used (m)."] }));
  assert.equal(fresh.text, "detail: this is the answer\nFound 1 record.");
  assert.deepEqual(fresh.trace, ["top: x (failure). remembered, not proven.", "renderer: used (m)."]);

  const legacy = plain(answerParts({
    text: [
      "Found 2 records.",
      "top: 3f2b8c1e-9d4a-4b7e-8a1c-5e6f7a8b9c0d (failure). remembered, not proven.",
      "decision: heuristic used, baseline kept, 0ms.",
      "detail: no key",
      "memory coverage incomplete: record-cap.",
      "renderer: template (no model text).",
    ].join("\n"),
  }));
  assert.equal(legacy.text, "Found 2 records.\nmemory coverage incomplete: record-cap.");
  assert.equal(legacy.trace.length, 4);
  assert.ok(legacy.trace[0]?.startsWith("top: "));

  const only = plain(answerParts({ text: "top: a (failure). remembered, not proven.\nrenderer: used (m)." }));
  assert.equal(only.text, "top: a (failure). remembered, not proven.\nrenderer: used (m).");
  assert.deepEqual(only.trace, []);

  assert.deepEqual(plain(answerParts({})), { text: "", trace: [] });
  assert.deepEqual(plain(answerParts(undefined)), { text: "", trace: [] });
});

test("coverage words pass through, and a saved bare reason keeps its old label", () => {
  const { coverageWords } = load<{ coverageWords(reason: string): string }>(["coverageWords"]);
  assert.equal(coverageWords("memory coverage incomplete: 1 line I cannot use."), "memory coverage incomplete: 1 line I cannot use.");
  assert.equal(coverageWords("record-cap"), "Coverage: record-cap");
});

test("the drawer says an answer was held only when the server held it", () => {
  const { noEvidenceNote } = load<{ noEvidenceNote(args: { memoryOnly: boolean; covered: boolean; status?: string }): string }>(["noEvidenceNote"]);
  const note = (memoryOnly: boolean, covered: boolean, status?: string): string => noEvidenceNote({ memoryOnly, covered, status });

  // held: the read stopped early, so Rocky gave no answer
  assert.equal(note(true, true, "unavailable"), "Memory coverage incomplete; answer held.");
  // answered: lines Rocky could not use, and no record matched well enough
  assert.equal(note(true, true, "low_confidence"), "No whole memory record matched well enough. Some memory lines could not be used.");
  assert.equal(note(true, false, "low_confidence"), "No whole memory record matched well enough.");
  assert.equal(note(false, true, "used"), "Memory coverage incomplete; code answer may miss memory evidence.");
  assert.equal(note(false, false, "used"), "No matching memory evidence for this question.");
});
