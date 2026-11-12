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
import { basename, dirname, join } from "node:path";
import { inspectAll, removeAll, type AutoContext } from "../setup/auto/engine.js";
import { mcpTargets } from "../setup/auto/mcp.js";
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

function profileWithHome(t: test.TestContext, homeSettings: boolean): { f: Fixture; homeFile: string; profileFile: string } {
  const f = fixture(t);
  // `~/.claude.json` makes claude-code detected without creating `~/.claude`.
  writeFileSync(join(f.home, ".claude.json"), "{}\n");
  const ownProfile = join(f.home, "profile");
  mkdirSync(ownProfile);
  writeFileSync(join(ownProfile, ".claude.json"), "{}\n");
  f.ctx.detect.env.CLAUDE_CONFIG_DIR = ownProfile;
  const homeFile = join(f.home, ".claude", "settings.json");
  if (homeSettings) {
    mkdirSync(join(f.home, ".claude"));
    writeFileSync(homeFile, "{}\n");
  }
  return { f, homeFile, profileFile: join(ownProfile, "settings.json") };
}

test("home settings stay a target when CLAUDE_CONFIG_DIR points at a profile", (t) => {
  const { f, homeFile, profileFile } = profileWithHome(t, true);

  const paths = inspectAll(f.ctx, undefined)
    .filter((report) => report.harness === "claude-code" && report.kind === "agent-hooks")
    .map((report) => report.path);

  assert.deepEqual([...paths].sort(), [homeFile, profileFile].sort());
});

test("a missing home .claude adds no target and no refusal under CLAUDE_CONFIG_DIR", (t) => {
  const { f, homeFile, profileFile } = profileWithHome(t, false);

  const reports = inspectAll(f.ctx, undefined).filter((report) => report.harness === "claude-code");

  assert.equal(reports.some((report) => report.path === homeFile), false);
  assert.equal(
    reports.some((report) => report.path === profileFile && report.kind === "agent-hooks"),
    true,
    JSON.stringify(reports.map((report) => [report.kind, report.state, report.path, report.detail])),
  );
});

test("removal also covers home settings when CLAUDE_CONFIG_DIR points at a profile", (t) => {
  const { f, homeFile } = profileWithHome(t, true);

  const reports = removeAll(f.ctx, undefined);

  assert.equal(reports.some((report) => report.path === homeFile && report.kind === "agent-hooks"), true);
});

function geminiOnPath(f: Fixture): string {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, process.platform === "win32" ? "gemini.cmd" : "gemini"), "");
  f.ctx.detect.env.PATH = bin;
  const target = mcpTargets("gemini-cli", f.ctx.detect, [])[0];
  assert.ok(target);
  return target.path;
}

test("a detected harness whose config folder does not exist yet gets no target", (t) => {
  const f = fixture(t);
  const geminiPath = geminiOnPath(f);

  const gemini = inspectAll(f.ctx, undefined).filter((report) => report.harness === "gemini-cli");

  assert.deepEqual(gemini, []);
  assert.equal(removeAll(f.ctx, undefined).some((report) => report.path === geminiPath), false);
});

test("the harness gets its target once its config folder appears", (t) => {
  const f = fixture(t);
  const geminiPath = geminiOnPath(f);
  mkdirSync(dirname(geminiPath), { recursive: true });

  const gemini = inspectAll(f.ctx, undefined).filter((report) => report.harness === "gemini-cli");

  assert.deepEqual(gemini.map((report) => [report.path, report.state]), [[geminiPath, "missing"]]);
});
