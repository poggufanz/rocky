/**
 * BYOK configuration, kept beside Rocky's memory rather than in the browser.
 *
 * The page never receives the key back. It learns only whether one is stored,
 * which is all it needs to decide whether to offer the ask control.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveRockyPaths } from "../core/state-paths.js";

export interface GuiSettings {
  /**
   * Main LLM provider. `openrouter` unifies the dash: the stored `key` below
   * IS the OpenRouter credential, driving BOTH the /api/ask LLM path and the
   * Jev decision path (typesafe/jev-1.13 behind the same key) — no Jev key,
   * no second OpenRouter key, no jevProvider selection needed in this mode.
   */
  provider: "openai" | "anthropic" | "openrouter";
  endpoint: string;
  model: string;
  /** Main-provider key. In unified `openrouter` mode this is the shared credential. */
  key: string;
  /** Jev (TypeSafe) key, stored server-side only. Env TYPESAFE_API_KEY wins when set. */
  jevKey: string;
  /** OpenRouter key, stored server-side only. Env OPENROUTER_API_KEY wins when set. */
  openRouterKey: string;
  /** The teach spec's output language: id reads teach-agent.md, en its twin. */
  lang: "id" | "en";
}

/** What the page is allowed to see: everything except the secret itself. */
export interface PublicSettings {
  provider: GuiSettings["provider"];
  endpoint: string;
  model: string;
  lang: GuiSettings["lang"];
  hasKey: boolean;
  /** Presence only: the Jev key value never travels to the page. */
  hasJevKey: boolean;
  /** Presence only: the OpenRouter key value never travels to the page. */
  hasOpenRouterKey: boolean;
}

const EMPTY: GuiSettings = { provider: "openai", endpoint: "", model: "", key: "", jevKey: "", openRouterKey: "", lang: "id" };

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRockyPaths(env).home, "gui.json");
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): GuiSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(env), "utf8")) as Partial<GuiSettings>;
    return {
      provider: parsed.provider === "anthropic" ? "anthropic" : parsed.provider === "openrouter" ? "openrouter" : "openai",
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      key: typeof parsed.key === "string" ? parsed.key : "",
      jevKey: typeof parsed.jevKey === "string" ? parsed.jevKey : "",
      openRouterKey: typeof parsed.openRouterKey === "string" ? parsed.openRouterKey : "",
      lang: parsed.lang === "en" ? "en" : "id",
    };
  } catch {
    // no file, unreadable file, bad json: an unset config, not an error
    return { ...EMPTY };
  }
}

export function publicSettings(settings: GuiSettings): PublicSettings {
  return {
    provider: settings.provider,
    endpoint: settings.endpoint,
    model: settings.model,
    lang: settings.lang,
    hasKey: settings.key.length > 0,
    hasJevKey: settings.jevKey.length > 0,
    hasOpenRouterKey: settings.openRouterKey.length > 0,
  };
}

/**
 * Writes the config. An absent `key` leaves the stored one alone, so the page
 * can save an endpoint change without ever having held the secret; an empty
 * string is an explicit erase.
 */
export function writeSettings(
  patch: Partial<GuiSettings>,
  env: NodeJS.ProcessEnv = process.env,
): GuiSettings {
  const current = readSettings(env);
  const next: GuiSettings = {
    provider: patch.provider === "anthropic" ? "anthropic" : patch.provider === "openrouter" ? "openrouter" : patch.provider === "openai" ? "openai" : current.provider,
    endpoint: typeof patch.endpoint === "string" ? patch.endpoint : current.endpoint,
    model: typeof patch.model === "string" ? patch.model : current.model,
    key: typeof patch.key === "string" ? patch.key : current.key,
    jevKey: typeof patch.jevKey === "string" ? patch.jevKey : current.jevKey,
    openRouterKey: typeof patch.openRouterKey === "string" ? patch.openRouterKey : current.openRouterKey,
    lang: patch.lang === "en" ? "en" : patch.lang === "id" ? "id" : current.lang,
  };

  const target = settingsPath(env);
  mkdirSync(dirname(target), { recursive: true });
  // 0600: a key on disk is readable by its owner and nobody else
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next;
}
