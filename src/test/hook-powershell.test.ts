/**
 * PowerShell hook install/uninstall/status (spec §5 "Test wajib" 1-6,
 * task-4-brief). Fast tests (1-3, plus a light status/corrupt/idempotency
 * pass) exercise `hookInstall`/`hookUninstall`/`hookStatus`'s PowerShell
 * branch directly against an injectable profile path via
 * `ROCKY_TEST_POWERSHELL_HOSTS` — the PowerShell analogue of
 * `hook-install.test.ts`'s `HOME`/`USERPROFILE` override for `.bashrc` — so
 * none of them ever reach a real `$PROFILE`. The underlying transaction
 * safety (settle/topology-refusal/publish) is the exact same audited
 * machinery `hook-block.test.ts` already exhaustively covers for bash; this
 * file does not re-litigate that, it only pins the PowerShell-specific glue
 * (codec selection, per-host labels, asset name).
 *
 * Real-host tests (skip cleanly, with a stated reason, when the host binary
 * is absent) cover spec test 6 and stand as the regression guard for three
 * bugs this release's implementer found and fixed by running the actual
 * shipped `rocky-hook.ps1` against real `powershell.exe`/`pwsh.exe`, not a
 * script-mode approximation — see task-4-report.md for the full empirical
 * record:
 *   1. Invoking the captured inner-`prompt` FunctionInfo's own `.ScriptBlock`
 *      directly (`&`/`.Invoke()`) hangs the shell dead, or crashes it with
 *      StackOverflowException — fixed by rebuilding a fresh, unbound
 *      scriptblock from the captured text.
 *   2. Windows PowerShell 5.1's native-argument-passing bug for a captured
 *      command string containing an embedded `"` (an entirely ordinary
 *      command, e.g. `cmd /c "exit 9"`) — fixed with edition-conditional
 *      quote-doubling.
 *   3. Stale `$LASTEXITCODE` was being treated as an unconditional override
 *      of `$?`, wrongly recording a hook failure for a later, wholly
 *      successful cmdlet — fixed by making `$?` the sole failure gate.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookInstall, hookStatus, hookUninstall, detectPowerShellHosts } from "../commands/hook.js";
import { POWERSHELL_HOOK_LINE, powershellHookBlockCodec } from "../core/hook-block.js";
import { validateRockyPhrase } from "../ui/phrases.js";

const BEGIN = "# >>> rocky hook >>>";
const END = "# <<< rocky hook <<<";
const BLOCK = `${BEGIN}\n${POWERSHELL_HOOK_LINE}\n${END}\n`;

function bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// hookInstall expects its shell assets next to the compiled commands, exactly
// where the production build puts them — same fixture pattern hook-block.test.ts
// and hook-install.test.ts already use, extended to pick up the .ps1 asset too
// so this file stays runnable alone via `node scripts/test.mjs hook-powershell`.
function ensureShellAssetsStaged(): void {
  const source = join(packageRoot, "src", "shell");
  const destination = join(packageRoot, ".test-dist", "shell");
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source).sort()) {
    if (name.endsWith(".bash") || name.endsWith(".sh") || name.endsWith(".ps1")) {
      writeFileSync(join(destination, name), readFileSync(join(source, name)));
    }
  }
}
ensureShellAssetsStaged();

interface PowerShellSandbox {
  profile: string;
  stderr: () => string;
}

/**
 * Injects exactly one fake "Windows PowerShell" host pointed at a temp
 * profile file, and suppresses bashrc management too (a fixed, absent-HOME
 * bashrc keeps every assertion below about PowerShell's own exit code, not a
 * bash side effect neither host under test needs).
 */
function powerShellSandbox(t: TestContext): PowerShellSandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-ps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const profile = join(root, "profile.ps1");

  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ROCKY_HOME: process.env.ROCKY_HOME,
    ROCKY_TEST_POWERSHELL_HOSTS: process.env.ROCKY_TEST_POWERSHELL_HOSTS,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ROCKY_HOME = join(root, "rocky-home");
  process.env.ROCKY_TEST_POWERSHELL_HOSTS = JSON.stringify([
    { label: "Windows PowerShell", profile, version: "5.1.26100.9168" },
  ]);
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

  return { profile, stderr: () => chunks.join("") };
}

