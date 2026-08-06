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
  artifacts: { displaced?: Buffer; prepared?: Buffer } = {},
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
  if (artifacts.prepared !== undefined) {
    writeFileSync(join(directory, "prepared"), artifacts.prepared);
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

// --- Important 2: the recovery boundary must be complete, not arbitrary ----

/**
 * Fails the single-argument `rmSync(temporaryPath)` unlink of the
 * transaction's own `prepared` artifact — the step right after the
 * "published" manifest write lands. Matched narrowly (no options object,
 * basename "prepared") so it cannot fire on any other `rmSync` call.
 */
function injectFailureOnPreparedUnlink(t: TestContext): void {
  const originalRm = fs.rmSync;
  let fired = false;
  fs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
    const [target, options] = args;
    if (!fired && typeof target === "string" && options === undefined && basename(target) === "prepared") {
      fired = true;
      throw new Error("injected unlink failure after publish");
    }
    return originalRm(...args);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  });
}

test("hook install recovers instead of permanently bricking after a published-but-uncommitted crash (Important 2, W2)", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export A=1\n");
  writeFileSync(sandbox.bashrc, original);
  injectFailureOnPreparedUnlink(t);

  // The crash lands here: the manifest already says "published" (stronger
  // evidence than the "displaced" window round 1 resolved), but round 1
  // still returned "manual" forever for this exact shape.
  assert.equal(hookInstall(), 1);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "pending");
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes(`export A=1\n\n${BLOCK}`), "already published");

  assert.equal(hookInstall(), 0, sandbox.stderr());
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes(`export A=1\n\n${BLOCK}`));
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");

  assert.equal(hookUninstall(), 0, sandbox.stderr());
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes("export A=1\n\n"));
});

// --- Important 1: guidance must never name bashrc itself for removal -------

test("hook status never tells the user to remove their own bashrc, even when the retained transaction directory vanishes mid-cleanup (Important 1)", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n");
  writeFileSync(sandbox.bashrc, original);
  // "prepared", no displaced: reaches the unconditional-discard branch, which
  // calls removeTransaction — exactly the reviewer's reproduction shape.
  writePendingTransactionFixture(sandbox.bashrc, "prepared");

  // Real fault injection, no sleep, no real crash: rmSync of the transaction
  // directory succeeds, but the parent-directory fsync (an EIO on $HOME)
  // throws, so removeTransaction reports failure even though the directory
  // is already gone.
  const originalSync = directorySyncCapability.sync;
  directorySyncCapability.sync = () => {
    throw new Error("injected EIO on $HOME fsync");
  };
  t.after(() => {
    directorySyncCapability.sync = originalSync;
  });

  const result = hookStatus();

  assert.equal(result, 1);
  const output = sandbox.stderr();
  assert.ok(!output.includes("remove by hand"), "no removal instruction when nothing provable survives");
  assert.ok(!output.includes("I keep safe copy"), "must not claim a safe copy exists when none does");
  assert.match(output, /no safe copy to name/);
  assert.deepEqual(readFileSync(sandbox.bashrc), original, "bashrc itself is untouched");
  assert.ok(!output.includes("SECRET_TOKEN"), "diagnostics stay secret-free");
});

// --- Minor 1: status must disclose, not silently absorb, a settled recovery ---

test("hook status discloses a retained copy left behind by settling someone else's interrupted transaction", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n");
  writeFileSync(sandbox.bashrc, original);
  injectPostPublishParentFsyncFailure(t, sandbox.bashrc);

  // This run crashes mid-publish (the W1 window round 1 already resolves)
  // and leaves a pending transaction behind — not status's own doing.
  assert.equal(hookInstall(), 1);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "pending");
  const before = sandbox.stderr().length;

  const result = hookStatus();

  assert.equal(result, 0, sandbox.stderr());
  const statusOutput = sandbox.stderr().slice(before);
  assert.ok(
    statusOutput.includes("I keep safe copy"),
    "status discloses the settled recovery instead of silently absorbing it",
  );
  assert.ok(!statusOutput.includes("SECRET_TOKEN"), "diagnostics stay secret-free");
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "clear");
  assert.match(sandbox.stderr(), /ears installed/);
});

