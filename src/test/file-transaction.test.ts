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
import { skipIfSymlinkUnavailable } from "./symlink-capability.js";

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

test("recovery resolves a prepared transaction that never displaced the target, without rm -r'ing the directory", (t) => {
  // Round 8, I1: resolving this shape used to `rmSync(dir, { recursive: true
  // })` the whole transaction directory in one step whose own outcome record
  // nothing ever read. It now takes the same narrow, already-audited action
  // the sibling "recovered" branches below take — discard just the staged
  // `prepared` artifact and advance the manifest to "committed" — leaving an
  // inert directory `pruneSupersededTransactions` reclaims on the next real
  // write. The guarantee this test name promises (the stale transaction no
  // longer blocks anything, and the live target is never touched) still
  // holds; only the "whole directory vanishes here" implementation detail
  // does not.
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
  assert.equal(existsSync(join(transactionDirectory, "prepared")), false, "the staged artifact is discarded");
  assert.equal(
    JSON.parse(readFileSync(join(transactionDirectory, "manifest.json"), "utf8")).state,
    "committed",
    "the directory is marked resolved, not silently removed",
  );
  assert.equal(inspectFileTransaction(path).status, "clear");
  assert.deepEqual(recoverFileTransaction(path), { status: "clear" }, "idempotent on a second run");
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

test("recovery commits a published transaction whose displaced backup and live target both prove safe, and skips committed ones (round 10, S1)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "states.bin");
  const original = Buffer.from("original\n", "utf8");
  const publishedBytes = Buffer.from("published\n", "utf8");
  const publishedDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    displaced: original,
  });
  writeFileSync(path, publishedBytes);

  // `displaced` is a proven, singly-owned copy and `path` is itself a live
  // regular file — the exact evidence `resolveUndisplacedTransaction`
  // already accepts, plus a proven `displaced` on top. Committing here
  // destroys nothing (`displaced` is retained either way); before round 10,
  // S1, this exact shape returned "manual" unconditionally, forever, with
  // no re-examination of the evidence — reported before this fix as "a
  // published transaction as manual" (this test's own former name).
  const recovered = recoverFileTransaction(path);
  assert.equal(recovered.status, "recovered");
  assert.deepEqual(readFileSync(path), publishedBytes, "the live target is never touched by this recovery");
  assert.deepEqual(readFileSync(join(publishedDirectory, "displaced")), original, "the retained copy survives untouched");
  assert.equal(
    JSON.parse(readFileSync(join(publishedDirectory, "manifest.json"), "utf8")).state,
    "committed",
  );
  assert.deepEqual(recoverFileTransaction(path), { status: "clear" }, "idempotent on a second run");

  rmSync(publishedDirectory, { recursive: true, force: true });
  writeLegacyV1TransactionFixture(directory, path, "committed", { displaced: original });
  assert.deepEqual(inspectFileTransaction(path), { status: "clear" });
  assert.deepEqual(recoverFileTransaction(path), { status: "clear" });
});

test("recovery still reports a published transaction as manual when the target is not itself a live regular file (negative control for S1)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "vanished-target-with-displaced.bin");
  const original = Buffer.from("original\n", "utf8");
  // `displaced` is present and provable, but `path` itself does not exist —
  // S1's new commit path requires both, and a target-absent shape stays
  // exactly as ambiguous as it was before this round (final audit's own
  // reasoning: a proven copy is not proof that discarding is not throwing
  // away the last surviving evidence of the target ever having existed at
  // all, when nothing currently occupies that name to compare against).
  const publishedDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    displaced: original,
  });

  const manual = recoverFileTransaction(path);
  assert.equal(manual.status, "manual");
  assert.equal(manual.recoveryPath, publishedDirectory);
  assert.equal(existsSync(join(publishedDirectory, "displaced")), true, "the only surviving copy is retained");
});

