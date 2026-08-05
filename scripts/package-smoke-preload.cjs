"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { basename, isAbsolute, normalize, resolve } = require("node:path");

if (process.env.ROCKY_PACKAGE_SMOKE_HERMETIC === "1") {
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = function packageSmokeReaddirSync(path, ...args) {
    if (typeof path === "string" && path.replaceAll("\\", "/") === "/mnt/c/Users") return [];
    return originalReaddirSync.call(this, path, ...args);
  };
  syncBuiltinESMExports();

  const kind = new Map([
    ["codex.exe", "codex"],
    ["claude.exe", "claude"],
  ]).get(basename(process.execPath).toLowerCase());
  if (kind !== undefined) {
    const fakeClient = process.env.ROCKY_PACKAGE_SMOKE_FAKE_CLIENT;
    const originalNode = process.env.ROCKY_PACKAGE_SMOKE_NODE;
    if (typeof fakeClient !== "string" || !isAbsolute(fakeClient)
      || typeof originalNode !== "string" || !isAbsolute(originalNode)) {
      throw new Error("package-smoke fake client launch path is unavailable");
    }
    if (/^(?:codex|claude)\.exe$/i.test(basename(originalNode))) {
      throw new Error("package-smoke original Node path resolves to fake client");
    }
    const fakeArgs = process.argv.slice(1);
    const receivedMain = fakeArgs[0];
    const expectedMain = resolve(process.cwd(), "mcp");
    const comparable = (path) => process.platform === "win32"
      ? normalize(path).toLowerCase()
      : normalize(path);
    if (receivedMain !== "mcp"
      && (typeof receivedMain !== "string"
        || comparable(receivedMain) !== comparable(expectedMain))) {
      throw new Error("package-smoke fake client received unexpected main argument");
    }
    fakeArgs[0] = "mcp";
    const result = spawnSync(
      originalNode,
      [fakeClient, kind, ...fakeArgs],
      {
        env: process.env,
        stdio: ["inherit", "pipe", "pipe"],
        timeout: 20_000,
        windowsHide: true,
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.stdout.length > 0) fs.writeSync(1, result.stdout);
    if (result.stderr.length > 0) fs.writeSync(2, result.stderr);
    if (result.signal !== null) {
      throw new Error(`package-smoke fake client received signal ${result.signal}`);
    }
    process.exit(result.status ?? 1);
  }
}
