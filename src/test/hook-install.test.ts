import test, { before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addHookBlock, hasHookBlock, hookInstall, hookUninstall, removeHookBlock } from "../commands/hook.js";
import { phrase, validateRockyPhrase } from "../ui/phrases.js";

const BLOCK_RE = /# >>> rocky hook >>>[\s\S]*# <<< rocky hook <<</;
const DISCLOSURE = "bashrc is write-protected. I replace it anyway. your lines stay.";

test("addHookBlock appends managed block once", () => {
  const once = addHookBlock("# my bashrc\nalias ll='ls -l'\n");
  assert.match(once, BLOCK_RE);
  const twice = addHookBlock(once);
  assert.equal(twice, once, "idempotent");
  assert.equal(twice.match(/rocky hook >>>/g)?.length, 1);
});

test("removeHookBlock strips block and leaves rest intact", () => {
  const content = addHookBlock("# my bashrc\nalias ll='ls -l'\n");
  const removed = removeHookBlock(content);
  assert.ok(!hasHookBlock(removed));
  assert.ok(removed.includes("alias ll='ls -l'"));
  assert.equal(removeHookBlock(removed), removed, "idempotent on absent block");
});

test("removeHookBlock leaves content unchanged when END marker is missing", () => {
  // BEGIN present, END hand-deleted: nothing may be stripped, the bashrc tail survives
  const content = "# my bashrc\n# >>> rocky hook >>>\nalias ll='ls -l'\nexport EDITOR=vim\n";
  assert.equal(removeHookBlock(content), content, "truncated block: return content byte-for-byte");
});

// --- write-protected bashrc disclosure --------------------------------------

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

before(() => {
  // hookInstall expects its shell assets next to the compiled commands
  // (matches hook-block.test.ts's fixture — this file is filtered to run
  // alone via `node scripts/test.mjs hook-install`, so it cannot rely on
  // another test file's before() hook having already copied them).
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
  bashrc: string;
  stderr: () => string;
}

function bashrcSandbox(t: TestContext): BashrcSandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ROCKY_HOME: process.env.ROCKY_HOME,
    ROCKY_TEST_POWERSHELL_HOSTS: process.env.ROCKY_TEST_POWERSHELL_HOSTS,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ROCKY_HOME = join(root, "rocky-home");
  // This sandbox exercises bashrc only — see the identical note in
  // hook-block.test.ts's bashrcSandbox.
  process.env.ROCKY_TEST_POWERSHELL_HOSTS = "[]";
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

  return { bashrc: join(home, ".bashrc"), stderr: () => chunks.join("") };
}

test("bashrc write-protected disclosure follows Rocky voice rules", () => {
  assert.deepEqual(validateRockyPhrase(DISCLOSURE), []);
});

test("hookInstall discloses a write-protected bashrc, replaces it anyway, keeps mode and user lines", (t) => {
  // Root bypasses the file mode entirely (chmod 0o400 would not stop the
  // write), so this case would pass for the wrong reason under root.
  if (process.getuid?.() === 0) {
    t.skip("root bypasses file mode; write-protection cannot be exercised");
    return;
  }
  const sandbox = bashrcSandbox(t);
  writeFileSync(sandbox.bashrc, "export MY_VAR=1\n");
  chmodSync(sandbox.bashrc, 0o400);

  assert.equal(hookInstall(), 0, sandbox.stderr());

  assert.ok(sandbox.stderr().includes(DISCLOSURE), sandbox.stderr());
  // Windows has no per-class permission bits: chmod(0o400) sets the
  // read-only attribute, and stat reports back 0o444, not 0o400. The bit
  // that actually matters on both platforms is the owner write bit staying
  // absent (0o400 on POSIX, 0o444 on Windows both clear it) — that's what
  // proves the file is still write-protected, not the exact POSIX octal.
  assert.equal(lstatSync(sandbox.bashrc).mode & 0o200, 0, "owner write bit must stay absent: still write-protected");
  const content = readFileSync(sandbox.bashrc, "utf8");
  assert.ok(content.includes("export MY_VAR=1"), "user line survives");
  assert.match(content, BLOCK_RE);
});

test("hookUninstall discloses a write-protected bashrc, replaces it anyway, keeps mode and user lines", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses file mode; write-protection cannot be exercised");
    return;
  }
  const sandbox = bashrcSandbox(t);
  writeFileSync(sandbox.bashrc, addHookBlock("export MY_VAR=1\n"));
  chmodSync(sandbox.bashrc, 0o400);

  assert.equal(hookUninstall(), 0, sandbox.stderr());

  assert.ok(sandbox.stderr().includes(DISCLOSURE), sandbox.stderr());
  // See the parallel hookInstall test above: Windows reports 0o444 (no
  // per-class bits, chmod just sets read-only), not POSIX's 0o400, so assert
  // the owner write bit is absent rather than the exact octal.
  assert.equal(lstatSync(sandbox.bashrc).mode & 0o200, 0, "owner write bit must stay absent: still write-protected");
  const content = readFileSync(sandbox.bashrc, "utf8");
  assert.ok(content.includes("export MY_VAR=1"), "user line survives");
  assert.ok(!hasHookBlock(content), "hook block removed");
});

test("hookInstall never prints the write-protected disclosure for an ordinary mode-644 bashrc", (t) => {
  const sandbox = bashrcSandbox(t);
  writeFileSync(sandbox.bashrc, "export MY_VAR=1\n");
  chmodSync(sandbox.bashrc, 0o644);

  assert.equal(hookInstall(), 0, sandbox.stderr());

  assert.ok(!sandbox.stderr().includes(DISCLOSURE), sandbox.stderr());
});

test("hook install discloses that it changes the shell history setting", (t) => {
  // bash-preexec strips ignorespace/ignoreboth from HISTCONTROL so it can read
  // commands via `history 1`. A command typed with a leading space — the usual
  // way to keep a token out of shell history — starts being recorded. Rocky
  // changes it, so Rocky has to say it.
  const sandbox = bashrcSandbox(t);
  writeFileSync(sandbox.bashrc, "export MY_VAR=1\n");

  assert.equal(hookInstall(), 0, sandbox.stderr());
  assert.ok(sandbox.stderr().includes(phrase("hook-histcontrol")), sandbox.stderr());
  assert.deepEqual(validateRockyPhrase(phrase("hook-histcontrol")), []);
});
