import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ROCKY_HOOK_PROTOCOL_VERSION } from "../commands/hook.js";
import { POWERSHELL_HOOK_LINE, addHookBlockBytes } from "../core/hook-block.js";
import { removeShellOnly, type AutoContext } from "../setup/auto/engine.js";
import {
  applyShell,
  createShellHookPort,
  inspectShell,
  removeShell,
  shellSnippets,
  type ShellHookPort,
} from "../setup/auto/shell.js";
import { readExpected, writeExpected } from "../setup/auto/state.js";

const VERSION_LITERAL = `ROCKY_HOOK_VERSION="${ROCKY_HOOK_PROTOCOL_VERSION}"`;
const BEGIN_MARKER = "# >>> rocky hook >>>";

interface Fixture {
  root: string;
  bashrc: string;
  rockyHome: string;
}

function fixture(t: test.TestContext): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-auto-shell-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome);
  return { root, bashrc: join(root, ".bashrc"), rockyHome };
}

function portFor(value: Fixture, overrides: Partial<ShellHookPort> = {}): ShellHookPort {
  return {
    install: () => 0,
    uninstall: () => 0,
    bashrcPath: () => value.bashrc,
    powerShellProfiles: () => [],
    rockyHome: () => value.rockyHome,
    ...overrides,
  };
}

function managedBashrc(value: Fixture): void {
  writeFileSync(value.bashrc, addHookBlockBytes(Buffer.from("export FIXTURE=1\n")));
}

function hookScript(value: Fixture, literal: string = VERSION_LITERAL): void {
  writeFileSync(join(value.rockyHome, "rocky-hook.bash"), `# fixture\n${literal}\n`);
}

test("auto shell: managed block with current script version inspects ok", (t) => {
  const value = fixture(t);
  managedBashrc(value);
  hookScript(value);
  assert.deepEqual(inspectShell(portFor(value)), {
    harness: "shell",
    kind: "shell-hook",
    path: value.bashrc,
    state: "ok",
  });
});

test("auto shell: an old script version inspects stale", (t) => {
  const value = fixture(t);
  managedBashrc(value);
  hookScript(value, 'ROCKY_HOOK_VERSION="0.4.0"');
  assert.equal(inspectShell(portFor(value)).state, "stale");
});

test("auto shell: install failure maps to error", (t) => {
  const value = fixture(t);
  assert.equal(applyShell(portFor(value, { install: () => 1 })).state, "error");
});

test("auto shell: inspect never asks PowerShell for profiles", (t) => {
  const value = fixture(t);
  managedBashrc(value);
  hookScript(value);
  const inspector = portFor(value, {
    powerShellProfiles: () => {
      throw new Error("probe");
    },
  });
  assert.equal(inspectShell(inspector).state, "ok");
});

test("auto shell: no block inspects missing", (t) => {
  const value = fixture(t);
  hookScript(value);
  assert.equal(inspectShell(portFor(value)).state, "missing");
});

test("auto shell: a malformed block inspects error", (t) => {
  const value = fixture(t);
  writeFileSync(value.bashrc, `${BEGIN_MARKER}\nnot the managed line\n`);
  hookScript(value);
  assert.equal(inspectShell(portFor(value)).state, "error");
});

test("auto shell: a fresh install reports written and an installed hook reports ok", (t) => {
  const value = fixture(t);
  assert.equal(applyShell(portFor(value)).state, "written");

  managedBashrc(value);
  hookScript(value);
  let installed = 0;
  assert.equal(applyShell(portFor(value, { install: () => (installed += 1, 0) })).state, "ok");
  assert.equal(installed, 1);
});

test("auto shell: remove reports missing, and a failed uninstall reports error", (t) => {
  const value = fixture(t);
  managedBashrc(value);
  hookScript(value);
  assert.equal(removeShell(portFor(value)).state, "missing");
  assert.equal(removeShell(portFor(value, { uninstall: () => 1 })).state, "error");
});

test("auto shell: snippets name the bytes each file must keep", (t) => {
  const value = fixture(t);
  const profile = join(value.root, "profile.ps1");
  const entries = shellSnippets(portFor(value, { powerShellProfiles: () => [profile] }));
  const expected: Array<{ path: string; snippets: string[] }> = [
    { path: value.bashrc, snippets: [BEGIN_MARKER] },
    { path: join(value.rockyHome, "rocky-hook.bash"), snippets: [VERSION_LITERAL] },
  ];
  if (process.platform === "win32") {
    expected.push({ path: join(value.rockyHome, "rocky-hook.ps1"), snippets: [VERSION_LITERAL] });
  }
  expected.push({ path: profile, snippets: [POWERSHELL_HOOK_LINE] });
  assert.deepEqual(entries, expected);
});

test("auto shell: createShellHookPort probes PowerShell profiles at most once across removeShellOnly", (t) => {
  const value = fixture(t);
  const psDir = join(value.root, "PowerShell");
  mkdirSync(psDir, { recursive: true });
  const profile = join(psDir, "Microsoft.PowerShell_profile.ps1");
  writeFileSync(profile, "# profile\n");
  const retained = join(psDir, `.${basename(profile)}.transaction-1234-abcd`);
  mkdirSync(retained);
  writeFileSync(
    join(retained, "manifest.json"),
    JSON.stringify({ version: 1, state: "committed", target: profile }),
  );
  writeExpected(value.rockyHome, {
    v: 1,
    files: [
      { path: value.bashrc, snippets: [BEGIN_MARKER] },
      { path: profile, snippets: [POWERSHELL_HOOK_LINE] },
    ],
    history: {},
  });

  let probeCalls = 0;
  const shell = createShellHookPort({
    platform: "win32",
    uninstall: () => 0,
    bashrcPath: () => value.bashrc,
    rockyHome: () => value.rockyHome,
    detectPowerShellHosts: () => {
      probeCalls += 1;
      return [{ profile }];
    },
  });
  const ctx: AutoContext = {
    rockyHome: value.rockyHome,
    detect: {
      home: value.root,
      env: {},
      platform: "win32",
      fileExists: existsSync,
      isFile: (path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      },
    },
    paths: { nodePath: process.execPath, entryPath: join(value.root, "entry.js") },
    registration: {
      name: "rocky",
      command: process.execPath,
      args: [join(value.root, "entry.js"), "mcp"],
      env: { ROCKY_HOME: value.rockyHome, ROCKY_MCP_EXPOSURE: "sanitized" },
    },
    shell,
    now: () => 1_700_000_000_000,
  };

  const reports = removeShellOnly(ctx);

  assert.equal(reports[0]?.state, "missing");
  assert.equal(probeCalls, 1);
  assert.deepEqual(readExpected(value.rockyHome).files, []);
  assert.equal(existsSync(retained), false);

  const profiles = shell.powerShellProfiles();
  profiles.push(join(psDir, "other.ps1"));
  assert.deepEqual(shell.powerShellProfiles(), [profile]);
  assert.equal(probeCalls, 1);
});

test("auto shell: createShellHookPort skips the PowerShell probe off win32", () => {
  let probeCalls = 0;
  const shell = createShellHookPort({
    platform: "linux",
    detectPowerShellHosts: () => {
      probeCalls += 1;
      return [{ profile: "/tmp/profile.ps1" }];
    },
  });
  assert.deepEqual(shell.powerShellProfiles(), []);
  assert.deepEqual(shell.powerShellProfiles(), []);
  assert.equal(probeCalls, 0);
});
