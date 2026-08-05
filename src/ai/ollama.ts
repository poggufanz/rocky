export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
export const OLLAMA_RESPONSE_LIMIT = 256 * 1024;

const DEFAULT_TIMEOUT_MS = 20_000;

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

async function readJson(response: Response, boundary: BoundedSignal): Promise<unknown> {
  if (!response.body) throw new Error("Ollama response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (boundary.signal.aborted) throw abortReason(boundary.signal);
      const { done, value } = await reader.read();
      if (boundary.signal.aborted) throw abortReason(boundary.signal);
      if (done) break;
      total += value.byteLength;
      if (total > OLLAMA_RESPONSE_LIMIT) {
        const error = new OllamaResponseTooLargeError();
        boundary.abort(error);
        try {
          await reader.cancel(error);
        } catch {
          // The bounded error remains the useful failure when cancellation races the stream.
        }
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function validateHttpResponse(response: Response): void {
  if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOllamaClient(options: OllamaClientOptions = {}): OllamaClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  async function requestJson(path: string, init: RequestInit, parent?: AbortSignal): Promise<unknown> {
    const boundary = boundedSignal(parent, timeoutMs);
    try {
      if (boundary.signal.aborted) throw abortReason(boundary.signal);
      const response = await fetchImpl(`${OLLAMA_ORIGIN}${path}`, { ...init, signal: boundary.signal });
      if (boundary.signal.aborted) throw abortReason(boundary.signal);
      validateHttpResponse(response);
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
    return requestJson("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        format: schema,
        keep_alive: 0,
        stream: false,
        think: false,
        options: { temperature: 0, num_ctx: 2048, num_predict: 256 },
      }),
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
