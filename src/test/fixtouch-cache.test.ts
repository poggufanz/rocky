import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  boundCodePoints,
  findFixTouchEntry,
  fixTouchCachePath,
  fixTouchEnabled,
  readFixTouchCache,
  rootKey,
  sanitizeField,
  writeFixTouchCache,
  type FixTouchCache,
  type FixTouchEntry,
} from "../core/fixtouch-cache.js";

const now = 1_800_000_000_000;
const entry: FixTouchEntry = {
  root: "/repo",
  path: "src/file.ts",
  cmd: "npm test",
  signature: "TypeError: token undefined",
  ts: now - 100,
};
const cache: FixTouchCache = { v: 1, builtAt: now, entries: [entry] };

function fixture(t: TestContext): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-fixtouch-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, file: fixTouchCachePath(home) };
}

test("fix-touch is enabled by an empty marker file", (t) => {
  const { home, file } = fixture(t);
  assert.equal(file, join(home, "derived", "attempts-hot.json"));
  assert.equal(fixTouchEnabled(home), false);
  writeFileSync(join(home, "fixtouch-on"), "");
  assert.equal(fixTouchEnabled(home), true);
});

test("cache writing creates a private directory and replaces the file without temporary leftovers", (t) => {
  const { file } = fixture(t);
  assert.equal(writeFixTouchCache(file, cache), true);
  assert.deepEqual(readFixTouchCache(file, now), cache);

  const updated = { ...cache, entries: [] };
  assert.equal(writeFixTouchCache(file, updated), true);
  assert.deepEqual(readFixTouchCache(file, now), updated);
  assert.deepEqual(readdirSync(dirname(file)), ["attempts-hot.json"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("a failed replacement preserves the destination and removes the temporary file", (t) => {
  const { file } = fixture(t);
  mkdirSync(file, { recursive: true });
  writeFileSync(join(file, "keep"), "existing data");

  assert.equal(writeFixTouchCache(file, cache), false);
  assert.equal(readFileSync(join(file, "keep"), "utf8"), "existing data");
  assert.deepEqual(readdirSync(dirname(file)), ["attempts-hot.json"]);
});

test("cache writing keeps a newest-first prefix within 256 KiB", (t) => {
  const { file } = fixture(t);
  const entries = Array.from({ length: 5_000 }, (_, index) => ({
    ...entry,
    path: `src/${"a".repeat(175)}`,
    cmd: "🪨".repeat(95),
    signature: "s".repeat(135),
    ts: entry.ts + index,
  }));

  assert.equal(writeFixTouchCache(file, { ...cache, entries }), true);
  assert.ok(statSync(file).size <= 256 * 1024);
  const written = readFixTouchCache(file, now);
  assert.ok(written);
  assert.ok(written.entries.length > 0 && written.entries.length < entries.length);
  assert.deepEqual(written.entries.map(({ ts }: FixTouchEntry) => ts),
    Array.from({ length: written.entries.length }, (_, index) => entry.ts + 4_999 - index));
  assert.deepEqual(written.entries[0], {
    root: entry.root,
    path: `src/${"a".repeat(156)}`,
    cmd: "🪨".repeat(80),
    signature: "s".repeat(120),
    ts: entry.ts + 4_999,
  });
});

test("cache reads ignore missing, oversized, malformed, and out-of-date files", (t) => {
  const { file } = fixture(t);
  assert.equal(readFixTouchCache(file, now), undefined);
  mkdirSync(dirname(file));
  const invalid = [
    ["oversized valid JSON", JSON.stringify(cache).padEnd(256 * 1024 + 1)],
    ["invalid JSON", "{"],
    ["null document", "null"],
    ["unknown version", JSON.stringify({ ...cache, v: 2 })],
    ["string timestamp", JSON.stringify({ ...cache, builtAt: String(now) })],
    ["non-finite timestamp", '{"v":1,"builtAt":1e999,"entries":[]}'],
    ["older than seven days", JSON.stringify({ ...cache, builtAt: now - 7 * 86_400_000 - 1 })],
    ["over a minute ahead", JSON.stringify({ ...cache, builtAt: now + 60_001 })],
    ["missing entries array", JSON.stringify({ ...cache, entries: {} })],
  ];
  for (const [label, contents] of invalid) {
    writeFileSync(file, contents);
    assert.equal(readFixTouchCache(file, now), undefined, label);
  }

  for (const builtAt of [now - 7 * 86_400_000, now + 60_000]) {
    const boundary = { ...cache, builtAt };
    writeFileSync(file, JSON.stringify(boundary).padEnd(256 * 1024));
    assert.deepEqual(readFixTouchCache(file, now), boundary);
  }
});

test("cache reads drop invalid entries and preserve valid neighbors", (t) => {
  const { file } = fixture(t);
  mkdirSync(dirname(file));
  const validAtBounds = {
    ...entry,
    root: "/" + "r".repeat(1_023),
    path: "p".repeat(160),
    cmd: "🪨".repeat(80),
    signature: "s".repeat(120),
  };
  const invalid = [
    null,
    { ...entry, root: 1 },
    { ...entry, root: "" },
    { ...entry, path: null },
    { ...entry, path: "" },
    { ...entry, path: "/outside.ts" },
    { ...entry, path: "C:\\outside.ts" },
    { ...entry, path: "\\\\server\\share\\outside.ts" },
    { ...entry, path: "../outside.ts" },
    { ...entry, path: "..outside.ts" },
    { ...entry, path: "\u202e../outside.ts" },
    { ...entry, path: "\u202e" },
    { ...entry, cmd: 1 },
    { ...entry, signature: [] },
    { ...entry, ts: "1e999" },
    { ...entry, ts: null },
    { ...validAtBounds, root: validAtBounds.root + "r" },
    { ...validAtBounds, path: validAtBounds.path + "p" },
    { ...validAtBounds, cmd: validAtBounds.cmd + "\u202e" },
    { ...validAtBounds, signature: validAtBounds.signature + "s" },
  ];
  const nonFinite = JSON.stringify({ ...entry, ts: "non-finite" }).replace('"non-finite"', "1e999");
  const entries = [JSON.stringify(entry), ...invalid.map((invalidEntry) => JSON.stringify(invalidEntry)),
    nonFinite, JSON.stringify(validAtBounds)];
  writeFileSync(file, `{"v":1,"builtAt":${now},"entries":[${entries.join(",")}]}`);

  assert.deepEqual(readFixTouchCache(file, now), { ...cache, entries: [entry, validAtBounds] });
});

test("path, command, and signature are sanitized on both read and write", (t) => {
  const { file } = fixture(t);
  mkdirSync(dirname(file));
  const fabricatedToken = `ghp_${"a1".repeat(18)}`;
  const tainted = {
    ...cache,
    entries: [{
      ...entry,
      path: "src/\u202efile.ts",
      cmd: `gh api\n${fabricatedToken}\u202e`,
      signature: 'TypeError: "token"\n\u202eundefined',
    }],
  };
  const sanitized = {
    ...cache,
    entries: [{ ...entry, cmd: "gh api [redacted github token]", signature: "TypeError: 'token' undefined" }],
  };

  writeFileSync(file, JSON.stringify(tainted));
  assert.deepEqual(readFixTouchCache(file, now), sanitized);
  assert.equal(writeFixTouchCache(file, tainted), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), sanitized);
});

test("matching picks the newest entry and uses the platform's path comparison", (t) => {
  fixture(t);
  const older = { ...entry, root: "c:/repo" };
  const newer = { ...older, root: "C:\\Repo\\", path: "Src\\File.ts", ts: older.ts + 1 };
  const anotherRoot = { ...newer, root: "C:/elsewhere", ts: newer.ts + 1 };
  const anotherPath = { ...newer, path: "src/other.ts", ts: newer.ts + 1 };
  const windowsCache = { ...cache, entries: [older, anotherRoot, newer, anotherPath] };
  assert.equal(findFixTouchEntry(windowsCache, "c:/REPO", "SRC/File.ts", "win32"), newer);
  assert.equal(findFixTouchEntry(undefined, "c:/REPO", "SRC/File.ts", "win32"), undefined);

  assert.equal(findFixTouchEntry(cache, "/repo/", "src/file.ts", "linux"), entry);
  assert.equal(findFixTouchEntry(cache, "/Repo", "src/file.ts", "linux"), undefined);
  assert.equal(findFixTouchEntry(cache, "/repo", "src/File.ts", "linux"), undefined);
});

test("root aliases and field bounds preserve meaningful characters", (t) => {
  fixture(t);
  assert.equal(rootKey("C:", "win32"), rootKey("C:/", "win32"));
  assert.equal(rootKey("C:", "win32"), rootKey("c:\\", "win32"));
  assert.equal(rootKey("/repo/", "linux"), rootKey("/repo", "linux"));
  assert.equal(rootKey("/", "linux"), "/");
  assert.equal(boundCodePoints("a🪨z", 2), "a🪨");
  assert.equal(sanitizeField("a\u202e🪨z", 2), "a🪨");
});
