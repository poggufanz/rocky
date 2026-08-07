import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfigAtomic } from "../core/config.js";

test("missing config returns disabled mode without creating a file", () => {
  const file = join(mkdtempSync(join(tmpdir(), "rocky-config-")), "config.json");
  assert.deepEqual(loadConfig(file), {
    status: "missing", path: file, config: { version: 1, ai: { enabled: false } },
  });
  assert.throws(() => statSync(file));
});

test("malformed config is never overwritten", () => {
  const file = join(mkdtempSync(join(tmpdir(), "rocky-config-")), "config.json");
  writeFileSync(file, "{broken\n", "utf8");
  assert.throws(() => saveConfigAtomic({ version: 1, ai: { enabled: false } }, file));
  assert.equal(readFileSync(file, "utf8"), "{broken\n");
});

test("active config is written atomically with a trailing newline", () => {
  const file = join(mkdtempSync(join(tmpdir(), "rocky-config-")), "config.json");
  const config = {
    version: 1 as const,
    ai: { enabled: true as const, provider: "ollama" as const, model: "qwen3:0.6b-q4_K_M", exposure: "sanitized" as const },
  };
  writeFileSync(file, JSON.stringify({ version: 1, ai: { enabled: false } }), "utf8");
  saveConfigAtomic(config, file);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(config, null, 2) + "\n");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadConfig(file), { status: "valid", path: file, config });
});

test("valid disabled config loads in disabled mode", () => {
  const file = join(mkdtempSync(join(tmpdir(), "rocky-config-")), "config.json");
  const config = { version: 1 as const, ai: { enabled: false as const } };
  writeFileSync(file, JSON.stringify(config), "utf8");
  assert.deepEqual(loadConfig(file), { status: "valid", path: file, config });
});

test("invalid config shapes are refused", () => {
  const cases = [
    { version: 2, ai: { enabled: false } },
    { version: 1, ai: { enabled: true, provider: "other", model: "model", exposure: "sanitized" } },
    { version: 1, ai: { enabled: true, provider: "ollama", model: " ", exposure: "sanitized" } },
    { version: 1, ai: { enabled: true, provider: "ollama", model: "model", exposure: "SANITIZED" } },
    { version: 1, ai: { enabled: false }, unexpected: true },
    { version: 1, ai: { enabled: false, provider: "ollama" } },
  ];
  for (const value of cases) {
    const file = join(mkdtempSync(join(tmpdir(), "rocky-config-")), "config.json");
    writeFileSync(file, JSON.stringify(value), "utf8");
    const result = loadConfig(file);
    assert.equal(result.status, "invalid");
  }
});

test("failed atomic write leaves no temp sibling", () => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-config-"));
  const file = join(directory, "config.json");
  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("injected rename failure");
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => saveConfigAtomic({ version: 1, ai: { enabled: false } }, file));
  } finally {
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(directory), []);
});
