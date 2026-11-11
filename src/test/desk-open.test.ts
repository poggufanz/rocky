import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DESK_EARLY_EXIT_MS,
  hasDesktopSession,
  launchDesk,
  openDesk,
  type DeskOpenDeps,
  type LaunchOutcome,
} from "../commands/desk-open.js";
import {
  BINARY_NAMES,
  binariesRecordPath,
  binaryFileName,
  type PlatformPackage,
  type SyncResult,
} from "../setup/auto/binaries.js";

// macOS CI has no platform package; its filesystem behavior is the POSIX path.
const PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : "linux";
const VERSION = "9.1.0";

function sandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-desk-open-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

function platformPackage(): PlatformPackage {
  const dir = join("platform", "package");
  return {
    dir,
    version: VERSION,
    binaries: {
      rockyd: join(dir, "bin", binaryFileName("rockyd", PLATFORM)),
      "rocky-desk": join(dir, "bin", binaryFileName("rocky-desk", PLATFORM)),
      "rocky-hook": join(dir, "bin", binaryFileName("rocky-hook", PLATFORM)),
    },
  };
}

interface RigOptions {
  rockyHome: string;
  packagePresent?: boolean;
  cliChanged?: boolean;
  quitCode?: number;
  syncResult?: SyncResult;
  launchOutcome?: LaunchOutcome;
}

interface Rig {
  deps: DeskOpenDeps;
  calls: string[];
  said: string[];
  quitTarget: string | undefined;
  launchTarget: string | undefined;
}

/** Fake deps that record the order of the effects they claim to perform. */
function rig(options: RigOptions): Rig {
  const pkg = platformPackage();
  const calls: string[] = [];
  const said: string[] = [];
  const state: Rig = { calls, said, quitTarget: undefined, launchTarget: undefined, deps: {} as DeskOpenDeps };
  state.deps = {
    rockyHome: options.rockyHome,
    platform: PLATFORM,
    arch: "x64",
    // A desktop session whatever the host: these tests exercise the package,
    // sync, quit, and launch order, not the session rules.
    env: { DISPLAY: ":0" },
    cliChanged: options.cliChanged ?? false,
    resolvePackage: () => (options.packagePresent === false ? undefined : pkg),
    runQuit: (exe) => {
      calls.push("quit");
      state.quitTarget = exe;
      return options.quitCode ?? 0;
    },
    sync: () => {
      calls.push("sync");
      return options.syncResult ?? { state: "installed" };
    },
    launch: async (exe) => {
      calls.push("launch");
      state.launchTarget = exe;
      return options.launchOutcome ?? "running";
    },
    applySetup: async () => {
      calls.push("apply");
    },
    say: (line) => {
      said.push(line);
    },
  };
  return state;
}

/** An installed home whose record and three targets satisfy binariesCurrent. */
function installedHome(t: TestContext): string {
  const rockyHome = join(sandbox(t), "home");
  const bin = join(rockyHome, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of BINARY_NAMES) writeFileSync(join(bin, binaryFileName(name, PLATFORM)), "binary");
  writeFileSync(binariesRecordPath(rockyHome), JSON.stringify({ v: 1, version: VERSION }));
  return rockyHome;
}

