import test from "node:test";
import assert from "node:assert/strict";
import {
  createOllamaClient,
  OLLAMA_ORIGIN,
  OLLAMA_REQUEST_LIMIT,
  OLLAMA_RESPONSE_LIMIT,
  OllamaRequestTooLargeError,
  OllamaResponseTooLargeError,
} from "../ai/ollama.js";

const tagsResponse = {
  models: [{
    name: "qwen3:0.6b-q4_K_M",
    model: "qwen3:0.6b-q4_K_M",
    modified_at: "2026-08-04T00:00:00Z",
    size: 523000000,
    digest: "sha256:test",
    details: {
      parent_model: "",
      format: "gguf",
      family: "qwen3",
      families: ["qwen3"],
      parameter_size: "0.6B",
      quantization_level: "Q4_K_M",
    },
  }],
};

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchFrom(responses: readonly Response[]) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const response = responses[calls.length - 1];
    if (!response) throw new Error("unexpected fetch call");
    return response;
  };
  return { fetchImpl, calls };
}

function urlOf(call: FetchCall): string {
  return typeof call.input === "string" ? call.input : call.input.toString();
}

function requestBody(call: FetchCall): Record<string, unknown> {
  const body = call.init?.body;
  if (typeof body !== "string") assert.fail("request body must be a string");
  return JSON.parse(body) as Record<string, unknown>;
}

function boundedJsonResponse(bytes: number): Response {
  const prefix = '{"response":"\\"';
  const suffix = '\\"","done":true}';
  const payload = prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
  assert.equal(Buffer.byteLength(payload, "utf8"), bytes);
  return new Response(payload, { headers: { "content-type": "application/json" } });
}

test("loopback origin seam accepts only explicit plain HTTP 127.0.0.1 ports", () => {
  for (const origin of [
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://localhost:11434",
    "https://127.0.0.1:11434",
    "http://127.0.0.1:11434/path",
    "http://127.0.0.1:11434?query",
    "http://127.0.0.1:11434#fragment",
    "http://user@127.0.0.1:11434",
    "http://[::1]:11434",
  ]) {
    assert.throws(() => createOllamaClient({ origin }), /origin/iu, origin);
  }
  assert.doesNotThrow(() => createOllamaClient({ origin: "http://127.0.0.1:1" }));
  assert.doesNotThrow(() => createOllamaClient({ origin: "http://127.0.0.1:65535" }));
});

test("rejects non-positive, non-finite, and unbounded request timeouts", () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 120_001]) {
    assert.throws(() => createOllamaClient({ timeoutMs }), /timeout/iu, String(timeoutMs));
  }
});

test("rejects an oversized outbound request before contacting loopback", async () => {
  const { fetchImpl, calls } = fetchFrom([]);
  const client = createOllamaClient({ fetchImpl });
  await assert.rejects(
    client.generateStructured("model", "x".repeat(OLLAMA_REQUEST_LIMIT), {}),
    OllamaRequestTooLargeError,
  );
  assert.equal(calls.length, 0);
});

test("lists canonical installed models from loopback tags", async () => {
  const { fetchImpl, calls } = fetchFrom([jsonResponse(tagsResponse)]);
  const client = createOllamaClient({ fetchImpl });

  assert.deepEqual(await client.listInstalledModels(), [{
    name: "qwen3:0.6b-q4_K_M",
    size: 523000000,
    modifiedAt: "2026-08-04T00:00:00Z",
  }]);
  assert.equal(calls.length, 1);
  assert.equal(urlOf(calls[0]), `${OLLAMA_ORIGIN}/api/tags`);
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.redirect, "error");
});

test("generates structured output with deterministic non-thinking options", async () => {
  const { fetchImpl, calls } = fetchFrom([jsonResponse({ done: true, response: '{"answer":"fixed"}' })]);
  const client = createOllamaClient({ fetchImpl });
  const schema = { type: "object", required: ["answer"] };

  assert.deepEqual(await client.generateStructured("qwen3:0.6b-q4_K_M", "rank this", schema), { answer: "fixed" });
  assert.equal(calls.length, 1);
  assert.equal(urlOf(calls[0]), `${OLLAMA_ORIGIN}/api/generate`);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  assert.deepEqual(requestBody(calls[0]), {
    model: "qwen3:0.6b-q4_K_M",
    prompt: "rank this",
    format: schema,
    keep_alive: 0,
    stream: false,
    think: false,
    options: { temperature: 0, num_ctx: 2048, num_predict: 256 },
  });
});

test("rejects 307 and 308 inference redirects without forwarding the request body", async (t) => {
  for (const status of [307, 308]) {
    await t.test(String(status), async () => {
      const calls: FetchCall[] = [];
      const secretBody = "raw local recall evidence";
      const redirectResponse = new Response(null, {
        status,
        headers: { location: "https://outside.example/collect" },
      });
      const fetchImpl: typeof fetch = async (input, init) => {
        calls.push({ input, init });
        if (calls.length === 1) {
          if (init?.redirect === "error") throw new TypeError("redirect blocked");
          calls.push({ input: redirectResponse.headers.get("location")!, init });
          return jsonResponse({ done: true, response: "{}" });
        }
        throw new Error("unexpected fetch call");
      };
      const client = createOllamaClient({ fetchImpl });

      await assert.rejects(
        client.generateStructured("model", secretBody, {}),
        /redirect blocked/,
      );
      assert.equal(calls[0].init?.redirect, "error");
      assert.equal(calls.length, 1);
      assert.equal(calls.some((call) => urlOf(call).startsWith("https://outside.example")), false);
      assert.equal(calls.slice(1).some((call) => String(call.init?.body).includes(secretBody)), false);
    });
  }
});

