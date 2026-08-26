/**
 * Rocky's localhost GUI server.
 *
 * Binds loopback only. Every launch mints a fresh token that the page carries
 * in its URL fragment and sends back on each API call, so another tab on this
 * machine cannot read the memory by guessing the port. Reads only: no route
 * here writes evidence.
 *
 * The one exception to no-egress is `POST /api/ask`, the BYOK proxy. It exists
 * because browsers cannot call model providers cross-origin; the request is
 * forwarded from here instead, and only when the page supplies a key.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";

import { loadMemoryChecked } from "../core/memory-read.js";
import { redactSecretsAtBoundary } from "../core/redact.js";
import { publicSettings, readSettings, writeSettings } from "./settings.js";
import { providerFor, providerList } from "./models-dev.js";
import { deriveHome } from "../core/home-data.js";
import { fileIndex, getCachedDiff, defaultDiffIo, lineOverlapPredicate } from "../core/compare-data.js";
import { filteredFiles, TEACH_MAX_LINES } from "../core/file-filter.js";
import { teachLookup } from "../core/teach.js";
import { buildLadder, defaultTeachNeighbor } from "../core/teach-ladder.js";
import {
  gapRungFor,
  renderLadderCard,
  renderLadderExpanded,
  renderWitnessCard,
} from "../core/teach-render.js";

export const DEFAULT_GUI_PORT = 7777;
const READ_CAP_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const ASK_TIMEOUT_MS = 60_000;
const MAX_PROMPT_CHARS = 24_000;
const MAX_ASK_IN_FLIGHT = 2;

let askInFlight = 0;

/**
 * The fallback rules every BYOK answer is bound by when the spec file is not
 * on disk, prepended here rather than in the page so a browser cannot drop
 * them.
 *
 * Ported from the owner's teach agent spec (assets/teach-agent.md), minus
 * every instruction that
 * needs a tool. This model has no shell, no git, and no filesystem: it sees
 * the snippet and whatever Rocky already holds, and nothing else. Telling it
 * to walk five hops and cite `git log -L` would only teach it to invent
 * citations, which is the one failure this whole surface exists to prevent.
 */
const TEACH_RULES = [
  "You explain why a code snippet exists. You are a witness, not a judge, and you do not invent.",
  "",
  "Output language: Indonesian.",
  "",
  "HARD STOP: you have no shell, no git, no database and no filesystem. You see only what is",
  "quoted below. NEVER claim you ran a command, read another file, or queried a database.",
  "NEVER imply you inspected live data. If a reason would need evidence you were not given,",
  "say so and stop there.",
  "",
  "Keep two tracks separate, and do not merge them into one essay:",
  "  KODE    why this construct is written this way in THIS file",
  "  BISNIS  why this behaviour exists for the product",
  "",
  "Every claim must point at something in the text you were given: a line, a quoted comment,",
  "or a record Rocky recorded. No support means the claim does not exist: do not write it.",
  "NEVER say `best practice`, `lebih rapi`, or `idiomatic` without naming the alternative it",
  "was chosen over. NEVER paraphrase a comment that is already quoted: quote it.",
  "NEVER present your reconstruction as something an agent stated when the code was written.",
  "",
  "Answer in this shape, omitting any line you have no support for:",
  "  KODE",
  "    why 1  …",
  "    stop   …",
  "  BISNIS",
  "    why 1  …",
  "    stop   …",
  "",
  "Two sentences per why, at most. Thin evidence is an answer: an honest two-line card beats",
  "a five-line story. Say plainly when you cannot tell.",
].join("\n");

const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "gui");

/** The owner's spec, whole, next to the dash assets so the package ships it. */
const TEACH_SPEC_CAP_BYTES = 64 * 1024;
const teachSpec: Partial<Record<"id" | "en", string | null>> = {};

