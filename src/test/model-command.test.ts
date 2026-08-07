import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OllamaClient, OllamaModel, ProbeResult } from "../ai/ollama.js";
import { model } from "../commands/model.js";
import { loadConfig, saveConfigAtomic, type ConfigLoadResult, type RockyConfigV1 } from "../core/config.js";

interface FakeOllama {
  client: OllamaClient;
  tags: number;
  probes: string[];
  generations: number;
}

function fakeOllama(models: readonly OllamaModel[], probe: ProbeResult = { supported: true }): FakeOllama {
  let tags = 0;
  const probes: string[] = [];
  let generations = 0;
  return {
    get tags() { return tags; },
    probes,
    get generations() { return generations; },
    client: {
      async listInstalledModels() {
        tags += 1;
        return models;
      },
      async probeModel(name) {
        probes.push(name);
        return probe;
      },
      async generateStructured() {
        generations += 1;
        throw new Error("model lifecycle must not generate");
      },
    },
  };
}

function configLoader(result: ConfigLoadResult): typeof loadConfig {
  return () => result;
}

function saveAt(path: string): typeof saveConfigAtomic {
  return (config: RockyConfigV1) => saveConfigAtomic(config, path);
}

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const originalStderr = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stderr };
  } finally {
    process.stderr.write = originalStderr;
  }
}

test("model status reports missing, disabled, and enabled config without loading a model", async (t) => {
  const cases: Array<{ name: string; config: ConfigLoadResult; expected: RegExp }> = [
    {
      name: "missing",
      config: { status: "missing", path: "/tmp/missing-config.json", config: { version: 1, ai: { enabled: false } } },
      expected: /AI: disabled .*missing-config\.json/,
    },
    {
      name: "disabled",
      config: { status: "valid", path: "/tmp/disabled-config.json", config: { version: 1, ai: { enabled: false } } },
      expected: /AI: disabled .*disabled-config\.json/,
    },
    {
      name: "enabled",
      config: {
        status: "valid",
        path: "/tmp/enabled-config.json",
        config: { version: 1, ai: { enabled: true, provider: "ollama", model: "installed-model", exposure: "raw" } },
      },
      expected: /AI: enabled .*installed-model.*raw/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const ollama = fakeOllama([]);
      const output = await captureStderr(() => model(["status"], {
        ollama: ollama.client,
        loadConfig: configLoader(entry.config),
        saveConfigAtomic: saveAt(join(mkdtempSync(join(tmpdir(), "rocky-model-status-")), "config.json")),
      }));

      assert.equal(output.code, 0);
      assert.match(output.stderr, entry.expected);
      assert.equal(ollama.tags, 0);
      assert.deepEqual(ollama.probes, []);
      assert.equal(ollama.generations, 0);
    });
  }
});

test("model use rejects missing names and non-exact raw exposure flags before contacting Ollama", async () => {
  for (const argv of [
    ["use"],
    ["use", "--exposure", "RAW", "installed-model"],
    ["use", "--raw", "installed-model"],
    ["use", "installed-model", "raw"],
  ]) {
    const ollama = fakeOllama([{ name: "installed-model", size: 1 }]);
    const output = await captureStderr(() => model(argv, {
      ollama: ollama.client,
      loadConfig: configLoader({ status: "missing", path: "/tmp/config.json", config: { version: 1, ai: { enabled: false } } }),
      saveConfigAtomic: saveAt(join(mkdtempSync(join(tmpdir(), "rocky-model-usage-")), "config.json")),
    }));

    assert.equal(output.code, 2, argv.join(" "));
    assert.equal(ollama.tags, 0);
    assert.deepEqual(ollama.probes, []);
  }
});

test("model use with no installed models offers Tiny and Balanced manual pulls without downloading", async () => {
  const ollama = fakeOllama([]);
  const output = await captureStderr(() => model(["use", "qwen3:0.6b-q4_K_M"], {
    ollama: ollama.client,
    loadConfig: configLoader({ status: "missing", path: "/tmp/config.json", config: { version: 1, ai: { enabled: false } } }),
    saveConfigAtomic: saveAt(join(mkdtempSync(join(tmpdir(), "rocky-model-none-")), "config.json")),
  }));

  assert.equal(output.code, 1);
  assert.match(output.stderr, /Tiny.*qwen3:0\.6b-q4_K_M.*523 MB/s);
  assert.match(output.stderr, /Balanced.*qwen3\.5:2b-q4_K_M.*1\.9 GB/s);
  assert.match(output.stderr, /download size is not peak RAM/i);
  assert.match(output.stderr, /ollama pull qwen3:0\.6b-q4_K_M/);
  assert.match(output.stderr, /ollama pull qwen3\.5:2b-q4_K_M/);
  assert.equal(ollama.tags, 1);
  assert.deepEqual(ollama.probes, []);
  assert.equal(ollama.generations, 0);
});