// --- spec test 1: install then uninstall returns the profile byte-for-byte ---

test("PowerShell hook install then uninstall restores the profile, leaving only the one separator line the shared codec always leaves (matches bash's own pinned behavior)", (t) => {
  const sandbox = powerShellSandbox(t);
  const original = bytes("# my profile\nSet-Alias ll Get-ChildItem\n");
  writeFileSync(sandbox.profile, original);

  assert.equal(hookInstall(), 0, sandbox.stderr());
  assert.notDeepEqual(readFileSync(sandbox.profile), original, "install actually changed the profile");
  assert.equal(powershellHookBlockCodec.classify(readFileSync(sandbox.profile)), "managed");

  assert.equal(hookUninstall(), 0, sandbox.stderr());
  // Same byte-level contract `hook-block.test.ts` already pins for bash
  // ("removeHookBlockBytes after addHookBlockBytes leaves only the separator
  // line"): one add/remove cycle leaves the one blank separator line install
  // added before the block; a second cycle reuses it rather than growing it
  // further (also pinned there). Not a PowerShell-specific quirk.
  assert.deepEqual(readFileSync(sandbox.profile), Buffer.concat([original, bytes("\n")]));
  assert.equal(powershellHookBlockCodec.classify(readFileSync(sandbox.profile)), "absent");
});

test("a second PowerShell install/uninstall cycle does not grow the separator line further", (t) => {
  const sandbox = powerShellSandbox(t);
  const original = bytes("# my profile\nSet-Alias ll Get-ChildItem\n");
  writeFileSync(sandbox.profile, original);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    assert.equal(hookInstall(), 0, sandbox.stderr());
    assert.equal(hookUninstall(), 0, sandbox.stderr());
  }

  assert.deepEqual(readFileSync(sandbox.profile), Buffer.concat([original, bytes("\n")]));
});

test("PowerShell hook install creates a missing profile with exactly the managed block", (t) => {
  const sandbox = powerShellSandbox(t);
  assert.equal(existsSync(sandbox.profile), false);

  assert.equal(hookInstall(), 0, sandbox.stderr());

  assert.deepEqual(readFileSync(sandbox.profile), bytes(`\n${BLOCK}`));
  assert.match(sandbox.stderr(), /ears installed in Windows PowerShell/);
});

// --- spec test 2: installing twice does not duplicate the block -----------

test("PowerShell hook install twice does not duplicate the block", (t) => {
  const sandbox = powerShellSandbox(t);
  writeFileSync(sandbox.profile, bytes("Set-Alias ll Get-ChildItem\n"));

  assert.equal(hookInstall(), 0, sandbox.stderr());
  const afterFirst = readFileSync(sandbox.profile);
  assert.equal(hookInstall(), 0, sandbox.stderr());

  assert.deepEqual(readFileSync(sandbox.profile), afterFirst, "second install is a no-op");
  assert.equal(readFileSync(sandbox.profile, "utf8").match(/rocky hook >>>/g)?.length, 1);
});

// --- spec test 3: a profile with existing user content is not damaged -----

test("PowerShell hook install preserves existing profile content around the block", (t) => {
  const sandbox = powerShellSandbox(t);
  const original = bytes("Import-Module posh-git\nfunction prompt { \"PS> \" }\n");
  writeFileSync(sandbox.profile, original);

  assert.equal(hookInstall(), 0, sandbox.stderr());

  const installed = readFileSync(sandbox.profile, "utf8");
  assert.ok(installed.startsWith(original.toString("utf8")), "prior content survives untouched");
  assert.match(installed, /rocky hook >>>/);
});

// --- status / corrupt / uninstall-absent: light PowerShell-specific pass ---

