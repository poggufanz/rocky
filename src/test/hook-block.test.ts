import test, { before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addHookBlockBytes,
  classifyHookBlock,
  removeHookBlockBytes,
} from "../core/hook-block.js";
import { hookInstall, hookStatus, hookUninstall } from "../commands/hook.js";
import { inspectFileTransaction } from "../setup/file-transaction.js";
import { directorySyncCapability } from "../setup/directory-sync.js";

// The exact managed block, pinned byte-for-byte from the marker format spec.
const BEGIN = "# >>> rocky hook >>>";
const END = "# <<< rocky hook <<<";
const LINE =
  '[ -f "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash" ] && . "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash"';
const BLOCK = `${BEGIN}\n${LINE}\n${END}\n`;

function bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

// --- pure parser -----------------------------------------------------------

test("classifyHookBlock reports absent when no marker bytes exist", () => {
  assert.equal(classifyHookBlock(bytes("")), "absent");
  assert.equal(classifyHookBlock(bytes("# my bashrc\nalias ll='ls -l'\n")), "absent");
  assert.equal(classifyHookBlock(bytes("rocky hook\n# >>> rocky hook >>\n")), "absent");
});

test("classifyHookBlock reports managed for the exact block alone and embedded", () => {
  assert.equal(classifyHookBlock(bytes(BLOCK)), "managed");
  const embedded = bytes(`export A=1\n\n${BLOCK}export B=2\n`);
  assert.equal(classifyHookBlock(embedded), "managed");
});

test("classifyHookBlock tolerates CRLF and non-UTF8 bytes outside the block", () => {
  const content = Buffer.concat([
    bytes("export A=1\r\nhéllo wörld\r\n"),
    Buffer.from([0xff, 0xfe, 0x0d, 0x0a]),
    bytes(BLOCK),
    bytes("export B=2\r\n"),
  ]);
  assert.equal(classifyHookBlock(content), "managed");
});

test("classifyHookBlock reports corrupt for an orphaned BEGIN without END", () => {
  assert.equal(classifyHookBlock(bytes(`export A=1\n${BEGIN}\n${LINE}\nexport B=2\n`)), "corrupt");
  assert.equal(classifyHookBlock(bytes(`${BEGIN}\n`)), "corrupt");
});

test("classifyHookBlock reports corrupt for an orphaned END without BEGIN", () => {
  assert.equal(classifyHookBlock(bytes(`export A=1\n${END}\n`)), "corrupt");
});

test("classifyHookBlock reports corrupt for reversed markers", () => {
  assert.equal(classifyHookBlock(bytes(`${END}\n${LINE}\n${BEGIN}\n`)), "corrupt");
});

test("classifyHookBlock reports corrupt for duplicate blocks", () => {
  assert.equal(classifyHookBlock(bytes(`${BLOCK}${BLOCK}`)), "corrupt");
  assert.equal(classifyHookBlock(bytes(`${BLOCK}export A=1\n${BLOCK}`)), "corrupt");
});

test("classifyHookBlock reports corrupt for nested markers", () => {
  assert.equal(classifyHookBlock(bytes(`${BEGIN}\n${BEGIN}\n${END}\n`)), "corrupt");
  assert.equal(classifyHookBlock(bytes(`${BEGIN}\n${LINE}\n${END}\n${END}\n`)), "corrupt");
});

test("classifyHookBlock reports corrupt when interior bytes differ from the hook line", () => {
  assert.equal(classifyHookBlock(bytes(`${BEGIN}\necho tampered\n${END}\n`)), "corrupt");
  assert.equal(classifyHookBlock(bytes(`${BEGIN}\n${LINE} \n${END}\n`)), "corrupt");
  assert.equal(classifyHookBlock(bytes(`${BEGIN}\n${END}\n`)), "corrupt");
});

test("classifyHookBlock reports corrupt when a marker is not at a line start", () => {
  assert.equal(classifyHookBlock(bytes(`  ${BEGIN}\n${LINE}\n${END}\n`)), "corrupt");
  assert.equal(classifyHookBlock(bytes(`x${BEGIN}\n${LINE}\n${END}\n`)), "corrupt");
});

