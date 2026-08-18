/**
 * `~/.rocky/hook-speech/` — the F2 buffer/publish mechanism's own state on
 * disk (`src/ui/rocky.ts`'s `flushHookSpeech`, `src/shell/rocky-hook.ps1`'s
 * `__rockySpawnDetached`/`prompt`). This file covers the four findings from
 * task-a's round-2 review of that mechanism, which `hook-powershell.test.ts`
 * (F2 round 1) does not exercise:
 *
 *   Finding 1 — session affinity. A file this exact PowerShell session did
 *     not itself spawn must never be spoken, even when it is sitting right
 *     there in the shared directory — it may belong to a different, still
 *     open session (Windows PowerShell and PS7 share `$env:ROCKY_HOME` by
 *     default), and speaking it would assert something false about the
 *     present session's own command/cwd/moment.
 *   Finding 2 — re-sanitization on read. A file's content is not trusted
 *     merely because it matches the glob; ANSI/control-sequence injection
 *     must be neutralized independent of source.
 *   Finding 3 — Windows PowerShell 5.1 encoding. Verified on a real 5.1
 *     host (task-a-report.md round 2) that `Get-Content -Raw` with no
 *     `-Encoding` corrupts non-ASCII content written by `ui/rocky.ts`'s
 *     BOM-less UTF-8 write. A second, independent corruption was found
 *     verifying the first fix on a real host rather than trusting it alone:
 *     even with `-Encoding UTF8` reading the file correctly,
 *     `[Console]::Error.Write` re-corrupted the same content on the way out
 *     whenever stderr is redirected/piped, because `[Console]::OutputEncoding`
 *     defaults to the system codepage there, not UTF-8. Both are fixed and
 *     both are tested here.
 *   Finding 4 — unbounded growth. Nothing pruned this directory before; a
 *     stale, unclaimed file (another session's, or an orphaned .tmp write
 *     fragment) now gets removed once it is old enough that no session
 *     could realistically still be waiting to claim it.
 *
 * These are driven directly: dot-source the real built `rocky-hook.ps1`,
 * seed `~/.rocky/hook-speech/` with fixtures (some claimed via
 * `$global:__rockySpeechIds`, matching what `__rockySpawnDetached` would
 * have done; some deliberately left unclaimed), call `prompt` once
 * non-interactively, and assert on both the captured stderr and the
 * fixtures' surviving filesystem state. This is faster and far more
 * precise than driving a live interactive session for these particular
 * properties (no ordering-relative-to-a-drawn-prompt claim is being made
 * here, unlike hook-powershell.test.ts's own round-1 regression guard) —
 * `prompt`'s drain loop runs unconditionally near the top of its body,
 * before any interactive history even needs to exist.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyShellAssetsStaged } from "./shell-assets-fixture.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hookScriptPath = join(packageRoot, ".test-dist", "shell", "rocky-hook.ps1");

verifyShellAssetsStaged();

const windowsPowerShellAvailable = process.platform === "win32"
  && !spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).error;

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
const realPwsh = findRealPwsh();

interface SpeechSandbox {
  root: string;
  rockyHome: string;
  speechDir: string;
}

function speechSandbox(t: TestContext, prefix: string): SpeechSandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rockyHome = join(root, "rocky-home");
  const speechDir = join(rockyHome, "hook-speech");
  mkdirSync(speechDir, { recursive: true });
  return { root, rockyHome, speechDir };
}

/** Byte-identical to `ui/rocky.ts`'s `flushHookSpeech`: UTF-8, no BOM. */
function writeSpeechFixture(speechDir: string, name: string, text: string): string {
  const filePath = join(speechDir, name);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

/** Backdates a fixture's mtime, relative to the shipped 10-minute stale cutoff (rocky-hook.ps1). */
function ageFile(filePath: string, minutesAgo: number): void {
  const old = new Date(Date.now() - minutesAgo * 60 * 1000);
  utimesSync(filePath, old, old);
}

interface PromptRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  /** [Console]::OutputEncoding.CodePage immediately before/after the `prompt` call, per the sentinel lines every driver script prints (task-a review round 3, Item 1: proves the restore is symmetric, not just that output looked fine). */
  outputEncodingCodePageBefore: number | undefined;
  outputEncodingCodePageAfter: number | undefined;
}

function parseSentinel(stdout: string, name: string): number | undefined {
  const match = new RegExp(`${name}=(\\d+)`).exec(stdout);
  return match ? Number(match[1]) : undefined;
}

/**
 * Runs a short, non-interactive PowerShell script that dot-sources the real
 * built hook, applies `setupLines` (fixture claims via
 * `$global:__rockySpeechIds`, or anything else a test needs before the
 * drain runs), and calls `prompt` exactly once, discarding its return value
 * (the next prompt string itself, irrelevant here) so only `prompt`'s own
 * stderr side effect is meaningful. `-NonInteractive` plus no stdin content
 * needed: nothing here ever reads input.
 *
 * Always sentinels `[Console]::OutputEncoding.CodePage` to stdout before and
 * after the `prompt` call (task-a review round 3): cheap, and no existing
 * test reads `stdout`, so this is free coverage for whichever test does
 * care whether `__rockyWriteSpeechToConsole`'s restore actually happened.
 */
