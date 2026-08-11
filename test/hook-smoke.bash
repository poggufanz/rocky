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

# --- passive labels: one per prompt, even with no captured command ---------
LABEL_STDOUT="$TMP/label.stdout"
LABEL_STDERR="$TMP/label.stderr"
printf 'first label\nsecond label\n' > "$ROCKY_HOME/labels"
bash --noprofile --norc -i -c '
  source "$ROCKY_HOME/rocky-hook.bash"
  __rocky_last_cmd=""
  __rocky_precmd
  __rocky_last_cmd=""
  __rocky_precmd
  __rocky_last_cmd=""
  __rocky_precmd
' >"$LABEL_STDOUT" 2>"$LABEL_STDERR"
check "first passive label prints once to stderr" \
  grep -qF '[Rocky] first label' "$LABEL_STDERR"
check "second passive label prints once to stderr" \
  grep -qF '[Rocky] second label' "$LABEL_STDERR"
check "passive labels preserve FIFO order" \
  test "$(grep -nF '[Rocky] first label' "$LABEL_STDERR" | head -n 1 | cut -d: -f1)" -lt \
       "$(grep -nF '[Rocky] second label' "$LABEL_STDERR" | head -n 1 | cut -d: -f1)"
check "third empty prompt is silent" \
  test "$(grep -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 2
check "passive labels keep stdout empty" test ! -s "$LABEL_STDOUT"
check "last passive label leaves an empty queue" test -f "$ROCKY_HOME/labels"
check "last passive label empties queue" test ! -s "$ROCKY_HOME/labels"

# Label fixtures use a separate real home, so malformed queue paths cannot
# affect the failure/fix checks below. Prompt calls are bounded to keep a
# regression that opens a FIFO from hanging the smoke gate.
LABEL_HOME="$TMP/label-home"
mkdir -p "$LABEL_HOME"
cp "$ROCKY_HOME/rocky-hook.bash" "$LABEL_HOME/rocky-hook.bash"
cp "$ROCKY_HOME/bash-preexec.sh" "$LABEL_HOME/bash-preexec.sh"
LABEL_SPAWN="$TMP/label-spawned"
LABEL_PROBE="$TMP/rocky-label-probe"
cat > "$LABEL_PROBE" <<'WRAP'
#!/bin/sh
printf x >> "$ROCKY_LABEL_SPAWN"
WRAP
chmod +x "$LABEL_PROBE"
export ROCKY_LABEL_SPAWN="$LABEL_SPAWN"

