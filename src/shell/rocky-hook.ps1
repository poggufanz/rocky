# rocky-hook.ps1 -- Rocky's PowerShell ears. Dot-sourced from $PROFILE via
# the managed block `rocky hook install` appends. Contract: this file must
# never throw past its own boundary, and must never leave $?/$LASTEXITCODE
# different from what the user's own last command already set -- the one
# disclosed exception is documented at the bottom of this file and in
# `rocky hook status`/README: forcing $? back to False (the only way
# PowerShell allows that) pushes one synthetic entry onto $Error, ahead of
# the user's own real error.
#
# Mechanism: overriding `prompt`, paired with `Get-History -Count 1`. Proven
# in the Task 3 spike to fire exactly once per completed interactive
# statement on both Windows PowerShell 5.1 and PowerShell 7.x, with `$?`
# reliable only when captured as prompt's first statement. See
# docs/superpowers/validation/2026-08-17-powershell-hook-spike.md and this
# release's task-4-report.md for the empirical basis of every ordering
# decision below.
#
# v1 scope (Ruling 4): passive ears only. `prompt` only sees a command after
# it has already run, so there is no PowerShell equivalent of the Bash
# hook's pre-execution guard confirmation -- Rocky listens here, he does not
# stop a command before it runs. No stderr is available either: failures use
# the command-only fingerprint fallback (`commandFingerprint` in
# src/core/fingerprint.ts) that the Bash hook has used since v0.4.0, via the
# same `origin: "hook"` record shape -- no new schema, no new CLI surface.
#
# ROCKY_HOOK_VERSION="0.3.0" -- same hook-protocol version as rocky-hook.bash;
# `rocky hook status` reads this exact literal via the same regex both hosts
# share (src/commands/hook.ts), so this line's shape must stay byte-parseable.

if (Get-Variable -Name __rockyHookLoaded -Scope Global -ErrorAction SilentlyContinue) { return }
$global:__rockyHookLoaded = $true

# F2 round 2 (task-a review, Finding 1): every hook-speech file name this
# session's own __rockySpawnDetached has ever handed to a child, so
# `prompt`'s drain loop below only ever SPEAKS a file this exact session
# spawned -- never a file some other session (a second open Windows
# PowerShell/PS7 window, or this same window's own next launch, sharing the
# same $env:ROCKY_HOME) is still waiting to claim itself. `$global:` here is
# this one process's own global scope, not shared across processes, so this
# starts empty on every fresh hook load and needs no cross-session storage.
$global:__rockySpeechIds = @()

# Capture whatever `prompt` was already installed -- the user's own function,
# oh-my-posh, starship, or PowerShell's own built-in default -- exactly once,
# at load time, never at call time. Wrapping (Ruling 1) instead of replacing
# is the single most important correction to the original spike snippet:
# `function global:prompt` below only ever OVERWRITES the name `prompt`, so
# capturing the inner prompt now is the only way to still reach the original.
# `Get-Command prompt` was observed, in this release's spike work, to always
# resolve to something even in a bare `-NoProfile` session (PowerShell ships
# its own default prompt function) -- this is a defensive guard for that
# capture failing for any other reason, not the expected common case.
#
# CRITICAL, empirically found in this release (task-4-report.md): the
# captured `FunctionInfo`'s own `.ScriptBlock` object must never be invoked
# directly. Re-invoking it via `& $cmd.ScriptBlock` hangs the shell dead on
# every command after the first -- prompt is called once for the load
# itself, then the interactive loop never advances past it again, on real
# Windows PowerShell 5.1. `.ScriptBlock.Invoke()` is worse: it recurses into
# this very `prompt` redefinition and crashes the whole process with
# StackOverflowException within a handful of frames. Both were reproduced
# with a real interactive host, not a script-mode approximation. The
# ScriptBlock object returned by `Get-Command <name>` for whichever function
# currently owns that name apparently keeps some engine-level tie back to
# that name's function-table slot; invoking it from inside a same-named
# redefinition re-enters that slot instead of running the captured code
# standalone. The fix is to capture the inner prompt's source TEXT once, at
# load time, and rebuild a brand-new, unbound `[scriptblock]` from that text
# -- a plain scriptblock with no tie to the name "prompt" at all, proven safe
# (no hang, no recursion, correct $?/$LASTEXITCODE) on both Windows
# PowerShell 5.1 and PowerShell 7.x, both with PowerShell's own built-in
# default prompt and with the empty/no-prompt case.
$__rockyInnerPromptCommand = Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue
$__rockyInnerPromptText = if ($__rockyInnerPromptCommand) { $__rockyInnerPromptCommand.ScriptBlock.ToString() } else { $null }
$global:__rockyInnerPromptBlock = if ($__rockyInnerPromptText) {
    try { [scriptblock]::Create($__rockyInnerPromptText) } catch { $null }
} else {
    $null
}