function runPromptOnce(exe: string, rockyHome: string, setupLines: string[]): PromptRunResult {
  const scriptPath = join(rockyHome, "..", "driver.ps1");
  const script = [
    `$env:ROCKY_HOME = '${rockyHome.replace(/'/g, "''")}'`,
    `. '${hookScriptPath.replace(/'/g, "''")}'`,
    ...setupLines,
    "Write-Output \"ROCKY_TEST_ENCODING_BEFORE=$([Console]::OutputEncoding.CodePage)\"",
    "prompt | Out-Null",
    "Write-Output \"ROCKY_TEST_ENCODING_AFTER=$([Console]::OutputEncoding.CodePage)\"",
  ].join("\n");
  writeFileSync(scriptPath, script, "utf8");
  const result = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  const stdout = result.stdout ?? "";
  return {
    stdout,
    stderr: result.stderr ?? "",
    status: result.status,
    outputEncodingCodePageBefore: parseSentinel(stdout, "ROCKY_TEST_ENCODING_BEFORE"),
    outputEncodingCodePageAfter: parseSentinel(stdout, "ROCKY_TEST_ENCODING_AFTER"),
  };
}

/** `$global:__rockySpeechIds += 'name.txt'`, one line per claimed name. */
function claimLines(names: string[]): string[] {
  return names.map((name) => `$global:__rockySpeechIds += '${name.replace(/'/g, "''")}'`);
}

// --- Findings 1, 2, 4: session affinity, sanitization, stale pruning ------

function sessionAffinitySanitizeAndPruneSmoke(t: TestContext, exe: string): void {
  const sandbox = speechSandbox(t, "rocky-hook-speech-affinity-");

  writeSpeechFixture(sandbox.speechDir, "owned.txt", "[Rocky] owned message, question\n");
  const maliciousText = `[Rocky] safe-before${String.fromCharCode(0x1b)}[2Jsafe-after, question\n`;
  writeSpeechFixture(sandbox.speechDir, "owned-malicious.txt", maliciousText);

  const foreignRecent = writeSpeechFixture(sandbox.speechDir, "foreign-recent.txt", "[Rocky] foreign recent message, question\n");
  const foreignStale = writeSpeechFixture(sandbox.speechDir, "foreign-stale.txt", "[Rocky] foreign stale message, question\n");
  ageFile(foreignStale, 60); // 1 hour: 6x the shipped 10-minute cutoff, unambiguously stale

  const staleTmp = writeSpeechFixture(sandbox.speechDir, "orphan.txt.9999.tmp", "half-written fragment, never completed");
  ageFile(staleTmp, 60);
  const recentTmp = writeSpeechFixture(sandbox.speechDir, "inflight.txt.1234.tmp", "still being written");

  const result = runPromptOnce(exe, sandbox.rockyHome, claimLines(["owned.txt", "owned-malicious.txt"]));

  assert.equal(result.status, 0, `driver script must exit cleanly; stderr: ${result.stderr}`);

  // Finding 1: only this session's own claimed files are ever spoken.
  assert.match(result.stderr, /owned message, question/, `owned file must be spoken; got: ${result.stderr}`);
  assert.ok(
    !result.stderr.includes("foreign recent message") && !result.stderr.includes("foreign stale message"),
    `unclaimed files must never be spoken, regardless of age; got: ${result.stderr}`,
  );

  // Finding 2: sanitized on read, even for a file this session does own --
  // the raw ESC byte must never reach the console, but the surrounding
  // printable text survives.
  assert.ok(result.stderr.includes("safe-before") && result.stderr.includes("safe-after"), `printable text must survive sanitization; got: ${result.stderr}`);
  assert.ok(!result.stderr.includes("\x1b"), `raw ESC byte must never reach stderr; got: ${JSON.stringify(result.stderr)}`);

  // Finding 1 + 4: claimed files are drained (spoken + deleted); an
  // unclaimed-but-recent file is left alone untouched (still might belong
  // to another live session); an unclaimed-and-stale file is pruned
  // silently; a stale orphaned .tmp fragment is pruned too; a recent .tmp
  // fragment (simulating one still being written) is left alone.
  assert.equal(existsSync(join(sandbox.speechDir, "owned.txt")), false, "spoken file must be deleted");
  assert.equal(existsSync(join(sandbox.speechDir, "owned-malicious.txt")), false, "spoken file must be deleted");
  assert.equal(existsSync(foreignRecent), true, "recent unclaimed file must be left alone, not deleted");
  assert.equal(existsSync(foreignStale), false, "stale unclaimed file must be pruned");
  assert.equal(existsSync(staleTmp), false, "stale orphaned .tmp fragment must be pruned (Finding 4)");
  assert.equal(existsSync(recentTmp), true, "recent .tmp fragment (simulating an in-progress write) must be left alone");
}

