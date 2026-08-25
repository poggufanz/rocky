/**
 * Which provider an endpoint belongs to, and which models it serves.
 *
 * The catalogue is models.dev. Rocky would rather show `GPT-4o` and a real
 * list of models than make the owner type an id and hope, and the only place
 * that knows is the catalogue. So this is the second host Rocky ever talks to,
 * after the BYOK proxy: cached on disk for a week, and failing open in every
 * direction. An unreachable catalogue means no model list, never an error.
 *
 * A logo never reaches the page as markup. Only the viewBox and each path's
 * `d` cross the boundary, and the page rebuilds the shape itself, so a third
 * party cannot put an element into Rocky's DOM.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveRockyPaths } from "../core/state-paths.js";

const CATALOGUE = "https://models.dev/api.json";
const LOGO = (provider: string): string => `https://models.dev/logos/${provider}.svg`;

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_LOGO_BYTES = 32 * 1024;
const MAX_PATHS = 24;

/**
 * OpenAI and Anthropic publish no `api` field in the catalogue, because every
 * client already knows where they live. These two fill that gap.
 */
const KNOWN_BASES: Record<string, string> = {
  "https://api.openai.com": "openai",
  "https://api.anthropic.com": "anthropic",
};

export interface ModelMark {
  viewBox: string;
  paths: string[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
  mark?: ModelMark;
}

interface Provider {
  name: string;
  api?: string;
  models: Array<[string, string]>;
}

interface Cache {
  fetchedAt: number;
  providers: Record<string, Provider>;
  marks: Record<string, ModelMark | null>;
}

function cachePath(env: NodeJS.ProcessEnv): string {
  return join(resolveRockyPaths(env).home, "models-dev.json");
}

function readCache(env: NodeJS.ProcessEnv): Cache {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(env), "utf8")) as Cache;
    return {
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      providers: parsed.providers ?? {},
      marks: parsed.marks ?? {},
    };
  } catch {
    return { fetchedAt: 0, providers: {}, marks: {} };
  }
}

function writeCache(cache: Cache, env: NodeJS.ProcessEnv): void {
  try {
    const target = cachePath(env);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(cache), "utf8");
  } catch {
    // an unwritable cache costs one fetch next time, nothing more
  }
}

/** Keeps only what the picker needs: 4MB of catalogue becomes about 330KB. */
export function compact(raw: Record<string, any>): Record<string, Provider> {
  const providers: Record<string, Provider> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== "object") continue;
    const models = Object.entries(entry.models ?? {})
      .map(([mid, m]: [string, any]): [string, string] => [mid, typeof m?.name === "string" ? m.name : mid])
      .sort((a, b) => a[1].localeCompare(b[1]));
    providers[id] = {
      name: typeof entry.name === "string" ? entry.name : id,
      ...(typeof entry.api === "string" ? { api: entry.api } : {}),
      models,
    };
  }
  return providers;
}

/**
 * Longest matching base URL wins. It has to be longest-prefix rather than
 * hostname: `opencode.ai` serves both OpenCode Zen and OpenCode Go, and only
 * the path tells them apart.
 */
export function providerIdFor(endpoint: string, providers: Record<string, Provider>): string | undefined {
  let best: { id: string; length: number } | undefined;
  const consider = (id: string, base: string): void => {
    if (!endpoint.startsWith(base)) return;
    if (best === undefined || base.length > best.length) best = { id, length: base.length };
  };
  for (const [base, id] of Object.entries(KNOWN_BASES)) consider(id, base);
  for (const [id, provider] of Object.entries(providers)) {
    if (provider.api !== undefined) consider(id, provider.api);
  }
  return best?.id;
}

/** Pulls the viewBox and the path geometry out, and nothing else. */
export function markFromSvg(svg: string): ModelMark | null {
  if (svg.length > MAX_LOGO_BYTES) return null;
  const viewBox = /viewBox\s*=\s*"([^"]{1,64})"/.exec(svg)?.[1];
  const paths: string[] = [];
  for (const match of svg.matchAll(/<path[^>]*\sd\s*=\s*"([^"]{1,4096})"/g)) {
    paths.push(match[1]);
    if (paths.length >= MAX_PATHS) break;
  }
  if (viewBox === undefined || paths.length === 0) return null;
  return { viewBox, paths };
}

async function get(url: string, as: "json" | "text"): Promise<unknown | undefined> {
  try {
    const answer = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!answer.ok) return undefined;
    return as === "json" ? await answer.json() : await answer.text();
  } catch {
    return undefined;
  }
}

/**
 * The provider serving `endpoint`, with every model it offers. Returns
 * undefined for an endpoint the catalogue does not recognise, which is how
 * the page knows to offer no models rather than a wrong list.
 */
export async function providerFor(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<ProviderInfo | undefined> {
  if (!endpoint) return undefined;
  const cache = readCache(env);
  let dirty = false;

  if (now - cache.fetchedAt > FRESH_MS || Object.keys(cache.providers).length === 0) {
    const raw = await get(CATALOGUE, "json");
    if (raw !== undefined && typeof raw === "object" && raw !== null) {
      cache.providers = compact(raw as Record<string, any>);
      cache.fetchedAt = now;
      dirty = true;
    }
  }

  const id = providerIdFor(endpoint, cache.providers);
  if (id === undefined) {
    if (dirty) writeCache(cache, env);
    return undefined;
  }

  if (!(id in cache.marks)) {
    const svg = await get(LOGO(id), "text");
    cache.marks[id] = typeof svg === "string" ? markFromSvg(svg) : null;
    dirty = true;
  }
  if (dirty) writeCache(cache, env);

  const provider = cache.providers[id];
  return {
    id,
    name: provider.name,
    models: provider.models.map(([mid, name]) => ({ id: mid, name })),
    ...(cache.marks[id] ? { mark: cache.marks[id] as ModelMark } : {}),
  };
}
