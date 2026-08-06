import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  atomicWriteBytesIfUnchanged,
  inspectFileTransaction,
  pruneSupersededTransactions,
  recoverFileTransaction,
} from "../setup/file-transaction.js";
import type { BytesReadResult } from "../setup/file-transaction.js";
import { directorySyncCapability } from "../setup/directory-sync.js";

function temporaryDirectory(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "rocky-file-transaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function snapshotBytes(path: string): BytesReadResult {
  try {
    return { status: "valid", bytes: readFileSync(path), mode: statSync(path).mode & 0o777 };
  } catch {
    return { status: "missing" };
  }
}

function assertRequestedFileMode(path: string, posixMode: number): void {
  const metadata = lstatSync(path);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  if (process.platform === "win32") {
    assert.equal((metadata.mode & 0o222) === 0, (posixMode & 0o222) === 0);
  } else {
    assert.equal(metadata.mode & 0o777, posixMode);
  }
}

function transactionDirectories(directory: string, path: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.startsWith(`.${basename(path)}.transaction-`));
}

/**
 * Builds an interrupted transaction exactly as the pre-extraction v1 engine
 * wrote it: a sibling `.<basename>.transaction-<pid>-<8-byte-hex>` directory
 * holding `manifest.json` as `${JSON.stringify({ version: 1, state, target })}\n`.
 */
function writeLegacyV1TransactionFixture(
  directory: string,
  path: string,
  state: "prepared" | "displaced" | "published" | "committed",
  artifacts: { displaced?: Buffer; prepared?: Buffer },
): string {
  const transactionDirectory = join(
    directory,
    `.${basename(path)}.transaction-4242-0123456789abcdef`,
  );
  mkdirSync(transactionDirectory, { mode: 0o700 });
  writeFileSync(
    join(transactionDirectory, "manifest.json"),
    `${JSON.stringify({ version: 1, state, target: path })}\n`,
    "utf8",
  );
  if (artifacts.displaced !== undefined) {
    writeFileSync(join(transactionDirectory, "displaced"), artifacts.displaced);
  }
  if (artifacts.prepared !== undefined) {
    writeFileSync(join(transactionDirectory, "prepared"), artifacts.prepared);
  }
  return transactionDirectory;
}

test("conditional byte write installs exact bytes and preserves the existing mode", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "settings.bin");
  const original = Buffer.from("original fake-secret-original\r\n", "utf8");
  writeFileSync(path, original, { mode: 0o640 });
  chmodSync(path, 0o640);
  const prior = snapshotBytes(path);
  const replacement = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0d, 0x0a, 0x00, 0x7a]);

  const result = atomicWriteBytesIfUnchanged(path, replacement, prior);

  assert.equal(result.status, "written");
  assert.deepEqual(readFileSync(path), replacement);
  assertRequestedFileMode(path, 0o640);
  assert.ok(result.recoveryPath !== undefined);
  assert.deepEqual(readFileSync(result.recoveryPath), original);
  assert.equal(inspectFileTransaction(path).status, "clear");
});

test("conditional byte write creates a missing target privately", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "created.bin");
  const bytes = Buffer.from("managed bytes\n", "utf8");

  const result = atomicWriteBytesIfUnchanged(path, bytes, { status: "missing" });

  assert.equal(result.status, "written");
  assert.deepEqual(readFileSync(path), bytes);
  assertRequestedFileMode(path, 0o600);
  assert.deepEqual(readdirSync(directory), [basename(path)]);
});

test("stale snapshot refuses to overwrite and retains the displaced bytes", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "stale.bin");
  writeFileSync(path, "original fake-secret-original\n", "utf8");
  const prior = snapshotBytes(path);
  const late = Buffer.from("late writer fake-secret-late\n", "utf8");
  writeFileSync(path, late);

  const result = atomicWriteBytesIfUnchanged(path, Buffer.from("stale merge\n", "utf8"), prior);

  assert.equal(result.status, "changed");
  assert.deepEqual(readFileSync(path), late);
  assert.ok(result.recoveryPath !== undefined);
  assert.deepEqual(readFileSync(result.recoveryPath), late);
  assert.equal(inspectFileTransaction(path).status, "clear");
});

