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
  provider: "openai" | "anthropic";
  endpoint: string;
  model: string;
  key: string;
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
}

const EMPTY: GuiSettings = { provider: "openai", endpoint: "", model: "", key: "", lang: "id" };

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRockyPaths(env).home, "gui.json");
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): GuiSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(env), "utf8")) as Partial<GuiSettings>;
    return {
      provider: parsed.provider === "anthropic" ? "anthropic" : "openai",
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      key: typeof parsed.key === "string" ? parsed.key : "",
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
    provider: patch.provider === "anthropic" ? "anthropic" : patch.provider === "openai" ? "openai" : current.provider,
    endpoint: typeof patch.endpoint === "string" ? patch.endpoint : current.endpoint,
    model: typeof patch.model === "string" ? patch.model : current.model,
    key: typeof patch.key === "string" ? patch.key : current.key,
    lang: patch.lang === "en" ? "en" : patch.lang === "id" ? "id" : current.lang,
  };

  const target = settingsPath(env);
  mkdirSync(dirname(target), { recursive: true });
  // 0600: a key on disk is readable by its owner and nobody else
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next;
}