test("classifyHookBlock reports corrupt when marker lines carry extra bytes", () => {
  assert.equal(classifyHookBlock(bytes(`${BEGIN} \n${LINE}\n${END}\n`)), "corrupt");
  assert.equal(classifyHookBlock(bytes(`${BEGIN}\r\n${LINE}\r\n${END}\r\n`)), "corrupt");
});

test("classifyHookBlock reports corrupt when END lacks its trailing newline", () => {
  assert.equal(classifyHookBlock(bytes(`${BEGIN}\n${LINE}\n${END}`)), "corrupt");
});

test("classifyHookBlock reports corrupt when marker text sits outside the block", () => {
  const content = bytes(`${BLOCK}echo "${BEGIN}"\n`);
  assert.equal(classifyHookBlock(content), "corrupt");
});

test("addHookBlockBytes appends the exact block and preserves every prior byte", () => {
  const plain = bytes("export A=1\n");
  assert.deepEqual(addHookBlockBytes(plain), bytes(`export A=1\n\n${BLOCK}`));

  const unterminated = bytes("export A=1");
  assert.deepEqual(addHookBlockBytes(unterminated), bytes(`export A=1\n\n${BLOCK}`));

  assert.deepEqual(addHookBlockBytes(bytes("")), bytes(`\n${BLOCK}`));
});

test("addHookBlockBytes preserves CRLF and non-UTF8 bytes byte-for-byte", () => {
  const content = Buffer.concat([
    bytes("export A=1\r\nhéllo\r\n"),
    Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a]),
  ]);
  const added = addHookBlockBytes(content);
  assert.deepEqual(added, Buffer.concat([content, bytes(`\n${BLOCK}`)]));
  assert.equal(classifyHookBlock(added), "managed");
});

test("addHookBlockBytes returns managed and corrupt input unchanged", () => {
  const managed = bytes(`export A=1\n\n${BLOCK}`);
  assert.deepEqual(addHookBlockBytes(managed), managed);

  const corrupt = bytes(`export A=1\n${BEGIN}\n`);
  assert.deepEqual(addHookBlockBytes(corrupt), corrupt);
});

test("removeHookBlockBytes removes exactly the block bytes and nothing else", () => {
  const prefix = Buffer.concat([bytes("export A=1\r\nhéllo wörld\n"), Buffer.from([0xff, 0x0a])]);
  const suffix = bytes("export B=2\r\n");
  const managed = Buffer.concat([prefix, bytes(BLOCK), suffix]);
  assert.equal(classifyHookBlock(managed), "managed");
  assert.deepEqual(removeHookBlockBytes(managed), Buffer.concat([prefix, suffix]));
});

test("removeHookBlockBytes after addHookBlockBytes leaves only the separator line", () => {
  const original = bytes("export A=1\n");
  const added = addHookBlockBytes(original);
  assert.deepEqual(removeHookBlockBytes(added), bytes("export A=1\n\n"));
});

test("addHookBlockBytes reuses an existing trailing blank line instead of growing it", () => {
  // Reproduces the reviewer's accumulation finding: repeated install/uninstall
  // cycles must not add one more blank line to bashrc each time.
  let content = bytes("export A=1\n");
  for (let cycle = 0; cycle < 3; cycle += 1) {
    content = addHookBlockBytes(content);
    assert.equal(classifyHookBlock(content), "managed");
    content = removeHookBlockBytes(content);
  }
  assert.deepEqual(content, bytes("export A=1\n\n"));
});

test("removeHookBlockBytes returns absent and corrupt input unchanged", () => {
  const absent = bytes("export A=1\n");
  assert.deepEqual(removeHookBlockBytes(absent), absent);

  const orphanedBegin = bytes(`export A=1\n${BEGIN}\nexport B=2\n`);
  assert.deepEqual(removeHookBlockBytes(orphanedBegin), orphanedBegin);

  const modifiedInterior = bytes(`${BEGIN}\necho tampered\n${END}\n`);
  assert.deepEqual(removeHookBlockBytes(modifiedInterior), modifiedInterior);
});