test("a target that appears after a missing snapshot is preserved", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "raced.bin");
  const prior: BytesReadResult = { status: "missing" };
  const racer = Buffer.from("concurrent fake-secret-racer\n", "utf8");
  writeFileSync(path, racer);

  const result = atomicWriteBytesIfUnchanged(path, Buffer.from("ours\n", "utf8"), prior);

  assert.equal(result.status, "changed");
  assert.deepEqual(readFileSync(path), racer);
  assert.equal(inspectFileTransaction(path).status, "clear");
  assert.deepEqual(readdirSync(directory), [basename(path)]);
});

test("a changed mutation guard refuses before touching the target", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "guarded.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);

  const result = atomicWriteBytesIfUnchanged(path, Buffer.from("new\n", "utf8"), prior, {
    unchanged: () => false,
  });

  assert.equal(result.status, "recovery-required");
  assert.equal(result.recoveryPath, undefined);
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(readdirSync(directory), [basename(path)]);
});

test("inspection reports a pending transaction without mutating anything", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "watched.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original);
  assert.deepEqual(inspectFileTransaction(path), { status: "clear" });

  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {});

  const inspection = inspectFileTransaction(path);
  assert.equal(inspection.status, "pending");
  assert.equal(inspection.recoveryPath, transactionDirectory);
  assert.deepEqual(readFileSync(path), original);
});

test("recovery restores displaced bytes from a byte-for-byte v1 transaction fixture", (t) => {
  const directory = temporaryDirectory(t);
  // The old engine's Claude Desktop target name is used deliberately: this
  // fixture proves interrupted pre-extraction transactions remain recoverable.
  const path = join(directory, "claude_desktop_config.json");
  const original = Buffer.from('{\n  "mcpServers": {}\n}\n', "utf8");
  // Simulates a process that died after displacing the target but before the
  // displaced manifest state landed: manifest still says "prepared", the
  // displaced artifact holds the user's bytes, and the target is gone.
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {
    displaced: original,
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.deepEqual(readFileSync(path), original);
  assert.equal(recovery.recoveryPath, join(transactionDirectory, "displaced"));
  assert.deepEqual(readFileSync(join(transactionDirectory, "displaced")), original);
  assert.equal(inspectFileTransaction(path).status, "clear");
  assert.equal(
    readFileSync(join(transactionDirectory, "manifest.json"), "utf8"),
    `${JSON.stringify({ version: 1, state: "committed", target: path })}\n`,
  );
});

test("recovery removes a prepared transaction that never displaced the target", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "prepared.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original);
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {
    prepared: Buffer.from("never published\n", "utf8"),
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.deepEqual(readFileSync(path), original);
  assert.equal(existsSync(transactionDirectory), false);
  assert.equal(inspectFileTransaction(path).status, "clear");
});

test("recovery completes a displaced transaction whose publish never happened", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "displaced.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "displaced", {
    displaced: original,
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.deepEqual(readFileSync(path), original);
  assert.equal(recovery.recoveryPath, join(transactionDirectory, "displaced"));
  assert.equal(inspectFileTransaction(path).status, "clear");
});

test("recovery reports a published transaction as manual and skips committed ones", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "states.bin");
  const original = Buffer.from("original\n", "utf8");
  const publishedBytes = Buffer.from("published\n", "utf8");
  const publishedDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    displaced: original,
  });
  writeFileSync(path, publishedBytes);

  const manual = recoverFileTransaction(path);
  assert.equal(manual.status, "manual");
  assert.equal(manual.recoveryPath, publishedDirectory);
  assert.deepEqual(readFileSync(path), publishedBytes);

  rmSync(publishedDirectory, { recursive: true, force: true });
  writeLegacyV1TransactionFixture(directory, path, "committed", { displaced: original });
  assert.deepEqual(inspectFileTransaction(path), { status: "clear" });
  assert.deepEqual(recoverFileTransaction(path), { status: "clear" });
});