run_label_prompt() { # <home> <locale> <stdout> <stderr> [off]
  local home="$1" locale_name="$2" out="$3" err="$4" off="${5:-}"
  : > "$out"
  : > "$err"
  if [[ "$off" == "1" ]]; then
    ROCKY_OFF=1 LC_ALL="$locale_name" ROCKY_HOME="$home" ROCKY_BIN="$LABEL_PROBE" \
      bash --noprofile --norc -i -c '
        source "$ROCKY_HOME/rocky-hook.bash"
        __rocky_last_cmd=""
        __rocky_precmd
      ' >"$out" 2>"$err" &
  else
    LC_ALL="$locale_name" ROCKY_HOME="$home" ROCKY_BIN="$LABEL_PROBE" \
      bash --noprofile --norc -i -c '
        source "$ROCKY_HOME/rocky-hook.bash"
        __rocky_last_cmd=""
        __rocky_precmd
      ' >"$out" 2>"$err" &
  fi
  local pid=$! ticks=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    if [[ "$ticks" -ge 50 ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      echo "FAIL  - passive-label prompt timed out"
      FAIL=1
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid"
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "FAIL  - passive-label prompt exited $status"
    FAIL=1
  fi
  return "$status"
}

LABEL_STDOUT="$TMP/malformed-label.stdout"
LABEL_STDERR="$TMP/malformed-label.stderr"
LABEL_MARKER="$TMP/label-marker"
LABEL_VALUE="literal %s \$(touch \"$LABEL_MARKER\") "
LABEL_VALUE="${LABEL_VALUE}"$'\033[31mred\033[0m\001bell\007 '
LABEL_VALUE="${LABEL_VALUE}"$'\342\200\256bidi\342\200\256 end'
printf '%s\nsecond safe label\n' "$LABEL_VALUE" > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "label command substitution stays inert" test ! -e "$LABEL_MARKER"
check "label percent text stays data" grep -qF '[Rocky] literal %s $(touch "' "$LABEL_STDERR"
check "label ANSI and controls are stripped" \
  bash -c '! LC_ALL=C grep -a -q "$(printf "\\033")" "$1"' bash "$LABEL_STDERR"
check "label BEL is stripped" \
  bash -c '! LC_ALL=C grep -a -q "$(printf "\\007")" "$1"' bash "$LABEL_STDERR"
check "label C0 control is stripped" \
  bash -c '! LC_ALL=C grep -a -q "$(printf "\\001")" "$1"' bash "$LABEL_STDERR"
check "label bidi controls are stripped" \
  bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\200\\256")" "$1"' bash "$LABEL_STDERR"
check "label sanitization keeps stdout empty" test ! -s "$LABEL_STDOUT"
check "label probe is not spawned for display" test ! -e "$LABEL_SPAWN"
check "sanitized label still dequeues first line" grep -qF 'second safe label' "$LABEL_HOME/labels"

# An empty first line is claimed without display, so it cannot block FIFO order.
printf '\nlast after empty\n' > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "empty label line is silent" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
check "empty label line is dequeued" grep -qF 'last after empty' "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "label after empty line prints" grep -qF '[Rocky] last after empty' "$LABEL_STDERR"

# A failed atomic rename must not print or lose the claimed line. The fixed
# legacy temp name remains an attacker-controlled symlink and is never used.
LABEL_FIXED_TARGET="$TMP/fixed-temp-target"
printf protected > "$LABEL_FIXED_TARGET"
ln -s "$LABEL_FIXED_TARGET" "$LABEL_HOME/labels.tmp"
printf 'rename must fail\n' > "$LABEL_HOME/labels"
LABEL_FAKEBIN="$TMP/fakebin"
mkdir -p "$LABEL_FAKEBIN"
cat > "$LABEL_FAKEBIN/mv" <<'MV'
#!/bin/sh
exit 1
MV
chmod +x "$LABEL_FAKEBIN/mv"
OLD_PATH="$PATH"
PATH="$LABEL_FAKEBIN:$PATH"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
PATH="$OLD_PATH"
check "failed rename prints no label" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
check "failed rename keeps queue line" grep -qF 'rename must fail' "$LABEL_HOME/labels"
check "fixed labels.tmp symlink remains untouched" test -L "$LABEL_HOME/labels.tmp"
check "fixed temp symlink target remains untouched" test "$(cat "$LABEL_FIXED_TARGET")" = protected
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "successful unique rename prints queued label" grep -qF '[Rocky] rename must fail' "$LABEL_STDERR"

# Disabled mode leaves queued labels for the next enabled prompt.
printf 'off label\n' > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" 1
check "ROCKY_OFF suppresses label display" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
check "ROCKY_OFF leaves labels queued" grep -qF 'off label' "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "queued label displays after ROCKY_OFF" grep -qF '[Rocky] off label' "$LABEL_STDERR"

# Missing, empty, directory, FIFO, symlink, unreadable, and oversized queues
# all fail open without opening special files or mutating unsafe paths.
rm -f "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "missing labels queue is silent" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
: > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "empty labels queue is silent" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
rm -f "$LABEL_HOME/labels"
mkdir "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "directory labels queue is silent" test -d "$LABEL_HOME/labels"
rmdir "$LABEL_HOME/labels"
mkfifo "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "FIFO labels queue is silent without blocking" test -p "$LABEL_HOME/labels"
rm -f "$LABEL_HOME/labels"
printf symlink-target > "$LABEL_HOME/label-target"
ln -s "$LABEL_HOME/label-target" "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "symlink labels queue is silent" test -L "$LABEL_HOME/labels"
check "symlink labels target is untouched" test "$(cat "$LABEL_HOME/label-target")" = symlink-target
rm -f "$LABEL_HOME/labels"
printf unreadable > "$LABEL_HOME/labels"
chmod 000 "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
if [[ -r "$LABEL_HOME/labels" ]]; then
  echo "ok    - unreadable labels queue check skipped for privileged user"
else
  check "unreadable labels queue is silent" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
  check "unreadable labels queue remains" test "$(stat -c %s "$LABEL_HOME/labels" 2>/dev/null || stat -f %z "$LABEL_HOME/labels")" -eq 10
fi
chmod 600 "$LABEL_HOME/labels"
head -c 65537 /dev/zero > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "oversized labels queue is silent" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
check "oversized labels queue stays untouched" test "$(stat -c %s "$LABEL_HOME/labels" 2>/dev/null || stat -f %z "$LABEL_HOME/labels")" -eq 65537

# Repeat the hostile control case under a UTF-8 locale when available; the
# hook also has to remain safe when locale byte indexing is C.
UTF8_LOCALE=""
if LC_ALL=C.UTF-8 bash -c ':' >/dev/null 2>&1; then UTF8_LOCALE="C.UTF-8"; fi
if [[ -n "$UTF8_LOCALE" ]]; then
  LABEL_VALUE=$'utf8 \033[32mgreen\033[0m '
  LABEL_VALUE="${LABEL_VALUE}"$'\342\200\256bidi\342\200\256'
  printf '%s\n' "$LABEL_VALUE" > "$LABEL_HOME/labels"
  run_label_prompt "$LABEL_HOME" "$UTF8_LOCALE" "$LABEL_STDOUT" "$LABEL_STDERR"
  check "UTF-8 label prints without ANSI" \
    bash -c '! LC_ALL=C grep -a -q "$(printf "\\033")" "$1"' bash "$LABEL_STDERR"
  check "UTF-8 label strips bidi controls" \
    bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\200\\256")" "$1"' bash "$LABEL_STDERR"
else
  echo "ok    - UTF-8 locale label check skipped"
fi

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