// --- Round 11, T1: round 10 wrote the published-commit branch above but
// wrote zero mutants against it. These five pin the nine survivors the
// final audit found (branch-final-audit-commit-path.md); E1 is a genuine
// equivalent (isManagedRegularFile implies pathExists on its whole domain)
// and E11 is a genuine equivalent re-derived in the round 11 report
// (targetExists from a "recovered" outcome is provably never read by any
// consumer — hook.ts's mergeOutcome always overwrites it with the next
// iteration's own value before a message can ever see it).

test("the published-commit branch's own final write still honors a guard change (round 11, T1/E7)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "commit-guard-published.bin");
  writeFileSync(path, "live\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    displaced: Buffer.from("original\n", "utf8"),
  });

  // Nothing above this branch's own commit calls the guard at all (unlike
  // `resolveUndisplacedTransaction`'s C10 test, where two of this
  // function's own checks precede its commit) — this branch's proof is
  // purely topological, so the very first `unchanged()` call happens inside
  // this call's own `writeManifest`. A guard reporting change on that first
  // call must still abort the commit — exactly the property C10 pins at the
  // sibling site, which this branch duplicated without duplicating the test.
  const guard = { unchanged: () => false };

  const recovery = recoverFileTransaction(path, guard);

  assert.equal(recovery.status, "manual", "a guard change reported during the commit's own write must abort it (E7)");
  assert.equal(
    JSON.parse(readFileSync(join(transactionDirectory, "manifest.json"), "utf8")).state,
    "published",
    "the manifest must not advance to committed once the guard reports change",
  );
});

test("the published-commit branch stays manual, not silently recovered, when its own manifest write fails (round 11, T1/E9)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "commit-fault-published.bin");
  writeFileSync(path, "live\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    displaced: Buffer.from("original\n", "utf8"),
  });

  // This fixture bypasses `writeManifest` entirely, so the commit this
  // branch attempts is the only "manifest.tmp" open the whole test
  // performs — failing the first one deterministically fails exactly this
  // call's own commit, with no guard, no crash, no concurrency involved.
  injectFailureBeforeNthManifestWrite(t, 1);

  const recovery = recoverFileTransaction(path);

  assert.equal(
    recovery.status,
    "manual",
    "a failed commit write must never be reported as recovered — nothing on disk actually advanced (E9)",
  );
  assert.equal(
    JSON.parse(readFileSync(join(transactionDirectory, "manifest.json"), "utf8")).state,
    "published",
    "the manifest stays published; a fail-open here would leave settleBashrcTransactions spinning forever on this same directory (E9, consequence class: E6)",
  );
});

test("the published-commit branch's own recovered outcome proves the retained copy before the commit and never claims an unfinished write (round 11, T1/E10,E8)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "commit-outcome-published.bin");
  writeFileSync(path, "live\n", "utf8");
  const original = Buffer.from("original\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    displaced: original,
  });
  const displacedPath = join(transactionDirectory, "displaced");

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.ok(recovery.outcome !== undefined);
  // E10: flipping this to `true` makes `hook.ts:259` say "bashrc gone. I
  // already put old bytes back from safe copy." over a `.bashrc` this call
  // never touched and that never went missing.
  assert.equal(
    recovery.outcome!.targetWritten,
    false,
    "this branch never writes path — settling on a manifest label alone must never claim a restore (E10)",
  );
  // E8: capturing `provenCopy` AFTER the commit re-derives the proof
  // against this transaction's own now-"committed" manifest, which counts
  // the directory against itself and reports the one surviving copy as
  // unproven — the exact self-reference trap the branch's own comment
  // names.
  assert.equal(
    recovery.outcome!.provenCopy,
    displacedPath,
    "the retained copy must stay disclosed after the commit, not swallowed by the self-reference trap (E8)",
  );
});

