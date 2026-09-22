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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { loadMemoryChecked, type MemoryRecord } from "../core/memory-read.js";
import { redactSecretsAtBoundary } from "../core/redact.js";
import { publicSettings, readSettings, writeSettings, type GuiSettings } from "./settings.js";
import { providerFor, providerList } from "./models-dev.js";
import { deriveHome } from "../core/home-data.js";
import { elapsed } from "../ui/rocky.js";
import { fileIndex, getCachedDiff, groupMomentsByChange, defaultDiffIo, lineOverlapPredicate, parsePatch, type DiffRow } from "../core/compare-data.js";
import { resolveContext } from "../core/context-resolve.js";
import { filteredFiles, TEACH_MAX_LINES } from "../core/file-filter.js";
import { repoForPath, type RepoCache } from "../core/repo-groups.js";
import { teachLookup } from "../core/teach.js";
import { buildLadder, calleeNames, collectImports, defaultTeachNeighbor, enclosingFunction, findDefinitionInText, isRelativeSpecifier, resolveRelativePath } from "../core/teach-ladder.js";
import { gitFirstTouch, resolveCommitDiff } from "../core/git-diff.js";
import { bundleGroups, splitRowsByFile, BUNDLE_MAX_FILES, type BundleInput } from "../core/bundle-groups.js";
import {
  gapRungFor,
  renderLadderCard,
  renderLadderExpanded,
  renderWitnessCard,
} from "../core/teach-render.js";
import { resolveRefer, escapeRegExp, type ReferWitness } from "../core/refer-resolve.js";
import { matchConcepts } from "../core/concepts.js";
import { CS_CONCEPT_IDS, explainFor } from "../core/cs-explain.js";
import { loadConfig } from "../core/config-read.js";
import { saveConfigAtomic } from "../core/config.js";
import {
  JEV_MODEL,
  JEV_OPENROUTER_MODEL,
  isUnifiedOpenRouterMode,
  resolveActiveJevKey,
  resolveJevKey,
  resolveOpenRouterKey,
  resolveUnifiedOpenRouterKey,
} from "../ai/jev.js";
import { createOllamaClient } from "../ai/ollama.js";
import { chatByokKeyPresent } from "../ai/chat-llm.js";
import { analyzeExplainDecision } from "../ai/explain-decision.js";
import { executeAnswer } from "../ai/answer.js";

export const DEFAULT_GUI_PORT = 7777;
const READ_CAP_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const ASK_TIMEOUT_MS = 60_000;
const MAX_PROMPT_CHARS = 24_000;
const MAX_ASK_IN_FLIGHT = 2;
const CHAT_MAX_MESSAGE_CHARS = 4_000;
const CHAT_DEFAULT_LIMIT = 5;
const CHAT_MAX_LIMIT = 10;
const CHAT_MAX_SNIPPET_CHARS = 500;
let chatInFlight = 0;
const CHAT_MAX_IN_FLIGHT = 2;

/** Jev runs only behind an explicit `decision.engine: "jev"` opt-in; absent = heuristic. */
function readDecisionSelection(): { engine: "heuristic" | "local" | "jev"; jevProvider: "typesafe" | "openrouter" } {
  try {
    const loaded = loadConfig();
    if (loaded.status === "valid" && loaded.config.decision !== undefined) {
      return { engine: loaded.config.decision.engine, jevProvider: loaded.config.decision.jevProvider ?? "typesafe" };
    }
  } catch {
    // An unreadable config keeps the heuristic default; never fail the chat.
  }
  return { engine: "heuristic", jevProvider: "typesafe" };
}

async function chat(
  body: Record<string, unknown>,
  root: string,
): Promise<{ status: number; payload: unknown }> {
  return executeAnswer({
    mode: "chat",
    message: typeof body.message === "string" ? body.message : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    jev: body.jev === true,
    limit: typeof body.limit === "number" ? body.limit : undefined,
    root,
  });
}