# Every embedded double-quote is backslash-escaped, on BOTH editions --
# `Start-Process`'s own argument-list-to-native-command-line construction
# uses the C-runtime/CommandLineToArgvW convention on Windows PowerShell 5.1
# AND PowerShell 7.x alike (verified empirically, fix round 1, task-4-
# report.md): a captured command string containing an embedded double-quote
# -- e.g. `cmd /c "exit 9" | Out-Null`, an entirely ordinary command -- was
# reproduced arriving at the spawned `rocky` process split into the wrong
# number of argv elements on both hosts without this. This is a genuinely
# different quoting convention than the ORIGINAL synchronous `&` call needed
# (doubling, Desktop-only, since replaced) -- two different PowerShell
# invocation mechanisms turned out to need two different fixes; verified
# doubling here (the old fix) actively breaks PowerShell 7's `Start-Process`
# path (a literal doubled quote lands where PS7 previously passed the
# argument through correctly), so backslash-escaping is now the only form
# used, unconditionally. `(Get-Location).Path` needs no such handling: `"`
# is a reserved character no Windows path can ever contain.
function global:__rockyQuoteArg([string]$value) {
    return '"' + ($value -replace '"', '\"') + '"'
}

# A real npm-installed `.ps1` shim (confirmed against a real one on this
# machine, C:\...\npm\bunx.ps1 and the same shape every npm `bin` entry gets)
# is literally `& "<real executable>" $args` -- one more native-argument
# hop Rocky's own code does not control the source of. On Windows PowerShell
# 5.1 that inner hop needs the SAME doubling convention the original
# synchronous call needed (Desktop-only, verified empirically, fix round 1);
# on PowerShell 7 the inner hop already passes strings through correctly, so
# adding doubling there would corrupt it a second time. This pre-compensates
# ONLY for that inner hop, Desktop-only, BEFORE `__rockyQuoteArg` above
# handles the outer `Start-Process` hop -- verified empirically, both hosts,
# against a shim reproducing the real npm template exactly, that composing
# the two in this order (pre-compensate, then quote) is the only combination
# that survives both hops intact on Windows PowerShell 5.1 without breaking
# PowerShell 7's already-correct inner hop.
function global:__rockyPreCompensateForShim([string]$value) {
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        return $value -replace '"', '""'
    }
    return $value
}

# F2 round 2 (task-a review, Finding 2): re-sanitize on read, independent of
# whether a given file actually came from Rocky's own atomic-rename write
# path. Legitimate content is already sanitized once, at write time
# (safeTerminalLine/safeTerminalBlock, ui/rocky.ts) -- but nothing before
# this point proves a given file in hook-speech was ever produced that way
# rather than dropped there by some other process running as this same user
# (a misbehaving dependency, a compromised script). A same-user trust
# boundary, not a privilege escalation, but a real gap in the defense in
# depth Rocky applies everywhere else user-visible text originates from
# something other than a hardcoded literal. Strips ANSI/CSI/OSC escape
# sequences and raw C0/DEL control bytes -- keeping tab and the newlines
# this file's own multi-line messages legitimately use -- before anything
# is ever written to the console. `` `e `` (the backtick escape for ESC) is
# PowerShell 6+ only and would silently fail to match on Windows PowerShell
# 5.1; `[char]27`/`[char]7` work identically on both editions.
function global:__rockySanitizeSpeechText([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $text }
    $esc = [char]27
    $bel = [char]7
    $sanitized = [regex]::Replace($text, "$esc\][^$bel$esc]*($bel|$esc\\)", '')  # OSC ... BEL/ST
    $sanitized = [regex]::Replace($sanitized, "$esc\[[0-9;?]*[@-~]", '')          # CSI ... final byte
    $sanitized = [regex]::Replace($sanitized, "$esc.", '')                        # any other escape form
    return [regex]::Replace($sanitized, '[\x00-\x08\x0B-\x1F\x7F]', '')
}