test("recovery still reports a published transaction as manual when the target is a dangling symlink (round 11, T1/E4)", (t) => {
  if (skipIfSymlinkUnavailable(t)) return;
  const directory = temporaryDirectory(t);
  const path = join(directory, "dangling-target-published.bin");
  const original = Buffer.from("original\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    displaced: original,
  });
  symlinkSync(join(directory, "never-existed"), path);

  // `pathExists` and `isLiveRegularFile` disagree here: a dangling symlink
  // resolves to *something* (`lstatSync` succeeds) but is not itself a
  // regular file. S2 eliminated this exact conflation at the sibling
  // `resolveUndisplacedTransaction` site by construction (round 10); this
  // branch performs the identical check inline and can re-merge the same
  // way with no compile error to catch it.
  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "manual", "a dangling symlink target must never be treated as live (E4)");
  assert.equal(recovery.recoveryPath, transactionDirectory);
  assert.equal(lstatSync(path).isSymbolicLink(), true, "the symlink itself is untouched");
  assert.equal(existsSync(join(transactionDirectory, "displaced")), true, "the only surviving copy is retained");
});

test("the published-commit branch retains a leftover prepared artifact instead of discarding it (round 11, T1/E13)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "leftover-artifact-published.bin");
  writeFileSync(path, "live\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    displaced: Buffer.from("original\n", "utf8"),
    // An unpaired `prepared` left behind by an earlier, unrelated crash —
    // not linked to `path`, so `isManagedRecoveryPair` never routes this
    // fixture through the complete-but-unrecorded branch above it; it
    // still reaches this branch's own commit.
    prepared: Buffer.from("stray, never linked to path\n", "utf8"),
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.equal(
    existsSync(join(transactionDirectory, "prepared")),
    true,
    "this branch commits on topology alone and must not silently discard an artifact it never proved safe to discard (E13)",
  );
});