let bundleCache: { key: string; payload: { bundles: unknown[]; unattributed: number } } | null = null;
let bundleInFlight: { key: string; promise: Promise<{ bundles: unknown[]; unattributed: number }> } | null = null;
const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "gui");

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
  if (entry === undefined) return { changes: [], unattributed: [] };
  const flat = entry.recs.map((rec, index) => {
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
  return groupMomentsByChange(flat);
}

/** Flat moment list recovered from grouped output: compare, strict, and the
 *  picker need per-moment granularity with diffs intact. */
function flatMoments(grouped: ReturnType<typeof momentsFor>) {
  return [...grouped.changes.flatMap((c) => c.witnesses), ...grouped.unattributed];
}

/**
 * The one cap and the one redaction every prompt leaving this machine goes
 * through: a selected line can carry a key, and the provider must never see
 * it. Callers own the prompt's content; this owns what may cross.
 */
function boundedPrompt(text: string): string {
  const bounded = text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n… cut, prompt long` : text;
  return redactSecretsAtBoundary(bounded);
}



/** Forwards one prompt to the provider the page names. When the page names
 *  the file its question is about, rocky digs first and quotes what it found:
 *  the model explains evidence, it does not have to imagine code. */
async function ask(body: Record<string, unknown>, root: string): Promise<{ status: number; payload: unknown }> {
  const rel = typeof body.path === "string" ? body.path : undefined;
  const start = typeof body.start === "number" ? body.start : (typeof body.start === "string" ? Number(body.start) : 1);
  const end = typeof body.end === "number" ? body.end : (typeof body.end === "string" ? Number(body.end) : start);
  const commit = typeof body.commit === "string" && /^[0-9a-fA-F]{4,128}$/.test(body.commit) ? body.commit : undefined;
  const symbol = typeof body.symbol === "string" ? body.symbol : undefined;

  return executeAnswer({
    mode: "explain",
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    jev: body.jev === true,
    codeContext: rel ? { path: rel, start, end, commit, symbol } : undefined,
    root,
  });
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

async function computeBundles(q = "", repoFilter: string | null = null): Promise<{ bundles: unknown[]; unattributed: number }> {
  const { list } = records();
  const lastRec = list[list.length - 1];
  const cacheKey = `${list.length}:${lastRec ? lastRec.ts : 0}:${q}:${repoFilter ?? ""}`;
  if (bundleCache && bundleCache.key === cacheKey) {
    return bundleCache.payload;
  }
  if (bundleInFlight && bundleInFlight.key === cacheKey) {
    return bundleInFlight.promise;
  }
  const promise = (async () => {
    const files = fileIndex(list);
    const shown = filteredFiles({ files, fquery: q });
    const repos: RepoCache = new Map();
    const inputs: BundleInput[] = [];
    for (const file of shown) {
      const repo = (await repoForPath(file.path, repos)) ?? "";
      if (repoFilter && repo !== repoFilter) continue;
      for (const rec of file.recs) {
        if (!repo) {
          inputs.push({
            path: file.path,
            repo: "",
            rec,
            diff: { rows: [] },
          });
          continue;
        }
        const diff = getCachedDiff(file.path, rec, defaultDiffIo);
        inputs.push({
          path: file.path,
          repo,
          rec,
          diff,
        });
      }
    }
    const result = bundleGroups(inputs);
    const payload = {
      bundles: result.bundles,
      unattributed: result.unattributed.length,
    };
    bundleCache = { key: cacheKey, payload };
    return payload;
  })();

  bundleInFlight = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (bundleInFlight?.key === cacheKey) {
      bundleInFlight = null;
    }
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
    // one cache per answer: the dash's files share the same few repo walks
    const repos: RepoCache = new Map();
    return sendJson(response, 200, await Promise.all(shown.map(async (f) => {
      // the newest record names what this file was last heard doing, so the
      // repo filter can card each group with its latest intent and age
      let newest: (typeof f.recs)[number] | undefined;
      for (const rec of f.recs) {
        if (newest === undefined || (rec.ts ?? 0) > (newest.ts ?? 0)) newest = rec;
      }
      const rawLabel = (newest?.summary ?? newest?.reason ?? newest?.excerpt ?? newest?.intent ?? newest?.kind ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const span = newest ? elapsed(Math.max(0, now - (newest.ts ?? 0))) : "";
      return {
        path: f.path,
        count: f.count,
        repo: await repoForPath(f.path, repos),
        last: newest ? {
          label: redactSecretsAtBoundary(rawLabel).slice(0, 140),
          agoText: span === "just now" ? span : `${span} ago`,
          ts: newest.ts ?? 0,
        } : null,
      };
    })));
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
    const all = flatMoments(momentsFor(rel, root, now));
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
    const grouped = momentsFor(rel, root, now);
    if (a === null || b === null) return sendJson(response, 200, grouped);
    const all = flatMoments(grouped);
    const pick = (id: string) => {
      const found = all.find((m) => m.id === id);
      return found ? { record: found, diff: found.diff ?? null } : null;
    };
    return sendJson(response, 200, { A: pick(a), B: pick(b) });
  }

  if (pathname === "/api/bundles") {
    const q = url.searchParams.get("q") ?? "";
    const repoFilter = url.searchParams.get("repo");
    const payload = await computeBundles(q, repoFilter);
    return sendJson(response, 200, payload);
  }

  if (pathname === "/api/bundle") {
    const commit = url.searchParams.get("commit");
    if (!commit || !/^[0-9a-fA-F]{4,128}$/.test(commit)) {
      return sendJson(response, 400, { error: "rocky needs a commit sha, question" });
    }
    const resolved = resolveCommitDiff({ sha: commit, cwd: root });
    if (resolved === undefined) {
      return sendJson(response, 200, null);
    }
    const rows = parsePatch(resolved.diff);
    const byFile = splitRowsByFile(rows);
    const files = Array.from(byFile.entries()).map(([path, fileRows]) => ({ path, rows: fileRows }));
    const total = files.length;
    const capped = files.slice(0, BUNDLE_MAX_FILES);
    const truncated = resolved.truncated || total > BUNDLE_MAX_FILES;
    return sendJson(response, 200, {
      commit: resolved.commit,
      files: capped,
      truncated,
      total,
    });
  }

  if (pathname === "/api/refer") {
    const rel = url.searchParams.get("path");
    if (!rel) {
      return sendJson(response, 400, { error: "rocky needs a file path, question" });
    }
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);

    let fileText = "";
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > READ_CAP_BYTES) return sendJson(response, 200, null);
      const raw = (await readFile(full, "utf8")).split(/\r?\n/);
      const capped = raw.length > TEACH_MAX_LINES ? raw.slice(0, TEACH_MAX_LINES) : raw;
      fileText = capped.join("\n");
    } catch {
      return sendJson(response, 200, null);
    }

    const lineParam = url.searchParams.get("line");
    const line = lineParam !== null && !isNaN(Number(lineParam)) && Number(lineParam) > 0
      ? Math.floor(Number(lineParam))
      : 1;
    const symbolParam = url.searchParams.get("symbol");
    const symbol = symbolParam !== null && symbolParam.trim().length > 0 ? symbolParam.trim() : undefined;

    let targetSymbol = symbol ?? "";
    if (!targetSymbol) {
      const lines = fileText.split(/\r?\n/);
      const lineIndex = line - 1;
      const lineText = lineIndex >= 0 && lineIndex < lines.length ? (lines[lineIndex] ?? "") : "";
      const callees = calleeNames(lineText);
      targetSymbol = callees[0] ?? "";
    }

    const witnesses: ReferWitness[] = [];
    const texts = new Map<string, string>();

    if (targetSymbol.length > 0) {
      const symbolRe = new RegExp(`\\b${escapeRegExp(targetSymbol)}\\b`);
      const { list } = records();
      const files = fileIndex(list);
      let matchedFiles = 0;
      for (const file of files) {
        if (matchedFiles >= 20) break;
        let matchedText: string | undefined;
        for (const rec of file.recs) {
          for (const candidate of [rec.excerpt, rec.reason, rec.intent]) {
            if (typeof candidate === "string" && symbolRe.test(candidate)) {
              matchedText = candidate;
              break;
            }
          }
          if (matchedText !== undefined) break;
        }

        if (matchedText !== undefined) {
          matchedFiles += 1;
          const matchLine = matchedText.split(/\r?\n/).find((l) => symbolRe.test(l)) ?? matchedText;
          witnesses.push({
            path: file.path,
            line: 0,
            text: matchLine.trim(),
          });

          if (texts.size < 10) {
            const neighborFull = confine(root, file.path) ?? witnessed(file.path);
            if (neighborFull !== undefined) {
              try {
                const st = statSync(neighborFull);
                if (st.isFile() && st.size <= 64 * 1024) {
                  texts.set(file.path, readFileSync(neighborFull, "utf8"));
                }
              } catch {
                // fail open
              }
            }
          }
        }
      }
    }

    const result = resolveRefer({
      path: rel,
      fileText,
      line,
      symbol,
      readNeighbor: defaultTeachNeighbor(full),
      texts,
      witnesses,
    });

    if (result.definition !== null) {
      result.definition.text = redactSecretsAtBoundary(result.definition.text);
      if (result.definition.jsdoc !== undefined) {
        result.definition.jsdoc = redactSecretsAtBoundary(result.definition.jsdoc);
      }
    }
    for (const ref of result.references) {
      ref.text = redactSecretsAtBoundary(ref.text);
    }

    return sendJson(response, 200, result);
  }

  if (pathname === "/api/teach" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const rel = String(body.path ?? "");
    let start = Number(body.start ?? 0);
    let end = Number(body.end ?? 0);
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);

    const lines = existsSync(full) ? readFileSync(full, "utf8").split(/\r?\n/) : [];
    const snippet = lines.slice(Math.max(0, start - 1), end).join("\n");
    const { list } = records();

    let expanded: { start: number; end: number; why: string } | undefined;
    if (body.expand === 1 && start === end) {
      let rows: DiffRow[] | undefined;
      const commit = typeof body.commit === "string" ? body.commit : "";
      if (/^[0-9a-fA-F]{4,128}$/.test(commit)) {
        const resolved = resolveCommitDiff({ sha: commit, cwd: root });
        if (resolved !== undefined) {
          const parsedRows = parsePatch(resolved.diff);
          const byFile = splitRowsByFile(parsedRows);
          for (const [diffPath, fileRows] of byFile.entries()) {
            if (diffPath === rel || diffPath.endsWith("/" + rel) || rel.endsWith("/" + diffPath)) {
              rows = fileRows;
              break;
            }
          }
        }
      }
      const ctx = resolveContext({
        fileText: lines.join("\n"),
        line: start,
        ...(rows !== undefined ? { rows } : {}),
      });
      start = ctx.start;
      end = ctx.end;
      expanded = { start: ctx.start, end: ctx.end, why: ctx.why };
    }

    const hit = teachLookup(list, { path: rel, snippet, cwd: root });
    const ladder = buildLadder({
      file: rel,
      startLine: start,
      endLine: end,
      fileText: lines.join("\n"),
      readNeighbor: defaultTeachNeighbor(rel),
    });
    if (hit !== undefined) {
      const card = renderWitnessCard(hit, gapRungFor(hit, ladder));
      const base = expanded !== undefined ? { ...card, expanded } : card;
      try {
        // Unified OpenRouter mode shares the main credential with the Jev path;
        // otherwise the active provider path resolves its own slot.
        const teachStored = readSettings();
        const teachUnified = isUnifiedOpenRouterMode(teachStored.provider, teachStored.endpoint);
        const teachSelection = readDecisionSelection();
        const teachProvider = teachUnified ? "openrouter" : teachSelection.jevProvider;
        const teachApiKey = teachUnified
          ? resolveUnifiedOpenRouterKey(process.env, teachStored.key)
          : resolveActiveJevKey(teachSelection.jevProvider, process.env, teachStored.jevKey, teachStored.openRouterKey);
        const trace = await analyzeExplainDecision({
          query: snippet.slice(0, 1000),
          candidates: [{
            ref: hit.record.id,
            kind: "explain",
            snippet: redactSecretsAtBoundary(hit.record.snippet ?? hit.record.code).slice(0, 500),
          }],
        }, { outcome: "teach", provider: teachProvider, apiKey: teachApiKey || undefined });
        if (trace !== undefined) return sendJson(response, 200, { ...base, decision: trace });
      } catch {
        // Analysis is advisory: the witness card stands on its own.
      }
      return sendJson(response, 200, base);
    }
    if (ladder.rungs.length > 0) {
      const card = renderLadderCard(rel, `${start}-${end}`, ladder);
      const payload = { ...card, rungs: renderLadderExpanded(ladder) };
      return sendJson(response, 200, expanded !== undefined ? { ...payload, expanded } : payload);
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
  if (pathname === "/api/chat-models") {
    // Model picker backing: the 1 keyed BYOK model named in settings
    // (with its human-friendly catalogue label if available), plus the
    // pinned Jev model of the ACTIVE provider when its key is present.
    // In unified OpenRouter mode the active provider is always
    // openrouter and the shared main credential (env OPENROUTER_API_KEY wins,
    // stored main key falls back) is the only presence signal — the Jev slots
    // are never read. Offline/absent BYOK falls back to Ollama or empty list.
    const stored = readSettings();
    const unified = isUnifiedOpenRouterMode(stored.provider, stored.endpoint);
    const provider = unified ? "openrouter" : readDecisionSelection().jevProvider;
    const byId: Record<string, string> = {};
    if (stored.endpoint.length > 0 && stored.model.length > 0 &&
      chatByokKeyPresent(stored.provider, stored.endpoint, stored.key)) {
      let label = stored.model;
      try {
        const info = await providerFor(stored.endpoint);
        const match = info?.models.find((m) => m.id === stored.model);
        if (match?.name) label = match.name;
      } catch {
        // fallback to model id
      }
      byId[stored.model] = label;
    }
    if (provider === "openrouter") {
      const shared = unified ? resolveUnifiedOpenRouterKey(process.env, stored.key) : resolveOpenRouterKey(process.env, stored.openRouterKey);
      if (shared.length > 0 && byId[JEV_OPENROUTER_MODEL] === undefined) {
        byId[JEV_OPENROUTER_MODEL] = JEV_OPENROUTER_MODEL;
      }
    } else if (resolveJevKey(process.env, stored.jevKey).length > 0 && byId[JEV_MODEL] === undefined) {
      byId[JEV_MODEL] = JEV_MODEL;
    }
    if (Object.keys(byId).length === 0) {
      try {
        const installed = await createOllamaClient().listInstalledModels();
        for (const model of installed) {
          if (model.name.length > 0 && byId[model.name] === undefined) byId[model.name] = model.name;
        }
      } catch {
        // Ollama offline: the picker still offers BYOK/Jev, never an error.
      }
    }
    return sendJson(response, 200, {
      models: Object.entries(byId).map(([id, label]) => ({ id, label })),
    });
  }
  if (pathname === "/api/settings") {
    if (request.method === "POST") {
      const patch = (await readBody(request)) as Record<string, unknown>;
      // The GUI provider selector writes the non-secret choice into config.json
      // (strict allowlist); keys stay in gui.json via writeSettings. A failed
      // provider write keeps the previous public settings so the page can retry.
      const requested = patch.jevProvider;
      if (requested !== undefined) {
        if (requested !== "typesafe" && requested !== "openrouter") {
          return sendJson(response, 400, { error: "unknown jev provider" });
        }
        try {
          const loaded = loadConfig();
          if (loaded.status === "invalid") throw new Error("invalid config");
          const decision = { ...(loaded.config.decision ?? { engine: "heuristic" as const }), jevProvider: requested as "typesafe" | "openrouter" };
          saveConfigAtomic({ ...loaded.config, decision }, loaded.path);
        } catch {
          return sendJson(response, 200, { ...publicSettings(readSettings()), jevProvider: readDecisionSelection().jevProvider });
        }
      }
      const saved = writeSettings(patch);
      return sendJson(response, 200, { ...publicSettings(saved), jevProvider: readDecisionSelection().jevProvider });
    }
    return sendJson(response, 200, { ...publicSettings(readSettings()), jevProvider: readDecisionSelection().jevProvider });
  }

  if (pathname === "/api/ask" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const { status, payload } = await ask(body, root);
    return sendJson(response, status, payload);
  }

  if (pathname === "/api/chat" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const { status, payload } = await chat(body, root);
    return sendJson(response, status, payload);
  }

  if (pathname === "/api/cs-explain") {
    const rel = url.searchParams.get("path") ?? "";
    const start = Number(url.searchParams.get("start") ?? "1");
    const end = Number(url.searchParams.get("end") ?? String(start));
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > READ_CAP_BYTES) return sendJson(response, 200, null);
      const raw = (await readFile(full, "utf8")).split(/\r?\n/);
      const s = Math.max(1, Math.floor(start) || 1);
      const e = Math.max(s, Math.floor(end) || s);
      const snippet = raw.slice(Math.max(0, s - 1), e).join("\n").slice(0, 2000);
      const hit = matchConcepts(`${rel} ${snippet}`).find((h) => (CS_CONCEPT_IDS as readonly string[]).includes(h.concept.id));
      if (hit === undefined) return sendJson(response, 200, null);
      const built = explainFor(hit.concept.id, snippet);
      if (built === undefined) return sendJson(response, 200, null);
      return sendJson(response, 200, {
        conceptId: redactSecretsAtBoundary(built.conceptId),
        definition: redactSecretsAtBoundary(built.definition),
        trace: built.trace.map((l) => redactSecretsAtBoundary(l)),
        check: redactSecretsAtBoundary(built.check),
      });
    } catch {
      return sendJson(response, 200, null);
    }
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
  let boundPort = wanted;
  void computeBundles().catch(() => {});

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : boundPort;
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
        const addr = server.address();
        boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
        done({
          port: boundPort,
          token,
          url: `http://127.0.0.1:${boundPort}/#${token}`,
          close: () =>
            new Promise<void>((shut) => {
              if (typeof (server as any).closeAllConnections === "function") {
                (server as any).closeAllConnections();
              }
              server.close(() => shut());
            }),
        });
      });
    };
    bind(wanted, wanted !== 0);
  });
}
