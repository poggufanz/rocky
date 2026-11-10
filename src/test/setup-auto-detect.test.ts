import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  detectHarnesses,
  findOnPath,
  validateConfigLocation,
  type DetectEnv,
} from "../setup/auto/detect.js";
import { resolveCodexHome } from "../setup/harness-codex.js";
import { resolveOpencodeConfigPath } from "../setup/harness-opencode.js";
import { resolveGeminiSettingsPath } from "../setup/harness-gemini-cli.js";
import { resolveCopilotConfigPath } from "../setup/harness-copilot-cli.js";

const IS_WINDOWS = process.platform === "win32";
const PATH_DELIMITER = IS_WINDOWS ? ";" : ":";

function tempRoot(t: TestContext, prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function envFor(home: string, overrides: Partial<DetectEnv> = {}): DetectEnv {
  return { home, env: {}, platform: process.platform, fileExists: existsSync, isFile, ...overrides };
}

/** A shim that exits non-zero: finding it without running it is the point. */
function writeShim(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name + (IS_WINDOWS ? ".cmd" : ""));
  writeFileSync(file, IS_WINDOWS ? "@echo off\r\nexit 1\r\n" : "#!/bin/sh\nexit 1\n");
  return file;
}

test("findOnPath finds a .cmd shim on win32 without running it", { skip: process.platform !== "win32" }, (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const bin = tempRoot(t, "rocky-auto-detect-bin-");
  const d = envFor(home);
  writeFileSync(join(bin, "gemini.cmd"), "@echo off\r\nexit 1\r\n");
  assert.equal(findOnPath("gemini", { ...d, env: { PATH: bin } }), join(bin, "gemini.cmd"));
});

test("findOnPath prefers .exe over .cmd on win32", { skip: process.platform !== "win32" }, (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const bin = tempRoot(t, "rocky-auto-detect-bin-");
  writeFileSync(join(bin, "gemini.cmd"), "@echo off\r\nexit 1\r\n");
  writeFileSync(join(bin, "gemini.exe"), "");
  assert.equal(findOnPath("gemini", { ...envFor(home), env: { PATH: bin } }), join(bin, "gemini.exe"));
});

test("findOnPath reads Path when PATH is absent on win32", { skip: process.platform !== "win32" }, (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const bin = tempRoot(t, "rocky-auto-detect-bin-");
  writeFileSync(join(bin, "codex.cmd"), "@echo off\r\nexit 1\r\n");
  assert.equal(findOnPath("codex", { ...envFor(home), env: { Path: bin } }), join(bin, "codex.cmd"));
});

test("findOnPath skips empty PATH entries and missing directories", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const bin = tempRoot(t, "rocky-auto-detect-bin-");
  const shim = writeShim(bin, "codex");
  const path = `${PATH_DELIMITER}${join(home, "nope")}${PATH_DELIMITER}${bin}${PATH_DELIMITER}`;
  assert.equal(findOnPath("codex", { ...envFor(home), env: { PATH: path } }), shim);
  assert.equal(findOnPath("codex", { ...envFor(home), env: { PATH: "" } }), undefined);
});

test("findOnPath ignores a directory whose name matches the binary", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const bin = tempRoot(t, "rocky-auto-detect-bin-");
  mkdirSync(join(bin, "gemini" + (IS_WINDOWS ? ".exe" : "")));
  assert.equal(findOnPath("gemini", { ...envFor(home), env: { PATH: bin } }), undefined);
});

test("detectHarnesses reports config-only when no binary is on PATH", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const d = envFor(home);
  mkdirSync(join(home, ".codex"));
  assert.deepEqual(detectHarnesses({ ...d, env: { PATH: "" } }).map((h) => [h.id, h.via]), [["codex", "config-only"]]);
});

test("detectHarnesses reports a binary ahead of a present config dir", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const bin = tempRoot(t, "rocky-auto-detect-bin-");
  mkdirSync(join(home, ".codex"));
  writeShim(bin, "codex");
  assert.deepEqual(
    detectHarnesses({ ...envFor(home), env: { PATH: bin } }).map((h) => [h.id, h.via]),
    [["codex", "binary"]],
  );
});

test("detectHarnesses reports nothing when no binary or config hint exists", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  assert.deepEqual(detectHarnesses({ ...envFor(home), env: { PATH: "" } }), []);
});

test("detectHarnesses accepts either claude config hint", (t) => {
  const withDir = tempRoot(t, "rocky-auto-detect-home-");
  mkdirSync(join(withDir, ".claude"));
  assert.deepEqual(
    detectHarnesses({ ...envFor(withDir), env: { PATH: "" } }).map((h) => [h.id, h.via]),
    [["claude-code", "config-only"]],
  );
  const withFile = tempRoot(t, "rocky-auto-detect-home-");
  writeFileSync(join(withFile, ".claude.json"), "{}");
  assert.deepEqual(
    detectHarnesses({ ...envFor(withFile), env: { PATH: "" } }).map((h) => [h.id, h.via]),
    [["claude-code", "config-only"]],
  );
});

test("validateConfigLocation accepts a profile dir that holds .claude.json", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const d = envFor(home);
  mkdirSync(join(home, "p2"));
  writeFileSync(join(home, "p2", ".claude.json"), "{}");
  assert.deepEqual(validateConfigLocation("claude-code", join(home, "p2"), d), { ok: true, location: join(home, "p2") });
});

test("validateConfigLocation accepts settings.json as a claude marker", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  mkdirSync(join(home, "p3"));
  writeFileSync(join(home, "p3", "settings.json"), "{}");
  assert.deepEqual(validateConfigLocation("claude-code", join(home, "p3"), envFor(home)), {
    ok: true,
    location: join(home, "p3"),
  });
});