// --- command lifecycle -------------------------------------------------------

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

before(() => {
  // The test build compiles sources only; hookInstall expects its shell assets
  // next to the compiled commands, exactly where the production build puts them.
  const source = join(packageRoot, "src", "shell");
  const destination = join(packageRoot, ".test-dist", "shell");
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source).sort()) {
    if (name.endsWith(".bash") || name.endsWith(".sh")) {
      copyFileSync(join(source, name), join(destination, name));
    }
  }
});

interface BashrcSandbox {
  home: string;
  bashrc: string;
  stderr: () => string;
}

function bashrcSandbox(t: TestContext): BashrcSandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-block-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ROCKY_HOME: process.env.ROCKY_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ROCKY_HOME = join(root, "rocky-home");
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const chunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    const callback = rest.find((argument) => typeof argument === "function") as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = originalWrite;
  });

  return { home, bashrc: join(home, ".bashrc"), stderr: () => chunks.join("") };
}

function transactionDirectories(home: string): string[] {
  return readdirSync(home).filter((name) => name.startsWith("..bashrc.transaction-"));
}

function writePendingTransactionFixture(
  bashrc: string,
  state: "prepared" | "displaced" | "published",
  artifacts: { displaced?: Buffer } = {},
): string {
  const directory = join(
    dirname(bashrc),
    `.${basename(bashrc)}.transaction-4242-0123456789abcdef`,
  );
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify({ version: 1, state, target: bashrc })}\n`,
    "utf8",
  );
  if (artifacts.displaced !== undefined) {
    writeFileSync(join(directory, "displaced"), artifacts.displaced);
  }
  return directory;
}

function assertModePreserved(path: string, posixMode: number): void {
  if (process.platform === "win32") return;
  assert.equal(lstatSync(path).mode & 0o777, posixMode);
}

function injectPreparedWriteEnospc(t: TestContext): void {
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
      // The final-review reproduction: seven bytes land, then ENOSPC.
      const staged = Buffer.isBuffer(data) ? data : bytes(String(data));
      fs.writeSync(file, staged, 0, Math.min(7, staged.length), 0);
      const error = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    }
    return callOriginal(file, data, options);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.writeFileSync = originalWriteFile;
    syncBuiltinESMExports();
  });
}

function injectDisplacementRenameFailure(t: TestContext, bashrc: string): void {
  const originalRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === bashrc) {
      throw new Error("injected displacement failure");
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  });
}

function injectPostPublishParentFsyncFailure(t: TestContext, bashrc: string): void {
  const originalLink = fs.linkSync;
  const originalSync = directorySyncCapability.sync;
  let published = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    originalLink(existingPath, newPath);
    if (String(newPath) === bashrc) published = true;
  }) as typeof fs.linkSync;
  directorySyncCapability.sync = (directoryPath: string) => {
    if (published && directoryPath === dirname(bashrc)) {
      throw new Error("injected fsync failure");
    }
    return true;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.linkSync = originalLink;
    directorySyncCapability.sync = originalSync;
    syncBuiltinESMExports();
  });
}

function injectConcurrentEdit(t: TestContext, bashrc: string, concurrent: Buffer): void {
  const originalRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === bashrc) {
      writeFileSync(bashrc, concurrent); // a late writer lands before displacement
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  });
}

test("hook install creates a missing bashrc with exactly the managed block", (t) => {
  const sandbox = bashrcSandbox(t);

  assert.equal(hookInstall(), 0, sandbox.stderr());

  assert.deepEqual(readFileSync(sandbox.bashrc), bytes(`\n${BLOCK}`));
  assert.equal(classifyHookBlock(readFileSync(sandbox.bashrc)), "managed");
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");
});

test("hook install appends the block and preserves bytes and mode", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = Buffer.concat([bytes("export A=1\r\nhéllo\r\n"), Buffer.from([0xff, 0x0a])]);
  writeFileSync(sandbox.bashrc, original, { mode: 0o640 });
  chmodSync(sandbox.bashrc, 0o640);

  assert.equal(hookInstall(), 0, sandbox.stderr());

  assert.deepEqual(readFileSync(sandbox.bashrc), Buffer.concat([original, bytes(`\n${BLOCK}`)]));
  assertModePreserved(sandbox.bashrc, 0o640);
  assert.match(sandbox.stderr(), /ears installed/);
});

test("hook install on a managed block is an idempotent no-op success", (t) => {
  const sandbox = bashrcSandbox(t);
  writeFileSync(sandbox.bashrc, bytes(`export A=1\n\n${BLOCK}export B=2\n`));
  const before = readFileSync(sandbox.bashrc);

  assert.equal(hookInstall(), 0, sandbox.stderr());

  assert.deepEqual(readFileSync(sandbox.bashrc), before);
  assert.match(sandbox.stderr(), /ears installed/);
  assert.deepEqual(transactionDirectories(sandbox.home), []);
});

test("hook install refuses a corrupt block and preserves every byte", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export IMPORTANT_USER_STATE=preserve-me\n${BEGIN}\nexport B=2\n`);
  writeFileSync(sandbox.bashrc, original);

  assert.equal(hookInstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.match(sandbox.stderr(), /corrupt/);
  assert.ok(sandbox.stderr().includes(sandbox.bashrc), "guidance names the plain path");
  assert.ok(!sandbox.stderr().includes("IMPORTANT_USER_STATE"), "diagnostics stay secret-free");
  assert.deepEqual(transactionDirectories(sandbox.home), []);
});

