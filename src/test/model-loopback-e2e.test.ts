import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OLLAMA_REQUEST_LIMIT, OLLAMA_RESPONSE_LIMIT, OllamaResponseTooLargeError, createOllamaClient } from "../ai/ollama.js";
import { createOllamaAnnotate } from "../ai/annotate.js";
import { createOllamaDictionaryRank } from "../ai/dictionary-ai.js";
import { createRecallAiPort } from "../ai/recall-ai.js";
import { annotateBatch } from "../agent/annotate.js";
import { appendEvent } from "../agent/spool.js";
import type { AgentEvent } from "../agent/schema.js";
import type { RecallHit } from "../core/memory-query.js";
import type { MemoryQueries } from "../core/memory-query.js";
import type { ConfigLoadResult } from "../core/config-read.js";
import type { MemoryRecord, TripleRecord } from "../core/memory-read.js";
import { loadMemory } from "../core/memory.js";
import { what } from "../commands/dictionary.js";
import { model } from "../commands/model.js";
import { recall } from "../commands/recall.js";
import { checkAmbiguity } from "../agent/ambiguity.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

const MODEL = "task16-e2e-model";

interface RequestRecord {
  method: string;
  url: string;
  body: string;
  json?: Record<string, unknown>;
  aborted: boolean;
  responseClosed: boolean;
}

type Handler = (request: RequestRecord, response: ServerResponse<IncomingMessage>) => void | Promise<void>;

class LoopbackServer {
  readonly requests: RequestRecord[] = [];
  private readonly server: ReturnType<typeof createServer>;
  private requestWaiters: Array<(request: RequestRecord) => void> = [];
  private abortWaiters: Array<() => void> = [];
  private closeWaiters: Array<() => void> = [];
  private listening = false;

  constructor(private readonly handler: Handler) {
    this.server = createServer((incoming, response) => {
      const request: RequestRecord = {
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        body: "",
        aborted: false,
        responseClosed: false,
      };
      this.requests.push(request);
      for (const waiter of this.requestWaiters.splice(0)) waiter(request);
      const markAborted = (): void => {
        if (request.aborted) return;
        request.aborted = true;
        for (const waiter of this.abortWaiters.splice(0)) waiter();
      };
      incoming.on("aborted", markAborted);
      incoming.on("close", () => {
        if (!incoming.complete) markAborted();
      });
      response.on("close", () => {
        request.responseClosed = true;
        if (!response.writableEnded) markAborted();
        for (const waiter of this.closeWaiters.splice(0)) waiter();
      });
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        request.body = Buffer.concat(chunks).toString("utf8");
        if (request.body.length > 0) {
          try {
            const parsed: unknown = JSON.parse(request.body);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              request.json = parsed as Record<string, unknown>;
            }
          } catch {
            // The test intentionally records malformed JSON as an absent object.
          }
        }
        void Promise.resolve(this.handler(request, response)).catch(() => response.destroy());
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.listening = true;
        resolve();
      });
    });
  }

  get origin(): string {
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("fake server has no loopback address");
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    const closePromise = new Promise<void>((resolve, reject) => {
      this.server.close((error) => error === undefined ? resolve() : reject(error));
    });
    // A held response/body is intentional in timeout tests. Force active
    // sockets closed after initiating server shutdown so failed assertions
    // cannot leave a loopback server or fetch connection alive.
    const forceClose = (this.server as typeof this.server & { closeAllConnections?: () => void }).closeAllConnections;
    if (typeof forceClose === "function") forceClose.call(this.server);
    await closePromise;
  }

  waitForRequest(): Promise<RequestRecord> {
    const existing = this.requests.at(-1);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => this.requestWaiters.push(resolve));
  }

  waitForAbort(): Promise<void> {
    if (this.requests.some((request) => request.aborted)) return Promise.resolve();
    return new Promise((resolve) => this.abortWaiters.push(resolve));
  }

  waitForResponseClose(): Promise<void> {
    if (this.requests.some((request) => request.responseClosed)) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }
}

