import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  atomicWriteJson,
  atomicWriteJsonIfUnchanged,
  backupFile,
  readJsonObject,
} from "../setup/json-config.js";

function temporaryDirectory(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "rocky-json-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("missing JSON config returns an empty object without creating the file", (t) => {
  const path = join(temporaryDirectory(t), "missing.json");

  assert.deepEqual(readJsonObject(path), { status: "missing", value: {} });
  assert.equal(readdirSync(dirname(path)).length, 0);
});

test("valid JSON object returns the parsed object, exact bytes, and permission mode", (t) => {
  const path = join(temporaryDirectory(t), "config.json");
  const bytes = Buffer.from('{\n  "theme": "dark"\n}\n', "utf8");
  writeFileSync(path, bytes, { mode: 0o640 });
  chmodSync(path, 0o640);

  const result = readJsonObject(path);

  assert.equal(result.status, "valid");
  if (result.status !== "valid") return;
  assert.deepEqual(result.value, { theme: "dark" });
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.mode, 0o640);
});

test("malformed JSON and non-object roots are invalid without exposing document contents", (t) => {
  const directory = temporaryDirectory(t);
  const malformed = join(directory, "malformed.json");
  const array = join(directory, "array.json");
  const scalar = join(directory, "scalar.json");
  writeFileSync(malformed, '{"token":"fake-secret-token",', "utf8");
  writeFileSync(array, '["fake-secret-array"]', "utf8");
  writeFileSync(scalar, '"fake-secret-scalar"', "utf8");

  const diagnostics = [readJsonObject(malformed), readJsonObject(array), readJsonObject(scalar)]
    .map((result) => result.status === "invalid" ? result.error : "")
    .join("\n");

  assert.match(diagnostics, /invalid|object/i);
  assert.doesNotMatch(diagnostics, /fake-secret-token|fake-secret-array|fake-secret-scalar/);
});

test("backup copies exact bytes to the specified timestamped sibling", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "settings.json");
  const bytes = Buffer.from([0x7b, 0x0d, 0x0a, 0x20, 0x20, 0x7d, 0x0a]);
  writeFileSync(path, bytes, { mode: 0o640 });
  chmodSync(path, 0o640);

  const backup = backupFile(path, new Date("2026-08-04T08:15:30.123Z"));

  assert.equal(backup, `${path}.backup-20260804T081530123Z`);
  assert.deepEqual(readFileSync(backup), bytes);
  assert.equal(statSync(backup).mode & 0o777, 0o640);
});

test("backup refuses a same-timestamp collision without changing existing bytes", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "settings.json");
  const now = new Date("2026-08-04T08:15:30.123Z");
  writeFileSync(path, '{"token":"first-secret"}\n', "utf8");
  const backup = backupFile(path, now);
  const firstBackupBytes = readFileSync(backup);
  writeFileSync(path, '{"token":"second-secret"}\n', "utf8");

  assert.throws(
    () => backupFile(path, now),
    (error: unknown) => error instanceof Error
      && /back up JSON config/i.test(error.message)
      && !/first-secret|second-secret/.test(error.message),
  );
  assert.deepEqual(readFileSync(backup), firstBackupBytes);
  assert.notDeepEqual(readFileSync(path), firstBackupBytes);
});

test("backup fsyncs a read-only source through its writable owned descriptor", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "readonly.json");
  const bytes = Buffer.from('{"token":"fake-readonly-secret"}\n', "utf8");
  writeFileSync(path, bytes, { mode: 0o400 });
  chmodSync(path, 0o400);

  const backup = backupFile(path, new Date("2026-08-04T08:15:31.123Z"));

  assert.deepEqual(readFileSync(backup), bytes);
  assert.equal(statSync(backup).mode & 0o777, 0o400);
});