test("hook uninstall on absent markers keeps the current quiet success", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export A=1\n");
  writeFileSync(sandbox.bashrc, original);

  assert.equal(hookUninstall(), 0, sandbox.stderr());

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.match(sandbox.stderr(), /no ears installed/);
});

test("hook uninstall on a missing bashrc keeps the current quiet success", (t) => {
  const sandbox = bashrcSandbox(t);

  assert.equal(hookUninstall(), 0, sandbox.stderr());
  assert.match(sandbox.stderr(), /no ears installed/);
  assert.equal(existsSync(sandbox.bashrc), false);
});

test("hook uninstall removes exactly the block bytes and preserves mode", (t) => {
  const sandbox = bashrcSandbox(t);
  const prefix = Buffer.concat([bytes("export A=1\r\nhéllo\r\n"), Buffer.from([0xff, 0x0a])]);
  const suffix = bytes("export B=2\r\n");
  writeFileSync(sandbox.bashrc, Buffer.concat([prefix, bytes(BLOCK), suffix]), { mode: 0o640 });
  chmodSync(sandbox.bashrc, 0o640);

  assert.equal(hookUninstall(), 0, sandbox.stderr());

  assert.deepEqual(readFileSync(sandbox.bashrc), Buffer.concat([prefix, suffix]));
  assertModePreserved(sandbox.bashrc, 0o640);
  assert.match(sandbox.stderr(), /ears removed/);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");
});

test("hook uninstall refuses a corrupt block and preserves every byte", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export IMPORTANT_USER_STATE=preserve-me\n${BEGIN}\nexport B=2\n`);
  writeFileSync(sandbox.bashrc, original);

  assert.equal(hookUninstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.match(sandbox.stderr(), /corrupt/);
  assert.ok(sandbox.stderr().includes(sandbox.bashrc));
  assert.ok(!sandbox.stderr().includes("IMPORTANT_USER_STATE"));
  assert.deepEqual(transactionDirectories(sandbox.home), []);
});

test("hook status reports absent and managed truthfully", (t) => {
  const missing = bashrcSandbox(t);
  assert.equal(hookStatus(), 0, missing.stderr());
  assert.match(missing.stderr(), /ears not installed/);

  const managed = bashrcSandbox(t);
  writeFileSync(managed.bashrc, bytes(`export A=1\n\n${BLOCK}`));
  assert.equal(hookStatus(), 0, managed.stderr());
  assert.match(managed.stderr(), /ears installed/);
});

test("hook status reports a corrupt block truthfully and exits 1", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export IMPORTANT_USER_STATE=preserve-me\n${BEGIN}\nexport B=2\n`);
  writeFileSync(sandbox.bashrc, original);

  assert.equal(hookStatus(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.match(sandbox.stderr(), /corrupt/);
  assert.ok(sandbox.stderr().includes(sandbox.bashrc));
  assert.ok(!sandbox.stderr().includes("IMPORTANT_USER_STATE"));
});

