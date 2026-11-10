import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  binDir,
  consentFile,
  expectedFile,
  hookBinPath,
  readConsentRecord,
  readExpected,
  withHistory,
  writeConsentRecord,
  writeExpected,
  type ConsentRecord,
  type ExpectedRecord,
} from "../setup/auto/state.js";
import { isGlobalPackageEntry, recordCli } from "../setup/auto/cli-record.js";

const EMPTY_EXPECTED: ExpectedRecord = { v: 1, files: [], history: {} };

function sandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-auto-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("state paths live under the rocky home", (t) => {
  const rh = join(sandbox(t), "rocky-home");
  assert.equal(consentFile(rh), join(rh, "setup", "consent.json"));
  assert.equal(expectedFile(rh), join(rh, "setup", "expected.json"));
  assert.equal(binDir(rh), join(rh, "bin"));
  assert.equal(hookBinPath(rh, "win32"), join(rh, "bin", "rocky-hook.exe"));
  assert.equal(hookBinPath(rh, "linux"), join(rh, "bin", "rocky-hook"));
});

test("consent record round-trips and rejects unknown versions", (t) => {
  const rh = join(sandbox(t), "rocky-home");
  assert.deepEqual(readConsentRecord(rh), { status: "missing" });
  const record: ConsentRecord = {
    v: 1,
    scope: 1,
    state: "approved",
    at: 1,
    harness_off: [],
    shell_hook: true,
    config_dirs: { "claude-code": [{ location: "C:\\config", last_seen: 2 }] },
  };
  writeConsentRecord(rh, record);
  assert.deepEqual(readConsentRecord(rh), { status: "valid", record });
  writeFileSync(consentFile(rh), '{"v":2,"scope":1,"state":"approved"}');
  assert.equal(readConsentRecord(rh).status, "invalid");
  writeFileSync(consentFile(rh), "{");
  assert.equal(readConsentRecord(rh).status, "invalid");
});

test("consent record rejects malformed fields", (t) => {
  const rh = join(sandbox(t), "rocky-home");
  const valid: ConsentRecord = {
    v: 1,
    scope: 1,
    state: "later",
    at: 1,
    harness_off: ["codex"],
    shell_hook: false,
    config_dirs: {},
  };
  const malformed: unknown[] = [
    { ...valid, scope: 2 },
    { ...valid, state: "maybe" },
    { ...valid, at: "1" },
    { ...valid, harness_off: ["vim"] },
    { ...valid, shell_hook: "yes" },
    { ...valid, config_dirs: { vim: [] } },
    { ...valid, config_dirs: { "claude-code": [{ location: "/x" }] } },
    { ...valid, config_dirs: { "claude-code": "not-an-array" } },
  ];
  writeConsentRecord(rh, valid);
  assert.equal(readConsentRecord(rh).status, "valid");
  for (const record of malformed) {
    writeFileSync(consentFile(rh), JSON.stringify(record));
    assert.equal(readConsentRecord(rh).status, "invalid", JSON.stringify(record));
  }
});

test("state files are private to the user", (t) => {
  if (process.platform === "win32") return;
  const rh = join(sandbox(t), "rocky-home");
  writeConsentRecord(rh, {
    v: 1,
    scope: 1,
    state: "removed",
    at: 1,
    harness_off: [],
    shell_hook: true,
    config_dirs: {},
  });
  assert.equal(statSync(dirname(consentFile(rh))).mode & 0o777, 0o700);
  assert.equal(statSync(consentFile(rh)).mode & 0o777, 0o600);
});

test("withHistory dedupes, keeps order, and caps at 20", () => {
  let r: ExpectedRecord = { v: 1, files: [], history: {} };
  for (let i = 0; i < 25; i += 1) r = withHistory(r, "/p", `k${i}`);
  r = withHistory(r, "/p", "k10");
  assert.equal(r.history["/p"].length, 20);
  assert.equal(r.history["/p"].at(-1), "k10");
  assert.equal(r.history["/p"].filter((k) => k === "k10").length, 1);

  const original: ExpectedRecord = { v: 1, files: [], history: { "/q": ["old"] } };
  const next = withHistory(original, "/q", "new");
  assert.deepEqual(original.history["/q"], ["old"]);
  assert.deepEqual(next.history["/q"], ["old", "new"]);
});

test("expected record round-trips and falls back to empty", (t) => {
  const rh = join(sandbox(t), "rocky-home");
  assert.deepEqual(readExpected(rh), EMPTY_EXPECTED);
  const record: ExpectedRecord = {
    v: 1,
    files: [{ path: "/p", snippets: ["a", "b"] }],
    history: { "/p": ["a"] },
  };
  writeExpected(rh, record);
  assert.deepEqual(readExpected(rh), record);
  writeFileSync(expectedFile(rh), JSON.stringify({ v: 1, files: [{ path: 1, snippets: [] }], history: {} }));
  assert.deepEqual(readExpected(rh), EMPTY_EXPECTED);
  writeFileSync(expectedFile(rh), "not json");
  assert.deepEqual(readExpected(rh), EMPTY_EXPECTED);
});

test("cli record only for an installed global package", (t) => {
  const root = sandbox(t);
  const rh = join(root, "rocky-home");
  const repo = join(root, "repo");
  const nodeAbs = process.execPath;
  const globalEntry = join(root, "node_modules", "@poggufanz", "rocky-cli", "dist", "index.js");

  assert.equal(isGlobalPackageEntry(globalEntry), true);
  assert.equal(isGlobalPackageEntry(join(repo, "dist", "index.js")), false);
  assert.equal(recordCli(rh, { node: nodeAbs, entry: join(repo, "dist", "index.js"), version: "2.0.0" }), "skipped");
  assert.equal(existsSync(join(binDir(rh), "cli.json")), false);

  assert.equal(recordCli(rh, { node: nodeAbs, entry: globalEntry, version: "2.0.0" }), "written");
  assert.deepEqual(JSON.parse(readFileSync(join(binDir(rh), "cli.json"), "utf8")), {
    v: 1,
    node: nodeAbs,
    entry: globalEntry,
    version: "2.0.0",
  });
  assert.equal(recordCli(rh, { node: nodeAbs, entry: globalEntry, version: "2.0.0" }), "unchanged");
});