test("an unreadable manifest is pending for inspection and manual for recovery", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "corrupt.bin");
  writeFileSync(path, "original\n", "utf8");
  const transactionDirectory = join(
    directory,
    `.${basename(path)}.transaction-7-deadbeefcafebabe`,
  );
  mkdirSync(transactionDirectory, { mode: 0o700 });
  writeFileSync(join(transactionDirectory, "manifest.json"), "not json\n", "utf8");

  assert.equal(inspectFileTransaction(path).status, "pending");
  const recovery = recoverFileTransaction(path);
  assert.equal(recovery.status, "manual");
  assert.equal(recovery.recoveryPath, transactionDirectory);
});

test("a failed prepared write throws and retains no transaction artifacts", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "write-fault.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);

  const originalWriteFile = fs.writeFileSync;
  const callOriginal = originalWriteFile as (
    file: fs.PathOrFileDescriptor,
    data: unknown,
    options?: fs.WriteFileOptions,
  ) => void;
  let injected = false;
  fs.writeFileSync = ((
    file: fs.PathOrFileDescriptor,
    data: unknown,
    options?: fs.WriteFileOptions,
  ) => {
    if (!injected && typeof file === "number") {
      injected = true;
      throw new Error("injected prepared-write failure carrying fake-secret-original");
    }
    return callOriginal(file, data, options);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.writeFileSync = originalWriteFile;
    syncBuiltinESMExports();
  });

  assert.throws(
    () => atomicWriteBytesIfUnchanged(path, Buffer.from("replacement\n", "utf8"), prior),
    (error: unknown) => error instanceof Error
      && /unable to write file/i.test(error.message)
      && !/fake-secret-original/.test(error.message),
  );
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(readdirSync(directory), [basename(path)]);
});

test("a failed displacement rename throws and leaves the target untouched", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "rename-fault.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);

  const originalRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === path) {
      throw new Error("injected displacement failure carrying fake-secret-original");
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  });

  assert.throws(
    () => atomicWriteBytesIfUnchanged(path, Buffer.from("replacement\n", "utf8"), prior),
    (error: unknown) => error instanceof Error
      && /unable to write file/i.test(error.message)
      && !/fake-secret-original/.test(error.message),
  );
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(readdirSync(directory), [basename(path)]);
});

test("a parent fsync failure after publish reports recovery-required with intact bytes", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "durability-fault.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);
  const replacement = Buffer.from("replacement fake-secret-replacement\n", "utf8");

  const originalLink = fs.linkSync;
  const originalDirectorySync = directorySyncCapability.sync;
  let published = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    originalLink(existingPath, newPath);
    if (String(newPath) === path) published = true;
  }) as typeof fs.linkSync;
  directorySyncCapability.sync = (directoryPath) => {
    if (published && directoryPath === dirname(path)) {
      throw new Error("injected fsync failure carrying fake-secret-original");
    }
    return true;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.linkSync = originalLink;
    directorySyncCapability.sync = originalDirectorySync;
    syncBuiltinESMExports();
  });

  const result = atomicWriteBytesIfUnchanged(path, replacement, prior);

  assert.equal(result.status, "recovery-required");
  assert.ok(result.recoveryPath !== undefined);
  assert.deepEqual(readFileSync(path), replacement);
  assert.deepEqual(readFileSync(result.recoveryPath), original);
  assert.equal(inspectFileTransaction(path).status, "pending");

  // The publish itself already completed (nlink 2, proven pairing with the
  // transaction's `prepared` artifact) — a later recovery must finish
  // committing it, not report `manual` forever (whole-branch review, Important 1).
  assert.equal(lstatSync(path).nlink, 2);
  const recovery = recoverFileTransaction(path);
  assert.equal(recovery.status, "recovered");
  assert.deepEqual(readFileSync(path), replacement, "already-published bytes stay live");
  assert.equal(lstatSync(path).nlink, 1, "the redundant prepared link is discarded");
  assert.equal(inspectFileTransaction(path).status, "clear");
  assert.deepEqual(recoverFileTransaction(path), { status: "clear" }, "idempotent on a second run");
});