test("the published-commit branch's displaced proof accounts for a committed sibling sharing displaced's inode (round 11, T1/E5)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "sibling-link-published.bin");
  writeFileSync(path, "live\n", "utf8");

  const committedDirectory = writeNamedTransactionFixture(
    directory, path, "1-committed", "committed", Buffer.from("original\n", "utf8"),
  );
  const publishedDirectory = writeNamedTransactionFixture(directory, path, "2-published", "published");
  // A second hard link to the exact same inode as the committed sibling's
  // own `displaced` — `isManagedRegularFile`'s link accounting must count
  // that committed sibling's own copy against `path` (the transaction
  // target), not against `displaced` itself, or this genuinely safe,
  // already-accounted-for two-name shape looks like an unaccounted extra
  // link and the branch wrongly refuses to commit.
  linkSync(join(committedDirectory, "displaced"), join(publishedDirectory, "displaced"));

  const recovery = recoverFileTransaction(path);

  assert.equal(
    recovery.status,
    "recovered",
    "a displaced backup shared with a committed sibling is still a proven, singly-owned copy of path (E5)",
  );
  assert.equal(
    JSON.parse(readFileSync(join(publishedDirectory, "manifest.json"), "utf8")).state,
    "committed",
  );
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

test("non-regular, symlink, and multi-link targets are refused without mutation", async (t) => {
  const directory = temporaryDirectory(t);

  await t.test("directory target", () => {
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
  });

  await t.test("symlink target", (st) => {
    if (skipIfSymlinkUnavailable(st)) return;
    const realTarget = join(directory, "real-target");
    const realBytes = Buffer.from("real fake-secret-real\n", "utf8");
    writeFileSync(realTarget, realBytes);
    const linkTarget = join(directory, "link-target");
    symlinkSync(realTarget, linkTarget);
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
  });

  await t.test("multi-link target", () => {
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

test("recovery resolves an orphaned published transaction directory without touching an unrelated target (W4 negative control)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "orphaned.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original); // path exists independently of any transaction artifact
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    prepared: Buffer.from("unrelated staged bytes, never linked to path\n", "utf8"),
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.equal(
    existsSync(join(transactionDirectory, "prepared")),
    false,
    "the unrelated staged artifact is discarded (round 8: no rm -r of the directory itself)",
  );
  assert.deepEqual(readFileSync(path), original, "unrelated target bytes are never touched");
});

test("the complete-but-unrecorded branch refuses when displaced is not a plain regular file (M3)", (t) => {
  if (skipIfSymlinkUnavailable(t)) return;
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
  symlinkSync(elsewhere, join(transactionDirectory, "displaced"));
  writeFileSync(
    join(transactionDirectory, "manifest.json"),
    `${JSON.stringify({ version: 1, state: "published", target: path })}\n`,
    "utf8",
  );

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "manual", "a symlinked displaced is not a proven backup; must not commit (M3)");
  assert.equal(lstatSync(path).nlink, 2, "nothing was mutated");
});

test("recovery retains and names a transaction directory instead of guessing when discarding its resolved artifact fails partway (Important 1 / round 8, I1)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "degraded-recovery.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {
    prepared: Buffer.from("never published\n", "utf8"),
  });

  // Real fault injection, no sleep: the staged artifact's own unlink
  // succeeds, but the follow-up directory fsync (a real EIO on $HOME)
  // throws. Round 8 no longer `rmSync`s the whole transaction directory
  // here (I1) — resolving discards only the staged artifact and marks the
  // directory committed — so a durability failure at that step must retain
  // and name the directory rather than proceed on an unproven assumption
  // that the discard actually completed.
  const originalSync = directorySyncCapability.sync;
  directorySyncCapability.sync = () => {
    throw new Error("injected EIO on directory fsync carrying fake-secret-original");
  };
  t.after(() => {
    directorySyncCapability.sync = originalSync;
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "manual");
  assert.equal(
    existsSync(transactionDirectory),
    true,
    "the directory is retained, not removed, when the discard cannot be proven durable",
  );
  assert.equal(existsSync(join(transactionDirectory, "prepared")), false, "the unlink itself already succeeded");
  assert.notEqual(recovery.recoveryPath, path, "the live target must never be offered as something to remove");
  assert.equal(recovery.recoveryPath, transactionDirectory, "the retained directory is named so the user has something to inspect");
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

test("recovery still resolves a published transaction with no displaced when the target is present (unaffected by the path check)", (t) => {
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
  assert.equal(
    existsSync(join(transactionDirectory, "prepared")),
    false,
    "safe to discard the staged artifact once path is proven present",
  );
  assert.deepEqual(readFileSync(path), Buffer.from("brand new file\n", "utf8"));
});

// --- Round 8 coverage: B3 (restoreDisplaced's own in-process copy-failure
// outcome, the publish route's twin of the already-pinned recovery-route
// fix) and B11 (the "nothing staged" arm of resolveUndisplacedTransaction) --

test("a fresh write's own in-process restore reports an interrupted restore honestly instead of defaulting targetWritten to false (round 8, B3)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "publish-restore-fault.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);

  // Corrupt the freshly-displaced backup the instant atomicWriteBytesIfUnchanged
  // creates it (its own renameSync(path, displaced)), so its own in-process
  // fileMatches check fails and it must restore from the very artifact it
  // just displaced — all inside this one call, unlike PROBE A / mutant B4,
  // which pin the same shape reached a call later, via recoverFileTransaction.
  const originalRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    originalRename(from, to);
    if (String(from) === path) writeFileSync(String(to), "corrupted\n", "utf8");
  }) as typeof fs.renameSync;

  // Fail only the write to the descriptor opened for `path` itself — the
  // restore's own O_CREAT|O_EXCL destination create — not any other
  // descriptor (the prepared write and the manifest writes also route
  // through the exported writeSync in this Node build, so a call-order-only
  // injection fires too early).
  const originalOpen = fs.openSync;
  let targetDescriptor: number | undefined;
  (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((
    ...args: Parameters<typeof fs.openSync>
  ) => {
    const fd = originalOpen(...args);
    if (String(args[0]) === path) targetDescriptor = fd;
    return fd;
  }) as typeof fs.openSync;
  const originalWriteSync = fs.writeSync;
  let injected = false;
  (fs as unknown as { writeSync: typeof fs.writeSync }).writeSync = ((
    ...args: Parameters<typeof fs.writeSync>
  ) => {
    if (!injected && args[0] === targetDescriptor) {
      injected = true;
      const error = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    }
    return originalWriteSync(...args);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = originalRename;
    fs.openSync = originalOpen;
    fs.writeSync = originalWriteSync;
    syncBuiltinESMExports();
  });

  const result = atomicWriteBytesIfUnchanged(path, Buffer.from("replacement\n", "utf8"), prior);

  assert.equal(result.status, "recovery-required");
  assert.ok(result.outcome !== undefined);
  // The failed O_CREAT|O_EXCL restore leaves a broken file at `path` behind
  // (never cleaned up — see copyRegularFileExclusiveNoFollow's own doc
  // comment on why not). `targetWritten` must reflect that fresh proof, not
  // a stale default of false — the exact thing mutant B3 (hardcode `false`
  // at restoreDisplaced's own ambiguousOutcome call) would get away with.
  assert.equal(existsSync(path), true, "the failed restore left a broken file behind");
  assert.equal(result.outcome!.targetWritten, true, "targetWritten must be proven fresh, not defaulted");
});

