import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTeachSpec } from "../ai/answer.js";
import { publicSettings, readSettings, writeSettings } from "../gui/settings.js";

/**
 * Each test gets its own ROCKY_HOME and passes it through the env argument, so
 * nothing here touches process.env or the developer's real gui.json.
 */
function homeFor(t: TestContext): { env: NodeJS.ProcessEnv; file: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-gui-settings-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { env: { ROCKY_HOME: home }, file: join(home, "gui.json") };
}

test("a fresh home teaches in english", (t) => {
  const { env } = homeFor(t);
  assert.equal(readSettings(env).lang, "en");
  assert.equal(publicSettings(readSettings(env)).lang, "en");
});

test("an unreadable settings file is an unset config, so english too", (t) => {
  const { env, file } = homeFor(t);
  writeFileSync(file, "{ not json");
  assert.equal(readSettings(env).lang, "en");
});

test("a stored id stays id", (t) => {
  const { env, file } = homeFor(t);
  writeFileSync(file, `${JSON.stringify({ provider: "openai", endpoint: "", model: "", key: "", lang: "id" })}\n`);
  assert.equal(readSettings(env).lang, "id");
  assert.equal(publicSettings(readSettings(env)).lang, "id");
});

test("a stored en stays en", (t) => {
  const { env, file } = homeFor(t);
  writeFileSync(file, `${JSON.stringify({ provider: "openai", endpoint: "", model: "", key: "", lang: "en" })}\n`);
  assert.equal(readSettings(env).lang, "en");
});

test("a settings file with no usable lang reads as en", (t) => {
  // files saved before lang existed omit it, and a hand-edited one can hold anything
  const { env, file } = homeFor(t);
  for (const stored of [undefined, "fr", "", 7, null]) {
    writeFileSync(file, `${JSON.stringify({ provider: "openai", model: "m", lang: stored })}\n`);
    assert.equal(readSettings(env).lang, "en", `stored lang ${JSON.stringify(stored)} (omitted when undefined)`);
  }
});

test("saving an unrelated field on a fresh home stores en", (t) => {
  const { env, file } = homeFor(t);
  assert.equal(writeSettings({ model: "m" }, env).lang, "en");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).lang, "en");
});

test("an explicit lang is saved and later saves keep it", (t) => {
  const { env } = homeFor(t);
  writeSettings({ lang: "id" }, env);
  writeSettings({ model: "other" }, env);
  assert.equal(readSettings(env).lang, "id");
  writeSettings({ lang: "en" }, env);
  writeSettings({ model: "again" }, env);
  assert.equal(readSettings(env).lang, "en");
});

test("the teach spec follows the stored language and is english on a fresh home", (t) => {
  const fresh = homeFor(t);
  const freshSpec = loadTeachSpec(readSettings(fresh.env).lang);
  assert.ok(freshSpec.includes("Output language: English."), "a fresh home did not get the english spec");

  const stored = homeFor(t);
  writeSettings({ lang: "id" }, stored.env);
  const storedSpec = loadTeachSpec(readSettings(stored.env).lang);
  assert.ok(storedSpec.includes("Output language: Indonesian."), "a stored id did not get the indonesian spec");
});
