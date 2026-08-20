import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { firstWord, resolvesOnPath } from "../core/path-lookup.js";

test("firstWord takes the first whitespace-delimited token", () => {
  assert.equal(firstWord("npm run build"), "npm");
  assert.equal(firstWord("   git   status  "), "git");
  assert.equal(firstWord(""), "");
  assert.equal(firstWord("   "), "");
});

test("a command present in PATH resolves as found", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-path-"));
  const exe = process.platform === "win32" ? "realtool.cmd" : "realtool";
  writeFileSync(join(dir, exe), "");
  if (process.platform !== "win32") chmodSync(join(dir, exe), 0o755);
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(resolvesOnPath("realtool", env), "found");
});

test("a command absent from PATH resolves as not-found", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-path-"));
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(resolvesOnPath("gti", env), "not-found");
});

test("an unanswerable lookup is unknown, never not-found", () => {
  assert.equal(resolvesOnPath("gti", {}), "unknown");
  assert.equal(resolvesOnPath("gti", { PATH: "" }), "unknown");
  assert.equal(resolvesOnPath("", { PATH: "/usr/bin" }), "unknown");
});

test("shell keywords are never treated as PATH lookups", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-path-"));
  const env = { PATH: dir };
  for (const keyword of ["if", "for", "while", "case", "until", "function", "[[", "{"]) {
    assert.equal(resolvesOnPath(keyword, env), "unknown", keyword);
  }
});

test("an explicit path is checked directly, not walked through PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-path-"));
  const exe = join(dir, "local-tool");
  writeFileSync(exe, "");
  const env = { PATH: "" };
  assert.equal(resolvesOnPath(exe.split("\\").join("/"), env), "found");
  assert.equal(resolvesOnPath(`${dir.split("\\").join("/")}/absent-tool`, env), "not-found");
});

test("multiple PATH entries are all searched", () => {
  const first = mkdtempSync(join(tmpdir(), "rocky-path-"));
  const second = mkdtempSync(join(tmpdir(), "rocky-path-"));
  const exe = process.platform === "win32" ? "secondtool.cmd" : "secondtool";
  writeFileSync(join(second, exe), "");
  const env = { PATH: `${first}${delimiter}${second}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(resolvesOnPath("secondtool", env), "found");
});