# Finding 3's other half (task-a review round 2), found while verifying the
# read-side fix on a real host rather than trusting it alone: reading with
# -Encoding UTF8 decodes the file correctly, but [Console]::Error.Write still
# re-encodes that correct string using [Console]::OutputEncoding before any
# byte reaches wherever stderr actually goes -- verified empirically (same
# real Windows PowerShell 5.1 host) that when stderr is redirected/piped
# rather than a live console handle, the default OutputEncoding is the
# system codepage, not UTF-8, corrupting the same non-ASCII content a second
# time on the way OUT. Only changed when there is actually something
# non-empty to say (most prompt cycles say nothing), and only when it is not
# already UTF-8 -- changing OutputEncoding on Windows calls
# SetConsoleOutputCP under the hood, a real console-wide effect not worth
# paying on every idle prompt draw.
#
# Save/set/write/restore, not set/leave (task-a review round 3): every other
# process-global mutation in this file is scrupulously undone --
# ROCKY_HOOK_SPEECH_FILE is set/restored around every Start-Process call,
# just above -- and OutputEncoding is no different in kind: SetConsoleOutputCP
# is console-wide, not per-stream, so leaving it changed would alter every
# OTHER program's subsequent output to that same console for the rest of the
# session, directly contradicting install's own "I touch nothing" promise.
# Verified empirically (same real Windows PowerShell 5.1 host, task-a-report
# round 3): restoring immediately after the write does not corrupt the
# bytes just written -- [Console]::Error.Write is synchronous, so by the
# time OutputEncoding changes back, this call's own bytes are already fully
# encoded and out. The restore itself is best-effort (wrapped separately, in
# `finally`): a failure restoring must never mask a write that already
# succeeded, and must never become a terminating error either.
function global:__rockyWriteSpeechToConsole([string]$text) {
    $previousEncoding = $null
    $changed = $false
    try {
        $previousEncoding = [Console]::OutputEncoding
        if ($previousEncoding.CodePage -ne [System.Text.Encoding]::UTF8.CodePage) {
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            $changed = $true
        }
    } catch {
        # best effort -- if reading/setting the encoding fails, still try the
        # write below rather than silently dropping the whole message
    }
    try {
        [Console]::Error.Write($text)
    } catch {
        # a broken write must never reach the user as a terminating error
    } finally {
        if ($changed) {
            try { [Console]::OutputEncoding = $previousEncoding } catch { }
        }
    }
}

