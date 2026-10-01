import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bash-side coverage for the guard decision note in src/shell/rocky-hook.bash.
// __rocky_guard appends one TSV line (ts, outcome, rule, cwd, cmd) per guard
// hit to guard.pending; the node drain parses, redacts, and bounds it. Like
// guard-prompt.test.ts and hook-speech.test.ts, these tests drive the LIVE
// hook file — not .test-dist/shell, which scripts/test.mjs stages only for
// hookInstall consumers (see shell-assets-fixture.ts). Exactly the two shipped
// functions are extracted, so the hook's interactive-only early return and its
// bash-preexec dependency stay out of the way.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hookPath = join(repoRoot, "src", "shell", "rocky-hook.bash");

const hasBash = (() => {
  try {
    const probe = spawnSync("bash", ["--version"], { stdio: "ignore", timeout: 5000 });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
})();
const bashSkip = "Bash executable unavailable; owner: Linux/WSL hook smoke CI";

// Which bash answers on PATH decides the path form. Git Bash (MSYS, what
// Windows CI and a Git-for-Windows PATH resolve) takes C:/... but has no
// /mnt; WSL bash needs /mnt/<drive>/...; POSIX paths pass through untouched.
const bashFlavor = (() => {
  if (!hasBash) return "";
  const probe = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8", timeout: 5000 });
  return (probe.stdout ?? "").trim();
})();

function toBashPath(native: string): string {
  const forward = native.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(forward);
  if (!match) return native;
  if (/^(MINGW|MSYS|CYGWIN)/i.test(bashFlavor)) return forward;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

/** The exact shipped __rocky_guard_note + __rocky_guard bodies, nothing else. */
function guardFunctions(): string {
  const src = readFileSync(hookPath, "utf8");
  const start = src.indexOf("__rocky_guard_note() {");
  const end = src.indexOf("__rocky_preexec() {");
  assert.ok(start !== -1 && end !== -1 && start < end, "live hook holds __rocky_guard_note and __rocky_guard");
  return src.slice(start, end);
}

function cleanup(t: TestContext, home: string): void {
  t.after(() => {
    // Windows holds freshly-written files briefly (AV/indexer); retry rather
    // than flake, and never fail a passing test on leftover tmp litter.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(home, { recursive: true, force: true });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  });
}

interface GuardProbe {
  home: string;
  probe: string;
}

/**
 * Rule/cmd travel via files because argv quoting of embedded newlines/tabs
 * varies across the Windows shells under test. Command substitution strips
 * only trailing newlines, which no fixture relies on.
 *
 * The answered y/n branches read from /dev/tty, unreachable from a
 * non-interactive probe, so behavior tests drive __rocky_guard_note directly
 * while pinning the three __rocky_guard call sites by source shape. The
 * no-tty branch is the only guard path a headless probe can reach.
 */
function makeProbe(t: TestContext, ruleLine: string, cmd: string): GuardProbe {
  const home = mkdtempSync(join(tmpdir(), "rocky-guard-pending-"));
  cleanup(t, home);
  writeFileSync(join(home, "rule.txt"), ruleLine, "utf8");
  writeFileSync(join(home, "cmd.txt"), cmd, "utf8");
  const probe = join(home, "probe.sh");
  writeFileSync(
    probe,
    [
      '__rocky_home="$1"',
      guardFunctions(),
      'printf \'%s\\n\' "$(cat "$__rocky_home/rule.txt")" > "$__rocky_home/guard.rules"',
      '__rocky_guard "$(cat "$__rocky_home/cmd.txt")"',
      'printf \'GUARD_STATUS=%s\\n\' "$?"',
      "",
    ].join("\n"),
    "utf8",
  );
  return { home, probe };
}

// Direct-note probe: drives the shipped __rocky_guard_note with caller-made
// arguments, bypassing the /dev/tty gate. Field values (outcome/rule/cmd)
// are the caller's; cwd and ts come from the probe environment.
function runNote(home: string, outcome: string, rule: string, cmdFile: string, cwd: string, fakePwd?: string): void {
  const probe = join(home, "note.sh");
  writeFileSync(
    probe,
    ['__rocky_home="$1"', guardFunctions(), 'if [[ -n "${4:-}" ]]; then PWD="$4"; fi', `__rocky_guard_note ${outcome} "$2" "$(cat "$3")"`, ""].join("\n"),
    "utf8",
  );
  // Freshly-created cwd siblings can hit a Windows AV/indexer window where
  // bash reports ENOENT; retry briefly rather than flake.
  let lastError = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = spawnSync("bash", [toBashPath(probe), toBashPath(home), rule, toBashPath(cmdFile), fakePwd ?? ""], {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!res.error) {
      assert.equal(res.status, 0, `note probe failed: ${res.stderr}`);
      return;
    }
    lastError = `${res.error}; stderr: ${res.stderr}`;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.fail(`bash probe failed to run: ${lastError}`);
}

function pendingFields(home: string): string[][] {
  // Detached probes may return before the FS settles; retry briefly.
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const lines = readFileSync(join(home, "guard.pending"), "utf8").split("\n").filter((l) => l.length > 0);
      assert.equal(lines.length, 1, `exactly one pending line, got ${lines.length}`);
      const fields = lines.map((l) => l.split("\t"));
      assert.equal(fields[0].length, 5, `five tab fields, got ${fields[0].length}`);
      return fields;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  throw lastError;
}

// The three __rocky_guard decision sites all pass the matched $regex as the
// rule, keep the y/n contract (y/Y proceeds, anything else cancels), and
// keep the no-tty path warn-only. A headless probe cannot reach /dev/tty,
// so these pin the shipped branch structure instead of executing it.
test("guard notes exactly three decision sites with the matched regex", () => {
  const src = readFileSync(hookPath, "utf8");
  const calls = src.match(/__rocky_guard_note (proceeded|cancelled) "\$regex" "\$cmd" \|\| :/g) ?? [];
  assert.equal(calls.length, 3);
  assert.equal(
    calls.filter((c) => c.startsWith("__rocky_guard_note cancelled")).length,
    1,
    "only the explicit-cancel branch notes cancelled",
  );
  assert.match(src, /__rocky_guard_note proceeded "\$regex" "\$cmd" \|\| :\n\s*return 0/);
  assert.match(src, /__rocky_guard_note cancelled "\$regex" "\$cmd" \|\| :\n\s*return 1/);
});

test("guard keeps the y/n and no-tty branch contract around the notes", () => {
  const src = readFileSync(hookPath, "utf8");
  assert.match(src, /\[\[ "\$ans" == "y" \|\| "\$ans" == "Y" \]\]/);
  assert.match(src, /# no usable tty: warn only, never block/);
});

test("no-tty guard hit appends a proceeded line", { skip: hasBash ? false : bashSkip }, (t) => {
  const rule = "^touch marker";
  const cmd = "touch marker";
  const { home, probe } = makeProbe(t, `${rule}\ttest rule speaks`, cmd);
  // detached: the probe inherits no controlling terminal, so the guard's
  // `read ... </dev/tty` deterministically fails down the warn-only branch
  // (without this, /dev/tty may open the runner's own terminal and block).
  const res = spawnSync("bash", [toBashPath(probe), toBashPath(home)], {
    cwd: home,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  } as never);
  assert.ok(!res.error, `bash probe failed to run: ${res.error}; stderr: ${res.stderr}`);
  // No GUARD_STATUS stdout assert: detached probes reparent before flushing
  // the pipe, but the pending line below proves the warn-only branch ran.
  const [ts, outcome, gotRule, , gotCmd] = pendingFields(home)[0];
  assert.match(ts, /^\d+$/, "ts is epoch seconds");
  assert.equal(outcome, "proceeded");
  assert.equal(gotRule, rule);
  assert.equal(gotCmd, cmd);
});

test("cancelled outcome appends a cancelled line", { skip: hasBash ? false : bashSkip }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-guard-pending-"));
  cleanup(t, home);
  const cmd = "touch marker";
  const cmdFile = join(home, "cmd.txt");
  writeFileSync(cmdFile, cmd, "utf8");
  runNote(home, "cancelled", "^touch marker", cmdFile, home);
  const [, outcome, gotRule, , gotCmd] = pendingFields(home)[0];
  assert.equal(outcome, "cancelled");
  assert.equal(gotRule, "^touch marker");
  assert.equal(gotCmd, cmd);
});

test("newline/tab/CR in the command flatten to a single line", { skip: hasBash ? false : bashSkip }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-guard-pending-"));
  cleanup(t, home);
  const cmdFile = join(home, "cmd.txt");
  writeFileSync(cmdFile, "touch marker\nwith newline\tand tab\rand CR", "utf8");
  runNote(home, "proceeded", "^touch marker", cmdFile, home);
  const [, outcome, , , gotCmd] = pendingFields(home)[0];
  assert.equal(outcome, "proceeded");
  assert.equal(gotCmd, "touch marker with newline and tab and CR");
});

test("command is bounded at 500 chars and cwd at 512", { skip: hasBash ? false : bashSkip }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-guard-pending-"));
  cleanup(t, home);
  const long = `touch ${"A".repeat(600)}`;
  const cmdFile = join(home, "cmd.txt");
  writeFileSync(cmdFile, long, "utf8");
  // A fabricated $PWD exercises the cwd bound without needing a real
  // 512-char directory (Windows caps components at 255 and bash may not
  // resolve freshly-created deep trees yet).
  const fakePwd = `/work/${"d".repeat(300)}/${"e".repeat(300)}`;
  runNote(home, "proceeded", "^touch", cmdFile, home, fakePwd);
  const [, , , cwd, gotCmd] = pendingFields(home)[0];
  assert.equal(cwd, fakePwd.slice(0, 512));
  assert.equal(gotCmd, long.slice(0, 500));
});

test("unwritable pending file stays fail-silent", { skip: hasBash ? false : bashSkip }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-guard-pending-"));
  cleanup(t, home);
  const probe = join(home, "note.sh");
  writeFileSync(
    probe,
    [
      '__rocky_home="$1"',
      guardFunctions(),
      '__rocky_guard_note proceeded "r" "c"',
      'printf \'NOTE_STATUS=%s\\n\' "$?"',
      "",
    ].join("\n"),
    "utf8",
  );
  const missing = join(home, "no-such-dir");
  const res = spawnSync("bash", [toBashPath(probe), toBashPath(missing)], {
    cwd: home,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(!res.error, `bash probe failed to run: ${res.error}`);
  assert.match(res.stdout, /NOTE_STATUS=0/);
  assert.equal(existsSync(join(missing, "guard.pending")), false);
});
