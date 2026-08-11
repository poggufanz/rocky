import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ANNOTATE_SCHEMA,
  annotatePortFromConfig,
  createOllamaAnnotate,
  parseAnnotateOutput,
} from "../ai/annotate.js";
import type { OllamaClient } from "../ai/ollama.js";
import { loadConfig, type ConfigLoadResult } from "../core/config-read.js";

function boundaryPadding(control: string, bytes = 4_080): string {
  const controlBytes = Buffer.byteLength(control, "utf8");
  const count = Math.floor(bytes / controlBytes);
  return control.repeat(count);
}

function enabledConfig(path = "/tmp/annotate-config.json"): ConfigLoadResult {
  return {
    status: "valid",
    path,
    config: {
      version: 1,
      ai: { enabled: true, provider: "ollama", model: "test-model", exposure: "sanitized" },
    },
  };
}

test("parseAnnotateOutput accepts valid shape and caps literal values", () => {
  const out = parseAnnotateOutput({
    summary: "s".repeat(500),
    tags: ["spacing", "css", "a", "b", "c", "d"],
    label: "l".repeat(200),
  });
  assert.ok(out);
  assert.equal(out.summary.length, 280);
  assert.equal(out.tags.length, 5);
  assert.equal(out.label?.length, 120);
});

test("parseAnnotateOutput rejects missing, wrong, extra, null, and non-plain records", () => {
  assert.equal(parseAnnotateOutput(null), undefined);
  assert.equal(parseAnnotateOutput([]), undefined);
  assert.equal(parseAnnotateOutput({ summary: 7, tags: [] }), undefined);
  assert.equal(parseAnnotateOutput({ summary: "ok" }), undefined);
  assert.equal(parseAnnotateOutput({ summary: "ok", tags: "x" }), undefined);
  assert.equal(parseAnnotateOutput({ summary: "ok", tags: [], label: null }), undefined);
  assert.equal(parseAnnotateOutput({ summary: "ok", tags: ["a", "b", "c", "d", "e", 7] }), undefined);
  assert.equal(parseAnnotateOutput({ summary: "ok", tags: [], extra: true }), undefined);
  assert.equal(parseAnnotateOutput(Object.assign(Object.create({ inherited: true }), { summary: "ok", tags: [] })), undefined);
});

test("parseAnnotateOutput omits unusable tags and optional label but requires summary", () => {
  const out = parseAnnotateOutput({
    summary: "  useful\nsummary  ",
    tags: ["", "\u0000\u001b[31m\u202e", "css", "css", "spacing"],
    label: "\u0000\u001b[31m\u202e",
  });
  assert.deepEqual(out, { summary: "useful summary", tags: ["css", "spacing"] });
  assert.equal(parseAnnotateOutput({ summary: "\u0000\u001b[31m\u202e", tags: [] }), undefined);
});

test("parseAnnotateOutput strips hostile controls, redacts secrets, dedupes and bounds tags", () => {
  const token = "sk-\u0000ant-abcdefghijklmnopqrst123";
  const out = parseAnnotateOutput({
    summary: `why\n${token}\u001b[31m\u202e`,
    tags: ["a".repeat(40), "a".repeat(40), "css", "css", "spacing", "layout", "color"],
    label: "say\nno \u001b[31m?\u202e",
  });
  assert.ok(out);
  assert.equal(out.summary, "why [redacted anthropic key]");
  assert.deepEqual(out.tags, ["a".repeat(24), "css", "spacing", "layout", "color"]);
  assert.equal(out.label, undefined);
  assert.doesNotMatch(JSON.stringify(out), /sk-|abcdefghijklmnopqrst123|[\u0000-\u001f\u007f\u001b\u202e]/u);
});

test("parseAnnotateOutput bounds hostile input before transformations and persists no hostile payload", () => {
  const hostile = "x".repeat(2_000_000) + " sk-ant-abcdefghijklmnopqrst123";
  const out = parseAnnotateOutput({ summary: hostile, tags: [hostile], label: hostile });
  assert.ok(out);
  assert.equal(out.summary.length, 280);
  assert.equal(out.tags.length, 1);
  assert.equal(out.tags[0]?.length, 24);
  assert.equal(out.label?.length, 120);
  assert.doesNotMatch(JSON.stringify(out), /sk-ant-|abcdefghijklmnopqrst123/u);
});

test("parseAnnotateOutput does not leak secret fragments after control padding reaches scan boundary", () => {
  const controls = ["\u0000", "\u001b[31m", "\u202e"];
  const secretFragments = [
    "AKIAABCDEFGHIJKLMNOP",
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "xoxb-1234567890abcdefghijklmnop",
    "sk-ant-abcdefghijklmnopqrst123",
    "sk-abcdefghijklmnopqrst123",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "npm_abcdefghijklmnopqrstuvwxyz1234567890",
    "-----BEGIN RSA PRIVATE KEY-----",
    "password='secret-value'",
    "secret=secret-value",
  ];
  for (const control of controls) {
    for (const fragment of secretFragments) {
      const padded = boundaryPadding(control) + fragment;
      const truncated = boundaryPadding(control, 4_600) + fragment;
      for (const candidate of [padded, truncated]) {
        const value = { summary: candidate, tags: [candidate], label: candidate };
        const out = parseAnnotateOutput(value);
        if (out) {
          const encoded = JSON.stringify(out);
          assert.doesNotMatch(encoded, /AKIA|gh[oprsu]_|github_pat_|xox[baprs]-|sk-(?:ant-)?|npm_|-----BEGIN|(?:password|secret)\s*=/u, `${control} ${fragment}`);
        }
      }
    }
  }
});