# Fire-and-forget (Finding 1, fix round 1): the shell must never block on
# Rocky's own bookkeeping the way the original synchronous `& $__rockyBin
# ...` call did -- on a machine with real-time AV scanning of newly-spawned
# processes, that became a repeated, perceptible stall on every denylist-
# passing command. `-NoNewWindow`, not `-WindowStyle Hidden`, is load-
# bearing: `-WindowStyle Hidden` allocates a NEW, separate (merely invisible)
# console for the child, and sayTty/detailTty's `\\.\CON` write would then
# reach THAT hidden console instead of the user's own, silently muting every
# hookFail/hookSuccess message forever -- verified this failure mode is real
# by checking what `-NoNewWindow` shares instead: the calling session's own
# console, the same sharing the synchronous `&` call already relied on.
# Verified empirically, both hosts (task-4-report.md): a real Node child
# spawned this way still reaches `\\.\CON` exactly like the synchronous path
# did, is genuinely non-blocking (returns in ~50-140ms regardless of how long
# the spawned `rocky` process itself takes), and correctly preserves every
# argument's own embedded spaces and quotes via `__rockyQuoteArg` above.
#
# Output is discarded to the null device, not a file (fix round 2, Finding
# 5): fix round 1 shipped static, non-unique discard *file* paths under the
# temp directory, which two near-concurrent spawns (rapid consecutive
# failures, or two PowerShell sessions on the same machine -- an ordinary
# thing, not a corner case) could collide on, silently dropping one
# invocation's memory write. `-RedirectStandardOutput`/`-RedirectStandardError`
# refuse an identical value for both parameters, so this uses two distinct
# spellings of the same device: `\\.\NUL` (the explicit Win32 device-
# namespace form, the same style `\\.\CON` already uses) for stdout, and the
# bare classic device name `NUL` for stderr. Verified empirically, both
# hosts, both parameter orderings: neither creates a stray file named `NUL`
# in the working directory and neither throws -- this is NOT the same trap
# bare `CON` sprang for `sayTty`/`detailTty` (that was Node's own `fs`
# layer mishandling a bare device name via long-path prefixing;
# `Start-Process`'s redirect-file setup is a different code path, verified
# separately, not assumed safe by analogy). No filesystem path is unique
# per invocation because none is needed: there is no file, so there is
# nothing to collide on and nothing to clean up.
#
# A `.ps1` target (the real npm-installed shim) cannot be launched directly
# by `Start-Process` -- routed through the same PowerShell executable this
# session is already running under, whichever host or install location that
# turns out to be.
#
# F2 (task-a-brief, manual PowerShell checklist): this spawn's own
# console write can never be ordered correctly against THIS session's next
# prompt draw -- it lands on `\\.\CON` whenever the child process happens to
# reach that statement, asynchronously, unrelated to when Start-Process
# itself returns. Proven on a real console (findings doc): the write arrives
# after the prompt is already drawn (sometimes mid-message, truncated), or
# lands on top of whatever the user has already started typing. A detached
# child writing straight to the shared console device has no way to fix
# this from its side -- nothing it does can make its own write race-free
# against a sibling process's read-eval-print loop.
#
# ROCKY_HOOK_SPEECH_FILE is the fix: set only around this one spawn, to a
# path unique to this invocation, so sayTty/detailTty (ui/rocky.ts) buffer
# their lines instead of writing the console, and publish them as one
# atomic unit under that exact name once this specific handler finishes.
# `prompt` below is the only reader, and the only place this file's speech
# is ever printed: correctly ordered there because nothing else runs
# between that print and the prompt string `prompt` itself returns.
#
# Set/restore, not set/leave: Start-Process (CreateProcess underneath)
# snapshots the parent's environment block once, at spawn time, so clearing
# this session's own copy immediately after issuing the spawn cannot
# un-deliver it to the already-launched child, and it can never leak into
# an environment variable a command the user types themselves might read.
# A fresh GUID per call (not a fixed name) is Finding 5's exact lesson
# applied here too: two overlapping spawns must never collide on one name,
# or the second rename silently discards the first message before `prompt`
# ever reads it.
function global:__rockySpawnDetached([string]$exe, [string[]]$scriptArgs) {
    try {
        $resolved = Get-Command $exe -ErrorAction SilentlyContinue
        if (-not $resolved) { return }
        $target = $resolved.Source

        $__rockyHomeForSpeech = if ($env:ROCKY_HOME) { $env:ROCKY_HOME } else { Join-Path $HOME '.rocky' }
        $__rockySpeechName = "$([System.Guid]::NewGuid().ToString('N')).txt"
        $speechFile = Join-Path (Join-Path $__rockyHomeForSpeech 'hook-speech') $__rockySpeechName
        # Finding 1: this session claims the name now, before the spawn --
        # the drain loop in `prompt` will only ever speak a file whose name
        # is in this list, so this is the one place session ownership is
        # established.
        $global:__rockySpeechIds += $__rockySpeechName
        $previousSpeechFile = $env:ROCKY_HOOK_SPEECH_FILE
        $env:ROCKY_HOOK_SPEECH_FILE = $speechFile
        try {
            if ($target -match '\.ps1$') {
                $hostExe = (Get-Process -Id $PID).Path
                $compensated = $scriptArgs | ForEach-Object { __rockyPreCompensateForShim $_ }
                $quotedArgs = $compensated | ForEach-Object { __rockyQuoteArg $_ }
                $allArgs = @('-NoProfile', '-NonInteractive', '-File', (__rockyQuoteArg $target)) + $quotedArgs
                Start-Process -FilePath $hostExe -ArgumentList $allArgs -NoNewWindow `
                    -RedirectStandardOutput '\\.\NUL' -RedirectStandardError 'NUL' -ErrorAction Stop | Out-Null
            } else {
                $quotedArgs = $scriptArgs | ForEach-Object { __rockyQuoteArg $_ }
                Start-Process -FilePath $target -ArgumentList $quotedArgs -NoNewWindow `
                    -RedirectStandardOutput '\\.\NUL' -RedirectStandardError 'NUL' -ErrorAction Stop | Out-Null
            }
        } finally {
            if ($null -eq $previousSpeechFile) {
                Remove-Item Env:\ROCKY_HOOK_SPEECH_FILE -ErrorAction SilentlyContinue
            } else {
                $env:ROCKY_HOOK_SPEECH_FILE = $previousSpeechFile
            }
        }
    } catch {
        # A broken spawn must never reach the user as a terminating error --
        # same contract every other fallible step in this file already keeps.
    }
}

