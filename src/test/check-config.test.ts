import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, saveConfigAtomic, setCheckRegistry } from "../core/config.js";
import { resolveRockyPaths } from "../core/state-paths.js";

function sandboxHome(t: TestContext): string {
  return join(mkdtempSync(join(tmpdir(), "rocky-check-config-")), "rocky-home");
}

function withRockyHome<T>(home: string, fn: () => T): T {
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
}

test("check section round-trips and validates strictly", (t) => {
  const home = sandboxHome(t);

  withRockyHome(home, () => {
    setCheckRegistry(true);

    const loaded = loadConfig();
    assert.equal(loaded.status, "valid");
    if (loaded.status !== "valid") assert.fail("check config should be valid");
    assert.deepEqual(loaded.config.check, { registry: true });
  });
});

test("unknown keys inside check invalidate the config, mirroring watch strictness", (t) => {
  const home = sandboxHome(t);

  withRockyHome(home, () => {
    const path = resolveRockyPaths().config;
    mkdirSync(home, { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 1,
      ai: { enabled: false },
      check: { registry: true, extra: 1 },
    }), "utf8");

    assert.deepEqual(loadConfig(), { status: "invalid", path, error: "invalid config shape" });
  });
});

test("check registry accepts only booleans", () => {
  for (const registry of [undefined, 0, 1, "true", null, []]) {
    assert.equal(
      parseConfig({ version: 1, ai: { enabled: false }, check: { registry } }),
      undefined,
      `registry=${JSON.stringify(registry)}`,
    );
  }
});

test("setCheckRegistry preserves existing ai and watch sections", (t) => {
  const home = sandboxHome(t);

  withRockyHome(home, () => {
    const path = resolveRockyPaths().config;
    saveConfigAtomic({
      version: 1,
      ai: { enabled: true, provider: "ollama", model: "preserved-model", exposure: "raw" },
      watch: { notify: false },
    }, path);

    setCheckRegistry(false);

    const loaded = loadConfig(path);
    assert.deepEqual(loaded, {
      status: "valid",
      path,
      config: {
        version: 1,
        ai: { enabled: true, provider: "ollama", model: "preserved-model", exposure: "raw" },
        watch: { notify: false },
        check: { registry: false },
      },
    });
  });
});