test("hook install survives ENOSPC mid-publish with the original bytes intact", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export IMPORTANT_USER_STATE=preserve-me\n");
  writeFileSync(sandbox.bashrc, original);
  injectPreparedWriteEnospc(t);

  assert.equal(hookInstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.deepEqual(transactionDirectories(sandbox.home), []);
  assert.ok(sandbox.stderr().includes(sandbox.bashrc));
  assert.ok(!sandbox.stderr().includes("IMPORTANT_USER_STATE"));
});

test("hook uninstall survives ENOSPC mid-publish with the original bytes intact", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export IMPORTANT_USER_STATE=preserve-me\n\n${BLOCK}`);
  writeFileSync(sandbox.bashrc, original);
  injectPreparedWriteEnospc(t);

  assert.equal(hookUninstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.deepEqual(transactionDirectories(sandbox.home), []);
  assert.ok(!sandbox.stderr().includes("IMPORTANT_USER_STATE"));
});

test("hook install survives a displacement rename failure with bytes intact", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export IMPORTANT_USER_STATE=preserve-me\n");
  writeFileSync(sandbox.bashrc, original);
  injectDisplacementRenameFailure(t, sandbox.bashrc);

  assert.equal(hookInstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.deepEqual(transactionDirectories(sandbox.home), []);
});

test("hook uninstall survives a displacement rename failure with bytes intact", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export A=1\n\n${BLOCK}`);
  writeFileSync(sandbox.bashrc, original);
  injectDisplacementRenameFailure(t, sandbox.bashrc);

  assert.equal(hookUninstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.deepEqual(transactionDirectories(sandbox.home), []);
});

test("hook install keeps a recoverable artifact when the parent fsync fails", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export IMPORTANT_USER_STATE=preserve-me\n");
  writeFileSync(sandbox.bashrc, original);
  injectPostPublishParentFsyncFailure(t, sandbox.bashrc);

  assert.equal(hookInstall(), 1);

  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "pending");
  const pending = inspectFileTransaction(sandbox.bashrc);
  assert.equal(pending.status, "pending");
  assert.ok(pending.recoveryPath !== undefined);
  assert.ok(sandbox.stderr().includes(pending.recoveryPath), "recovery path is reported");
  // The staged result was published before durability failed; the displaced
  // artifact retains the original bytes. Nothing is truncated.
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes(`export IMPORTANT_USER_STATE=preserve-me\n\n${BLOCK}`));
  const displaced = readFileSync(join(pending.recoveryPath, "displaced"));
  assert.deepEqual(displaced, original);
  assert.ok(!sandbox.stderr().includes("IMPORTANT_USER_STATE"));
});

