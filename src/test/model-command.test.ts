import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OllamaClient, OllamaModel, ProbeResult } from "../ai/ollama.js";
import { MODEL_USE_DEADLINE_MS, model } from "../commands/model.js";
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

test("model use shares one bounded deadline across discovery and probe", async () => {
  const signals: AbortSignal[] = [];
  let saved: RockyConfigV1 | undefined;
  const ollama: OllamaClient = {
    async listInstalledModels(signal) {
      assert.ok(signal);
      signals.push(signal);
      return [{ name: "installed-model", size: 1 }];
    },
    async probeModel(_name, signal) {
      assert.ok(signal);
      signals.push(signal);
      return { supported: true };
    },
    async generateStructured() { throw new Error("model use must not generate"); },
  };

  assert.equal(await model(["use", "installed-model"], {
    ollama,
    loadConfig: configLoader({ status: "missing", path: "/tmp/task16-model-deadline.json", config: { version: 1, ai: { enabled: false } } }),
    saveConfigAtomic: (config) => { saved = config; return { path: "/tmp/task16-model-deadline.json" }; },
  }), 0);
  assert.equal(MODEL_USE_DEADLINE_MS, 30_000);
  assert.equal(signals.length, 2);
  assert.strictEqual(signals[0], signals[1], "tags and probe must share one aggregate deadline signal");
  assert.equal(signals[0]?.aborted, false);
  assert.deepEqual(saved?.ai, { enabled: true, provider: "ollama", model: "installed-model", exposure: "sanitized" });
});

test("model use returns on a non-cooperative discovery call without saving", async () => {
  let saved = false;
  const never = new Promise<readonly OllamaModel[]>(() => {});
  const output = await captureStderr(() => model(["use", "installed-model"], {
    ollama: {
      listInstalledModels: async () => never,
      probeModel: async () => ({ supported: true }),
      generateStructured: async () => ({}),
    },
    deadlineMs: 10,
    loadConfig: configLoader({ status: "missing", path: "/tmp/model-deadline-discovery.json", config: { version: 1, ai: { enabled: false } } }),
    saveConfigAtomic: () => { saved = true; return { path: "/tmp/model-deadline-discovery.json" }; },
  }));

  assert.equal(output.code, 1);
  assert.equal(saved, false);
});

test("model use returns on a non-cooperative probe call without saving", async () => {
  let saved = false;
  const never = new Promise<ProbeResult>(() => {});
  const output = await captureStderr(() => model(["use", "installed-model"], {
    ollama: {
      listInstalledModels: async () => [{ name: "installed-model", size: 1 }],
      probeModel: async () => never,
      generateStructured: async () => ({}),
    },
    deadlineMs: 10,
    loadConfig: configLoader({ status: "missing", path: "/tmp/model-deadline-probe.json", config: { version: 1, ai: { enabled: false } } }),
    saveConfigAtomic: () => { saved = true; return { path: "/tmp/model-deadline-probe.json" }; },
  }));

  assert.equal(output.code, 1);
  assert.equal(saved, false);
});

test("model use re-checks deadline before saving a late probe result", async () => {
  let saved = false;
  let resolveProbe: ((result: ProbeResult) => void) | undefined;
  const probe = new Promise<ProbeResult>((resolve) => { resolveProbe = resolve; });
  const outputPromise = model(["use", "installed-model"], {
    ollama: {
      listInstalledModels: async () => [{ name: "installed-model", size: 1 }],
      probeModel: async () => probe,
      generateStructured: async () => ({}),
    },
    deadlineMs: 10,
    loadConfig: configLoader({ status: "missing", path: "/tmp/model-deadline-late.json", config: { version: 1, ai: { enabled: false } } }),
    saveConfigAtomic: () => { saved = true; return { path: "/tmp/model-deadline-late.json" }; },
  });
  const output = await outputPromise;
  resolveProbe?.({ supported: true });

  assert.equal(output, 1);
  assert.equal(saved, false);
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

test("model off and model use keep config keys they do not own", async () => {
  // Rebuilding the config from scratch silently deleted the user's `watch`
  // key, so `rocky model off` turned watch notifications back on for someone
  // who had deliberately switched them off.
  const withWatch = {
    version: 1 as const,
    ai: { enabled: true as const, provider: "ollama" as const, model: "llama3", exposure: "sanitized" as const },
    watch: { notify: false },
  };

  let saved: unknown;
  const deps = {
    ollama: { listInstalledModels: async () => [], probeModel: async () => ({ supported: true }), generateStructured: async () => ({}) },
    loadConfig: () => ({ status: "valid" as const, path: "/tmp/config.json", config: withWatch }),
    saveConfigAtomic: (config: unknown) => { saved = config; return { path: "/tmp/config.json" }; },
  } as unknown as Parameters<typeof model>[1];

  assert.equal(await model(["off"], deps), 0);
  assert.deepEqual(saved, { version: 1, ai: { enabled: false }, watch: { notify: false } });
});

test("model off and model use preserve check registry consent byte-for-byte", async () => {
  const check = { registry: true };
  const seeded: RockyConfigV1 = {
    version: 1,
    ai: { enabled: true, provider: "ollama", model: "llama3", exposure: "sanitized" },
    check,
  };
  const savedCheckBytes: string[] = [];

  for (const argv of [["off"], ["use", "installed-model"]]) {
    const saved: RockyConfigV1[] = [];
    const ollama = fakeOllama([{ name: "installed-model", size: 1 }]);

    assert.equal(await model(argv, {
      ollama: ollama.client,
      loadConfig: configLoader({ status: "valid", path: "/tmp/config.json", config: seeded }),
      saveConfigAtomic: (config) => {
        saved.push(config);
        return { path: "/tmp/config.json" };
      },
    }), 0, argv.join(" "));
    assert.equal(saved.length, 1, argv.join(" "));
    savedCheckBytes.push(JSON.stringify(saved[0]!.check));
  }

  const seededCheckBytes = JSON.stringify(check);
  assert.deepEqual(savedCheckBytes, [seededCheckBytes, seededCheckBytes]);
});