test("non-regular, symlink, and multi-link targets are refused without mutation", (t) => {
  const directory = temporaryDirectory(t);

  const directoryTarget = join(directory, "directory-target");
  mkdirSync(directoryTarget);
  assert.throws(
    () => atomicWriteBytesIfUnchanged(
      directoryTarget,
      Buffer.from("replacement\n", "utf8"),
      { status: "valid", bytes: Buffer.from("claimed\n", "utf8"), mode: 0o644 },
    ),
    /unable to write file/i,
  );
  assert.equal(statSync(directoryTarget).isDirectory(), true);
  assert.deepEqual(transactionDirectories(directory, directoryTarget), []);

  const realTarget = join(directory, "real-target");
  const realBytes = Buffer.from("real fake-secret-real\n", "utf8");
  writeFileSync(realTarget, realBytes);
  const linkTarget = join(directory, "link-target");
  let symlinkAvailable = true;
  try {
    symlinkSync(realTarget, linkTarget);
  } catch {
    symlinkAvailable = false; // Some platforms require privilege for symlinks.
  }
  if (symlinkAvailable) {
    assert.throws(
      () => atomicWriteBytesIfUnchanged(
        linkTarget,
        Buffer.from("replacement\n", "utf8"),
        snapshotBytes(linkTarget),
      ),
      /unable to write file/i,
    );
    assert.equal(lstatSync(linkTarget).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(realTarget), realBytes);
    assert.deepEqual(transactionDirectories(directory, linkTarget), []);
  }

  const multiTarget = join(directory, "multi-target");
  const multiBytes = Buffer.from("multi fake-secret-multi\n", "utf8");
  writeFileSync(multiTarget, multiBytes);
  linkSync(multiTarget, join(directory, "multi-target-alias"));
  assert.throws(
    () => atomicWriteBytesIfUnchanged(
      multiTarget,
      Buffer.from("replacement\n", "utf8"),
      snapshotBytes(multiTarget),
    ),
    /unable to write file/i,
  );
  assert.deepEqual(readFileSync(multiTarget), multiBytes);
  assert.deepEqual(transactionDirectories(directory, multiTarget), []);
});

test("a concurrent mode change between snapshot and publish refuses to overwrite", (t) => {
  if (process.platform === "win32") return; // POSIX mode bits only.
  const directory = temporaryDirectory(t);
  const path = join(directory, "modechange.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original, { mode: 0o644 });
  chmodSync(path, 0o644);
  const prior = snapshotBytes(path); // bytes AND mode 0o644 captured here

  chmodSync(path, 0o600); // bytes unchanged, mode changes concurrently

  const result = atomicWriteBytesIfUnchanged(path, Buffer.from("new\n", "utf8"), prior);

  // Bytes alone would match: the mode conjunct is what must trigger the
  // refusal here. Without it, Rocky would silently overwrite past a user's
  // concurrent chmod.
  assert.equal(result.status, "changed");
  assert.deepEqual(readFileSync(path), original);
  assertRequestedFileMode(path, 0o600);
  assert.equal(inspectFileTransaction(path).status, "clear");
});

/**
 * Fails the Nth manifest write (by counting `openSync(..., "wx")` calls whose
 * path ends in `manifest.tmp`) exactly once, then behaves normally. Manifests
 * are written in order prepared -> displaced -> published, so N=3 fails the
 * "published" manifest specifically, deterministically reproducing the
 * reviewer's SIGKILL window: the destination is already hard-linked to the
 * transaction's `prepared` artifact (nlink 2) and `displaced` already holds
 * the pre-write bytes, but the manifest never advances past "displaced".
 */
function injectFailureBeforeNthManifestWrite(t: test.TestContext, n: number): void {
  const originalOpen = fs.openSync;
  let manifestWrites = 0;
  let fired = false;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const [target, flags] = args;
    if (!fired && typeof target === "string" && target.endsWith("manifest.tmp") && flags === "wx") {
      manifestWrites += 1;
      if (manifestWrites === n) {
        fired = true;
        throw new Error("injected crash before a manifest write carrying fake-secret-original");
      }
    }
    return originalOpen(...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  });
}