test("hook uninstall keeps a recoverable artifact when the parent fsync fails", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export A=1\n\n${BLOCK}`);
  writeFileSync(sandbox.bashrc, original);
  injectPostPublishParentFsyncFailure(t, sandbox.bashrc);

  assert.equal(hookUninstall(), 1);

  const pending = inspectFileTransaction(sandbox.bashrc);
  assert.equal(pending.status, "pending");
  assert.ok(pending.recoveryPath !== undefined);
  assert.ok(sandbox.stderr().includes(pending.recoveryPath));
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes("export A=1\n\n"));
  assert.deepEqual(readFileSync(join(pending.recoveryPath, "displaced")), original);
});

test("hook install refuses when bashrc changes between snapshot and publish", (t) => {
  const sandbox = bashrcSandbox(t);
  writeFileSync(sandbox.bashrc, bytes("export A=1\n"));
  const concurrent = bytes("export LATE_WRITER=wins\n");
  injectConcurrentEdit(t, sandbox.bashrc, concurrent);

  assert.equal(hookInstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), concurrent, "user bytes win");
  assert.match(sandbox.stderr(), /changed while I worked/);
  assert.ok(sandbox.stderr().includes(sandbox.bashrc));
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");
});

test("hook uninstall refuses when bashrc changes between snapshot and publish", (t) => {
  const sandbox = bashrcSandbox(t);
  writeFileSync(sandbox.bashrc, bytes(`export A=1\n\n${BLOCK}`));
  const concurrent = bytes(`export LATE_WRITER=wins\n\n${BLOCK}`);
  injectConcurrentEdit(t, sandbox.bashrc, concurrent);

  assert.equal(hookUninstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), concurrent, "user bytes win");
  assert.match(sandbox.stderr(), /changed while I worked/);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");
});

test("hook install and uninstall refuse a symlink bashrc without touching it", (t) => {
  const sandbox = bashrcSandbox(t);
  const real = join(sandbox.home, "real-bashrc");
  const original = bytes("export A=1\n");
  writeFileSync(real, original);
  let symlinkAvailable = true;
  try {
    symlinkSync(real, sandbox.bashrc);
  } catch {
    symlinkAvailable = false; // Some platforms require privilege for symlinks.
  }
  if (!symlinkAvailable) return;

  assert.equal(hookInstall(), 1);
  assert.match(sandbox.stderr(), /symlink/);
  assert.equal(lstatSync(sandbox.bashrc).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(real), original);

  assert.equal(hookUninstall(), 1);
  assert.equal(lstatSync(sandbox.bashrc).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(real), original);
  assert.deepEqual(transactionDirectories(sandbox.home), []);
});

test("hook install and uninstall refuse a multi-linked bashrc without touching it", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export A=1\n");
  writeFileSync(sandbox.bashrc, original);
  linkSync(sandbox.bashrc, join(sandbox.home, "bashrc-alias"));

  assert.equal(hookInstall(), 1);
  assert.match(sandbox.stderr(), /many names|hard link/i);
  assert.deepEqual(readFileSync(sandbox.bashrc), original);

  assert.equal(hookUninstall(), 1);
  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.deepEqual(transactionDirectories(sandbox.home), []);
});

test("hook install refuses a non-regular bashrc without touching it", (t) => {
  const sandbox = bashrcSandbox(t);
  mkdirSync(sandbox.bashrc);

  assert.equal(hookInstall(), 1);

  assert.match(sandbox.stderr(), /not regular file/);
  assert.equal(lstatSync(sandbox.bashrc).isDirectory(), true);
  assert.deepEqual(transactionDirectories(sandbox.home), []);
});

test("hook install recovers a pending transaction before proceeding fresh", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export A=1\n");
  writeFileSync(sandbox.bashrc, original);
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "prepared");

  assert.equal(hookInstall(), 0, sandbox.stderr());

  assert.equal(existsSync(fixture), false, "stale transaction recovered away");
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes(`export A=1\n\n${BLOCK}`));
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");
});

test("hook uninstall recovers a pending transaction before proceeding fresh", (t) => {
  const sandbox = bashrcSandbox(t);
  writeFileSync(sandbox.bashrc, bytes(`export A=1\n\n${BLOCK}`));
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "prepared");

  assert.equal(hookUninstall(), 0, sandbox.stderr());

  assert.equal(existsSync(fixture), false);
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes("export A=1\n\n"));
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");
});

test("hook install stops with guidance when a pending transaction is ambiguous", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export IMPORTANT_USER_STATE=preserve-me\n");
  writeFileSync(sandbox.bashrc, original);
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "published", {
    displaced: original,
  });

  assert.equal(hookInstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original, "bytes untouched");
  assert.ok(sandbox.stderr().includes(fixture), "secret-free recovery path printed");
  assert.ok(!sandbox.stderr().includes("IMPORTANT_USER_STATE"));
  assert.equal(existsSync(fixture), true, "artifact retained for manual repair");
});

test("hook uninstall stops with guidance when a pending transaction is ambiguous", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export A=1\n\n${BLOCK}`);
  writeFileSync(sandbox.bashrc, original);
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "published", {
    displaced: original,
  });

  assert.equal(hookUninstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original);
  assert.ok(sandbox.stderr().includes(fixture));
  assert.equal(existsSync(fixture), true);
});