// --- Minor 3: hookUninstall's disclosure must be pinned too (M15) ----------

test("hook uninstall reports the retained copy of the previous bashrc instead of staying silent", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n\n${BLOCK}`);
  writeFileSync(sandbox.bashrc, original);

  assert.equal(hookUninstall(), 0, sandbox.stderr());

  const [transactionDirectory] = transactionDirectories(sandbox.home);
  assert.ok(transactionDirectory !== undefined);
  const recoveryPath = join(sandbox.home, transactionDirectory, "displaced");
  assert.ok(existsSync(recoveryPath));
  assert.ok(sandbox.stderr().includes(recoveryPath), "the retained copy path is disclosed");
  assert.ok(!sandbox.stderr().includes("SECRET_TOKEN"), "diagnostics stay secret-free");
});

// --- Minor 4: a stray transaction directory with no manifest must degrade informatively ---

test("hook status degrades informatively instead of failing hard on a stray transaction directory with no manifest", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export A=1\n");
  writeFileSync(sandbox.bashrc, original);
  const junk = join(sandbox.home, "..bashrc.transaction-junk");
  mkdirSync(junk, { mode: 0o700 }); // no manifest.json at all — no `displaced` either

  const result = hookStatus();

  assert.equal(result, 1, "status must not crash or silently claim installed");
  assert.deepEqual(readFileSync(sandbox.bashrc), original, "bashrc itself is untouched");
  assert.ok(sandbox.stderr().includes(junk), "the stray directory is named so the user can inspect it");
  assert.match(sandbox.stderr(), /bashrc keeps unclear transaction/);
  // Final audit, Important 2: this exact fixture — an empty directory,
  // nothing proving a copy of anything — is the shape the previous version
  // of this test built while the code spoke "I keep safe copy" over it. That
  // was false: an empty directory is not a copy. This test previously never
  // checked for the false claim's absence, so the suite stayed green on it.
  // Corrected here to pin the honest message instead.
  assert.ok(
    !sandbox.stderr().includes("I keep safe copy"),
    "must not claim a safe copy exists over a directory proven to hold no copy",
  );
  assert.ok(
    !sandbox.stderr().includes("remove by hand"),
    "must not instruct removal when nothing provable survives",
  );
});

// --- Final audit, Important 2/3: prove the artifact, not the path ----------

test("hook status names the surviving copy without inviting its removal when bashrc itself is gone (Important 3)", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n");
  // bashrc itself does NOT exist — the transaction directory's `displaced`
  // copy is the only surviving place holding it. This is exactly the
  // round-5-added guard's own shape (published, target absent, displaced
  // present) and it must never invite destroying the last copy.
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "published", {
    displaced: original,
  });

  const result = hookStatus();

  assert.equal(result, 1);
  const output = sandbox.stderr();
  assert.ok(!output.includes("remove by hand"), "must never invite deleting the only surviving copy");
  assert.ok(
    output.includes(join(fixture, "displaced")),
    "the surviving copy's exact path is still named, so the user can find it",
  );
  assert.ok(!output.includes("SECRET_TOKEN"), "diagnostics stay secret-free");
  assert.equal(existsSync(join(fixture, "displaced")), true, "the copy itself is left untouched");
  // Round 6 named the copy's path but never pinned that a *remedy* comes
  // with it — the whole sentence was deletable with a green suite (final
  // audit, F9 mutant A9). Strengthened here, not just re-asserted.
  assert.ok(
    output.includes("restore by copying that file to the bashrc path yourself"),
    "the last-surviving-copy case must give a remedy, not just name the path (A9)",
  );
});

/**
 * Races a "missing-prior" install (`.bashrc` did not exist) so `linkSync`
 * throws EEXIST against a concurrently-created `path` (a real, independent
 * write to `bashrc`, not Rocky's own), then fails only the very next parent
 * fsync — matching `removeTransaction`'s own follow-up sync after its
 * `rmSync` already succeeded. This is the one real site (`file-transaction.ts`'s
 * missing-prior `EEXIST` catch) where the engine can still hand back `path`
 * itself as a `recovery-required` `recoveryPath` (final audit, Minor 3/N1) —
 * `destinationPublished` is false there, so it is not covered by the
 * "already-published, already correct" reasoning that applies to the sites
 * left alone. `hook.ts`'s message layer must independently refuse to ever
 * name bashrc's own path as a transaction artifact.
 */
function injectMissingPriorLinkRaceWithPhantomRemoval(t: TestContext, bashrc: string, concurrent: Buffer): void {
  const originalLink = fs.linkSync;
  const originalSync = directorySyncCapability.sync;
  let raced = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!raced && String(newPath) === bashrc) {
      raced = true;
      writeFileSync(bashrc, concurrent); // a concurrent writer wins the race
      const error = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  directorySyncCapability.sync = (directoryPath: string) => {
    if (raced && directoryPath === dirname(bashrc)) {
      throw new Error("injected EIO on $HOME fsync, after removeTransaction's rmSync already succeeded");
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

test("hook install never offers bashrc itself as something to remove, even when a concurrent writer races the missing-prior publish (N1)", (t) => {
  const sandbox = bashrcSandbox(t);
  const concurrent = bytes("export CONCURRENT_WRITER=wins\n");
  // bashrc absent: prior.status === "missing".
  injectMissingPriorLinkRaceWithPhantomRemoval(t, sandbox.bashrc, concurrent);

  const result = hookInstall();

  assert.equal(result, 1);
  const output = sandbox.stderr();
  assert.ok(!output.includes("remove by hand"), "must never instruct removing bashrc itself");
  assert.ok(!output.includes("I keep safe copy"), "must not claim a safe copy when only bashrc itself was named");
  assert.ok(!output.includes("transaction directory:"), "must not name bashrc's own path as a transaction directory");
  // The transaction directory itself was actually removed here (rmSync
  // succeeded; only the follow-up fsync threw) — round 7's outcome record
  // must reflect that a removed directory is never named for inspection
  // either, under the new wording (final audit, F9 mutant A4's analogue:
  // the "does this still exist" proof, not a file/directory shape guess).
  assert.ok(
    !output.includes("inspect before removing"),
    "must not claim a directory survives to inspect when it was actually removed",
  );
  assert.match(output, /no safe copy to name/);
  assert.deepEqual(readFileSync(sandbox.bashrc), concurrent, "the concurrent writer's bytes are untouched");
});

// --- Final audit, Important 1: settling can (re-)create bashrc, not just keep a copy ---

test("hook status says plainly when settling has to put bashrc back, not just that a copy exists", (t) => {
  const sandbox = bashrcSandbox(t);
  // bashrc absent; a prior crashed install/uninstall left a restorable backup.
  const original = bytes("export RESTORE_ME=please\n");
  writePendingTransactionFixture(sandbox.bashrc, "displaced", { displaced: original });
  assert.equal(existsSync(sandbox.bashrc), false, "bashrc absent before status runs");

  const result = hookStatus();

  assert.equal(result, 0, sandbox.stderr());
  assert.deepEqual(readFileSync(sandbox.bashrc), original, "settling restored bashrc from the retained copy");
  const output = sandbox.stderr();
  assert.ok(
    output.includes("I already put old bytes back"),
    "status must say it recreated bashrc, not only that a copy exists",
  );
  assert.ok(!output.includes("RESTORE_ME"), "diagnostics stay secret-free");
});

test("hook install also discloses settling having to put bashrc back, separately from its own write", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export RESTORE_ME=please\n");
  writePendingTransactionFixture(sandbox.bashrc, "displaced", { displaced: original });

  const result = hookInstall();

  assert.equal(result, 0, sandbox.stderr());
  assert.deepEqual(readFileSync(sandbox.bashrc), bytes(`export RESTORE_ME=please\n\n${BLOCK}`));
  assert.ok(
    sandbox.stderr().includes("I already put old bytes back"),
    "install must disclose the settle-time restore, not only its own new write",
  );
});

test("hook status discloses a retained copy that settling only finalized, without falsely claiming bashrc was recreated", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n");
  writeFileSync(sandbox.bashrc, original);
  injectPostPublishParentFsyncFailure(t, sandbox.bashrc);

  // bashrc already held the new bytes before this call — settling only
  // finalizes the manifest bookkeeping, it never (re)writes bashrc itself.
  assert.equal(hookInstall(), 1);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "pending");

  const result = hookStatus();

  assert.equal(result, 0, sandbox.stderr());
  const output = sandbox.stderr();
  assert.ok(output.includes("I keep safe copy"), "still discloses the retained copy");
  assert.ok(
    !output.includes("I already put old bytes back"),
    "must not claim bashrc was recreated when it was already live the whole time",
  );
});

// --- Final audit, Minor 2 (N6): status's own prune call is unpinned --------

test("hook status prunes a superseded retained copy when it settles a fresh one (N6)", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export GEN1_SUPERSEDED=drop-me\n");
  writeFileSync(sandbox.bashrc, original);

  // GEN1: a normal install leaves one committed retained copy holding `original`.
  assert.equal(hookInstall(), 0, sandbox.stderr());
  const [gen1] = transactionDirectories(sandbox.home);
  assert.ok(gen1 !== undefined);
  assert.equal(transactionDirectories(sandbox.home).length, 1);

  // GEN2: uninstall crashes after publish but before the parent fsync,
  // leaving a second, pending transaction behind.
  injectPostPublishParentFsyncFailure(t, sandbox.bashrc);
  assert.equal(hookUninstall(), 1);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "pending");
  assert.equal(transactionDirectories(sandbox.home).length, 2, "GEN1 committed + GEN2 pending");

  const result = hookStatus();

  assert.equal(result, 0, sandbox.stderr());
  assert.ok(sandbox.stderr().includes("I keep safe copy"), "the surviving GEN2 copy is disclosed before pruning");
  const remaining = transactionDirectories(sandbox.home);
  assert.equal(remaining.length, 1, "status prunes the superseded GEN1 copy when it settles GEN2");
  assert.ok(!remaining.includes(gen1), "the older, now-superseded copy is gone");
});

// --- Round 7 final audit: an outcome record, not a live filesystem check,
// drives every recovery message. F1/F2/F3 reproduced exactly as the auditor
// did (PROBE A, PROBE B, PROBE G). -------------------------------------

/**
 * Fails the first `fs.writeSync` call, landing inside `writeDescriptorCompletely`
 * — the byte-copy loop `copyRegularFileExclusiveNoFollow` uses to restore a
 * displaced backup. Nothing else in a settle/status invocation calls raw
 * `writeSync` before that point. Matches the final audit's PROBE A exactly.
 */
function injectRecoveryWriteEnospc(t: TestContext): void {
  const originalWriteSync = fs.writeSync;
  let injected = false;
  (fs as unknown as { writeSync: typeof fs.writeSync }).writeSync = ((
    ...args: Parameters<typeof fs.writeSync>
  ) => {
    if (!injected) {
      injected = true;
      const error = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    }
    return originalWriteSync(...args);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.writeSync = originalWriteSync;
    syncBuiltinESMExports();
  });
}

test("hook status reports an interrupted restore honestly instead of claiming to touch nothing (round 7, F1, PROBE A)", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\nalias ll='ls -l'\n");
  // bashrc absent; a prior crashed install/uninstall left a restorable
  // backup — PROBE A's exact fixture.
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "displaced", { displaced: original });
  injectRecoveryWriteEnospc(t);

  const result = hookStatus();

  assert.equal(result, 1);
  const output = sandbox.stderr();
  // Before this round: Rocky created a truncated bashrc during the failed
  // restore (openSync(O_CREAT|O_EXCL) lands before the injected write
  // fails), then said "I touch nothing more" and pointed removal at the
  // displaced copy — the only intact copy left. Both are now false claims
  // this round refuses to make.
  assert.equal(existsSync(sandbox.bashrc), true, "the failed restore left a broken bashrc behind");
  assert.equal(readFileSync(sandbox.bashrc).length, 0, "the broken bashrc holds zero bytes, not real content");
  assert.ok(!output.includes("I touch nothing more"), "must not claim nothing was touched after creating bashrc");
  assert.ok(!output.includes("remove by hand"), "no removal instruction is ever spoken from an ambiguous stop");
  assert.ok(output.includes("inspect:"), "actionable guidance still names the surviving copy");
  assert.ok(output.includes(join(fixture, "displaced")), "the surviving copy is still named for inspection");
  assert.deepEqual(readFileSync(join(fixture, "displaced")), original, "the only intact copy is never destroyed");
  assert.ok(!output.includes("SECRET_TOKEN"), "diagnostics stay secret-free");
});

test("hook commands give actionable guidance instead of a permanent dead end on a published transaction with no displaced backup (round 7, F2, PROBE B)", (t) => {
  const sandbox = bashrcSandbox(t);
  // bashrc absent; txdir manifest state="published", prepared = exactly
  // what a crashed missing-prior install leaves (the hook block over zero
  // prior content) — PROBE B's exact fixture.
  const staged = addHookBlockBytes(Buffer.alloc(0));
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "published", { prepared: staged });

  for (const attempt of [hookStatus, hookInstall, hookUninstall, hookStatus]) {
    const result = attempt();
    assert.equal(result, 1, "no path resolves this ambiguous shape into a silent success");
    const output = sandbox.stderr();
    assert.ok(!output.includes("I keep safe copy"), "no copy is proven for a prepared-only artifact");
    assert.ok(!output.includes("remove by hand"), "never a destructive imperative");
    assert.ok(output.includes(fixture), "the directory is named so the user has something to inspect");
    assert.ok(
      output.includes("inspect before removing"),
      "the message gives a remedy instead of a bare path with no verb (F2's escape hatch)",
    );
    assert.equal(existsSync(fixture), true, "nothing is silently discarded");
  }
  assert.equal(existsSync(sandbox.bashrc), false, "bashrc is never created by any of the four attempts");
});

test("hook status never deletes the only surviving copy of a prepared write, and never reports false success over it (round 7, F3, PROBE G)", (t) => {
  const sandbox = bashrcSandbox(t);
  // bashrc absent; txdir manifest state="prepared", prepared = the ONLY
  // surviving copy of the user's content plus the hook block — PROBE G's
  // exact fixture. Before this round, "prepared" was discarded
  // unconditionally regardless of `path`, deleting this silently.
  const staged = bytes("export USER_SECRET=only-copy\n\n# >>> rocky hook >>>\n");
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "prepared", { prepared: staged });

  const result = hookStatus();

  assert.equal(result, 1, "status must not silently discard the only surviving copy and exit 0");
  const output = sandbox.stderr();
  assert.ok(!output.includes("ears not installed"), "must not report false success over a destroyed transaction");
  assert.equal(existsSync(fixture), true, "the transaction directory survives");
  assert.equal(
    existsSync(join(fixture, "prepared")),
    true,
    "the only surviving copy of the user's bytes is not deleted",
  );
  assert.deepEqual(readFileSync(join(fixture, "prepared")), staged, "the surviving bytes are untouched");
  assert.ok(output.includes(fixture), "the directory is named");
  assert.ok(!output.includes("USER_SECRET"), "diagnostics stay secret-free");
});

// --- Round 7 final audit, Minors F4/F5/F6 ----------------------------------

test("hook install never promises permanence for a settle-disclosed copy its own publish supersedes (round 7, F4)", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes(`export A=1\n\n${BLOCK}`);
  writeFileSync(sandbox.bashrc, original);

  // Inline, resettable version of `injectPostPublishParentFsyncFailure`:
  // that helper's fault stays permanently live once triggered, which would
  // also break this test's own SECOND write below. Only the first crash
  // may be faulted — there must be exactly one interrupted transaction to
  // settle, not two.
  const originalLink = fs.linkSync;
  const originalSync = directorySyncCapability.sync;
  let published = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    originalLink(existingPath, newPath);
    if (String(newPath) === sandbox.bashrc) published = true;
  }) as typeof fs.linkSync;
  directorySyncCapability.sync = (directoryPath: string) => {
    if (published && directoryPath === dirname(sandbox.bashrc)) {
      throw new Error("injected fsync failure");
    }
    return true;
  };
  syncBuiltinESMExports();

  // hookUninstall crashes after publish, leaving a pending transaction a
  // later invocation must settle before proceeding.
  assert.equal(hookUninstall(), 1);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "pending");

  fs.linkSync = originalLink;
  directorySyncCapability.sync = originalSync;
  syncBuiltinESMExports();

  // hookInstall settles that stale transaction (disclosing it), then
  // performs its own fresh write — disclosing a second, different copy —
  // and its own prune supersedes the first.
  const result = hookInstall();

  assert.equal(result, 0, sandbox.stderr());
  const output = sandbox.stderr();
  const promises = (output.match(/yours to remove, any time/g) ?? []).length;
  assert.equal(
    promises,
    1,
    "only the final, genuinely-last write may promise permanence — not a settled copy this same call supersedes",
  );
  assert.ok(output.includes("I keep safe copy"), "the settled copy is still disclosed, just without the broken promise");
});

test("hook install never says a transaction is 'from before' when it is this very call's own write (round 7, F5)", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export A=1\n");
  writeFileSync(sandbox.bashrc, original);
  injectPostPublishParentFsyncFailure(t, sandbox.bashrc);

  const result = hookInstall();

  assert.equal(result, 1);
  const output = sandbox.stderr();
  assert.ok(
    !output.includes("from before"),
    "this call's own write turning ambiguous is not a transaction from before",
  );
  assert.match(output, /bashrc write leaves unclear state/);
});

test("hook status discloses what settling did even when it cannot then check bashrc itself (round 7, F6)", (t) => {
  const sandbox = bashrcSandbox(t);
  const original = bytes("export SECRET_TOKEN=sk-live-DO-NOT-LEAK\n");
  writeFileSync(sandbox.bashrc, original);
  injectPostPublishParentFsyncFailure(t, sandbox.bashrc);
  assert.equal(hookInstall(), 1);
  assert.equal(inspectFileTransaction(sandbox.bashrc).status, "pending");

  // Fires only on the 3rd `lstatSync(bashrc)` call during the next
  // settle+check: calls 1-2 belong to `recoverFileTransaction`'s own
  // internal proofs (which must succeed for settling to finish and
  // disclose); call 3 is `prepareBashrc`'s own post-settle topology check,
  // the one this finding is about. Calibrated empirically against this
  // exact fixture, not guessed.
  const originalLstat = fs.lstatSync;
  let calls = 0;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((
    ...args: Parameters<typeof fs.lstatSync>
  ) => {
    if (args[0] === sandbox.bashrc) {
      calls += 1;
      if (calls === 3) {
        const error = new Error("injected EACCES on bashrc lstat") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
    }
    return originalLstat(...args);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  t.after(() => {
    (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstat;
    syncBuiltinESMExports();
  });

  const result = hookStatus();

  assert.equal(result, 1);
  const output = sandbox.stderr();
  assert.match(output, /I cannot check bashrc/);
  assert.ok(
    output.includes("I keep safe copy"),
    "settling's own mutation must still be disclosed before this stop, not suppressed by it",
  );
  assert.ok(!output.includes("SECRET_TOKEN"), "diagnostics stay secret-free");
});

// --- Round 7 final audit, F9 coverage gaps (A1) ----------------------------

test("hook status never claims a safe copy exists when the displaced artifact is not a proven regular file (round 7, F9 A1)", (t) => {
  const sandbox = bashrcSandbox(t);
  const elsewhere = join(sandbox.home, "elsewhere.txt");
  writeFileSync(elsewhere, "not the real backup\n");
  const fixture = writePendingTransactionFixture(sandbox.bashrc, "published");
  let symlinkAvailable = true;
  try {
    symlinkSync(elsewhere, join(fixture, "displaced"));
  } catch {
    symlinkAvailable = false; // Some platforms require privilege for symlinks.
  }
  if (!symlinkAvailable) return;

  const result = hookStatus();

  assert.equal(result, 1);
  const output = sandbox.stderr();
  assert.ok(
    !output.includes("I keep safe copy"),
    "a symlinked displaced artifact must never be claimed as a proven copy (the .isFile() proof, not a bare existence check)",
  );
  assert.ok(!output.includes("safe copy:"), "no copy path is asserted over an unproven artifact");
  assert.equal(lstatSync(join(fixture, "displaced")).isSymbolicLink(), true, "the symlink itself is left untouched");
});