test("PowerShell hook status reports absent, then installed, per host", (t) => {
  const sandbox = powerShellSandbox(t);

  assert.equal(hookStatus(), 0, sandbox.stderr());
  assert.match(sandbox.stderr(), /Windows PowerShell: not installed\. run: rocky hook install/);

  assert.equal(hookInstall(), 0, sandbox.stderr());
  assert.equal(hookStatus(), 0, sandbox.stderr());
  assert.match(sandbox.stderr(), /Windows PowerShell: installed, hook version 0\.3\.0, PowerShell 5\.1\.26100\.9168\./);
  // Ruling 2: the $Error[0] shift must be disclosed where a user actually
  // meets it -- rocky hook status for the PowerShell hosts.
  assert.match(sandbox.stderr(), /\$Error/, "status must disclose the $Error shift for a PowerShell host");
});

test("the $Error-shift disclosure follows Rocky's voice rules", () => {
  assert.deepEqual(
    validateRockyPhrase("exit status stays exact. forcing it false pushes one entry into $Error first, named as mine."),
    [],
  );
});

test("PowerShell hook uninstall on an absent profile stays a quiet success", (t) => {
  const sandbox = powerShellSandbox(t);
  assert.equal(hookUninstall(), 0, sandbox.stderr());
  assert.match(sandbox.stderr(), /no ears installed in Windows PowerShell/);
  assert.equal(existsSync(sandbox.profile), false);
});

test("PowerShell hook install refuses a corrupt block and preserves every byte", (t) => {
  const sandbox = powerShellSandbox(t);
  const original = bytes(`export IMPORTANT=preserve-me\n${BEGIN}\nexport B=2\n`);
  writeFileSync(sandbox.profile, original);

  assert.equal(hookInstall(), 1);

  assert.deepEqual(readFileSync(sandbox.profile), original);
  assert.match(sandbox.stderr(), /corrupt/);
});

// --- bash and PowerShell both run in one call, independently -------------

test("hookInstall installs bash and the PowerShell host independently, aggregating exit codes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-both-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const profile = join(root, "profile.ps1");

  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ROCKY_HOME: process.env.ROCKY_HOME,
    ROCKY_TEST_POWERSHELL_HOSTS: process.env.ROCKY_TEST_POWERSHELL_HOSTS,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ROCKY_HOME = join(root, "rocky-home");
  process.env.ROCKY_TEST_POWERSHELL_HOSTS = JSON.stringify([
    { label: "Windows PowerShell", profile, version: "5.1.26100.9168" },
    { label: "PowerShell 7", profile: join(root, "profile7.ps1"), version: "7.6.5" },
  ]);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  assert.equal(hookInstall(), 0);
  assert.equal(powershellHookBlockCodec.classify(readFileSync(profile)), "managed");
  assert.equal(powershellHookBlockCodec.classify(readFileSync(join(root, "profile7.ps1"))), "managed");
  assert.equal(existsSync(join(home, ".bashrc")), true, "bash still runs in the same call");

  assert.equal(hookUninstall(), 0);
  assert.equal(powershellHookBlockCodec.classify(readFileSync(profile)), "absent");
  assert.equal(powershellHookBlockCodec.classify(readFileSync(join(root, "profile7.ps1"))), "absent");
});

// --- real-host tests: spec test 6, skip cleanly when the host is absent ---