// --- status shares topology/pending-transaction handling with install/uninstall ---

test("hook status refuses a symlink bashrc instead of following it and claiming installed", (t) => {
  const sandbox = bashrcSandbox(t);
  const real = join(sandbox.home, "real-bashrc");
  writeFileSync(real, bytes(`export A=1\n\n${BLOCK}`));
  let symlinkAvailable = true;
  try {
    symlinkSync(real, sandbox.bashrc);
  } catch {
    symlinkAvailable = false;
  }
  if (!symlinkAvailable) return;

  assert.equal(hookStatus(), 1);
  assert.match(sandbox.stderr(), /symlink/);
  // Consistent with install/uninstall, which refuse the same topology.
  assert.equal(hookInstall(), 1);
  assert.match(sandbox.stderr(), /symlink/);
});

test("hook status refuses a dangling symlink instead of telling the user to run install", (t) => {
  const sandbox = bashrcSandbox(t);
  let symlinkAvailable = true;
  try {
    symlinkSync(join(sandbox.home, "missing-target"), sandbox.bashrc);
  } catch {
    symlinkAvailable = false;
  }
  if (!symlinkAvailable) return;

  const result = hookStatus();

  // Before the fix this claimed "ears not installed. run: rocky hook
  // install" — a command that install then refuses. A dangling symlink is a
  // topology refusal, exactly like install/uninstall already give it.
  assert.equal(result, 1);
  assert.match(sandbox.stderr(), /symlink/);
  assert.ok(!sandbox.stderr().includes("run: rocky hook install"));
});