test("rejects non-success inference responses without retrying", async () => {
  const { fetchImpl, calls } = fetchFrom([jsonResponse({ error: "model unavailable" }, 500)]);
  const client = createOllamaClient({ fetchImpl });

  await assert.rejects(client.generateStructured("model", "prompt", {}), /Ollama request failed: 500/);
  assert.equal(calls.filter((call) => urlOf(call).endsWith("/api/generate")).length, 1);
});

test("aborts and cancels an endless non-success body exactly once without reading it", async () => {
  const events: string[] = [];
  let pulls = 0;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancellations += 1;
      events.push("body-cancelled");
    },
  });
  let requestSignal: AbortSignal | undefined;
  const calls: FetchCall[] = [];
  const client = createOllamaClient({
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener("abort", () => events.push("request-aborted"), { once: true });
      return new Response(body, { status: 503 });
    },
  });

  await assert.rejects(client.generateStructured("model", "prompt", {}), /Ollama request failed: 503/);

  assert.equal(calls.length, 1);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(cancellations, 1);
  assert.ok(pulls <= 1, `non-success body was read ${pulls} times`);
  assert.deepEqual(events, ["request-aborted", "body-cancelled"]);
});

test("rejects malformed tags JSON", async () => {
  const { fetchImpl } = fetchFrom([new Response("{not-json")]);
  const client = createOllamaClient({ fetchImpl });

  await assert.rejects(client.listInstalledModels(), SyntaxError);
});

test("rejects tags response without a model array", async () => {
  const { fetchImpl } = fetchFrom([jsonResponse({ models: "not-an-array" })]);
  const client = createOllamaClient({ fetchImpl });

  await assert.rejects(client.listInstalledModels(), /Ollama tags response has no models array/);
});

test("rejects invalid installed model fields", async () => {
  const { fetchImpl } = fetchFrom([jsonResponse({ models: [{ name: "", size: -1 }] })]);
  const client = createOllamaClient({ fetchImpl });

  await assert.rejects(client.listInstalledModels(), /Ollama tags response has invalid model/);
});

test("accepts a response exactly at the bounded response limit", async () => {
  const { fetchImpl } = fetchFrom([boundedJsonResponse(OLLAMA_RESPONSE_LIMIT)]);
  const client = createOllamaClient({ fetchImpl });

  const result = await client.generateStructured("model", "prompt", {});
  assert.equal(typeof result, "string");
});

test("aborts and rejects a response larger than the bounded response limit", async () => {
  const { fetchImpl, calls } = fetchFrom([boundedJsonResponse(OLLAMA_RESPONSE_LIMIT + 1)]);
  const client = createOllamaClient({ fetchImpl });

  await assert.rejects(client.generateStructured("model", "prompt", {}), OllamaResponseTooLargeError);
  assert.equal(calls.filter((call) => urlOf(call).endsWith("/api/generate")).length, 1);
});

test("forwards caller cancellation without retrying", async () => {
  const controller = new AbortController();
  const callerReason = new Error("caller cancelled");
  const { calls, fetchImpl } = fetchFrom([jsonResponse({ done: true, response: "{}" })]);
  const client = createOllamaClient({
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        queueMicrotask(() => controller.abort(callerReason));
      });
    },
  });

  await assert.rejects(client.generateStructured("model", "prompt", {}, controller.signal), callerReason);
  assert.equal(calls.filter((call) => urlOf(call).endsWith("/api/generate")).length, 1);
});

test("does not invoke fetch for a pre-aborted caller signal", async () => {
  const controller = new AbortController();
  const callerReason = new Error("already cancelled");
  controller.abort(callerReason);
  let calls = 0;
  const client = createOllamaClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(tagsResponse);
    },
  });

  await assert.rejects(client.listInstalledModels(controller.signal), callerReason);
  assert.equal(calls, 0);
});

test("uses the configured bounded timeout without retrying", async () => {
  const { calls } = fetchFrom([]);
  const client = createOllamaClient({
    timeoutMs: 5,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    },
  });

  await assert.rejects(client.generateStructured("model", "prompt", {}), /Ollama request timed out/);
  assert.equal(calls.filter((call) => urlOf(call).endsWith("/api/generate")).length, 1);
});

test("propagates a pre-aborted caller signal from a model probe without fetching", async () => {
  const controller = new AbortController();
  const callerReason = new Error("probe already cancelled");
  controller.abort(callerReason);
  let calls = 0;
  const client = createOllamaClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ done: true, response: '{"ok":true}' });
    },
  });

  await assert.rejects(client.probeModel("model", controller.signal), callerReason);
  assert.equal(calls, 0);
});

test("propagates a model probe timeout without retrying", async () => {
  const { calls } = fetchFrom([]);
  const client = createOllamaClient({
    timeoutMs: 5,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    },
  });

  await assert.rejects(client.probeModel("model"), /Ollama request timed out/);
  assert.equal(calls.filter((call) => urlOf(call).endsWith("/api/generate")).length, 1);
});

test("probes structured non-thinking support and reports unsupported capability", async () => {
  const { fetchImpl, calls } = fetchFrom([
    jsonResponse({ done: true, response: '{"ok":true}' }),
    jsonResponse({ done: true, response: '{"ok":false}' }),
  ]);
  const client = createOllamaClient({ fetchImpl });

  assert.deepEqual(await client.probeModel("model"), { supported: true });
  assert.deepEqual(await client.probeModel("model"), { supported: false, reason: "probe response did not contain ok: true" });
  for (const call of calls) {
    const body = requestBody(call);
    assert.equal(body.keep_alive, 0);
    assert.equal(body.think, false);
    assert.deepEqual(body.format, {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { const: true } },
    });
  }
});