test("recovery resolves a transaction with nothing staged when the target is also absent (round 8, B11)", (t) => {
  // No target, no prepared, no displaced: purely empty bookkeeping, exactly
  // what a crash between mkdirSync and the very first openSync("prepared",
  // "wx") leaves behind. Safe to resolve regardless of the target's own
  // state, since nothing was ever staged to protect.
  const directory = temporaryDirectory(t);
  const path = join(directory, "nothing-staged.bin");
  writeLegacyV1TransactionFixture(directory, path, "published", {});

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered", "nothing staged and no live target: safe to resolve, not retain forever");
  assert.equal(inspectFileTransaction(path).status, "clear");
});

// --- Round 9, r4: a leftover link-probe hard link must not survive a
// discard that only accounted for the "prepared" name ----------------------

test("recovery discards a leftover link-probe hard link alongside prepared, not just the prepared name (round 9, r4)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "link-probe-leftover.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original);
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {
    prepared: Buffer.from("staged, never published fake-secret-staged\n", "utf8"),
  });
  // Reproduces the exact crash window atomicWriteBytesIfUnchanged's own
  // link-capability probe leaves: `link-probe` is a second hard link to the
  // same inode as `prepared`, created and normally removed two lines later
  // in that function. A crash between those two lines leaves both names
  // live; round 8's discard only ever unlinked the name "prepared", so the
  // same bytes silently survived under "link-probe".
  linkSync(join(transactionDirectory, "prepared"), join(transactionDirectory, "link-probe"));
  assert.equal(lstatSync(join(transactionDirectory, "prepared")).nlink, 2);

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.deepEqual(readFileSync(path), original, "the live target is untouched");
  assert.equal(existsSync(join(transactionDirectory, "prepared")), false, "the prepared name is discarded");
  assert.equal(
    existsSync(join(transactionDirectory, "link-probe")),
    false,
    "the link-probe name is discarded too — round 8 discarded only the 'prepared' name and left this inode's other name behind (r4)",
  );
  assert.equal(
    JSON.parse(readFileSync(join(transactionDirectory, "manifest.json"), "utf8")).state,
    "committed",
  );
});

test("recovery still discards only prepared when no link-probe leftover exists (negative control for r4)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "no-link-probe.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original);
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {
    prepared: Buffer.from("staged, never published\n", "utf8"),
  });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered");
  assert.equal(existsSync(join(transactionDirectory, "prepared")), false);
  assert.equal(existsSync(join(transactionDirectory, "link-probe")), false, "never created, never an error to discard it");
});