async function waitForPid(marker: string): Promise<number | undefined> {
  // Anti-hang guard only: the child writes this file as its first statement.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const pid = Number(readFileSync(marker, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

async function stopMarkedChild(marker: string): Promise<void> {
  const pid = await waitForPid(marker);
  if (pid === undefined) return;
  try {
    process.kill(pid);
  } catch {
    return;
  }
  // Anti-hang guard only: a killed child releases its pid shortly.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("desk open: desktop session rules", () => {
  assert.equal(DESK_EARLY_EXIT_MS, 1500);
  assert.equal(hasDesktopSession({}, "win32"), true);
  assert.equal(hasDesktopSession({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, "win32"), false);
  assert.equal(hasDesktopSession({ SSH_CONNECTION: "" }, "win32"), true);
  assert.equal(hasDesktopSession({}, "linux"), false);
  assert.equal(hasDesktopSession({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(hasDesktopSession({ DISPLAY: ":0", SSH_TTY: "/dev/pts/1" }, "linux"), false);
  assert.equal(hasDesktopSession({ DISPLAY: ":0" }, "darwin"), false);
});

test("desk open: no platform package is unavailable and touches nothing", async (t) => {
  const rockyHome = join(sandbox(t), "home");
  const source = rig({ rockyHome, packagePresent: false });

  assert.equal(await openDesk(source.deps), "unavailable");
  assert.deepEqual(source.calls, []);
  assert.deepEqual(source.said, []);
  assert.equal(existsSync(join(rockyHome, "bin")), false);
});

test("desk open: fresh home quits, syncs, launches, then applies setup", async (t) => {
  const rockyHome = join(sandbox(t), "home");
  const source = rig({ rockyHome });
  const pkg = platformPackage();

  assert.equal(await openDesk(source.deps), "opened");
  assert.deepEqual(source.calls, ["quit", "sync", "launch", "apply"]);
  assert.equal(source.quitTarget, pkg.binaries["rocky-desk"]);
  assert.equal(source.launchTarget, join(rockyHome, "bin", binaryFileName("rocky-desk", PLATFORM)));
  assert.deepEqual(source.said, []);
});

test("desk open: current binaries only launch", async (t) => {
  const rockyHome = installedHome(t);

  const unchanged = rig({ rockyHome, cliChanged: false });
  assert.equal(await openDesk(unchanged.deps), "opened");
  assert.deepEqual(unchanged.calls, ["launch"]);

  const changed = rig({ rockyHome, cliChanged: true });
  assert.equal(await openDesk(changed.deps), "opened");
  assert.deepEqual(changed.calls, ["launch", "apply"]);
});

test("desk open: desk exiting non-zero at once falls back to dash", async (t) => {
  const rockyHome = join(sandbox(t), "home");
  const source = rig({ rockyHome, launchOutcome: "failed" });

  assert.equal(await openDesk(source.deps), "failed");
  assert.ok(source.said.includes("rocky: the desktop app did not start. Opening the browser view instead."));
  assert.equal(source.calls.includes("apply"), false);
});

test("desk open: a desk that will not close still gets the swap and a note", async (t) => {
  const rockyHome = join(sandbox(t), "home");
  const source = rig({ rockyHome, quitCode: 2 });

  assert.equal(await openDesk(source.deps), "opened");
  assert.deepEqual(source.calls, ["quit", "sync", "launch", "apply"]);
  assert.equal(source.said.length, 1);
  assert.ok(source.said[0].includes("Quit it from its tray menu"));
  assert.ok(source.said[0].includes(VERSION));
});

test("desk open: sync error stops before launch", async (t) => {
  const rockyHome = join(sandbox(t), "home");
  const source = rig({ rockyHome, syncResult: { state: "error", detail: "disk full" } });

  assert.equal(await openDesk(source.deps), "failed");
  assert.deepEqual(source.calls, ["quit", "sync"]);
  assert.equal(source.said.length, 1);
  assert.ok(source.said[0].startsWith("rocky: cannot install the desktop app into"));
  assert.ok(source.said[0].includes(join(rockyHome, "bin")));
  assert.ok(source.said[0].includes("disk full"));
});

test("desk open: launchDesk classifies exit codes", async (t) => {
  assert.equal(await launchDesk(process.execPath, ["-e", "process.exit(0)"]), "handed-off");
  assert.equal(await launchDesk(process.execPath, ["-e", "process.exit(3)"]), "failed");
  assert.equal(await launchDesk(join(sandbox(t), "missing-desk"), []), "failed");

  const marker = join(sandbox(t), "child.pid");
  const source = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 5000);`;
  try {
    assert.equal(await launchDesk(process.execPath, ["-e", source], 300), "running");
  } finally {
    await stopMarkedChild(marker);
  }
});