function sendJson(response: ServerResponse<IncomingMessage>, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function envelope(value: unknown): Record<string, unknown> {
  return { done: true, response: JSON.stringify(value) };
}

function enabledConfig(path = "/tmp/task16-e2e-config.json"): ConfigLoadResult {
  return {
    status: "valid",
    path,
    config: { version: 1, ai: { enabled: true, provider: "ollama", model: MODEL, exposure: "sanitized" } },
  };
}

function triple(id: string, path: string): TripleRecord {
  return {
    kind: "triple",
    id,
    ts: Date.now() - 1_000,
    cwd: "/task16/project",
    schemaV: 1,
    agent: "codex",
    origin: "agent-hook",
    intent: { text: "change button" },
    rationale: { text: "spacing", tags: ["layout"], source: "transcript" },
    mechanism: { files: [{ path, plusMinus: [1, 0], props: ["button", "margin-top"] }], truncatedFiles: 0 },
  };
}

function recallHit(id = "failure-1"): RecallHit {
  return {
    failure: {
      kind: "failure",
      id,
      ts: Date.now() - 1_000,
      cwd: "/task16/project",
      cmd: "npm test",
      exitCode: 1,
      fingerprint: "task16-fingerprint",
      signature: ["button", "missing"],
      excerpt: "module missing",
    },
    score: 0.9,
  };
}

function generateReply(format: Record<string, unknown>): unknown {
  const properties = format.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return envelope({ ok: true });
  const keys = Object.keys(properties as Record<string, unknown>);
  if (keys.includes("ranked_ids")) return envelope({ ranked_ids: ["triple-1", "triple-2"] });
  if (keys.includes("ambiguous")) return envelope({ ambiguous: true, referent: "button" });
  if (keys.includes("summary")) return envelope({ summary: "button spacing", tags: ["layout"] });
  if (keys.includes("act")) return envelope({
    act: "known_fix",
    ranked_candidates: ["c1"],
    evidence_refs: ["c1.failure"],
    confidence: 0.9,
    explanation: "known local evidence",
  });
  return envelope({ ok: true });
}

async function boundedWait<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("real loopback E2E covers model use, recall, what, annotation, and ambiguity", async (t) => {
  const server = new LoopbackServer((request, response) => {
    if (request.url === "/api/tags") {
      sendJson(response, { models: [{ name: MODEL, size: 1 }] });
      return;
    }
    if (request.url === "/api/generate" && request.json !== undefined) {
      sendJson(response, generateReply(request.json.format as Record<string, unknown>));
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });
  await server.start();
  t.after(async () => { await server.close(); });

  const client = createOllamaClient({ origin: server.origin, timeoutMs: 1_000 });
  let saved: unknown;
  assert.equal(await model(["use", MODEL], {
    ollama: client,
    loadConfig: () => ({ status: "missing", path: "/tmp/task16-model-use.json", config: { version: 1, ai: { enabled: false } } }),
    saveConfigAtomic: (config) => { saved = config; return { path: "/tmp/task16-model-use.json" }; },
  }), 0);
  assert.deepEqual(saved, { version: 1, ai: { enabled: true, provider: "ollama", model: MODEL, exposure: "sanitized" } });

  const hit = recallHit();
  const recallBefore = JSON.stringify(hit);
  const recallPort = createRecallAiPort({ loadConfig: () => enabledConfig(), ollama: client });
  const recallMemory: MemoryQueries = {
    recall: () => [hit],
    recentFailures: () => [{ failure: hit.failure }],
    stats: () => ({ failures: 1, fixEvents: 0, resolved: 0, unresolved: 1 }),
    searchKnowledge: () => [],
    fetchRecord: () => undefined,
    whyFile: () => [],
  };
  assert.equal(await recall(["--ai", "button", "missing"], {
    memory: recallMemory,
    recallWithAi: recallPort,
  }), 0);
  assert.equal(JSON.stringify(hit), recallBefore, "recall model cannot mutate captured evidence");

  const first = triple("triple-1", "src/first.css");
  const second = triple("triple-2", "src/second.css");
  const records: MemoryRecord[] = [first, second];
  const recordsBefore = JSON.stringify(records);
  const out: string[] = [];
  assert.equal(await what(["--ai", "button"], {
    load: () => records,
    rank: createOllamaDictionaryRank(client, MODEL),
    say: () => {},
    out: (line) => out.push(line),
  }), 0);
  assert.ok(out.length >= 1);
  assert.equal(JSON.stringify(records), recordsBefore, "what model cannot mutate durable evidence");

  const annotationHome = mkdtempSync(join(tmpdir(), "rocky-task16-annotation-"));
  t.after(() => rmSync(annotationHome, { recursive: true, force: true }));
  const annotationPaths: RockyPaths = resolveRockyPaths({ ROCKY_HOME: annotationHome });
  const annotationEvents: AgentEvent[] = [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, cwd: "/task16/project", text: "change button" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "src/first.css", excerpt: "button margin" },
    { v: 1, agent: "claude-code", kind: "rationale", ts: 3, source: "transcript", text: "increase spacing" },
  ];
  for (const event of annotationEvents) appendEvent("task16-annotation", event, annotationPaths);
  const annotation = await annotateBatch("task16-annotation", {
    paths: annotationPaths,
    git: () => undefined,
    ai: createOllamaAnnotate(client, MODEL),
    now: () => 7,
    queueLabel: () => {},
  });
  assert.ok(annotation);
  assert.deepEqual(annotation.intent, { text: "change button" });
  assert.equal(annotation.mechanism.files[0]?.path, "src/first.css");
  assert.equal(annotation.mechanism.files[0]?.excerpt, "button margin");
  assert.equal(annotation.mechanism.files[0]?.provenance, undefined, "model output cannot fabricate file provenance");
  assert.deepEqual(annotation.rationale, { text: "button spacing", tags: ["layout"], source: "transcript" });
  assert.deepEqual(loadMemory(annotationPaths.memory), [annotation]);

  const queued: string[] = [];
  const ambiguity = await checkAmbiguity("change button", {
    config: enabledConfig(),
    client,
    load: () => records,
    paths: resolveRockyPaths(),
    queueLabel: (line) => queued.push(line),
  });
  assert.equal(ambiguity, 'you say "button". I hear 2 button before. which one, question');
  assert.deepEqual(queued, [ambiguity]);
  assert.equal(JSON.stringify(records), recordsBefore, "ambiguity model cannot mutate durable evidence");

  const tagsRequests = server.requests.filter((request) => request.url === "/api/tags");
  assert.equal(tagsRequests.length, 1);
  assert.equal(tagsRequests[0]?.method, "GET");
  assert.equal(tagsRequests[0]?.body, "");
  const generateRequests = server.requests.filter((request) => request.url === "/api/generate");
  assert.equal(generateRequests.length, 5, `probe plus four model surfaces: ${JSON.stringify(generateRequests.map((request) => request.json?.format))}`);
  for (const request of generateRequests) {
    assert.equal(request.method, "POST");
    assert.equal(request.json?.model, MODEL);
    assert.equal(request.json?.stream, false);
    assert.equal(request.json?.keep_alive, 0);
    assert.equal(request.json?.think, false);
    assert.deepEqual(request.json?.options, { temperature: 0, num_ctx: 2048, num_predict: 256 });
    assert.ok(Buffer.byteLength(request.body, "utf8") <= OLLAMA_REQUEST_LIMIT);
  }
  assert.deepEqual(
    server.requests.map((request) => request.url),
    ["/api/tags", "/api/generate", "/api/generate", "/api/generate", "/api/generate", "/api/generate"],
  );
});

test("real loopback failures preserve deterministic recall and capture cancellation", async (t) => {
  const hit = recallHit();
  const recallInput = { query: "button missing", hits: [hit], exposure: "sanitized" } as const;

  const nonSuccess = new LoopbackServer((_request, response) => sendJson(response, { error: "down" }, 503));
  await nonSuccess.start();
  t.after(async () => { await nonSuccess.close(); });
  const nonSuccessClient = createOllamaClient({ origin: nonSuccess.origin, timeoutMs: 1_000 });
  await assert.rejects(nonSuccessClient.generateStructured(MODEL, "probe", {}), /503/);
  assert.equal(nonSuccess.requests.length, 1, "non-2xx must not retry");
  await nonSuccess.close();

  const malformed = new LoopbackServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{not-json");
  });
  await malformed.start();
  t.after(async () => { await malformed.close(); });
  const malformedClient = createOllamaClient({ origin: malformed.origin, timeoutMs: 1_000 });
  await assert.rejects(malformedClient.generateStructured(MODEL, "probe", {}), SyntaxError);
  const malformedRecall = createRecallAiPort({ loadConfig: () => enabledConfig(), ollama: malformedClient });
  const malformedOutcome = await malformedRecall.run(recallInput, new AbortController().signal);
  assert.equal(malformedOutcome.aiStatus, "invalid_output");
  assert.deepEqual(malformedOutcome.rankedCandidateIds, ["c1"]);
  await malformed.close();

  const invalidSchema = new LoopbackServer((_request, response) => sendJson(response, envelope({
    act: "known_fix", ranked_candidates: ["forged"], evidence_refs: [], confidence: 0.9, explanation: "no",
  })));
  await invalidSchema.start();
  t.after(async () => { await invalidSchema.close(); });
  const invalidClient = createOllamaClient({ origin: invalidSchema.origin, timeoutMs: 1_000 });
  const invalidRecall = createRecallAiPort({ loadConfig: () => enabledConfig(), ollama: invalidClient });
  const invalidOutcome = await invalidRecall.run(recallInput, new AbortController().signal);
  assert.equal(invalidOutcome.aiStatus, "invalid_output");
  assert.deepEqual(invalidOutcome.rankedCandidateIds, ["c1"]);
  await invalidSchema.close();

  const oversized = new LoopbackServer((_request, response) => {
    const body = JSON.stringify({ done: true, response: "x".repeat(OLLAMA_RESPONSE_LIMIT) });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await oversized.start();
  t.after(async () => { await oversized.close(); });
  const oversizedClient = createOllamaClient({ origin: oversized.origin, timeoutMs: 1_000 });
  await assert.rejects(oversizedClient.generateStructured(MODEL, "probe", {}), OllamaResponseTooLargeError);
  await boundedWait(oversized.waitForResponseClose(), "oversized response close");
  await oversized.close();

  const delayedHeaders = new LoopbackServer(() => { /* Hold headers until client timeout. */ });
  await delayedHeaders.start();
  t.after(async () => { await delayedHeaders.close(); });
  const delayedHeaderClient = createOllamaClient({ origin: delayedHeaders.origin, timeoutMs: 40 });
  await assert.rejects(delayedHeaderClient.generateStructured(MODEL, "probe", {}), /timed out/iu);
  await boundedWait(delayedHeaders.waitForAbort(), "delayed-header request abort");
  await delayedHeaders.close();

  const delayedBody = new LoopbackServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"done":true,"response":"');
  });
  await delayedBody.start();
  t.after(async () => { await delayedBody.close(); });
  const delayedBodyClient = createOllamaClient({ origin: delayedBody.origin, timeoutMs: 40 });
  await assert.rejects(delayedBodyClient.generateStructured(MODEL, "probe", {}), /timed out/iu);
  await boundedWait(delayedBody.waitForAbort(), "delayed-body request abort");
  await delayedBody.close();

  const callerAbort = new LoopbackServer(() => { /* Caller controls cancellation. */ });
  await callerAbort.start();
  t.after(async () => { await callerAbort.close(); });
  const callerClient = createOllamaClient({ origin: callerAbort.origin, timeoutMs: 1_000 });
  const controller = new AbortController();
  const reason = new Error("caller cancellation");
  const request = callerClient.generateStructured(MODEL, "probe", {}, controller.signal);
  await boundedWait(callerAbort.waitForRequest(), "caller-abort request start");
  controller.abort(reason);
  await assert.rejects(request, reason);
  await boundedWait(callerAbort.waitForAbort(), "caller-abort request abort");
  assert.equal(callerAbort.requests.filter((entry) => entry.aborted).length, 1);
  await callerAbort.close();
});

test("unavailable loopback service is surfaced without external fallback", async () => {
  const server = new LoopbackServer(() => {});
  await server.start();
  const origin = server.origin;
  await server.close();
  const client = createOllamaClient({ origin, timeoutMs: 100 });
  await assert.rejects(client.generateStructured(MODEL, "probe", {}));
});

test("real model canary is opt-in and fixed-loopback only", {
  skip: process.env.ROCKY_REAL_MODEL_CANARY === "1" ? false : "set ROCKY_REAL_MODEL_CANARY=1 to run explicit local canary",
}, async () => {
  const modelName = process.env.ROCKY_REAL_MODEL_NAME;
  if (modelName === undefined || modelName.trim().length === 0) throw new Error("ROCKY_REAL_MODEL_NAME is required for canary");
  const client = createOllamaClient({ timeoutMs: 5_000 });
  const installed = await client.listInstalledModels();
  assert.ok(installed.some((candidate) => candidate.name === modelName));
  assert.deepEqual((await client.probeModel(modelName)).supported, true);
});