function findRealPwsh(): string | undefined {
  const candidates = ["pwsh"];
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"));
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
  for (const candidate of candidates) {
    if (candidate !== "pwsh" && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8", windowsHide: true,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return undefined;
}

const windowsPowerShellAvailable = process.platform === "win32"
  && !spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).error;
const realPwsh = findRealPwsh();

test(
  "detectPowerShellHosts finds real Windows PowerShell with a sane profile and version",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  () => {
    const saved = process.env.ROCKY_TEST_POWERSHELL_HOSTS;
    delete process.env.ROCKY_TEST_POWERSHELL_HOSTS;
    try {
      const hosts = detectPowerShellHosts();
      const windows = hosts.find((h) => h.label === "Windows PowerShell");
      assert.ok(windows, "Windows PowerShell must be detected on a machine that has it");
      assert.ok(windows!.profile.length > 0);
      assert.match(windows!.version, /^\d+\.\d+/);
    } finally {
      if (saved === undefined) delete process.env.ROCKY_TEST_POWERSHELL_HOSTS;
      else process.env.ROCKY_TEST_POWERSHELL_HOSTS = saved;
    }
  },
);

function parseCheck(exe: string, scriptPath: string): { ok: boolean; message: string } {
  const probe = spawnSync(
    exe,
    [
      "-NoProfile", "-Command",
      `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}', [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.ToString() }; exit 1 } else { exit 0 }`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  return { ok: !probe.error && probe.status === 0, message: probe.stdout + probe.stderr };
}

test(
  "rocky-hook.ps1 parses without syntax errors on real Windows PowerShell 5.1",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  () => {
    const scriptPath = join(packageRoot, ".test-dist", "shell", "rocky-hook.ps1");
    const result = parseCheck("powershell.exe", scriptPath);
    assert.equal(result.ok, true, result.message);
  },
);

test(
  "rocky-hook.ps1 parses without syntax errors on real PowerShell 7.x",
  { skip: realPwsh ? false : "PowerShell 7 (pwsh) is unavailable on this machine" },
  () => {
    const scriptPath = join(packageRoot, ".test-dist", "shell", "rocky-hook.ps1");
    const result = parseCheck(realPwsh!, scriptPath);
    assert.equal(result.ok, true, result.message);
  },
);

/**
 * The regression guard for the three bugs task-4-report.md records finding
 * by running the real, built rocky-hook.ps1 against a real interactive host:
 * the inner-prompt recursion/hang, the $LASTEXITCODE-overrides-$? false
 * positive, and Windows PowerShell 5.1's embedded-quote argument-splitting
 * bug. Drives a real interactive session (RedirectStandardInput over a plain
 * pipe -- the same technique the Task 3 spike used, disclosed as harness-only
 * for the five items still UNVERIFIED, not for this) through a failing
 * cmdlet, a failing native command, and a successful cmdlet, then asserts on
 * the *effects* a real user would see: $?/$LASTEXITCODE unchanged from what
 * the unhooked shell would show, and memory.jsonl holding exactly the right
 * records with no false positive for the successful command. Hard-timeout
 * bounded so a reintroduced hang fails this test in seconds instead of
 * hanging the suite.
 */
interface FeedResult {
  stdout: string;
  timedOut: boolean;
}

const DEFAULT_SMOKE_LINES = (rockyHome: string): string[] => [
  `. "${join(rockyHome, "rocky-hook.ps1")}"`,
  "Get-Item ./__rocky_nope__ -ErrorAction SilentlyContinue 2>$null",
  "echo LIVE1_DOLLARQ=$? LIVE1_EXIT=$LASTEXITCODE",
  'cmd /c "exit 9" | Out-Null',
  "echo LIVE2_DOLLARQ=$? LIVE2_EXIT=$LASTEXITCODE",
  "Get-Item .",
  "echo LIVE3_DOLLARQ=$? LIVE3_EXIT=$LASTEXITCODE",
  "exit",
];

function spawnAndFeed(exe: string, rockyHome: string, shim: string, lines?: string[]): Promise<FeedResult> {
  return new Promise((resolve) => {
    const child = spawn(exe, ["-NoProfile", "-NoLogo"], {
      env: { ...process.env, ROCKY_HOME: rockyHome, ROCKY_BIN: shim },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", () => { /* discarded, matches how the real hook is invoked */ });

    const feedLines = lines ?? DEFAULT_SMOKE_LINES(rockyHome);
    let index = 0;
    const feed = setInterval(() => {
      if (index >= feedLines.length) { clearInterval(feed); return; }
      child.stdin.write(`${feedLines[index]}\n`);
      index += 1;
    }, 400);

    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(feed);
      clearTimeout(watchdog);
      if (timedOut) { try { child.kill("SIGKILL"); } catch { /* best effort */ } }
      resolve({ stdout, timedOut });
    };

    // Hard-bounded: a reintroduced hang (the exact bug this test guards
    // against) must fail this test in seconds, not hang the whole suite.
    const watchdog = setTimeout(() => finish(true), 20_000);
    child.on("exit", () => finish(false));
    child.on("error", () => finish(false));
  });
}

/**
 * Fix round 1 (Finding 1) made the spawn genuinely non-blocking, which means
 * the detached `rocky` process can still be running after the interactive
 * PowerShell session itself has already exited (proven correct by the
 * non-blocking test above — it does not wait for the spawn either). Every
 * real-host test that inspects `memory.jsonl` right after the session ends
 * needs to poll for it settling rather than assume it is already there.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only JSONL parse, shape varies by record kind
async function readMemoryRecordsSettled(memoryPath: string, timeoutMs = 5_000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let last: any[] = [];
  while (Date.now() < deadline) {
    if (existsSync(memoryPath)) {
      const parsed = readFileSync(memoryPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (parsed.length > 0 && JSON.stringify(parsed) === JSON.stringify(last)) return parsed; // stable across a poll: settled
      last = parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return last;
}

async function realHostSmoke(t: TestContext, exe: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-ps-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  writeFileSync(
    join(rockyHome, "rocky-hook.ps1"),
    readFileSync(join(packageRoot, ".test-dist", "shell", "rocky-hook.ps1")),
  );
  const shim = join(root, "rocky-shim.ps1");
  const entry = join(packageRoot, "dist", "index.js").replace(/'/g, "''");
  writeFileSync(shim, `& node '${entry}' @args\nexit $LASTEXITCODE\n`);

  const result = await spawnAndFeed(exe, rockyHome, shim);
  assert.equal(result.timedOut, false, "the session must not hang (recursion/hang regression guard)");
  // `echo a b` prints each argument on its own line, so DOLLARQ/EXIT land on
  // consecutive lines rather than sharing one -- matches what the real
  // interactive session actually prints (confirmed empirically, both hosts).
  assert.match(result.stdout, /LIVE1_DOLLARQ=False\r?\nLIVE1_EXIT=\r?\n/, `$? must read False after a failing cmdlet; got: ${result.stdout}`);
  assert.match(result.stdout, /LIVE2_DOLLARQ=False\r?\nLIVE2_EXIT=9\r?\n/, `$?/$LASTEXITCODE must read False/9 after a failing native command; got: ${result.stdout}`);
  assert.match(result.stdout, /LIVE3_DOLLARQ=True\r?\nLIVE3_EXIT=9\r?\n/, `a later successful cmdlet must not flip $? and must leave stale $LASTEXITCODE alone; got: ${result.stdout}`);

  const memoryPath = join(rockyHome, "memory.jsonl");
  const records = await readMemoryRecordsSettled(memoryPath);
  assert.ok(records.length > 0, "the failing commands must have recorded memory");
  const failures = records.filter((r) => r.kind === "failure");
  assert.equal(failures.length, 2, `expected exactly 2 failures, no false positive for the successful Get-Item; got: ${JSON.stringify(records)}`);
  assert.ok(failures.every((f) => f.origin === "hook"), "every PowerShell-hook record must carry origin:hook");
  assert.ok(
    failures.every((f) => /^exit -?\d+$/.test(f.excerpt)),
    "the no-stderr marker: excerpt must be the command-only 'exit N' fallback, never stderr-derived text",
  );
  const nativeFailure = failures.find((f) => f.cmd.includes("exit 9"));
  assert.ok(nativeFailure, "the native failure's own command text must survive with its embedded quote intact");
  assert.equal(nativeFailure.exitCode, 9, "the native command's real exit code must be recovered, not a synthetic 1");
}

test(
  "real interactive Windows PowerShell 5.1 preserves $?/$LASTEXITCODE and records exactly the right memory (regression guard)",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  async (t) => {
    await realHostSmoke(t, "powershell.exe");
  },
);

test(
  "real interactive PowerShell 7.x preserves $?/$LASTEXITCODE and records exactly the right memory (regression guard)",
  { skip: realPwsh ? false : "PowerShell 7 (pwsh) is unavailable on this machine" },
  async (t) => {
    await realHostSmoke(t, realPwsh!);
  },
);

/**
 * Finding 1 (fix round 1), regression guard: the whole point of
 * `__rockySpawnDetached` (`Start-Process -NoNewWindow`, replacing the
 * original synchronous `& $__rockyBin ...` call) is that the shell must
 * never wait on Rocky's own bookkeeping. Proven directly with a
 * deliberately slow `ROCKY_BIN` shim (a multi-second sleep before it ever
 * writes anything) — if the spawn were still synchronous, the interactive
 * session's wall-clock time would be dominated by that sleep; non-blocking,
 * it is not, regardless of how slow the spawned process itself is.
 */
async function realHostNonBlockingSmoke(t: TestContext, exe: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-ps-nonblocking-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  writeFileSync(
    join(rockyHome, "rocky-hook.ps1"),
    readFileSync(join(packageRoot, ".test-dist", "shell", "rocky-hook.ps1")),
  );
  const slowMarker = join(root, "slow-shim-ran.txt");
  const slowShim = join(root, "slow-shim.ps1");
  // Sleeps far longer than any reasonable prompt render should ever take,
  // then proves it actually ran (and how late) by writing a marker file.
  writeFileSync(
    slowShim,
    `Start-Sleep -Milliseconds 4000\n"ran" | Set-Content -Path "${slowMarker.replace(/\\/g, "\\\\")}"\nexit 0\n`,
  );

  const before = Date.now();
  const result = await spawnAndFeed(exe, rockyHome, slowShim, [
    `. "${join(rockyHome, "rocky-hook.ps1")}"`,
    "Get-Item ./__rocky_nope__ -ErrorAction SilentlyContinue 2>$null",
    "echo NEXT_PROMPT_REACHED",
    "exit",
  ]);
  const elapsedMs = Date.now() - before;

  assert.equal(result.timedOut, false, "the session must not hang");
  assert.match(result.stdout, /NEXT_PROMPT_REACHED/, `the next command must run without waiting on the slow spawn; got: ${result.stdout}`);
  assert.ok(
    elapsedMs < 4000,
    `session wall-clock time (${elapsedMs}ms) must not be dominated by the spawned process's 4000ms sleep -- a synchronous spawn would fail this`,
  );
  assert.equal(existsSync(slowMarker), false, "the slow shim must still be running in the background when this assertion runs");
}

test(
  "the hook body never blocks the next prompt on a deliberately slow spawn, Windows PowerShell 5.1 (Finding 1)",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  async (t) => {
    await realHostNonBlockingSmoke(t, "powershell.exe");
  },
);

test(
  "the hook body never blocks the next prompt on a deliberately slow spawn, PowerShell 7.x (Finding 1)",
  { skip: realPwsh ? false : "PowerShell 7 (pwsh) is unavailable on this machine" },
  async (t) => {
    await realHostNonBlockingSmoke(t, realPwsh!);
  },
);

/**
 * Finding 3 (fix round 1): denylist parity with rocky-hook.bash's
 * cd|pushd|popd|export|alias|source|.|rocky, translated to PowerShell
 * equivalents rather than copied literally. Drives a real interactive
 * session through a failing `Push-Location` and a failing dot-source (the
 * two entries the review specifically named as missing and "idiomatic and
 * heavily used"), then a genuine non-denylisted failure, so the test proves
 * the denylist actually suppresses the first two rather than the whole
 * mechanism being silent for unrelated reasons.
 */
async function realHostDenylistSmoke(t: TestContext, exe: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-ps-denylist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  writeFileSync(
    join(rockyHome, "rocky-hook.ps1"),
    readFileSync(join(packageRoot, ".test-dist", "shell", "rocky-hook.ps1")),
  );
  const shim = join(root, "rocky-shim.ps1");
  const entry = join(packageRoot, "dist", "index.js").replace(/'/g, "''");
  writeFileSync(shim, `& node '${entry}' @args\nexit $LASTEXITCODE\n`);

  const result = await spawnAndFeed(exe, rockyHome, shim, [
    `. "${join(rockyHome, "rocky-hook.ps1")}"`,
    "Push-Location -Path ./__rocky_denylist_nope__ -ErrorAction SilentlyContinue 2>$null",
    ". ./__rocky_denylist_nope_dotsource__.ps1 2>$null",
    "Get-Item ./__rocky_denylist_should_record__ -ErrorAction SilentlyContinue 2>$null",
    "exit",
  ]);
  assert.equal(result.timedOut, false, "the session must not hang");

  const memoryPath = join(rockyHome, "memory.jsonl");
  const records = await readMemoryRecordsSettled(memoryPath);
  const failureCmds: string[] = records.filter((r) => r.kind === "failure").map((r) => r.cmd);

  assert.ok(
    !failureCmds.some((cmd) => cmd.includes("Push-Location")),
    `Push-Location must be denylisted like bash's pushd/popd; got failures: ${JSON.stringify(failureCmds)}`,
  );
  assert.ok(
    !failureCmds.some((cmd) => cmd.startsWith(". ")),
    `dot-sourcing must be denylisted like bash's source/.; got failures: ${JSON.stringify(failureCmds)}`,
  );
  assert.ok(
    failureCmds.some((cmd) => cmd.includes("__rocky_denylist_should_record__")),
    `a genuine non-denylisted failure must still be recorded (proves the mechanism isn't just silent); got: ${JSON.stringify(failureCmds)}`,
  );
}

test(
  "Push-Location and dot-sourcing are denylisted like bash's pushd/popd/source, Windows PowerShell 5.1 (Finding 3)",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  async (t) => {
    await realHostDenylistSmoke(t, "powershell.exe");
  },
);

test(
  "Push-Location and dot-sourcing are denylisted like bash's pushd/popd/source, PowerShell 7.x (Finding 3)",
  { skip: realPwsh ? false : "PowerShell 7 (pwsh) is unavailable on this machine" },
  async (t) => {
    await realHostDenylistSmoke(t, realPwsh!);
  },
);

/**
 * Finding 4 (fix round 1) / spec §5 test 4: "a hook that fails midway does
 * not change the exit code of the user's command." Held by construction
 * (the outer try/catch), but never adversarially tested — this genuinely
 * injects a fault, rather than relying on construction. After dot-sourcing
 * the real hook, `__rockySpawnDetached` (the one function that actually
 * touches `_hookfail`/`_hooksuccess`) is redefined to unconditionally
 * `throw`, with no inner catch of its own left to absorb it, so the
 * exception can only be swallowed by `prompt`'s own outer try/catch. Then a
 * real failing command runs, and the assertion is on what the user
 * genuinely observes on the *next* real prompt: `$?`/`$LASTEXITCODE` must
 * read exactly what the user's own failing command produced, unrelated to
 * and unaffected by the injected internal fault.
 */
async function realHostFaultInjectionSmoke(t: TestContext, exe: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-ps-fault-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  writeFileSync(
    join(rockyHome, "rocky-hook.ps1"),
    readFileSync(join(packageRoot, ".test-dist", "shell", "rocky-hook.ps1")),
  );

  const result = await spawnAndFeed(exe, rockyHome, join(root, "unused-shim.ps1"), [
    `. "${join(rockyHome, "rocky-hook.ps1")}"`,
    // Genuine fault injection: replace the one function that ever touches
    // _hookfail/_hooksuccess with one that always throws, with no inner
    // catch left to absorb it -- only prompt's own outer try/catch can.
    'function global:__rockySpawnDetached { throw "INJECTED-FAULT-FOR-TEST" }',
    "cmd /c \"exit 7\" | Out-Null",
    "echo AFTER_FAULT_DOLLARQ=$? AFTER_FAULT_EXIT=$LASTEXITCODE",
    "exit",
  ]);

  assert.equal(result.timedOut, false, "an injected internal fault must never hang the shell");
  assert.match(
    result.stdout,
    /AFTER_FAULT_DOLLARQ=False\r?\nAFTER_FAULT_EXIT=7\r?\n/,
    `the user's own command's $?/$LASTEXITCODE must be exactly what it produced (False/7), untouched by the injected internal fault; got: ${result.stdout}`,
  );
  // The fault fired before any write could happen -- confirms this genuinely
  // exercised the failure path, not a no-op that happened to look silent.
  assert.equal(existsSync(join(rockyHome, "memory.jsonl")), false, "the injected fault must have prevented the memory write it would otherwise have made");
}

test(
  "an injected internal hook-body fault never changes the user's own exit code, Windows PowerShell 5.1 (Finding 4, spec §5 test 4)",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  async (t) => {
    await realHostFaultInjectionSmoke(t, "powershell.exe");
  },
);

test(
  "an injected internal hook-body fault never changes the user's own exit code, PowerShell 7.x (Finding 4, spec §5 test 4)",
  { skip: realPwsh ? false : "PowerShell 7 (pwsh) is unavailable on this machine" },
  async (t) => {
    await realHostFaultInjectionSmoke(t, realPwsh!);
  },
);

/**
 * Ruling 1's central claim, checked directly rather than only via the
 * default-prompt case above: a real, already-installed custom prompt
 * (oh-my-posh/starship-shaped — a function whose output changes on every
 * call, here keyed off `$MyInvocation.HistoryId`) must keep rendering, live,
 * after `rocky-hook.ps1` wraps it. Regression guard for exactly the bug this
 * release found and fixed: invoking the captured inner-prompt the wrong way
 * either hangs the shell (never advancing past the *first* prompt call) or
 * crashes it outright — either failure mode would make this test's `after-
 * hook-2` sentinel simply never appear, and a hang is caught by the same
 * watchdog `spawnAndFeed` already uses.
 */
async function realHostCustomPromptSmoke(t: TestContext, exe: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-ps-custom-prompt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  writeFileSync(
    join(rockyHome, "rocky-hook.ps1"),
    readFileSync(join(packageRoot, ".test-dist", "shell", "rocky-hook.ps1")),
  );
  const customPromptScript = join(root, "custom-prompt.ps1");
  writeFileSync(customPromptScript, 'function global:prompt {\n    "CUSTOM-PROMPT[$($MyInvocation.HistoryId)]> "\n}\n');

  const result = await spawnAndFeed(exe, rockyHome, join(root, "unused-shim.ps1"), [
    `. "${customPromptScript}"`,
    "echo before-hook",
    `. "${join(rockyHome, "rocky-hook.ps1")}"`,
    "echo after-hook-1",
    "echo after-hook-2",
    "exit",
  ]);
  assert.equal(result.timedOut, false, "the session must not hang (recursion/hang regression guard)");
  assert.match(result.stdout, /CUSTOM-PROMPT\[\d+\]> echo after-hook-1/, `the custom prompt must keep rendering, live, after being wrapped; got: ${result.stdout}`);
  assert.match(result.stdout, /CUSTOM-PROMPT\[\d+\]> echo after-hook-2/, `and keep rendering for more than one call after the wrap; got: ${result.stdout}`);
}

test(
  "a real custom prompt keeps rendering after rocky-hook.ps1 wraps it on Windows PowerShell 5.1 (Ruling 1)",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  async (t) => {
    await realHostCustomPromptSmoke(t, "powershell.exe");
  },
);

test(
  "a real custom prompt keeps rendering after rocky-hook.ps1 wraps it on PowerShell 7.x (Ruling 1)",
  { skip: realPwsh ? false : "PowerShell 7 (pwsh) is unavailable on this machine" },
  async (t) => {
    await realHostCustomPromptSmoke(t, realPwsh!);
  },
);
