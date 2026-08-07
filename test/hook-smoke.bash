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
