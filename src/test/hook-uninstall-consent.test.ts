import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasHookBlock, ROCKY_HOOK_PROTOCOL_VERSION } from "../commands/hook.js";
import { hookUninstallCommand } from "../commands/hook-uninstall.js";
import { addHookBlockBytes, removeHookBlockBytes } from "../core/hook-block.js";
import { runAutoCommand } from "../setup/auto/command.js";
import type { AutoContext } from "../setup/auto/engine.js";
import type { ShellHookPort } from "../setup/auto/shell.js";
import {
  consentFile,
  readConsentRecord,
  readExpected,
  writeConsentRecord,
  writeExpected,
  type ConsentState,
} from "../setup/auto/state.js";
import { validateOutputLine } from "../ui/phrases.js";

interface Fixture {
  root: string;
  home: string;
  rh: string;
  ctx: AutoContext;
  portUninstallCalls: () => number;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fakeShellPort(
  home: string,
  rockyHome: string,
  uninstallExit: number,
  onUninstall: () => void,
): ShellHookPort {
  const bashrc = join(home, ".bashrc");
  const script = (): void => {
    writeFileSync(
      join(rockyHome, "rocky-hook.bash"),
      `# fixture\nROCKY_HOOK_VERSION="${ROCKY_HOOK_PROTOCOL_VERSION}"\n`,
    );
    if (process.platform === "win32") {
      writeFileSync(
        join(rockyHome, "rocky-hook.ps1"),
        `# fixture\nROCKY_HOOK_VERSION="${ROCKY_HOOK_PROTOCOL_VERSION}"\n`,
      );
    }
  };
  return {
    install: () => {
      const current = existsSync(bashrc) ? readFileSync(bashrc) : Buffer.from("");
      writeFileSync(bashrc, addHookBlockBytes(current));
      script();
      return 0;
    },
    uninstall: () => {
      onUninstall();
      if (uninstallExit !== 0) return uninstallExit;
      if (existsSync(bashrc)) writeFileSync(bashrc, removeHookBlockBytes(readFileSync(bashrc)));
      return 0;
    },
    bashrcPath: () => bashrc,
    powerShellProfiles: () => [],
    rockyHome: () => rockyHome,
  };
}

function fixture(t: TestContext, options: { uninstallExit?: number } = {}): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-hook-uninstall-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const rh = join(root, "rocky-home");
  mkdirSync(home);
  mkdirSync(rh);
  let calls = 0;
  return {
    root,
    home,
    rh,
    portUninstallCalls: () => calls,
    ctx: {
      rockyHome: rh,
      detect: { home, env: {}, platform: process.platform, fileExists: existsSync, isFile },
      paths: { nodePath: process.execPath, entryPath: join(root, "entry.js") },
      registration: {
        name: "rocky",
        command: process.execPath,
        args: [join(root, "entry.js"), "mcp"],
        env: { ROCKY_HOME: rh, ROCKY_MCP_EXPOSURE: "sanitized" },
      },
      shell: fakeShellPort(home, rh, options.uninstallExit ?? 0, () => {
        calls += 1;
      }),
      now: () => 1_700_000_000_000,
    },
  };
}

function seedConsent(rh: string, state: ConsentState | "invalid" | "absent"): void {
  if (state === "absent") return;
  const path = consentFile(rh);
  if (state === "invalid") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{nope", "utf8");
    assert.equal(readConsentRecord(rh).status, "invalid");
    return;
  }
  writeConsentRecord(rh, {
    v: 1,
    scope: 1,
    state,
    at: 1,
    harness_off: [],
    shell_hook: true,
    config_dirs: {},
  });
  assert.equal(readConsentRecord(rh).status, "valid");
}

async function captureOutput(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

test("approved consent: hook uninstall records shell off and drops shell expectations", async (t) => {
  const f = fixture(t);
  await runAutoCommand(["consent", "approve", "--json"], f.ctx, () => {});
  const bashrc = join(f.home, ".bashrc");
  assert.equal(hasHookBlock(readFileSync(bashrc, "utf8")), true);
  assert.ok(readExpected(f.rh).files.some((file) => file.path === bashrc));

  const output = await captureOutput(() => hookUninstallCommand({
    rockyHome: f.rh,
    buildContext: () => f.ctx,
    uninstall: () => {
      assert.fail("legacy uninstall must not run while consent is approved");
    },
  }));

  assert.equal(output.code, 0);
  const read = readConsentRecord(f.rh);
  assert.equal(read.status === "valid" && read.record.state, "approved");
  assert.equal(read.status === "valid" && read.record.shell_hook, false);
  assert.ok(readExpected(f.rh).files.every((file) => file.path !== bashrc));
  assert.ok(readExpected(f.rh).files.every((file) => !file.path.endsWith("rocky-hook.bash") && !file.path.endsWith("rocky-hook.ps1")));
  assert.equal(hasHookBlock(readFileSync(bashrc, "utf8")), false);
  assert.equal(f.portUninstallCalls(), 1);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /Shell hook off\. The desk switch is off too\./);
  assert.deepEqual(validateOutputLine("Shell hook off. The desk switch is off too."), []);
});

test("approved consent: hook uninstall leaves harness expectations and harness_off intact", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  await runAutoCommand(["consent", "approve", "--json"], f.ctx, () => {});
  const bashrc = join(f.home, ".bashrc");
  const claudeSettings = join(f.home, ".claude", "settings.json");
  assert.ok(readExpected(f.rh).files.some((file) => file.path === claudeSettings));
  assert.ok(readExpected(f.rh).files.some((file) => file.path === bashrc));

  const output = await captureOutput(() => hookUninstallCommand({
    rockyHome: f.rh,
    buildContext: () => f.ctx,
    uninstall: () => {
      assert.fail("legacy uninstall must not run while consent is approved");
    },
  }));

  assert.equal(output.code, 0);
  const read = readConsentRecord(f.rh);
  assert.equal(read.status === "valid" && read.record.shell_hook, false);
  assert.deepEqual(read.status === "valid" ? read.record.harness_off : undefined, []);
  assert.ok(readExpected(f.rh).files.some((file) => file.path === claudeSettings));
  assert.ok(readExpected(f.rh).files.every((file) => file.path !== bashrc));
});