/**
 * teach-agent.md is the system prompt, read whole at request time (cached
 * after the first read) so editing the file edits the investigator. The
 * settings pick the language: id reads teach-agent.md, en its english twin.
 * The spec assumes tools this model does not have, so an environment note
 * rides ahead of it; where the spec says walk hops with a shell, the model
 * works only from the quoted evidence. TEACH_RULES stays as the fallback for
 * a spec that is not on disk.
 */
const TEACH_ENV = [
  "Environment note for this run: you have no shell, no git, no database and no filesystem.",
  "Where the spec below tells you to read files or run commands, work only from the evidence",
  "quoted after the rules instead, and cite that. Never claim you ran anything.",
].join("\n");

function loadTeachSpec(lang: "id" | "en"): string {
  if (teachSpec[lang] === undefined) {
    try {
      const path = resolve(ASSET_ROOT, "..", lang === "en" ? "teach-agent.en.md" : "teach-agent.md");
      const raw = readFileSync(path, "utf8");
      teachSpec[lang] = Buffer.byteLength(raw) <= TEACH_SPEC_CAP_BYTES ? raw : null;
    } catch {
      teachSpec[lang] = null;
    }
  }
  return teachSpec[lang] ?? TEACH_RULES;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/** Applied to every response: no store, no sniff, no referrer, no CORS at all. */
function baseHeaders(type: string): Record<string, string> {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, baseHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

/** 403 carries no detail: a prober learns nothing from which check failed. */
function forbid(response: ServerResponse): void {
  response.writeHead(403, baseHeaders("text/plain; charset=utf-8"));
  response.end("no");
}

/** Blocks DNS rebinding: a foreign name resolving here still fails the check. */
function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * A path input may be read two ways: it sits inside the repo the server was
 * launched in, or memory already names it. The dash lists exactly what memory
 * names, so refusing such a read only breaks the page when rocky was launched
 * outside that file's tree.
 *
 * The comparison is case-insensitive on Windows because the filesystem is:
 * memory canonicalises paths to lower case, so a case-sensitive prefix test
 * refused the repo's own files and the page reported hearing nothing.
 */
function confine(root: string, candidate: string): string | undefined {
  const full = resolve(root, candidate);
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const inside = fold(full) === fold(root) || fold(full).startsWith(fold(root) + sep);
  return inside ? full : undefined;
}

/** Memory already discloses these paths to the page, so reading one leaks nothing new. */
function witnessed(candidate: string): string | undefined {
  const norm = candidate.replace(/\\/g, "/");
  const heard = fileIndex(records().list).some((file) => file.path === norm);
  return heard ? norm : undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function records(): { list: ReturnType<typeof loadMemoryChecked>["records"]; reason: string | undefined } {
  const loaded = loadMemoryChecked();
  // an incomplete read is disclosed, never passed off as full coverage
  const reason = loaded.coverage?.complete === false ? loaded.coverage.reason : undefined;
  return { list: loaded.records, reason };
}

const ago = (ts: number, now: number): string => {
  const delta = Math.max(0, now - ts);
  if (delta >= 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  if (delta >= 3_600_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 60_000)}m ago`;
};

/** One moment as the GUI reads it: identity, labels, and its diff if any. */
function momentsFor(path: string, root: string, now: number) {
  const entry = fileIndex(records().list).find((file) => file.path === path);
  if (entry === undefined) return [];
  return entry.recs.map((rec, index) => {
    const diff = getCachedDiff(path, rec, defaultDiffIo) ?? undefined;
    return {
      id: `${rec.ts}-${index}`,
      kind: rec.kind,
      source: rec.source,
      ts: rec.ts,
      ago: ago(rec.ts, now),
      machine: rec.machine,
      reason: rec.reason,
      summary: rec.summary,
      excerpt: rec.excerpt,
      intent: rec.intent,
      diff,
    };
  });
}

/** Forwards one prompt to the provider the page names. OpenAI-compatible
 *  hosts and Anthropic differ only in header and body shape. */
async function ask(body: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
  // endpoint, model and key all come off disk: the page never holds the secret
  const stored = readSettings();
  const endpoint = stored.endpoint;
  const key = stored.key;
  const model = stored.model;
  const raw = String(body.prompt ?? "");
  if (!endpoint || !key || !model || !raw) {
    return { status: 400, payload: { error: "rocky need endpoint, key, model in settings first" } };
  }
  if (askInFlight >= MAX_ASK_IN_FLIGHT) {
    return { status: 429, payload: { error: "rocky already asking. wait, question" } };
  }

  // This is the only text that leaves the machine, so it is redacted first:
  // a selected line can carry a key, and the provider must never see it.
  const asked = redactSecretsAtBoundary(
    raw.length > MAX_PROMPT_CHARS ? `${raw.slice(0, MAX_PROMPT_CHARS)}\n… cut, prompt long` : raw,
  );
  // the rules ride here, not in the page, so a browser cannot drop them
  const prompt = `${TEACH_ENV}\n\n${loadTeachSpec(stored.lang)}\n\n---\n\n${asked}`;

  const anthropic = endpoint.includes("/v1/messages");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (anthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${key}`;
  }

  const payload = anthropic
    ? { model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }
    : { model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] };

  askInFlight += 1;
  try {
    const answer = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    const data = (await answer.json()) as Record<string, any>;
    if (!answer.ok) {
      return { status: answer.status, payload: { error: data?.error?.message ?? "provider refused" } };
    }
    const text = anthropic ? data?.content?.[0]?.text : data?.choices?.[0]?.message?.content;
    return { status: 200, payload: { text: typeof text === "string" ? text : "" } };
  } finally {
    askInFlight -= 1;
  }
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/assets\//, "");
  const full = confine(ASSET_ROOT, rel);
  if (full === undefined) return forbid(response);
  try {
    const body = await readFile(full);
    response.writeHead(200, baseHeaders(TYPES[extname(full)] ?? "application/octet-stream"));
    response.end(body);
  } catch {
    response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
  }
}

async function handleApi(
  pathname: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
): Promise<void> {
  const now = Date.now();

  if (pathname === "/api/home") {
    const { list, reason } = records();
    return sendJson(response, 200, deriveHome(list, reason, now));
  }

  if (pathname === "/api/files") {
    const files = fileIndex(records().list);
    const q = url.searchParams.get("q") ?? "";
    const shown = filteredFiles({ files, fquery: q });
    return sendJson(response, 200, shown.map((f) => ({ path: f.path, count: f.count })));
  }

  if (pathname === "/api/file") {
    const rel = url.searchParams.get("path") ?? "";
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > READ_CAP_BYTES) throw new Error("bounded read miss");
      const raw = (await readFile(full, "utf8")).split(/\r?\n/);
      const capped = raw.length > TEACH_MAX_LINES ? raw.slice(0, TEACH_MAX_LINES) : raw;
      return sendJson(response, 200, { lines: capped, truncated: raw.length > TEACH_MAX_LINES });
    } catch {
      return sendJson(response, 200, { lines: [], missing: true });
    }
  }

  if (pathname === "/api/moments") {
    const rel = url.searchParams.get("path") ?? "";
    const all = momentsFor(rel, root, now);
    if (url.searchParams.get("strict") !== "1") return sendJson(response, 200, all);
    // strict keeps only the moments touching the same lines as the other side
    const near = url.searchParams.get("near");
    const anchor = all.find((m) => m.id === near);
    const related = lineOverlapPredicate(rel);
    const kept = anchor === undefined
      ? all.filter((m) => m.diff !== undefined)
      : all.filter((m) => m.id === anchor.id || related(anchor as never, m as never));
    return sendJson(response, 200, kept);
  }

  if (pathname === "/api/compare") {
    const rel = url.searchParams.get("path") ?? "";
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    const all = momentsFor(rel, root, now);
    if (a === null || b === null) return sendJson(response, 200, { records: all });
    const pick = (id: string) => {
      const found = all.find((m) => m.id === id);
      return found ? { record: found, diff: found.diff ?? null } : null;
    };
    return sendJson(response, 200, { A: pick(a), B: pick(b) });
  }

  if (pathname === "/api/teach" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const rel = String(body.path ?? "");
    const start = Number(body.start ?? 0);
    const end = Number(body.end ?? 0);
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);

    const lines = existsSync(full) ? readFileSync(full, "utf8").split(/\r?\n/) : [];
    const snippet = lines.slice(Math.max(0, start - 1), end).join("\n");
    const { list } = records();

    const hit = teachLookup(list, { path: rel, snippet, cwd: root });
    const ladder = buildLadder({
      file: rel,
      startLine: start,
      endLine: end,
      fileText: lines.join("\n"),
      readNeighbor: defaultTeachNeighbor(rel),
    });

    if (hit !== undefined) {
      return sendJson(response, 200, renderWitnessCard(hit, gapRungFor(hit, ladder)));
    }
    if (ladder.rungs.length > 0) {
      const card = renderLadderCard(rel, `${start}-${end}`, ladder);
      return sendJson(response, 200, { ...card, rungs: renderLadderExpanded(ladder) });
    }
    return sendJson(response, 200, null);
  }

  if (pathname === "/api/providers") {
    return sendJson(response, 200, await providerList());
  }

  if (pathname === "/api/provider") {
    // an endpoint the catalogue does not know returns nothing, so the page
    // offers no models rather than a wrong list
    const found = await providerFor(url.searchParams.get("endpoint") ?? "");
    return sendJson(response, 200, found ?? null);
  }

  if (pathname === "/api/settings") {
    if (request.method === "POST") {
      const patch = (await readBody(request)) as Record<string, unknown>;
      return sendJson(response, 200, publicSettings(writeSettings(patch)));
    }
    return sendJson(response, 200, publicSettings(readSettings()));
  }

  if (pathname === "/api/ask" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const { status, payload } = await ask(body);
    return sendJson(response, status, payload);
  }

  response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
}