test("recovery retains a link-probe-only leftover instead of discarding it when the target is not proven live (round 10, s5/D10)", (t) => {
  if (skipIfSymlinkUnavailable(t)) return;
  // r4's own test above pins only the discard side (target live, both
  // "prepared" and "link-probe" removed together). This is the missing
  // retain side: `link-probe` is the *only* surviving artifact (no
  // "prepared" name at all) over a target that proves nothing was ever
  // there. Mutant D10 drops the `link-probe` disjunct from the retain gate
  // only (leaving it in the discard gate two lines below) — under that
  // mutant this exact shape is silently discarded and committed, destroying
  // the only surviving copy of the staged bytes: the I2/PROBE-L data-loss
  // shape, reintroduced under the "link-probe" name instead of "prepared".
  const directory = temporaryDirectory(t);
  const path = join(directory, "link-probe-only-dangling.bin");
  symlinkSync(join(directory, "missing-target"), path);
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "prepared", {});
  writeFileSync(
    join(transactionDirectory, "link-probe"),
    Buffer.from("staged bytes fake-secret-linkprobe\n", "utf8"),
  );

  const recovery = recoverFileTransaction(path);

  assert.equal(
    recovery.status,
    "manual",
    "a dangling symlink target proves nothing was ever there — link-probe alone must still be retained (s5/D10)",
  );
  assert.equal(existsSync(join(transactionDirectory, "link-probe")), true, "the only surviving copy is not silently discarded");
  assert.equal(lstatSync(path).isSymbolicLink(), true, "the dangling symlink itself is left untouched");
});

// --- Round 9, m1: a successful write's own retained-copy disclosure must be
// a proven copy, not a bare existence check ----------------------------------

test("a successful write discloses the retained-copy path only when proven, not from a bare existence check (round 9, m1)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "proven-recovery.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);
  const replacement = Buffer.from("replacement fake-secret-replacement\n", "utf8");

  // Races the retained copy the instant its own "prepared" artifact is
  // unlinked — the exact window between this call's last proof of
  // `displaced` and its final disclosure of the recovery path (matched the
  // same narrow call signature `injectFailureOnPreparedUnlink` above uses:
  // no options object, basename "prepared", so it fires exactly once, at
  // exactly this call, nowhere else). A second hard link to the exact same
  // inode moves `displaced`'s own nlink from 1 to 2, which is enough to fail
  // `isManagedRegularFile`'s "singly-owned copy" proof — only reachable by a
  // same-user concurrent writer inside this 0700 directory.
  const originalRm = fs.rmSync;
  let raced = false;
  fs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
    const [target, options] = args;
    originalRm(...args);
    if (!raced && typeof target === "string" && options === undefined && basename(target) === "prepared") {
      raced = true;
      const displaced = join(dirname(target), "displaced");
      linkSync(displaced, `${displaced}-extra-name`);
    }
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  });

  const result = atomicWriteBytesIfUnchanged(path, replacement, prior);

  assert.ok(raced, "the injected race actually fired");
  assert.deepEqual(readFileSync(path), replacement, "the write itself still succeeded and is not undone");
  // Before round 9: the final success return used a bare `firstExistingPath`
  // (an lstat existence check, true regardless of how many names now point
  // at that inode) — it would have reported this doubly-linked file as
  // though it were still the proven, singly-owned retained copy. After:
  // recoveryPath is only ever the same `isManagedRegularFile`-proven value
  // the outcome record's own `provenCopy` field uses elsewhere in this
  // module — never a bare "something exists at this name" check.
  assert.notEqual(result.status, "written", "an unproven retained copy must not be reported as a plain success");
  assert.equal(result.status, "recovery-required");
  assert.ok(result.outcome !== undefined);
  assert.equal(result.outcome!.provenCopy, undefined, "the doubly-linked file is never accepted as a proven copy");
  // Round 10, s3: `path` itself was already proven byte- and mode-correct by
  // this same call's own `fileMatches` check, before the race above ever
  // touched `displaced` — only the *retained copy's* provenance is what this
  // branch cannot prove. `targetWritten` must say so: `false`, not `true`,
  // so `hook.ts` never renders "bashrc holds unfinished write. do not trust
  // it." over a write that is neither unfinished nor untrustworthy.
  assert.equal(
    result.outcome!.targetWritten,
    false,
    "the target's own write was already verified — this is not an unfinished-write claim (s3)",
  );
});