test("hook status refuses a multi-linked managed bashrc instead of claiming plain installed", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export A=1\n\n${BLOCK}`);
  writeFileSync(sandbox.bashrc, original);
  linkSync(sandbox.bashrc, join(sandbox.home, "bashrc-alias"));

  assert.equal(hookStatus(), 1);
  assert.match(sandbox.stderr(), /many names|hard link/i);
});

test("hook status settles a pending transaction instead of reporting stale state", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export A=1\n");
  writeFileSync(sandbox.bashrc, original);
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "prepared");

  assert.equal(hookStatus(), 0, sandbox.stderr());

  assert.equal(existsSync(fixture), false, "stale transaction recovered away by status too");
  assert.match(sandbox.stderr(), /ears not installed/);
});

test("hook status reports the same ambiguous-transaction guidance install gives, not a false installed", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export IMPORTANT_USER_STATE=preserve-me\n");
  writeFileSync(sandbox.bashrc, original);
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "published", {
    displaced: original,
  });

  assert.equal(hookStatus(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), original, "status never mutates");
  assert.ok(sandbox.stderr().includes(fixture));
  assert.ok(!sandbox.stderr().includes("IMPORTANT_USER_STATE"));
  assert.equal(existsSync(fixture), true);
});

// --- Important 2: undisclosed retained copies of the previous bashrc bytes ---

test("hook install writes no rocky-home assets before a topology refusal", (t) => {
  const sandbox = bashrcSandbox(t);
  const real = join(sandbox.home, "real-bashrc");
  writeFileSync(real, bytes("export A=1\n"));
  let symlinkAvailable = true;
  try {
    symlinkSync(real, sandbox.bashrc);
  } catch {
    symlinkAvailable = false;
  }
  if (!symlinkAvailable) return;

  assert.equal(hookInstall(), 1);

  assert.match(sandbox.stderr(), /symlink/);
  assert.equal(
    existsSync(process.env.ROCKY_HOME as string),
    false,
    "no ~/.rocky assets written ahead of an \"I touch nothing\" refusal",
  );
});

test("hook install reports the retained copy of the previous bashrc instead of staying silent", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n");
  writeFileSync(sandbox.bashrc, original);

  assert.equal(hookInstall(), 0, sandbox.stderr());

  const [transactionDirectory] = transactionDirectories(sandbox.home);
  assert.ok(transactionDirectory !== undefined);
  const recoveryPath = join(sandbox.home, transactionDirectory, "displaced");
  assert.ok(existsSync(recoveryPath));
  assert.ok(sandbox.stderr().includes(recoveryPath), "the retained copy path is disclosed");
  assert.ok(!sandbox.stderr().includes("SECRET_TOKEN"), "diagnostics stay secret-free");
});

test("hook install discloses a retained copy on refusal instead of claiming it touches nothing", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n");
  writeFileSync(sandbox.bashrc, original);
  const concurrent = bytes("export LATE_WRITER=wins\n");
  injectConcurrentEdit(t, sandbox.bashrc, concurrent);

  assert.equal(hookInstall(), 1);

  assert.deepEqual(readFileSync(sandbox.bashrc), concurrent, "user bytes win");
  assert.ok(
    !sandbox.stderr().includes("I touch nothing"),
    "must not claim it touched nothing while a copy was written",
  );
  const [transactionDirectory] = transactionDirectories(sandbox.home);
  assert.ok(transactionDirectory !== undefined);
  assert.ok(sandbox.stderr().includes(join(sandbox.home, transactionDirectory, "displaced")));
});

test("repeated install/uninstall cycles keep only the most recent retained copy", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n");
  writeFileSync(sandbox.bashrc, original);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    assert.equal(hookInstall(), 0, sandbox.stderr());
    assert.equal(hookUninstall(), 0, sandbox.stderr());
  }

  const remaining = transactionDirectories(sandbox.home);
  assert.equal(remaining.length, 1, `expected exactly one retained copy, got ${remaining.length}`);
  // The first add/remove cycle leaves one separator blank line behind (pinned
  // by "removeHookBlockBytes after addHookBlockBytes leaves only the
  // separator line"); later cycles reuse it and must not add another.
  assert.deepEqual(readFileSync(sandbox.bashrc), Buffer.concat([original, bytes("\n")]));
});

// --- Important 1: a completed-but-unrecorded crash window must not brick install/uninstall ---

/**
 * Fails the Nth manifest write (counting `openSync(..., "wx")` calls whose
 * path ends in `manifest.tmp`) exactly once. Manifests are written in order
 * prepared -> displaced -> published, so N=3 fails the "published" manifest
 * specifically: the bashrc write has already published (linked to the new
 * bytes, nlink 2) but the manifest never advances past "displaced" —
 * deterministically reproducing the reviewer's real-SIGKILL window without
 * any sleep or an actual crash.
 */
function injectFailureBeforeNthManifestWrite(t: TestContext, n: number): void {
  const originalOpen = fs.openSync;
  let manifestWrites = 0;
  let fired = false;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const [target, flags] = args;
    if (!fired && typeof target === "string" && target.endsWith("manifest.tmp") && flags === "wx") {
      manifestWrites += 1;
      if (manifestWrites === n) {
        fired = true;
        throw new Error("injected crash before a manifest write");
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

test("hook install recovers instead of permanently bricking after a completed-but-unrecorded crash", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export A=1\n");
  writeFileSync(sandbox.bashrc, original);
  injectFailureBeforeNthManifestWrite(t, 3); // fails exactly the "published" manifest write

  // The crash lands here: the write already published, but the manifest
  // could not record it. Before the fix, every later `hook install` and
  // `hook uninstall` call returned exit 1 forever with "write stops halfway"
  // — even though the write had, in fact, fully succeeded.
  assert.equal(hookInstall(), 1);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "pending");
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes(`export A=1\n\n${BLOCK}`), "already published");

  // A later run (the injected fault only fires once) must recover and settle
  // cleanly instead of reporting the same dead end forever.
  assert.equal(hookInstall(), 0, sandbox.stderr());
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes(`export A=1\n\n${BLOCK}`));
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");

  assert.equal(hookUninstall(), 0, sandbox.stderr());
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes("export A=1\n\n"));

  // `hook status` must never have contradicted this: it settles the same way.
});