test("model use offers only the requested exact missing model pull when other models exist", async () => {
  const ollama = fakeOllama([{ name: "unrelated-model", size: 10 }]);
  const output = await captureStderr(() => model(["use", "qwen3.5:2b-q4_K_M"], {
    ollama: ollama.client,
    loadConfig: configLoader({ status: "missing", path: "/tmp/config.json", config: { version: 1, ai: { enabled: false } } }),
    saveConfigAtomic: saveAt(join(mkdtempSync(join(tmpdir(), "rocky-model-missing-")), "config.json")),
  }));

  assert.equal(output.code, 1);
  assert.match(output.stderr, /ollama pull qwen3\.5:2b-q4_K_M/);
  assert.doesNotMatch(output.stderr, /ollama pull qwen3:0\.6b-q4_K_M/);
  assert.deepEqual(ollama.probes, []);
});

test("model use probes an exact installed name before atomically saving sanitized config", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-model-use-"));
  const configPath = join(directory, "config.json");
  const ollama = fakeOllama([{ name: "qwen3:0.6b-q4_K_M", size: 523_000_000 }]);
  const output = await captureStderr(() => model(["use", "qwen3:0.6b-q4_K_M"], {
    ollama: ollama.client,
    loadConfig: () => loadConfig(configPath),
    saveConfigAtomic: saveAt(configPath),
  }));

  assert.equal(output.code, 0);
  assert.deepEqual(ollama.probes, ["qwen3:0.6b-q4_K_M"]);
  assert.deepEqual(loadConfig(configPath), {
    status: "valid",
    path: configPath,
    config: {
      version: 1,
      ai: { enabled: true, provider: "ollama", model: "qwen3:0.6b-q4_K_M", exposure: "sanitized" },
    },
  });
  assert.match(output.stderr, /AI: enabled.*qwen3:0\.6b-q4_K_M.*sanitized/);
});

test("model use accepts raw only through the exact exposure option", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-model-raw-"));
  const configPath = join(directory, "config.json");
  const ollama = fakeOllama([{ name: "installed-model", size: 1 }]);

  assert.equal(await model(["use", "--exposure", "raw", "installed-model"], {
    ollama: ollama.client,
    loadConfig: () => loadConfig(configPath),
    saveConfigAtomic: saveAt(configPath),
  }), 0);
  const saved = loadConfig(configPath);
  assert.notEqual(saved.status, "invalid");
  if (saved.status === "invalid") assert.fail("saved config must be valid");
  assert.deepEqual(saved.config, {
    version: 1,
    ai: { enabled: true, provider: "ollama", model: "installed-model", exposure: "raw" },
  });
});

test("failed model probe leaves existing config bytes unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-model-probe-"));
  const configPath = join(directory, "config.json");
  const original = "{\n  \"version\": 1,\n  \"ai\": { \"enabled\": false }\n}\n";
  writeFileSync(configPath, original, "utf8");
  const ollama = fakeOllama([{ name: "installed-model", size: 1 }], { supported: false, reason: "structured output unavailable" });
  const output = await captureStderr(() => model(["use", "installed-model"], {
    ollama: ollama.client,
    loadConfig: () => loadConfig(configPath),
    saveConfigAtomic: saveAt(configPath),
  }));

  assert.equal(output.code, 1);
  assert.deepEqual(ollama.probes, ["installed-model"]);
  assert.equal(readFileSync(configPath, "utf8"), original);
  assert.doesNotMatch(output.stderr, /structured output unavailable/);
});

test("model off writes only disabled config and refuses malformed config without Ollama calls", async () => {
  const activeDirectory = mkdtempSync(join(tmpdir(), "rocky-model-off-"));
  const activePath = join(activeDirectory, "config.json");
  writeFileSync(activePath, JSON.stringify({
    version: 1,
    ai: { enabled: true, provider: "ollama", model: "installed-model", exposure: "raw" },
  }), "utf8");
  const ollama = fakeOllama([{ name: "installed-model", size: 1 }]);

  assert.equal(await model(["off"], {
    ollama: ollama.client,
    loadConfig: () => loadConfig(activePath),
    saveConfigAtomic: saveAt(activePath),
  }), 0);
  const disabled = loadConfig(activePath);
  assert.notEqual(disabled.status, "invalid");
  if (disabled.status === "invalid") assert.fail("disabled config must be valid");
  assert.deepEqual(disabled.config, { version: 1, ai: { enabled: false } });
  assert.equal(ollama.tags, 0);
  assert.deepEqual(ollama.probes, []);
  assert.equal(ollama.generations, 0);

  const invalidDirectory = mkdtempSync(join(tmpdir(), "rocky-model-invalid-"));
  const invalidPath = join(invalidDirectory, "config.json");
  const invalid = "{not JSON\n";
  writeFileSync(invalidPath, invalid, "utf8");
  const refused = await captureStderr(() => model(["off"], {
    ollama: ollama.client,
    loadConfig: () => loadConfig(invalidPath),
    saveConfigAtomic: saveAt(invalidPath),
  }));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(invalidPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readFileSync(invalidPath, "utf8"), invalid);
  assert.equal(ollama.tags, 0);
  assert.deepEqual(ollama.probes, []);
});