test("recovery finishes a transaction whose publish completed before the manifest recorded it", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "crash-window.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);
  const replacement = Buffer.from("replacement fake-secret-replacement\n", "utf8");

  injectFailureBeforeNthManifestWrite(t, 3); // fail exactly the "published" manifest write

  const result = atomicWriteBytesIfUnchanged(path, replacement, prior);
  assert.equal(result.status, "recovery-required");

  // Reproduces the review's SIGKILL window exactly: the target is already a
  // hard link of the transaction's `prepared` artifact (nlink 2), the
  // pre-write bytes are intact in `displaced`, and the manifest still says
  // "displaced" because the crash landed before "published" was recorded.
  const [transactionName] = transactionDirectories(directory, path);
  assert.ok(transactionName !== undefined, "a transaction directory survives the crash");
  const transactionDirectory = join(directory, transactionName);
  const manifestPath = join(transactionDirectory, "manifest.json");
  assert.equal(
    readFileSync(manifestPath, "utf8"),
    `${JSON.stringify({ version: 1, state: "displaced", target: path })}\n`,
  );
  assert.equal(lstatSync(path).nlink, 2);
  assert.deepEqual(readFileSync(path), replacement, "the write already published");
  assert.deepEqual(readFileSync(join(transactionDirectory, "displaced")), original);
  assert.equal(inspectFileTransaction(path).status, "pending");

  // A fresh process picking this up (a later `recoverFileTransaction` call,
  // exactly like a new `rocky hook install` after the crash) must finish the
  // transaction it already completed, not report "manual" forever.
  const recovery = recoverFileTransaction(path);
  assert.equal(recovery.status, "recovered");
  assert.deepEqual(readFileSync(path), replacement, "already-published bytes stay live");
  assert.equal(lstatSync(path).nlink, 1, "the redundant prepared link is discarded");
  assert.equal(inspectFileTransaction(path).status, "clear");
  assert.equal(
    readFileSync(manifestPath, "utf8"),
    `${JSON.stringify({ version: 1, state: "committed", target: path })}\n`,
  );

  // Idempotent and safe on a second run.
  assert.deepEqual(recoverFileTransaction(path), { status: "clear" });
});

test("recovery cannot be tricked by an unrelated file merely sharing displaced's identity shape", (t) => {
  // Negative control for the new evidence-based branch: a "prepared" manifest
  // with an existing `displaced` artifact that is NOT actually paired with
  // `path` (no shared inode with `prepared`) must stay manual, not be
  // silently resolved.
  const directory = temporaryDirectory(t);
  const path = join(directory, "ambiguous.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original);
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {
    displaced: Buffer.from("unrelated bytes\n", "utf8"),
    prepared: Buffer.from("never linked to path\n", "utf8"),
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "manual");
  assert.equal(recovery.recoveryPath, transactionDirectory);
  assert.deepEqual(readFileSync(path), original, "bytes untouched while ambiguous");
});

function writeNamedTransactionFixture(
  directory: string,
  path: string,
  suffix: string,
  state: "prepared" | "displaced" | "published" | "committed",
  displaced?: Buffer,
): string {
  const transactionDirectory = join(directory, `.${basename(path)}.transaction-${suffix}`);
  mkdirSync(transactionDirectory, { mode: 0o700 });
  writeFileSync(
    join(transactionDirectory, "manifest.json"),
    `${JSON.stringify({ version: 1, state, target: path })}\n`,
    "utf8",
  );
  if (displaced !== undefined) writeFileSync(join(transactionDirectory, "displaced"), displaced);
  return transactionDirectory;
}

test("pruneSupersededTransactions removes only committed siblings other than the kept one", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "pruned.bin");
  writeFileSync(path, "current\n", "utf8");

  const oldCommitted = writeNamedTransactionFixture(
    directory, path, "1-old", "committed", Buffer.from("old\n", "utf8"),
  );
  const pending = writeNamedTransactionFixture(
    directory, path, "2-pending", "displaced", Buffer.from("mid\n", "utf8"),
  );
  const keep = writeNamedTransactionFixture(
    directory, path, "3-keep", "committed", Buffer.from("kept\n", "utf8"),
  );

  pruneSupersededTransactions(path, keep);

  assert.equal(existsSync(oldCommitted), false, "superseded committed directory is pruned");
  assert.equal(existsSync(pending), true, "a non-committed directory is never touched by pruning");
  assert.equal(existsSync(keep), true, "the kept directory survives");
  assert.deepEqual(readFileSync(path, "utf8"), "current\n", "pruning never touches the target");
});