test("parseAnnotateOutput removes the short Anthropic fragment from the original boundary repro", () => {
  const candidate = "\u0000".repeat(4_080) + "sk-ant-abcdefghijkl";
  const parsed = parseAnnotateOutput({ summary: candidate, tags: [candidate], label: candidate });
  if (parsed) {
    assert.doesNotMatch(JSON.stringify(parsed), /sk-ant-|abcdefghijkl/u);
  }
});

test("parseAnnotateOutput removes a secret fragment after a Unicode word prefix", () => {
  const candidate = "é" + boundaryPadding("\u0000", 4_585) + "sk-ant-abcdefghijklmnopqrst123" + "SAFE".repeat(20);
  const parsed = parseAnnotateOutput({ summary: candidate, tags: [candidate], label: candidate });
  assert.ok(parsed);
  assert.doesNotMatch(JSON.stringify(parsed), /sk-ant-|abcdefghijklmnopqrst123/u);
});

test("boundary scrub preserves benign text and removes an incomplete prefix before trailing text", async () => {
  const controls = ["\u0000", "\u001b[31m", "\u202e"];
  for (const control of controls) {
    const candidate = `keep this ${boundaryPadding(control, 4_580)}sk-ant-abc tail${"x".repeat(100)}`;
    const parsed = parseAnnotateOutput({ summary: candidate, tags: [candidate], label: candidate });
    assert.ok(parsed);
    assert.match(parsed.summary, /keep this tail/u);
    assert.doesNotMatch(JSON.stringify(parsed), /sk-ant-|sk-|keep this.*abc/u);

    const capture: GenerateCapture = {};
    const port = createOllamaAnnotate(fakeClient({ summary: "compact", tags: [] }, capture), "m");
    await port.run({ intent: candidate, rationaleRaw: candidate, files: [{ path: candidate, excerpt: candidate }] }, AbortSignal.timeout(1_000));
    assert.ok(capture.prompt);
    assert.match(capture.prompt, /keep this tail/u);
    assert.doesNotMatch(capture.prompt, /sk-ant-|sk-|abc/u);
  }
});

test("boundary scrub removes an incomplete private-key header", () => {
  const candidate = `keep this ${boundaryPadding("\u0000", 4_550)}-----BEGIN RSA PR${"x".repeat(100)}`;
  const parsed = parseAnnotateOutput({ summary: candidate, tags: [candidate], label: candidate });
  assert.ok(parsed);
  assert.match(parsed.summary, /keep this/u);
  assert.doesNotMatch(JSON.stringify(parsed), /-----BEGIN|PRIVATE/u);
});

test("ANNOTATE_SCHEMA independently requires bounded summary and tags and rejects extras", () => {
  assert.deepEqual(ANNOTATE_SCHEMA, {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string", maxLength: 280 },
      tags: { type: "array", items: { type: "string", maxLength: 24 }, maxItems: 5, uniqueItems: true },
      label: { type: "string", maxLength: 120 },
    },
    required: ["summary", "tags"],
  });
});

