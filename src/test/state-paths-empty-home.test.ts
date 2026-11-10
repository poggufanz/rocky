import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveRockyPaths, configuredRockyHome } from "../core/state-paths.js";
import { resolveMcpRegistration } from "../setup/registration.js";

// Absolute fixtures per platform so path joining and the "already absolute"
// short-circuits inside both resolvers behave like a real install.
const fixtures = process.platform === "win32"
  ? {
    home: "C:\\Users\\u",
    work: "C:\\work",
    data: "C:\\data\\r",
    node: "C:\\Program Files\\nodejs\\node.exe",
    entry: "C:\\opt\\rocky\\dist\\index.js",
  }
  : {
    home: "/home/u",
    work: "/work",
    data: "/data/r",
    node: "/usr/bin/node",
    entry: "/opt/r/dist/index.js",
  };

test("empty ROCKY_HOME resolves like an unset one", () => {
  assert.equal(resolveRockyPaths({ ROCKY_HOME: "" }, fixtures.home, fixtures.work).home, join(fixtures.home, ".rocky"));
  assert.equal(resolveRockyPaths({}, fixtures.home, fixtures.work).home, join(fixtures.home, ".rocky"));
});

test("a set ROCKY_HOME still wins", () => {
  assert.equal(resolveRockyPaths({ ROCKY_HOME: fixtures.data }, fixtures.home, fixtures.work).home, fixtures.data);
});

test("configuredRockyHome reports only a non-empty value", () => {
  assert.equal(configuredRockyHome({}), undefined);
  assert.equal(configuredRockyHome({ ROCKY_HOME: "" }), undefined);
  assert.equal(configuredRockyHome({ ROCKY_HOME: fixtures.data }), fixtures.data);
});

test("MCP registration treats empty ROCKY_HOME as unset", () => {
  const registration = resolveMcpRegistration({
    exposure: "sanitized",
    env: { ROCKY_HOME: "" },
    home: fixtures.home,
    nodePath: fixtures.node,
    entryPath: fixtures.entry,
    fileExists: () => true,
  });
  assert.equal(registration.env.ROCKY_HOME, join(fixtures.home, ".rocky"));
});