test("a successful write discloses the exact proven copy in the ordinary, uncontested case (negative control for m1)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "ordinary-recovery.bin");
  const original = Buffer.from("original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);

  const result = atomicWriteBytesIfUnchanged(path, Buffer.from("replacement\n", "utf8"), prior);

  assert.equal(result.status, "written");
  assert.ok(result.recoveryPath !== undefined);
  assert.deepEqual(readFileSync(result.recoveryPath), original, "the disclosed path is the genuine retained copy");
});

test("restoreDisplaced's own success return discloses the copy proven before its commit, not a fresh check racing it (round 10, s4/D3)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "restore-disclosure-race.bin");
  const original = Buffer.from("original fake-secret-original\n", "utf8");
  writeFileSync(path, original);
  const prior = snapshotBytes(path);

  // Corrupt the freshly-displaced backup the instant it is created (same
  // technique as the B3 test above), forcing restoreDisplaced's own
  // in-process restore-from-displaced branch to run.
  const originalRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    originalRename(from, to);
    if (String(from) === path) writeFileSync(String(to), "corrupted\n", "utf8");
  }) as typeof fs.renameSync;

  // restoreDisplaced writes exactly one manifest of its own ("committed"),
  // the third manifest.tmp write overall (prepared, displaced, committed).
  // Delete `displaced` as that write lands — after every stability check
  // this function performs on that name has already passed, so the deletion
  // changes nothing about whether the restore itself succeeded; it only
  // matters to a check re-run *after* this point. Round 9's m1 item 3
  // (`recoveryPath: provenCopy`) captures that proof once, before this call's
  // own commit could distort it (the exact self-reference reasoning the
  // sibling comments in `file-transaction.ts` name repeatedly), and discloses
  // that frozen value — never a bare existence check re-evaluated fresh at
  // the return statement, which mutant D3 (revert to
  // `firstExistingPath(displacedPath)`) reintroduces and this race exposes.
  const originalOpen = fs.openSync;
  let manifestWrites = 0;
  let raced = false;
  (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((
    ...args: Parameters<typeof fs.openSync>
  ) => {
    const [target, flags] = args;
    if (!raced && typeof target === "string" && target.endsWith("manifest.tmp") && flags === "wx") {
      manifestWrites += 1;
      if (manifestWrites === 3) {
        raced = true;
        rmSync(join(dirname(target), "displaced"), { force: true });
      }
    }
    return originalOpen(...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = originalRename;
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  });

  const result = atomicWriteBytesIfUnchanged(path, Buffer.from("replacement\n", "utf8"), prior);

  assert.ok(raced, "the injected race actually fired");
  assert.equal(result.status, "changed");
  assert.ok(
    result.recoveryPath !== undefined,
    "the copy proven before this call's own commit is still disclosed, not re-derived from a now-stale existence check (s4/D3)",
  );
  assert.ok(
    result.recoveryPath!.endsWith("displaced"),
    "the disclosed path names the copy that was proven, by identity, not re-checked fresh",
  );
});

// --- Round 9 coverage: C6 (the discard gate must not attempt a needless
// fsync when nothing was ever staged), C10 (the commit's own writeManifest
// call must still carry the guard argument), C11 (the standalone recheck
// between a successful discard and the commit must stay distinct from
// writeManifest's own internal guard checks) -------------------------------