test("pruneSupersededTransactions protects the kept directory by filesystem identity, not string equality", (t) => {
  // Reviewer's P3-7: a differently-spelled-but-identical `keep` path (a
  // trailing slash) must still protect that directory. A raw string compare
  // would fail to recognize it and delete the copy that was just created.
  const directory = temporaryDirectory(t);
  const path = join(directory, "structural-keep.bin");
  writeFileSync(path, "current\n", "utf8");

  const keep = writeNamedTransactionFixture(
    directory, path, "1-keep", "committed", Buffer.from("kept\n", "utf8"),
  );
  const other = writeNamedTransactionFixture(
    directory, path, "2-other", "committed", Buffer.from("old\n", "utf8"),
  );

  pruneSupersededTransactions(path, `${keep}/`);

  assert.equal(existsSync(keep), true, "the kept directory survives a non-canonical spelling of its own path");
  assert.equal(existsSync(other), false, "the other committed sibling is still pruned");
});

// --- Important 2: the recovery boundary must be complete, not arbitrary ----

/**
 * Fails the single-argument `rmSync(temporaryPath)` unlink of the
 * transaction's own `prepared` artifact — the step immediately after the
 * "published" manifest write lands, and the last step before the manifest
 * advances to "committed". Matched narrowly (no options object, basename
 * "prepared") so it cannot fire on `discardPrepared`'s `{ force: true }`
 * calls, `removeTransaction`'s `{ recursive: true }` call, or the
 * `link-probe` cleanup.
 */
function injectFailureOnPreparedUnlink(t: test.TestContext): void {
  const originalRm = fs.rmSync;
  let fired = false;
  fs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
    const [target, options] = args;
    if (!fired && typeof target === "string" && options === undefined && basename(target) === "prepared") {
      fired = true;
      throw new Error("injected unlink failure after publish carrying fake-secret-original");
    }
    return originalRm(...args);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  });
}

test("recovery finishes a transaction whose manifest already recorded the publish (Important 2, W2)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "published-window.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);
  const replacement = Buffer.from("replacement fake-secret-replacement\n", "utf8");

  injectFailureOnPreparedUnlink(t);

  const result = atomicWriteBytesIfUnchanged(path, replacement, prior);
  assert.equal(result.status, "recovery-required");

  const [transactionName] = transactionDirectories(directory, path);
  assert.ok(transactionName !== undefined, "a transaction directory survives the crash");
  const transactionDirectory = join(directory, transactionName);
  const manifestPath = join(transactionDirectory, "manifest.json");
  // The manifest DID advance to "published" here — strictly more evidence
  // than the "displaced" window round 1 already resolved, per the reviewer.
  assert.equal(
    readFileSync(manifestPath, "utf8"),
    `${JSON.stringify({ version: 1, state: "published", target: path })}\n`,
  );
  assert.equal(lstatSync(path).nlink, 2, "path is still hard-linked to the undiscarded prepared artifact");
  assert.deepEqual(readFileSync(path), replacement, "the write already published");
  assert.deepEqual(readFileSync(join(transactionDirectory, "displaced")), original);
  assert.equal(inspectFileTransaction(path).status, "pending");

  const recovery = recoverFileTransaction(path);
  assert.equal(
    recovery.status,
    "recovered",
    "W2: a 'published' manifest with intact displaced and a proven prepared pairing must finish, not stay manual forever",
  );
  assert.deepEqual(readFileSync(path), replacement, "already-published bytes stay live");
  assert.equal(lstatSync(path).nlink, 1, "the redundant prepared link is discarded");
  assert.equal(inspectFileTransaction(path).status, "clear");
  assert.equal(
    readFileSync(manifestPath, "utf8"),
    `${JSON.stringify({ version: 1, state: "committed", target: path })}\n`,
  );
  assert.deepEqual(recoverFileTransaction(path), { status: "clear" }, "idempotent on a second run");
});

