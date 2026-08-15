export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
export const OLLAMA_REQUEST_LIMIT = 64 * 1024;
export const OLLAMA_RESPONSE_LIMIT = 256 * 1024;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;

export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt?: string;
}

export interface ProbeResult {
  supported: boolean;
  reason?: string;
}

export interface OllamaClient {
  listInstalledModels(signal?: AbortSignal): Promise<readonly OllamaModel[]>;
  probeModel(model: string, signal?: AbortSignal): Promise<ProbeResult>;
  generateStructured(
    model: string,
    prompt: string,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface OllamaClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Internal test seam; production callers use the fixed loopback origin. */
  origin?: string;
}

export class OllamaRequestTooLargeError extends Error {
  constructor() {
    super(`Ollama request exceeds ${OLLAMA_REQUEST_LIMIT} byte limit`);
    this.name = "OllamaRequestTooLargeError";
  }
}

export class OllamaResponseTooLargeError extends Error {
  constructor() {
    super(`Ollama response exceeds ${OLLAMA_RESPONSE_LIMIT} byte limit`);
    this.name = "OllamaResponseTooLargeError";
  }
}

class OllamaRequestTimeoutError extends Error {
  constructor() {
    super("Ollama request timed out");
    this.name = "OllamaRequestTimeoutError";
  }
}

interface BoundedSignal {
  signal: AbortSignal;
  abort(reason: unknown): void;
  close(): void;
}

function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): BoundedSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new OllamaRequestTimeoutError()), timeoutMs);
  return {
    signal: controller.signal,
    abort(reason) {
      controller.abort(reason);
    },
    close() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Ollama request aborted");
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  try {
    void Promise.resolve(reader.cancel(reason)).catch(() => {
      // The bounded error remains the useful failure when cancellation races the stream.
    });
  } catch {
    // The bounded error remains the useful failure when cancellation races the stream.
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  boundary: BoundedSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (boundary.signal.aborted) {
    const reason = abortReason(boundary.signal);
    cancelReader(reader, reason);
    return Promise.reject(reason);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => boundary.signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason = abortReason(boundary.signal);
      cancelReader(reader, reason);
      reject(reason);
    };
    boundary.signal.addEventListener("abort", onAbort, { once: true });

    let read: Promise<ReadableStreamReadResult<Uint8Array>>;
    try {
      read = reader.read();
    } catch (error) {
      settled = true;
      cleanup();
      reject(boundary.signal.aborted ? abortReason(boundary.signal) : error);
      return;
    }
    void read.then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (boundary.signal.aborted) reject(abortReason(boundary.signal));
        else resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (boundary.signal.aborted) reject(abortReason(boundary.signal));
        else reject(error);
      },
    );
  });
}

async function readJson(response: Response, boundary: BoundedSignal): Promise<unknown> {
  if (!response.body) throw new Error("Ollama response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, boundary);
      if (done) break;
      total += value.byteLength;
      if (total > OLLAMA_RESPONSE_LIMIT) {
        const error = new OllamaResponseTooLargeError();
        boundary.abort(error);
        cancelReader(reader, error);
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative reader may still be pending after cancellation.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function rejectHttpResponse(response: Response, boundary: BoundedSignal): void {
  if (response.ok) return;
  const error = new Error(`Ollama request failed: ${response.status}`);
  boundary.abort(error);
  if (response.body !== null) {
    void response.body.cancel(error).catch(() => {
      // The status-only failure remains authoritative if transport cleanup races.
    });
  }
  throw error;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateOrigin(origin: string): string {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(origin);
  if (!match) throw new Error("Ollama origin must be explicit plain HTTP loopback");
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Ollama origin port must be between 1 and 65535");
  }
  return `http://127.0.0.1:${port}`;
}

function boundedRequestBody(value: unknown): string {
  const body = JSON.stringify(value);
  if (typeof body !== "string") throw new Error("Ollama request body is not JSON");
  if (Buffer.byteLength(body, "utf8") > OLLAMA_REQUEST_LIMIT) throw new OllamaRequestTooLargeError();
  return body;
}

export function createOllamaClient(options: OllamaClientOptions = {}): OllamaClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin = validateOrigin(options.origin ?? OLLAMA_ORIGIN);

  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Ollama timeout must be finite and between 1 and ${MAX_TIMEOUT_MS} ms`);
  }

  async function requestJson(path: string, init: RequestInit, parent?: AbortSignal): Promise<unknown> {
    const boundary = boundedSignal(parent, timeoutMs);
    try {
      if (boundary.signal.aborted) throw abortReason(boundary.signal);
      let response: Response;
      try {
        response = await fetchImpl(`${origin}${path}`, {
          ...init,
          signal: boundary.signal,
          redirect: "error",
        });
      } catch (error) {
        if (boundary.signal.aborted) throw abortReason(boundary.signal);
        throw error;
      }
      if (boundary.signal.aborted) throw abortReason(boundary.signal);
      rejectHttpResponse(response, boundary);
      return await readJson(response, boundary);
    } finally {
      boundary.close();
    }
  }

  async function generateEnvelope(
    model: string,
    prompt: string,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const body = boundedRequestBody({
      model,
      prompt,
      format: schema,
      keep_alive: 0,
      stream: false,
      think: false,
      options: { temperature: 0, num_ctx: 2048, num_predict: 256 },
    });
    return requestJson("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }, signal);
  }

  async function generateStructured(
    model: string,
    prompt: string,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const envelope = requireRecord(
      await generateEnvelope(model, prompt, schema, signal),
      "Ollama generate response must be an object",
    );
    if (envelope.done !== true || typeof envelope.response !== "string") {
      throw new Error("Ollama generate response must have done: true and a string response");
    }
    return JSON.parse(envelope.response) as unknown;
  }

  return {
    async listInstalledModels(signal) {
      const payload = requireRecord(
        await requestJson("/api/tags", { method: "GET" }, signal),
        "Ollama tags response must be an object",
      );
      if (!Array.isArray(payload.models)) throw new Error("Ollama tags response has no models array");
      return payload.models.map((model): OllamaModel => {
        const candidate = requireRecord(model, "Ollama tags response has invalid model");
        if (
          typeof candidate.name !== "string" || candidate.name.trim().length === 0 ||
          typeof candidate.size !== "number" || !Number.isFinite(candidate.size) || candidate.size < 0 ||
          (candidate.modified_at !== undefined && typeof candidate.modified_at !== "string")
        ) {
          throw new Error("Ollama tags response has invalid model");
        }
        return candidate.modified_at === undefined
          ? { name: candidate.name, size: candidate.size }
          : { name: candidate.name, size: candidate.size, modifiedAt: candidate.modified_at };
      });
    },

    async probeModel(model, signal) {
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { const: true } },
      };
      try {
        const result = await generateStructured(model, "Return only the required JSON object.", schema, signal);
        const output = requireRecord(result, "probe response was not an object");
        return output.ok === true
          ? { supported: true }
          : { supported: false, reason: "probe response did not contain ok: true" };
      } catch (error) {
        if (signal?.aborted || error instanceof OllamaRequestTimeoutError) throw error;
        return { supported: false, reason: errorReason(error) };
      }
    },

    generateStructured,
  };
}