function global:prompt {
    # 1. Capture $? as the ABSOLUTE FIRST statement. Any statement that runs
    #    before this -- including reading $LASTEXITCODE into a variable --
    #    already resets $? to True as a side effect of merely succeeding
    #    (verified in the spike and reconfirmed for this file: a bare
    #    assignment is itself a "successful statement").
    $__rockyQ = $?
    $__rockyExit = $LASTEXITCODE

    # 2. Call the wrapped/inner prompt FIRST, before Rocky's own bookkeeping
    #    touches anything. $?/$LASTEXITCODE are still exactly what the
    #    user's last real command left them as at this point, so a prompt
    #    framework that reads them itself (starship, oh-my-posh, a
    #    hand-written prompt showing the last exit code) sees the truth, not
    #    Rocky's own mid-flight state. Verified empirically, both hosts, in
    #    this release's task-4-report.md.
    $__rockyResult = $null
    if ($global:__rockyInnerPromptBlock) {
        try {
            $__rockyResult = & $global:__rockyInnerPromptBlock
        } catch {
            # A prompt that throws inside the user's own code must not
            # become Rocky's problem or the user's crash -- fall back.
            $__rockyResult = $null
        }
    }
    if ($null -eq $__rockyResult) {
        $__rockyResult = "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }

    try {
        if (-not $global:__rockyDisabled -and -not $env:ROCKY_OFF) {
            # F2: print whatever a previous detached spawn buffered instead
            # of writing the console directly (see __rockySpawnDetached and
            # ui/rocky.ts's flushHookSpeech). This is the only place any
            # hook-origin speech is ever printed on PowerShell now, and it is
            # correctly ordered here: nothing else in this function writes
            # the console between this loop and the prompt string returned
            # at the very end, so a message is never interleaved with the
            # prompt draw or with whatever the user is already typing.
            #
            # A message is necessarily at least one prompt cycle behind the
            # command it describes -- the child that produced it is still
            # running, somewhere, when THIS prompt call starts; that lag is
            # not a bug, it is fix round 1's non-blocking spawn (Finding 1)
            # doing exactly what it was built to do.
            $__rockyHomeForSpeech = if ($env:ROCKY_HOME) { $env:ROCKY_HOME } else { Join-Path $HOME '.rocky' }
            $__rockySpeechDir = Join-Path $__rockyHomeForSpeech 'hook-speech'
            if (Test-Path -LiteralPath $__rockySpeechDir) {
                # Finding 4 (task-a review round 2): every file in this
                # directory is listed, not just *.txt -- an orphaned *.tmp
                # fragment from a write interrupted mid-flight (process
                # killed) matched nothing before and was never pruned.
                # Finding 1's staleness cutoff below prunes those too.
                #
                # 10 minutes, not 24 hours (task-a review round 3): the
                # cutoff carries zero safety weight either way -- Finding 1's
                # allowlist check above is what actually prevents
                # misattribution, unconditionally, regardless of any file's
                # age. This threshold only trades off litter lifetime against
                # the odds of pruning a message before its own idle-but-live
                # originating session gets back to it. Real writes finish in
                # well under a second (Finding 5, fix round 2), so 10 minutes
                # is already generous margin for that -- and orders of
                # magnitude shorter than 24 hours for everything else, which
                # is the litter this cutoff exists to bound.
                $__rockyStaleCutoff = [DateTime]::UtcNow.AddMinutes(-10)
                $__rockySpeechEntries = Get-ChildItem -LiteralPath $__rockySpeechDir -File -ErrorAction SilentlyContinue
                foreach ($__rockySpeechEntry in $__rockySpeechEntries) {
                    if ($__rockySpeechEntry.Name -in $global:__rockySpeechIds) {
                        # Finding 1: this exact session spawned this file --
                        # the only files this loop ever speaks.
                        try {
                            # Finding 3 (task-a review round 2, verified on a
                            # real Windows PowerShell 5.1 host with non-ASCII
                            # content): Get-Content with no -Encoding defaults
                            # to the system ANSI codepage for a BOM-less file
                            # on Windows PowerShell 5.1, corrupting any
                            # non-ASCII byte ui/rocky.ts's UTF-8-no-BOM write
                            # produced -- PowerShell 7 was already correct.
                            # -Encoding UTF8 forces correct decoding on both
                            # editions regardless of BOM.
                            $__rockySpeechText = Get-Content -LiteralPath $__rockySpeechEntry.FullName -Raw -Encoding UTF8 -ErrorAction Stop
                            # Finding 2: re-sanitize on read -- see
                            # __rockySanitizeSpeechText above. Independent of
                            # whether this file's content is already known
                            # safe; a second, cheap layer, not a replacement
                            # for the write-time pass.
                            $__rockySpeechText = __rockySanitizeSpeechText $__rockySpeechText
                            if ($__rockySpeechText) {
                                __rockyWriteSpeechToConsole $__rockySpeechText
                            }
                        } catch {
                            # unreadable/vanished between listing and reading -- skip, never fatal
                        } finally {
                            Remove-Item -LiteralPath $__rockySpeechEntry.FullName -Force -ErrorAction SilentlyContinue
                            $global:__rockySpeechIds = @($global:__rockySpeechIds | Where-Object { $_ -ne $__rockySpeechEntry.Name })
                        }
                    } elseif ($__rockySpeechEntry.LastWriteTimeUtc -lt $__rockyStaleCutoff) {
                        # Finding 1 + Finding 4: not ours -- possibly another
                        # still-open session's own pending message (Windows
                        # PowerShell and PS7 share the same $env:ROCKY_HOME by
                        # default) -- so it is never spoken here regardless of
                        # age. Only once it is old enough that no session
                        # could realistically still be waiting to claim it
                        # (the ordinary case: a session closed right after a
                        # failure, before its own spawn even finished writing)
                        # is it pruned, silently, never printed.
                        Remove-Item -LiteralPath $__rockySpeechEntry.FullName -Force -ErrorAction SilentlyContinue
                    }
                    # else: not ours, but recent -- leave it alone untouched;
                    # it may still belong to a live session that has not had
                    # a prompt cycle yet.
                }
            }

            $__rockyHistory = Get-History -Count 1
            if ($__rockyHistory -and $__rockyHistory.Id -ne $global:__rockyLastSeenId) {
                $global:__rockyLastSeenId = $__rockyHistory.Id
                $__rockyCmd = $__rockyHistory.CommandLine
                $__rockyFirstWord = ($__rockyCmd.TrimStart() -split '\s+', 2)[0]
                # Denylist mirrors __rocky_precmd's case "$first_word" in
                # rocky-hook.bash (cd|pushd|popd|export|alias|source|.|rocky),
                # each entry translated to its PowerShell equivalent rather
                # than copied as a literal string (fix round 1, Finding 3 --
                # the narrower first draft here let a failing interactive
                # dot-source, or Push-Location/Pop-Location, get recorded as
                # hook-origin noise where Bash would have silently skipped
                # it): cd -> cd/Set-Location; pushd/popd -> the identically-
                # named PowerShell aliases plus their full cmdlet names
                # Push-Location/Pop-Location; alias -> Set-Alias/New-Alias;
                # source/. -> `.` (PowerShell has no separate "source"
                # keyword -- dot-sourcing is the only spelling, and it is
                # idiomatic and heavily used, exactly the gap this round
                # closes). `export` has no PowerShell entry: PowerShell's
                # nearest equivalent, `$env:X = 1`, is a variable assignment
                # whose first word is the variable reference itself, not a
                # command name -- there is no first-word form to denylist,
                # so nothing was silently dropped in translation. Shell
                # navigation and Rocky's own invocations carry no information
                # worth remembering, and a naive hook would double-record
                # `rocky run` failures on top of run.ts's own deep record.
                if ($__rockyFirstWord -notin @(
                    'cd', 'Set-Location',
                    'pushd', 'Push-Location',
                    'popd', 'Pop-Location',
                    'alias', 'Set-Alias', 'New-Alias',
                    '.',
                    'rocky'
                ) -and $__rockyCmd -notmatch '^\s*rocky\b') {
                    $__rockyHome = if ($env:ROCKY_HOME) { $env:ROCKY_HOME } else { Join-Path $HOME '.rocky' }
                    $__rockyBin = if ($env:ROCKY_BIN) { $env:ROCKY_BIN } else { 'rocky' }
                    if (-not (Get-Command $__rockyBin -ErrorAction SilentlyContinue)) {
                        if (-not $global:__rockyWarned) {
                            # Rocky's voice is stderr-only (README, ui/rocky.ts) --
                            # Write-Host writes to the host's Information stream,
                            # not stderr, so it would not match rocky-hook.bash's
                            # `>&2` twin of this exact message. [Console]::Error
                            # is the interactive session's own real stderr, not
                            # the same reserved-device write sayTty/detailTty use
                            # from a detached process -- this line always runs
                            # inside the live, console-attached prompt function.
                            [Console]::Error.WriteLine('[Rocky] rocky binary gone. my ears sleep now.')
                            $global:__rockyWarned = $true
                            $global:__rockyDisabled = $true
                        }
                    } else {
                        # $? is the sole failure gate -- confirmed empirically
                        # (task-4-report.md, real interactive PowerShell 5.1
                        # and 7.x) to be correct for both cmdlet and native
                        # failure/success alike (matches the spike's own §7.1
                        # data table). $LASTEXITCODE is used only AFTER a
                        # failure is already established, to recover a real
                        # numeric exit code when this failure was plausibly a
                        # native one -- never to independently decide
                        # pass/fail. An earlier draft of this file used
                        # $LASTEXITCODE as an unconditional OR with $?, which
                        # is a real, empirically-caught bug: $LASTEXITCODE
                        # stays stale from an earlier native command long
                        # after a later, wholly successful cmdlet, and that
                        # draft wrongly called _hookfail on every such
                        # success. $LASTEXITCODE -ne $null guards the same
                        # fresh-session gotcha the spike found (§8): it starts
                        # $null before any native command has ever run, and
                        # `$null -ne 0` is $true in PowerShell.
                        $__rockyFailed = -not $__rockyQ
                        if ($__rockyFailed) {
                            $__rockyNativeFailed = ($__rockyExit -ne $null) -and ($__rockyExit -ne 0)
                            $__rockyEffectiveExit = if ($__rockyNativeFailed) { $__rockyExit } else { 1 }
                            __rockySpawnDetached $__rockyBin @('_hookfail', $__rockyCmd, "$__rockyEffectiveExit", (Get-Location).Path)
                        } elseif (Test-Path (Join-Path $__rockyHome 'pending')) {
                            __rockySpawnDetached $__rockyBin @('_hooksuccess', $__rockyCmd, (Get-Location).Path)
                        }
                    }
                }
            }
        }
    } catch {
        # A broken hook body must never reach the user as a terminating error.
    }

    # 3. Restore $LASTEXITCODE unconditionally. This assignment always
    #    succeeds and is completely safe to do at any point.
    $global:LASTEXITCODE = $__rockyExit

    # 4. Restore $? as the ABSOLUTE LAST statement before the return value.
    #    Direct assignment to $? is impossible on either host (spike §7.3:
    #    a parse-time failure on Windows PowerShell 5.1, a recoverable
    #    non-terminating error on PowerShell 7.x -- neither usable). The
    #    only way left to force it back to False is a real, suppressed
    #    non-terminating error, which pushes one synthetic entry onto
    #    $Error ahead of the user's own. Disclosed, accepted trade-off
    #    (Ruling 2) -- `rocky hook status` and README name it. The message
    #    below names Rocky so a user who inspects $Error[0] is not left
    #    chasing a phantom failure.
    if (-not $__rockyQ) {
        Write-Error 'rocky-hook internal $? restore (harmless) -- see: rocky hook status' -ErrorAction SilentlyContinue 2>$null
    }

    # 5. Return the captured variable, not a literal -- verified empirically
    #    (task-4-report.md) not to disturb $? on either host: evaluating a
    #    bare variable/literal expression is not a command invocation, so it
    #    does not touch $?. The spike only proved this shape with a string
    #    literal; this file needed its own evidence for a variable, since it
    #    must hold the wrapped prompt's own output.
    $__rockyResult
}