/**
 * Fails `removeTransaction`'s `rmSync(transactionDirectory, { recursive:
 * true })` exactly once, matched by the `recursive` option so it cannot fire
 * on any other `rmSync` call in the module.
 */
function injectFailureOnTransactionRemoval(t: test.TestContext): void {
  const originalRm = fs.rmSync;
  let fired = false;
  fs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
    const [target, options] = args;
    const recursive = typeof options === "object" && options !== null
      && (options as { recursive?: boolean }).recursive === true;
    if (!fired && typeof target === "string" && recursive) {
      fired = true;
      throw new Error("injected transaction directory removal failure carrying fake-secret-original");
    }
    return originalRm(...args);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  });
}

test("recovery finishes a missing-prior transaction whose manifest already recorded the publish (Important 2, W4)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "missing-prior-published.bin");
  const prior: BytesReadResult = { status: "missing" };
  const bytes = Buffer.from("brand new file fake-secret-new\n", "utf8");

  injectFailureOnTransactionRemoval(t);

  const result = atomicWriteBytesIfUnchanged(path, bytes, prior);
  assert.equal(result.status, "recovery-required");

  const [transactionName] = transactionDirectories(directory, path);
  assert.ok(transactionName !== undefined, "a transaction directory survives the crash");
  const transactionDirectory = join(directory, transactionName);
  assert.equal(
    readFileSync(join(transactionDirectory, "manifest.json"), "utf8"),
    `${JSON.stringify({ version: 1, state: "published", target: path })}\n`,
  );
  assert.equal(existsSync(join(transactionDirectory, "displaced")), false, "no prior file ever existed to displace");
  assert.equal(lstatSync(path).nlink, 2);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(inspectFileTransaction(path).status, "pending");

  const recovery = recoverFileTransaction(path);
  assert.equal(
    recovery.status,
    "recovered",
    "W4: a 'published' manifest with nothing to protect (no prior file) must finish, not stay manual forever",
  );
  assert.deepEqual(readFileSync(path), bytes, "already-published bytes stay live");
  assert.equal(lstatSync(path).nlink, 1, "the redundant prepared link is discarded");
  assert.equal(inspectFileTransaction(path).status, "clear");
  assert.deepEqual(recoverFileTransaction(path), { status: "clear" }, "idempotent on a second run");
});

test("recovery discards an orphaned published transaction directory without touching an unrelated target (W4 negative control)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "orphaned.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original); // path exists independently of any transaction artifact
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    prepared: Buffer.from("unrelated staged bytes, never linked to path\n", "utf8"),
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.equal(existsSync(transactionDirectory), false, "orphaned transaction directory discarded");
  assert.deepEqual(readFileSync(path), original, "unrelated target bytes are never touched");
});