test("resolving a transaction with nothing staged never attempts a needless discard fsync (round 9, coverage: C6)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "nothing-staged-gate.bin");
  writeFileSync(path, "live\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {});

  // Fails the SECOND directory fsync this transaction directory ever
  // receives. This fixture's manifest was written directly (bypassing
  // writeManifest), so the gated code makes exactly one fsync call for this
  // directory: the final commit's own writeManifest. If the "nothing to
  // discard" gate were dropped, discardPrepared would run unconditionally
  // (a harmless rmSync no-op, since nothing exists) but still perform its
  // own fsync first — making the commit's fsync the SECOND call instead of
  // the first, which this injection would then catch.
  const originalSync = directorySyncCapability.sync;
  let calls = 0;
  directorySyncCapability.sync = (directoryPath: string) => {
    if (directoryPath === transactionDirectory) {
      calls += 1;
      if (calls === 2) throw new Error("injected second fsync failure carrying fake-secret");
    }
    return originalSync(directoryPath);
  };
  t.after(() => { directorySyncCapability.sync = originalSync; });

  const recovery = recoverFileTransaction(path);

  assert.equal(recovery.status, "recovered", "nothing staged: only one fsync should ever be attempted");
  assert.equal(calls, 1, "the discard gate must not perform a needless fsync when nothing was staged (C6)");
});

test("resolving an undisplaced transaction still honors a guard change during its own final commit (round 9, coverage: C10)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "commit-guard.bin");
  writeFileSync(path, "live\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {});

  // The first two `unchanged()` calls are this function's own explicit
  // checks (both pass, since nothing is staged to discard); a change
  // reported starting on the third call — the very first check the commit's
  // own writeManifest performs — must still abort the commit. Dropping the
  // `guard` argument on that specific call (as opposed to dropping a check)
  // is invisible to every explicit check resolveUndisplacedTransaction makes
  // itself and observable only here.
  let calls = 0;
  const guard = { unchanged: () => { calls += 1; return calls <= 2; } };

  const recovery = recoverFileTransaction(path, guard);

  assert.equal(recovery.status, "manual", "a guard change reported during the commit's own write must still abort it (C10)");
  assert.equal(
    JSON.parse(readFileSync(join(transactionDirectory, "manifest.json"), "utf8")).state,
    "published",
    "the manifest must not advance to committed once the guard reports change",
  );
});

test("resolving an undisplaced transaction stays silent about the directory once its own discard already succeeded before a later guard change (round 9, coverage: C11)", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "post-discard-guard.bin");
  writeFileSync(path, "live\n", "utf8");
  const transactionDirectory = writeLegacyV1TransactionFixture(directory, path, "published", {
    prepared: Buffer.from("staged, safe to discard\n", "utf8"),
  });

  // unchanged() reports true for the function's own first two checks (the
  // one right after the retain branch, and the one guarding the discard
  // itself — both of which must pass for the discard to actually run), then
  // false starting on the third call: the standalone recheck this function
  // performs between a successful discard and its own commit. Removing that
  // standalone recheck (C11) does not change the final `status` here (the
  // commit's own internal guard check still aborts it) — it changes what
  // gets disclosed: the standalone check's own return names no directory
  // (nothing is left at risk once the discard already succeeded), while the
  // commit's internal-guard-check catch always names the directory as
  // retained, which is what this test's `recoveryPath` assertion pins.
  let calls = 0;
  const guard = { unchanged: () => { calls += 1; return calls <= 2; } };

  const recovery = recoverFileTransaction(path, guard);

  assert.equal(recovery.status, "manual");
  assert.equal(existsSync(join(transactionDirectory, "prepared")), false, "the discard itself already completed");
  assert.equal(recovery.recoveryPath, undefined, "nothing is left at risk, so no directory is offered for inspection (C11)");
});