test("atomic JSON replacement preserves unrelated keys and prior permissions", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "settings.json");
  writeFileSync(path, '{"theme":"dark","mcpServers":{"other":{"secret":"fake-secret"}}}\n', {
    mode: 0o640,
  });
  chmodSync(path, 0o640);
  const prior = readJsonObject(path);
  assert.equal(prior.status, "valid");
  if (prior.status !== "valid") return;

  atomicWriteJson(path, {
    ...prior.value,
    mcpServers: {
      ...(prior.value.mcpServers as Record<string, unknown>),
      rocky: { command: "/opt/node" },
    },
  }, prior);

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    theme: "dark",
    mcpServers: {
      other: { secret: "fake-secret" },
      rocky: { command: "/opt/node" },
    },
  });
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(directory), [basename(path)]);
});

test("atomic JSON writer creates private files", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "settings.json");
  atomicWriteJson(path, { theme: "dark" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("atomic JSON writer cleans its random temporary sibling after rename failure", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "settings.json");
  mkdirSync(path);

  assert.throws(
    () => atomicWriteJson(path, { token: "fake-secret-token" }),
    (error: unknown) => error instanceof Error
      && /write JSON config/i.test(error.message)
      && !/fake-secret-token/.test(error.message),
  );
  assert.deepEqual(readdirSync(directory), [basename(path)]);
  assert.equal(statSync(path).isDirectory(), true);
});

test("atomic JSON writer reports published bytes when parent fsync fails after rename", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "settings.json");
  writeFileSync(path, '{"before":true}\n', "utf8");
  const originalRename = fs.renameSync;
  const originalFsync = fs.fsyncSync;
  let published = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    originalRename(from, to);
    if (String(to) === path) published = true;
  }) as typeof fs.renameSync;
  fs.fsyncSync = ((descriptor: number) => {
    if (published) throw new Error("fake parent fsync secret");
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = originalRename;
    fs.fsyncSync = originalFsync;
    syncBuiltinESMExports();
  });

  assert.throws(
    () => atomicWriteJson(path, { after: true }),
    (error: unknown) => {
      const candidate = error as Error & { committed?: boolean };
      return error instanceof Error
        && candidate.committed === true
        && /durability/i.test(candidate.message)
        && !/fake parent fsync secret/.test(candidate.message);
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { after: true });
});

test("conditional JSON results only report recovery artifacts that still exist", (t) => {
  const directory = temporaryDirectory(t);
  const successfulPath = join(directory, "successful.json");
  const createdPath = join(directory, "created.json");
  const racedPath = join(directory, "raced.json");
  writeFileSync(successfulPath, '{"before":true}\n', "utf8");
  writeFileSync(racedPath, '{"before":true}\n', "utf8");

  const successfulPrior = readJsonObject(successfulPath);
  const createdPrior = readJsonObject(createdPath);
  const racedPrior = readJsonObject(racedPath);
  assert.equal(successfulPrior.status, "valid");
  assert.equal(createdPrior.status, "missing");
  assert.equal(racedPrior.status, "valid");

  const observations = [
    {
      scenario: "successful replacement",
      result: atomicWriteJsonIfUnchanged(successfulPath, { after: true }, successfulPrior),
    },
    {
      scenario: "successful creation",
      result: atomicWriteJsonIfUnchanged(createdPath, { after: true }, createdPrior),
    },
  ];

  const originalLink = fs.linkSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (basename(existingPath.toString()) === "prepared" && newPath.toString() === racedPath) {
      rmSync(join(dirname(existingPath.toString()), "displaced"));
      writeFileSync(racedPath, '{"concurrent":true}\n', "utf8");
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  });

  observations.push({
    scenario: "publication conflict after displaced recovery disappears",
    result: atomicWriteJsonIfUnchanged(racedPath, { after: true }, racedPrior),
  });

  for (const { scenario, result } of observations) {
    if (result.recoveryPath === undefined) continue;
    assert.doesNotThrow(
      () => lstatSync(result.recoveryPath!),
      `${scenario} reported a missing recovery artifact`,
    );
  }
});