test("the complete-but-unrecorded branch refuses when displaced is not a plain regular file (M3)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "displaced-symlink.bin");
  const elsewhere = join(directory, "elsewhere.bin");
  writeFileSync(elsewhere, Buffer.from("not the real backup\n", "utf8"));

  // Build the exact "path === transaction's own prepared artifact" pairing
  // the branch requires (nlink 2, shared inode), but make `displaced` a
  // symlink instead of the plain regular file `isManagedRegularFile` demands.
  const transactionDirectory = join(directory, `.${basename(path)}.transaction-9-cafef00dfeed`);
  mkdirSync(transactionDirectory, { mode: 0o700 });
  writeFileSync(path, "publishable bytes\n", "utf8");
  linkSync(path, join(transactionDirectory, "prepared"));
  let symlinkAvailable = true;
  try {
    symlinkSync(elsewhere, join(transactionDirectory, "displaced"));
  } catch {
    symlinkAvailable = false; // Some platforms require privilege for symlinks.
  }
  if (!symlinkAvailable) return;
  writeFileSync(
    join(transactionDirectory, "manifest.json"),
    `${JSON.stringify({ version: 1, state: "published", target: path })}\n`,
    "utf8",
  );

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "manual", "a symlinked displaced is not a proven backup; must not commit (M3)");
  assert.equal(lstatSync(path).nlink, 2, "nothing was mutated");
});

test("recovery never offers the target path itself as a manual recovery path, even when directory removal partially fails (Important 1)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "degraded-recovery.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {
    prepared: Buffer.from("never published\n", "utf8"),
  });

  // The reviewer's exact mechanism: rmSync of the transaction directory
  // succeeds, but the follow-up parent-directory fsync throws (a real EIO on
  // $HOME), so `removeTransaction` reports failure even though the directory
  // is already gone.
  const originalSync = directorySyncCapability.sync;
  directorySyncCapability.sync = () => {
    throw new Error("injected EIO on parent directory fsync carrying fake-secret-original");
  };
  t.after(() => {
    directorySyncCapability.sync = originalSync;
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "manual");
  assert.equal(existsSync(transactionDirectory), false, "rmSync itself succeeded; only the parent fsync failed");
  assert.notEqual(recovery.recoveryPath, path, "the live target must never be offered as something to remove");
  assert.equal(recovery.recoveryPath, undefined, "nothing Rocky-owned survives to name once the directory is gone");
  assert.deepEqual(readFileSync(path), original, "the untouched target keeps its own bytes");
});

// --- Minor 4 (final audit): the unconditional-discard branch never checked `path` ---

test("recovery does not silently discard a published transaction's staged bytes when both the target and displaced are gone", (t) => {
  // published + no displaced is normally safe to discard unconditionally
  // (site 1): every provable crash window that reaches "published" leaves
  // `path` linked, so `prepared`'s bytes are never the last copy of
  // anything. That invariant breaks if `path` is ALSO gone — reachable only
  // by something external removing it after publish, since Rocky's own code
  // never unlinks `path` between the publishing linkSync and "committed".
  // Before this fix, site 1 discarded unconditionally here too, silently
  // destroying `prepared` — the only surviving evidence, derived from the
  // user's own file.
  const directory = temporaryDirectory(t);
  const path = join(directory, "vanished-target.bin");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    prepared: Buffer.from("staged bytes derived from the user's file fake-secret\n", "utf8"),
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "manual", "must not silently discard the only surviving evidence");
  assert.equal(existsSync(transactionDirectory), true, "the transaction directory survives");
  assert.equal(
    existsSync(join(transactionDirectory, "prepared")),
    true,
    "prepared bytes, the last surviving copy, are not deleted",
  );
});

test("recovery still discards a published transaction with no displaced when the target is present (unaffected by the path check)", (t) => {
  // Negative control: the missing-prior crash window (W4) legitimately
  // reaches this exact shape with `path` present (just linked). The added
  // `path` proof must not regress that case.
  const directory = temporaryDirectory(t);
  const path = join(directory, "present-target.bin");
  writeFileSync(path, "brand new file\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    prepared: Buffer.from("unrelated staged bytes\n", "utf8"),
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.equal(existsSync(transactionDirectory), false, "safe to discard once path is proven present");
  assert.deepEqual(readFileSync(path), Buffer.from("brand new file\n", "utf8"));
});
