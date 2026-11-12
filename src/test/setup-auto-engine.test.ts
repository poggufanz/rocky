import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeAll, type AutoContext } from "../setup/auto/engine.js";
import type { ShellHookPort } from "../setup/auto/shell.js";
import { skipIfSymlinkUnavailable } from "./symlink-capability.js";

interface Fixture {
  root: string;
  home: string;
  ctx: AutoContext;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function idleShell(home: string, rockyHome: string): ShellHookPort {
  return {
    install: () => 0,
    uninstall: () => 0,
    bashrcPath: () => join(home, ".bashrc"),
    powerShellProfiles: () => [],
    rockyHome: () => rockyHome,
  };
}

function fixture(t: test.TestContext, env: NodeJS.ProcessEnv = {}): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-auto-engine-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const rh = join(root, "rocky-home");
  mkdirSync(home);
  mkdirSync(rh);
  return {
    root,
    home,
    ctx: {
      rockyHome: rh,
      detect: { home, env, platform: process.platform, fileExists: existsSync, isFile },
      paths: { nodePath: process.execPath, entryPath: join(root, "entry.js") },
      registration: {
        name: "rocky",
        command: process.execPath,
        args: [join(root, "entry.js"), "mcp"],
        env: { ROCKY_HOME: rh, ROCKY_MCP_EXPOSURE: "sanitized" },
      },
      shell: idleShell(home, rh),
      now: () => 1_700_000_000_000,
    },
  };
}

function transactionFixture(
  directory: string,
  path: string,
  suffix: string,
  state: "displaced" | "committed",
  displaced: string,
): string {
  const transactionDirectory = join(directory, `.${basename(path)}.transaction-${suffix}`);
  mkdirSync(transactionDirectory, { mode: 0o700 });
  writeFileSync(
    join(transactionDirectory, "manifest.json"),
    `${JSON.stringify({ version: 1, state, target: path })}\n`,
    "utf8",
  );
  writeFileSync(join(transactionDirectory, "displaced"), displaced);
  return transactionDirectory;
}

test("remove keeps the recovery copy beside a refused MCP path", (t) => {
  if (skipIfSymlinkUnavailable(t, "dir")) return;
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-auto-engine-link-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, "real-config");
  mkdirSync(real);
  const link = join(dir, "link-config");
  symlinkSync(real, link, "dir");
  const f = fixture(t, { CLAUDE_CONFIG_DIR: link });
  const target = join(link, ".claude.json");
  const retained = transactionFixture(real, target, "1234-abcd", "committed", "{}\n");

  const reports = removeAll(f.ctx, undefined);

  assert.equal(existsSync(retained), true);
  const mine = reports.find((report) => report.path === target);
  assert.equal(mine?.state, "refused");
});

test("remove recovers a pending transaction when the target file is gone", (t) => {
  const f = fixture(t);
  const target = join(f.home, ".claude.json");
  const pending = transactionFixture(f.home, target, "4242-0123", "displaced", "{\"keep\":true}\n");
  assert.equal(existsSync(target), false);

  const reports = removeAll(f.ctx, undefined);

  const mine = reports.find((report) => report.path === target);
  assert.notEqual(mine?.state, "refused");
  assert.equal(existsSync(pending), false);
  assert.deepEqual(
    readdirSync(f.home).filter((name) => name.includes(".transaction-")),
    [],
  );
});

test("remove reports a missing MCP target with no pending transaction as ok", (t) => {
  const f = fixture(t);
  const target = join(f.home, ".claude.json");
  const reports = removeAll(f.ctx, undefined);
  assert.equal(reports.find((report) => report.path === target)?.state, "ok");
});

test("remove keeps the recovery copy beside settings the engine refuses to rewrite", (t) => {
  const f = fixture(t);
  const claudeDir = join(f.home, ".claude");
  mkdirSync(claudeDir);
  const settings = join(claudeDir, "settings.json");
  writeFileSync(settings, "{ not json");
  const retained = transactionFixture(claudeDir, settings, "1234-abcd", "committed", "{}\n");

  const reports = removeAll(f.ctx, undefined);

  assert.equal(reports.some((report) => report.path === settings && report.state === "refused"), true);
  assert.equal(existsSync(retained), true);
});
