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

# Windows PowerShell 5.1 (PSEdition "Desktop") has a long-standing native-
# argument-passing bug, empirically reproduced and fixed in this release
# (task-4-report.md): a captured command string containing an embedded
# double-quote -- e.g. `cmd /c "exit 9" | Out-Null`, an entirely ordinary
# command -- arrives at the spawned `rocky` process split into TWO argv
# elements instead of one, corrupting the recorded command text and shifting
# every positional argument after it (exit code, cwd). Doubling each embedded
# `"` is the verified workaround on Desktop edition. PowerShell 7.x (PSEdition
# "Core") never had this bug and passes the same string through correctly
# unmodified -- doubling there was verified to actively break it (a literal
# doubled quote lands in the argument PS7 already passed through fine), so
# this only ever applies on Desktop edition. `(Get-Location).Path` needs no
# such handling: `"` is a reserved character no Windows path can ever contain.
function global:__rockyNativeArg([string]$value) {
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        return $value -replace '"', '""'
    }
    return $value
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
            $__rockyHistory = Get-History -Count 1
            if ($__rockyHistory -and $__rockyHistory.Id -ne $global:__rockyLastSeenId) {
                $global:__rockyLastSeenId = $__rockyHistory.Id
                $__rockyCmd = $__rockyHistory.CommandLine
                $__rockyFirstWord = ($__rockyCmd.TrimStart() -split '\s+', 2)[0]
                # Denylist mirrors __rocky_precmd's case "$first_word" in
                # rocky-hook.bash: shell navigation and Rocky's own
                # invocations carry no information worth remembering, and a
                # naive hook would double-record `rocky run` failures on top
                # of run.ts's own deep record.
                if ($__rockyFirstWord -notin @('cd', 'Set-Location', 'rocky') -and $__rockyCmd -notmatch '^\s*rocky\b') {
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
                        $__rockyCmdArg = __rockyNativeArg $__rockyCmd
                        if ($__rockyFailed) {
                            $__rockyNativeFailed = ($__rockyExit -ne $null) -and ($__rockyExit -ne 0)
                            $__rockyEffectiveExit = if ($__rockyNativeFailed) { $__rockyExit } else { 1 }
                            & $__rockyBin _hookfail $__rockyCmdArg $__rockyEffectiveExit (Get-Location).Path *> $null
                        } elseif (Test-Path (Join-Path $__rockyHome 'pending')) {
                            & $__rockyBin _hooksuccess $__rockyCmdArg (Get-Location).Path *> $null
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