test(
  "session affinity, read-time sanitization, and stale pruning all hold together, Windows PowerShell 5.1 (task-a review round 2, Findings 1/2/4)",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  (t) => {
    sessionAffinitySanitizeAndPruneSmoke(t, "powershell.exe");
  },
);

test(
  "session affinity, read-time sanitization, and stale pruning all hold together, PowerShell 7.x (task-a review round 2, Findings 1/2/4)",
  { skip: realPwsh ? false : "PowerShell 7 (pwsh) is unavailable on this machine" },
  (t) => {
    sessionAffinitySanitizeAndPruneSmoke(t, realPwsh!);
  },
);

// --- Finding 3: Windows PowerShell 5.1 UTF-8-no-BOM read/write ------------

function nonAsciiRoundTripSmoke(t: TestContext, exe: string): void {
  const sandbox = speechSandbox(t, "rocky-hook-speech-encoding-");
  const text = "[Rocky] this error again. deep memory need stderr. run with: rocky run 'Get-Item ./café-müller-日本語', question\n    place: café-dir\n";
  writeSpeechFixture(sandbox.speechDir, "nonascii.txt", text);

  const result = runPromptOnce(exe, sandbox.rockyHome, claimLines(["nonascii.txt"]));

  assert.equal(result.status, 0, `driver script must exit cleanly; stderr: ${result.stderr}`);
  assert.ok(
    result.stderr.includes("café-müller-日本語") && result.stderr.includes("café-dir"),
    `non-ASCII content must round-trip intact, not as mojibake (Finding 3, verified corrupt on a real 5.1 host without -Encoding UTF8); got: ${JSON.stringify(result.stderr)}`,
  );
  assert.equal(existsSync(join(sandbox.speechDir, "nonascii.txt")), false, "claimed file must still be drained normally");

  // Item 1 (task-a review round 3): __rockyWriteSpeechToConsole must restore
  // [Console]::OutputEncoding symmetrically, the same discipline
  // ROCKY_HOOK_SPEECH_FILE already gets around every Start-Process call --
  // this is the proof, not just an assumption, that the restore (a) happens
  // and (b) does not corrupt the message this exact call already printed
  // (the stderr assertion above ran against output produced *after* the
  // restore already fired, inside this same process).
  assert.notEqual(result.outputEncodingCodePageBefore, undefined, "the before-sentinel must have been captured");
  assert.equal(
    result.outputEncodingCodePageAfter,
    result.outputEncodingCodePageBefore,
    `OutputEncoding must be restored to its pre-call value, not left as UTF-8 for the rest of the session; before=${result.outputEncodingCodePageBefore} after=${result.outputEncodingCodePageAfter}`,
  );
}

test(
  "non-ASCII hook speech round-trips intact through both the read (-Encoding UTF8) and write (Console.OutputEncoding) fixes, Windows PowerShell 5.1 (task-a review round 2, Finding 3)",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  (t) => {
    nonAsciiRoundTripSmoke(t, "powershell.exe");
  },
);

test(
  "non-ASCII hook speech round-trips intact through both the read (-Encoding UTF8) and write (Console.OutputEncoding) fixes, PowerShell 7.x (task-a review round 2, Finding 3 regression guard)",
  { skip: realPwsh ? false : "PowerShell 7 (pwsh) is unavailable on this machine" },
  (t) => {
    nonAsciiRoundTripSmoke(t, realPwsh!);
  },
);

// --- Sanity: the exact corruption Finding 3 describes really did exist ----
//
// Not a regression guard for shipped code (no -Encoding path exists in the
// fixed file to compare against) -- this is the empirical evidence for the
// report: proof, kept executable rather than asserted only in prose, that
// plain `Get-Content -Raw` (no `-Encoding`) really does corrupt this exact
// content on a real Windows PowerShell 5.1 host. If Windows PowerShell 5.1's
// own default ever changes upstream, this is the test that will say so.
test(
  "Get-Content -Raw with no -Encoding corrupts non-ASCII content on real Windows PowerShell 5.1 (Finding 3 evidence)",
  { skip: windowsPowerShellAvailable ? false : "Windows PowerShell is unavailable on this machine/platform" },
  (t) => {
    const sandbox = speechSandbox(t, "rocky-hook-speech-encoding-evidence-");
    const text = "café müller 日本語\n";
    const filePath = writeSpeechFixture(sandbox.speechDir, "evidence.txt", text);

    const probe = spawnSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `$t = Get-Content -LiteralPath '${filePath.replace(/'/g, "''")}' -Raw; [Console]::Out.Write($t)`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 },
    );

    assert.notEqual(probe.stdout, text, "documents the real defect: no -Encoding must NOT round-trip non-ASCII content on Windows PowerShell 5.1 -- if this now passes, the platform default changed and Finding 3's fix may no longer be necessary");
  },
);