export interface GuiHandle {
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
}

/** Starts the surface. Resolves once bound, so the caller can print the URL. */
export function startGui(options: { port?: number; root?: string } = {}): Promise<GuiHandle> {
  const token = randomBytes(16).toString("hex");
  const root = resolve(options.root ?? process.cwd());
  const wanted = options.port ?? DEFAULT_GUI_PORT;

  const server = createServer((request, response) => {
    void (async () => {
      const port = (server.address() as { port: number }).port;
      try {
        if (!hostAllowed(request.headers.host, port)) return forbid(response);
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
        const pathname = url.pathname;

        if (pathname.startsWith("/api/")) {
          // the shell and its assets load before any script can send a header,
          // so only the api is token-gated
          if (request.headers["x-rocky-token"] !== token) return forbid(response);
          return await handleApi(pathname, url, request, response, root);
        }
        if (pathname === "/" || pathname.startsWith("/assets/")) {
          return await serveAsset(pathname, response);
        }
        response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
      } catch {
        // one bad request never takes the server down with it
        if (!response.headersSent) sendJson(response, 500, { error: "rocky not hear that, question" });
        else response.end();
      }
    })();
  });

  return new Promise((done, fail) => {
    const bind = (port: number, retry: boolean): void => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        // the wanted port being busy is not a failure: take any free one
        if (retry && error.code === "EADDRINUSE") return bind(0, false);
        fail(error);
      });
      server.listen(port, "127.0.0.1", () => {
        const bound = (server.address() as { port: number }).port;
        done({
          port: bound,
          token,
          url: `http://127.0.0.1:${bound}/#${token}`,
          close: () => new Promise<void>((shut) => server.close(() => shut())),
        });
      });
    };
    bind(wanted, wanted !== 0);
  });
}