test("validateConfigLocation refuses a dir with no harness file", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const d = envFor(home);
  mkdirSync(join(home, "p1"));
  assert.deepEqual(validateConfigLocation("claude-code", join(home, "p1"), d), { ok: false, reason: "no-harness-file" });
});

test("validateConfigLocation refuses a dir outside home", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const outside = tempRoot(t, "rocky-auto-detect-outside-");
  const d = envFor(home);
  writeFileSync(join(outside, ".claude.json"), "{}");
  assert.equal(validateConfigLocation("claude-code", outside, d).ok, false);
  assert.deepEqual(validateConfigLocation("claude-code", outside, d), { ok: false, reason: "outside-home" });
});

test("validateConfigLocation refuses home itself", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  assert.deepEqual(validateConfigLocation("claude-code", home, envFor(home)), { ok: false, reason: "outside-home" });
});

test("validateConfigLocation refuses relative or non-normalized values", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const d = envFor(home);
  assert.deepEqual(validateConfigLocation("claude-code", "profile", d), { ok: false, reason: "not-canonical" });
  assert.deepEqual(validateConfigLocation("claude-code", `${join(home, "p")}/`, d), {
    ok: false,
    reason: "not-canonical",
  });
  assert.deepEqual(validateConfigLocation("opencode", `${join(home, "opencode.json")}/`, d), {
    ok: false,
    reason: "not-canonical",
  });
});

test("validateConfigLocation refuses a missing location", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const d = envFor(home);
  assert.deepEqual(validateConfigLocation("codex", join(home, "absent"), d), { ok: false, reason: "missing" });
  assert.deepEqual(validateConfigLocation("opencode", join(home, "absent.json"), d), { ok: false, reason: "missing" });
});

test("validateConfigLocation refuses a symlinked location", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const target = join(home, "real-profile");
  mkdirSync(target);
  writeFileSync(join(target, ".claude.json"), "{}");
  const link = join(home, "linked-profile");
  try {
    symlinkSync(target, link, IS_WINDOWS ? "junction" : "dir");
  } catch {
    t.skip("directory symlinks are unavailable");
    return;
  }
  assert.deepEqual(validateConfigLocation("claude-code", link, envFor(home)), { ok: false, reason: "symlink" });
});

test("validateConfigLocation accepts the codex and copilot marker dirs", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  mkdirSync(join(home, "codex-home"));
  writeFileSync(join(home, "codex-home", "config.toml"), "");
  assert.deepEqual(validateConfigLocation("codex", join(home, "codex-home"), envFor(home)), {
    ok: true,
    location: join(home, "codex-home"),
  });
  mkdirSync(join(home, "copilot-home"));
  writeFileSync(join(home, "copilot-home", "config.json"), "{}");
  assert.deepEqual(validateConfigLocation("copilot-cli", join(home, "copilot-home"), envFor(home)), {
    ok: true,
    location: join(home, "copilot-home"),
  });
});

test("validateConfigLocation accepts config files under home", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const d = envFor(home);
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  const opencode = join(home, ".config", "opencode", "opencode.json");
  writeFileSync(opencode, "{}");
  assert.deepEqual(validateConfigLocation("opencode", opencode, d), { ok: true, location: opencode });
  const gemini = join(home, "gemini-settings.json");
  writeFileSync(gemini, "{}");
  assert.deepEqual(validateConfigLocation("gemini-cli", gemini, d), { ok: true, location: gemini });
});

test("validateConfigLocation refuses a config file outside home", (t) => {
  const home = tempRoot(t, "rocky-auto-detect-home-");
  const outside = tempRoot(t, "rocky-auto-detect-outside-");
  const file = join(outside, "opencode.json");
  writeFileSync(file, "{}");
  assert.deepEqual(validateConfigLocation("opencode", file, envFor(home)), { ok: false, reason: "outside-home" });
});

test("adapter resolvers keep today's path resolution", () => {
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: "/custom/codex" }, home: "/home/u", platform: "linux" }), "/custom/codex");
  assert.equal(resolveCodexHome({ env: {}, home: "/home/u", platform: "linux" }), join("/home/u", ".codex"));

  assert.equal(
    resolveOpencodeConfigPath({ env: { OPENCODE_CONFIG: "/tmp/opencode.json" }, home: "/home/u", platform: "win32", appData: "C:\\ad" }),
    "/tmp/opencode.json",
  );
  assert.equal(
    resolveOpencodeConfigPath({ env: {}, home: "/home/u", platform: "win32", appData: "C:\\ad" }),
    join("C:\\ad", "opencode", "opencode.json"),
  );
  assert.equal(
    resolveOpencodeConfigPath({ env: {}, home: "/home/u", platform: "linux", appData: "C:\\ad" }),
    join("/home/u", ".config", "opencode", "opencode.json"),
  );

  assert.equal(
    resolveGeminiSettingsPath({ env: { GEMINI_SETTINGS: "/tmp/gemini.json" }, home: "/home/u", platform: "linux" }),
    "/tmp/gemini.json",
  );
  assert.equal(
    resolveGeminiSettingsPath({ env: {}, home: "/home/u", platform: "win32", appData: "C:\\ad" }),
    join("C:\\ad", "gemini", "settings.json"),
  );
  assert.equal(
    resolveGeminiSettingsPath({ env: {}, home: "/home/u", platform: "linux" }),
    join("/home/u", ".gemini", "settings.json"),
  );

  assert.equal(
    resolveCopilotConfigPath({ env: { COPILOT_HOME: "/custom/copilot" }, home: "/home/u", platform: "linux" }),
    join("/custom/copilot", "config.json"),
  );
  assert.equal(
    resolveCopilotConfigPath({ env: {}, home: "/home/u", platform: "linux" }),
    join("/home/u", ".copilot", "config.json"),
  );
});
