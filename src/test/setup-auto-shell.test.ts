import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROCKY_HOOK_PROTOCOL_VERSION } from "../commands/hook.js";
import { POWERSHELL_HOOK_LINE, addHookBlockBytes } from "../core/hook-block.js";
import {
  applyShell,
  inspectShell,
  removeShell,
  shellSnippets,
  type ShellHookPort,
} from "../setup/auto/shell.js";

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