test("approved consent: a failed shell removal returns 1 and still records shell off", async (t) => {
  const f = fixture(t, { uninstallExit: 1 });
  await runAutoCommand(["consent", "approve", "--json"], f.ctx, () => {});

  const output = await captureOutput(() => hookUninstallCommand({
    rockyHome: f.rh,
    buildContext: () => f.ctx,
    uninstall: () => {
      assert.fail("legacy uninstall must not run while consent is approved");
    },
  }));

  assert.equal(output.code, 1);
  assert.equal(f.portUninstallCalls(), 1);
  const read = readConsentRecord(f.rh);
  assert.equal(read.status === "valid" && read.record.shell_hook, false);
  assert.equal(output.stdout, "");
  assert.doesNotMatch(output.stderr, /Shell hook off\. The desk switch is off too\./);
});

test("approved consent: a context-build failure returns 1 without claiming shell hook off", async (t) => {
  const f = fixture(t);
  seedConsent(f.rh, "approved");

  const output = await captureOutput(() => hookUninstallCommand({
    rockyHome: f.rh,
    buildContext: () => {
      throw new Error("boom");
    },
    uninstall: () => {
      assert.fail("legacy uninstall must not run while consent is approved");
    },
  }));

  assert.equal(output.code, 1);
  assert.equal(output.stdout, "");
  assert.doesNotMatch(output.stderr, /Shell hook off\. The desk switch is off too\./);
});

for (const state of ["later", "removed", "invalid", "absent"] as const) {
  test(`consent ${state}: hook uninstall keeps the old path and leaves consent alone`, async (t) => {
    const f = fixture(t);
    seedConsent(f.rh, state);
    const consentPath = consentFile(f.rh);
    const beforeConsent = existsSync(consentPath) ? readFileSync(consentPath) : undefined;

    let uninstallCalls = 0;
    let buildContextCalls = 0;
    const output = await captureOutput(() => hookUninstallCommand({
      rockyHome: f.rh,
      buildContext: () => {
        buildContextCalls += 1;
        return f.ctx;
      },
      uninstall: () => {
        uninstallCalls += 1;
        return 0;
      },
    }));

    assert.equal(output.code, 0);
    assert.equal(uninstallCalls, 1);
    assert.equal(buildContextCalls, 0);
    assert.equal(output.stdout, "");
    assert.doesNotMatch(output.stderr, /Shell hook off/);
    if (beforeConsent === undefined) {
      assert.equal(existsSync(consentPath), false);
    } else {
      assert.deepEqual(readFileSync(consentPath), beforeConsent);
    }
  });
}

test("non-approved consent: hook uninstall propagates the legacy uninstall exit code", async (t) => {
  const f = fixture(t);
  seedConsent(f.rh, "later");
  const output = await captureOutput(() => hookUninstallCommand({
    rockyHome: f.rh,
    buildContext: () => {
      assert.fail("buildContext must not run when consent is not approved");
    },
    uninstall: () => 1,
  }));
  assert.equal(output.code, 1);
  assert.doesNotMatch(output.stderr, /Shell hook off/);
});

test("built CLI dispatches `rocky hook uninstall` through consent-aware removal", async (t) => {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
  assert.ok(existsSync(entry), `expected built CLI at ${entry}`);

  await t.test("without approved consent, runs legacy hook uninstall and keeps consent absent", (st) => {
    const f = fixture(st);
    const bashrc = join(f.home, ".bashrc");
    writeFileSync(bashrc, addHookBlockBytes(Buffer.from("export KEEP=1\n")));

    const result = spawnSync(process.execPath, [entry, "hook", "uninstall"], {
      cwd: f.root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: f.home,
        USERPROFILE: f.home,
        ROCKY_HOME: f.rh,
        ROCKY_TEST_POWERSHELL_HOSTS: "[]",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(hasHookBlock(readFileSync(bashrc, "utf8")), false);
    assert.equal(existsSync(consentFile(f.rh)), false);
    assert.doesNotMatch(result.stderr, /Shell hook off\. The desk switch is off too\./);
  });

  await t.test("with approved consent, removes block, sets shell_hook false, and drops bashrc expectation", (st) => {
    const f = fixture(st);
    const bashrc = join(f.home, ".bashrc");
    writeFileSync(bashrc, addHookBlockBytes(Buffer.from("export KEEP=1\n")));
    seedConsent(f.rh, "approved");
    writeExpected(f.rh, {
      v: 1,
      files: [{ path: bashrc, snippets: ["# >>> rocky hook >>>"] }],
      history: {},
    });

    const result = spawnSync(process.execPath, [entry, "hook", "uninstall"], {
      cwd: f.root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: f.home,
        USERPROFILE: f.home,
        ROCKY_HOME: f.rh,
        ROCKY_TEST_POWERSHELL_HOSTS: "[]",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(hasHookBlock(readFileSync(bashrc, "utf8")), false);
    const read = readConsentRecord(f.rh);
    assert.equal(read.status === "valid" && read.record.state, "approved");
    assert.equal(read.status === "valid" && read.record.shell_hook, false);
    assert.ok(readExpected(f.rh).files.every((file) => file.path !== bashrc));
    assert.match(result.stderr, /Shell hook off\. The desk switch is off too\./);
  });
});
