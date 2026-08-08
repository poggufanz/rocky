#!/usr/bin/env bash
# Smoke test for rocky-hook.bash. Runs real interactive bash under script(1).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP"
export ROCKY_HOME="$TMP/.rocky"
FAIL=0

check() { # check <description> <condition...>
  local desc="$1"; shift
  if "$@"; then echo "ok    - $desc"; else echo "FAIL  - $desc"; FAIL=1; fi
}

# rocky wrapper so the hook can spawn a single executable path
cat > "$TMP/rocky" <<WRAP
#!/bin/sh
exec node "$ROOT/dist/index.js" "\$@"
WRAP
chmod +x "$TMP/rocky"
export ROCKY_BIN="$TMP/rocky"

# --- install ---------------------------------------------------------------
"$ROCKY_BIN" hook install >/dev/null 2>&1
check "install writes managed bashrc block" grep -q "rocky hook >>>" "$HOME/.bashrc"
check "install copies hook file"            test -f "$ROCKY_HOME/rocky-hook.bash"
check "install copies bash-preexec"         test -f "$ROCKY_HOME/bash-preexec.sh"
check "install writes guard rules"          test -f "$ROCKY_HOME/guard.rules"

# add a harmless test rule so guard can be exercised without danger
printf '^touch marker\ttest rule speaks\n' >> "$ROCKY_HOME/guard.rules"

# fixtures for the cwd-at-typed-time check
mkdir -p "$TMP/typed" "$TMP/elsewhere"

# rocky must be resolvable by name (not just $ROCKY_BIN) for the denylist's
# "rocky run ..." scenario to exercise a real invocation from the prompt.
export PATH="$TMP:$PATH"

# --- interactive session: guard + failure + fix-link -----------------------
# Input is paced (~0.3s/line) like a human typist. Dumping all lines at once
# lets readline read ahead past the guard's /dev/tty answer read, which desyncs
# the scripted session under script(1). Session content is unchanged.
SESSION_OUT="$TMP/session.log"
feed_session() {
  local line
  while IFS= read -r line; do
    printf '%s\n' "$line"
    sleep 0.3
  done
}
feed_session <<EOS | script -qec "bash -i" "$SESSION_OUT" > /dev/null 2>&1
cd "$TMP"
touch marker1
n
touch marker2
y
ls /rocky-not-here
sleep 1
ls /rocky-not-here
sleep 1
ls .
sleep 1
exit
EOS

check "guard cancel: 'n' answer stops command"  test ! -f "$TMP/marker1"
check "guard confirm: 'y' answer runs command"  test -f "$TMP/marker2"
grep -q "command not run" "$SESSION_OUT"; check "guard prints cancel message" test $? -eq 0
check "hook failure recorded"      grep -q '"origin":"hook"' "$ROCKY_HOME/memory.jsonl"
check "repeat failure remembered"  grep -q "deep memory need stderr" "$SESSION_OUT"
check "success links fix"          grep -q '"kind":"fix"' "$ROCKY_HOME/memory.jsonl"
check "pending flag cleared"       test ! -f "$ROCKY_HOME/pending"

# --- second interactive session: denylist + cwd-at-typed-time --------------
# Its own session (rather than appended to the one above) so its failures —
# and the pending flag they set — don't reopen the "pending flag cleared"
# assertion the first session already closed. Same $ROCKY_HOME, so records
# still land in the same memory.jsonl.
DENY_SESSION_OUT="$TMP/deny-session.log"
feed_session <<EOS2 | script -qec "bash -i" "$DENY_SESSION_OUT" > /dev/null 2>&1
cd "$TMP/typed"
sleep 1
cd /rocky-not-here-either
sleep 1
{ cd "$TMP/elsewhere"; } && ls /rocky-not-here
sleep 1
rocky run "sh -c 'exit 4'"
sleep 1
exit
EOS2

# --- denylist: builtins and rocky's own invocations carry no information ---
not_present() { ! grep -q "$1" "$2"; }
check "failing cd produces no memory record" \
  not_present "rocky-not-here-either" "$ROCKY_HOME/memory.jsonl"

# rocky's own exit code propagates from `rocky run`, so a naive hook would
# record the outer "rocky run ..." failure on top of run.ts's own deep
# record for the inner command — same failure, counted twice.
hook_origin_lines_matching() { # <substring>
  grep -F '"origin":"hook"' "$ROCKY_HOME/memory.jsonl" 2>/dev/null | grep -c -F -- "$1"
}
rocky_run_not_double_recorded() { [ "$(hook_origin_lines_matching "exit 4")" -eq 0 ]; }
check "rocky run failure not double-recorded by the hook" rocky_run_not_double_recorded

# --- cwd is where the command was typed, not where it ended ----------------
cwd_field_of_hook_record_matching() { # <substring>
  grep -F '"origin":"hook"' "$ROCKY_HOME/memory.jsonl" 2>/dev/null | grep -F -- "$1"
}
cwd_recorded_as_typed() {
  local line
  line=$(cwd_field_of_hook_record_matching "elsewhere")
  [ -n "$line" ] && printf '%s\n' "$line" | grep -qF "\"cwd\":\"$TMP/typed\""
}
check "cwd recorded is where command was typed" cwd_recorded_as_typed

# --- resilience: rules file gone, shell must stay alive --------------------
rm -f "$ROCKY_HOME/guard.rules"
ALIVE_OUT="$TMP/alive.log"
script -qec "bash -i" "$ALIVE_OUT" > /dev/null 2>&1 <<'EOS'
echo still-alive
exit
EOS
check "shell alive without rules file" grep -q "still-alive" "$ALIVE_OUT"

# --- uninstall -------------------------------------------------------------
"$ROCKY_BIN" hook uninstall >/dev/null 2>&1
grep -q "rocky hook >>>" "$HOME/.bashrc" && FAIL=1 && echo "FAIL  - uninstall leaves block"
echo "uninstall removes block: checked"

if [ "$FAIL" -ne 0 ]; then echo "SMOKE: FAIL"; exit 1; fi
echo "SMOKE: PASS"