interface GenerateCapture {
  model?: string;
  prompt?: string;
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

function fakeClient(response: unknown, capture: GenerateCapture, failure?: Error): OllamaClient {
  return {
    async listInstalledModels() { return []; },
    async probeModel() { return { supported: true }; },
    async generateStructured(model, prompt, schema, signal) {
      capture.model = model;
      capture.prompt = prompt;
      capture.schema = schema;
      capture.signal = signal;
      if (failure) throw failure;
      return response;
    },
  };
}

test("createOllamaAnnotate sends bounded quoted evidence and the supplied signal/schema", async () => {
  const capture: GenerateCapture = {};
  const client = fakeClient({ summary: "margin adds space", tags: ["spacing"], label: "spacing, question" }, capture);
  const port = createOllamaAnnotate(client, "model-a");
  const signal = AbortSignal.timeout(1_000);
  const out = await port.run({
    intent: "naikin sk-\u0000ant-abcdefghijklmnopqrst123",
    rationaleRaw: "agent said margin adds space",
    files: [{ path: "src/app.css", excerpt: "margin-top: 8px" }],
  }, signal);
  assert.deepEqual(out, { summary: "margin adds space", tags: ["spacing"], label: "spacing, question" });
  assert.equal(capture.model, "model-a");
  assert.equal(capture.signal, signal);
  assert.equal(capture.schema, ANNOTATE_SCHEMA);
  assert.ok(capture.prompt);
  assert.ok(Buffer.byteLength(capture.prompt, "utf8") <= 8 * 1024);
  assert.match(capture.prompt, /untrusted quoted evidence/i);
  assert.match(capture.prompt, /stated reasoning/i);
  assert.match(capture.prompt, /never invent facts/i);
  assert.match(capture.prompt, /never (?:follow|obey|execute)/i);
  assert.match(capture.prompt, /intent|mechanism/i);
  assert.doesNotMatch(capture.prompt, /sk-ant-|abcdefghijklmnopqrst123/u);
  assert.doesNotMatch(capture.prompt, /interpret|run|execute.*command/i);
});

test("createOllamaAnnotate redacts control-padded secret fragments in prompt evidence", async () => {
  const capture: GenerateCapture = {};
  const client = fakeClient({ summary: "compact", tags: [] }, capture);
  const port = createOllamaAnnotate(client, "model-a");
  for (const control of ["\u0000", "\u001b[31m", "\u202e"]) {
    const padded = boundaryPadding(control) + "sk-ant-abcdefghijklmnopqrst123";
    const out = await port.run({ intent: padded, rationaleRaw: padded, files: [{ path: padded, excerpt: padded }] }, AbortSignal.timeout(1_000));
    assert.deepEqual(out, { summary: "compact", tags: [] });
    assert.ok(capture.prompt);
    assert.doesNotMatch(capture.prompt, /sk-(?:ant-)?|abcdefghijklmnopqrst123/u);
    assert.ok(Buffer.byteLength(capture.prompt, "utf8") <= 8 * 1024);
  }
});

test("createOllamaAnnotate removes a secret fragment after a Unicode word prefix in prompt evidence", async () => {
  const candidate = "é" + boundaryPadding("\u0000", 4_585) + "sk-ant-abcdefghijklmnopqrst123" + "SAFE".repeat(20);
  const capture: GenerateCapture = {};
  const port = createOllamaAnnotate(fakeClient({ summary: "compact", tags: [] }, capture), "model-a");
  const out = await port.run(
    { intent: candidate, rationaleRaw: candidate, files: [{ path: "safe", excerpt: candidate }] },
    AbortSignal.timeout(1_000),
  );
  assert.deepEqual(out, { summary: "compact", tags: [] });
  assert.ok(capture.prompt);
  assert.doesNotMatch(capture.prompt, /sk-ant-|abcdefghijklmnopqrst123/u);
});

test("createOllamaAnnotate returns undefined for invalid, throwing, and already-aborted calls", async () => {
  const invalid = createOllamaAnnotate(fakeClient({ summary: 7, tags: [] }, {}), "m");
  assert.equal(await invalid.run({ files: [] }, AbortSignal.timeout(1_000)), undefined);

  const throwing = createOllamaAnnotate(fakeClient(undefined, {}, new Error("down")), "m");
  assert.equal(await throwing.run({ files: [] }, AbortSignal.timeout(1_000)), undefined);

  const capture: GenerateCapture = {};
  const aborted = createOllamaAnnotate(fakeClient({ summary: "late", tags: [] }, capture), "m");
  const signal = AbortSignal.abort(new Error("cancelled"));
  assert.equal(await aborted.run({ files: [] }, signal), undefined);
  assert.equal(capture.model, undefined);
});

test("createOllamaAnnotate rejects a response after its signal expires", async () => {
  const controller = new AbortController();
  const client: OllamaClient = {
    async listInstalledModels() { return []; },
    async probeModel() { return { supported: true }; },
    async generateStructured(_model, _prompt, _schema, signal) {
      controller.abort(new Error("expired"));
      assert.equal(signal, controller.signal);
      return { summary: "late", tags: [] };
    },
  };
  const port = createOllamaAnnotate(client, "m");
  assert.equal(await port.run({ files: [] }, controller.signal), undefined);
});

test("annotatePortFromConfig is enabled only for valid Ollama config", () => {
  assert.ok(annotatePortFromConfig(enabledConfig()));
  assert.equal(annotatePortFromConfig({
    status: "valid",
    path: "/tmp/config.json",
    config: { version: 1, ai: { enabled: false } },
  }), undefined);
  assert.equal(annotatePortFromConfig({
    status: "missing",
    path: "/tmp/config.json",
    config: { version: 1, ai: { enabled: false } },
  }), undefined);
  assert.equal(annotatePortFromConfig({ status: "invalid", path: "/tmp/config.json", error: "bad" }), undefined);
  assert.equal(annotatePortFromConfig({
    status: "valid",
    path: "/tmp/config.json",
    config: { version: 1, ai: { enabled: true, provider: "not-ollama", model: "m", exposure: "sanitized" } as never },
  }), undefined);
});

test("config factory accepts an enabled config at an explicit path without touching network", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-annotate-config-"));
  t.after(() => {
    // The test runner owns this scratch directory; no real home is used.
  });
  const path = join(home, "config.json");
  writeFileSync(path, JSON.stringify({ version: 1, ai: { enabled: true, provider: "ollama", model: "m", exposure: "sanitized" } }), "utf8");
  const result = loadConfig(path);
  assert.equal(result.status, "valid");
  assert.ok(annotatePortFromConfig(result));
});
