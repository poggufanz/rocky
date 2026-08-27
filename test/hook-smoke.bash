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

check_file_contains() { # check_file_contains <description> <needle> <path>
  local desc="$1" needle="$2" path="$3"
  if [[ -f "$path" ]] && grep -qF "$needle" "$path"; then
    echo "ok    - $desc"
  else
    echo "FAIL  - $desc"
    FAIL=1
  fi
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
check "last passive label removes empty queue" test ! -e "$ROCKY_HOME/labels"
check "normal passive drain leaves no private claim" test -z "$(find "$ROCKY_HOME" -maxdepth 1 -name '.labels.claim.*' -print -quit)"

# --- stamped labels: fresh speaks without its stamp, stale never speaks -----
STAMP_STDERR="$TMP/stamp.stderr"
NOW="$(date +%s)"
printf '@%s stale label\n@%s fresh label\n' "$((NOW - 4000))" "$NOW" > "$ROCKY_HOME/labels"
bash --noprofile --norc -i -c '
  source "$ROCKY_HOME/rocky-hook.bash"
  __rocky_last_cmd=""
  __rocky_precmd
  __rocky_last_cmd=""
  __rocky_precmd
' >/dev/null 2>"$STAMP_STDERR"
check "fresh stamped label prints without its stamp" \
  grep -qF '[Rocky] fresh label' "$STAMP_STDERR"
check "stale stamped label never prints" \
  test "$(grep -cF 'stale label' "$STAMP_STDERR" || true)" -eq 0
check "stale stamped label is still consumed" test ! -e "$ROCKY_HOME/labels"

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

run_label_prompt() { # <home> <locale> <stdout> <stderr> [off] [shim-dir] [race-mode] [race-path]
  local home="$1" locale_name="$2" out="$3" err="$4" off="${5:-}"
  local shim_dir="${6:-}" race_mode="${7:-}" race_path="${8:-}"
  local shim_prefix=""
  [[ -n "$shim_dir" ]] && shim_prefix="$shim_dir:"
  : > "$out"
  : > "$err"
  if [[ "$off" == "1" ]]; then
    ROCKY_OFF=1 PATH="$shim_prefix$PATH" ROCKY_LABEL_RACE_MODE="$race_mode" \
      ROCKY_LABEL_RACE_PATH="$race_path" ROCKY_LABEL_RACE_MARKER="$LABEL_RACE_MARKER" \
      ROCKY_LABEL_RACE_DIR="$LABEL_RACE_DIR" ROCKY_LABEL_REAL_STAT="$LABEL_REAL_STAT" \
      ROCKY_LABEL_REAL_MV="$LABEL_REAL_MV" ROCKY_LABEL_REAL_CAT="$LABEL_REAL_CAT" \
      ROCKY_LABEL_REAL_MKDIR="$LABEL_REAL_MKDIR" \
      ROCKY_LABEL_ESCAPE="$LABEL_ESCAPE" LC_ALL="$locale_name" ROCKY_HOME="$home" ROCKY_BIN="$LABEL_PROBE" \
      bash --noprofile --norc -i -c '
        source "$ROCKY_HOME/rocky-hook.bash"
        __rocky_last_cmd=""
        __rocky_precmd
      ' >"$out" 2>"$err" &
  else
    PATH="$shim_prefix$PATH" ROCKY_LABEL_RACE_MODE="$race_mode" \
      ROCKY_LABEL_RACE_PATH="$race_path" ROCKY_LABEL_RACE_MARKER="$LABEL_RACE_MARKER" \
      ROCKY_LABEL_RACE_DIR="$LABEL_RACE_DIR" ROCKY_LABEL_REAL_STAT="$LABEL_REAL_STAT" \
      ROCKY_LABEL_REAL_MV="$LABEL_REAL_MV" ROCKY_LABEL_REAL_CAT="$LABEL_REAL_CAT" \
      ROCKY_LABEL_REAL_MKDIR="$LABEL_REAL_MKDIR" \
      ROCKY_LABEL_ESCAPE="$LABEL_ESCAPE" LC_ALL="$locale_name" ROCKY_HOME="$home" ROCKY_BIN="$LABEL_PROBE" \
      bash --noprofile --norc -i -c '
        source "$ROCKY_HOME/rocky-hook.bash"
        __rocky_last_cmd=""
        __rocky_precmd
      ' >"$out" 2>"$err" &
  fi
  local pid=$! ticks=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    if [[ "$ticks" -ge 50 ]]; then
      # SIGTERM can remain pending while Bash is blocked in a FIFO redirection;
      # SIGKILL makes the bounded regression deterministic before cleanup.
      kill -KILL "$pid" >/dev/null 2>&1 || true
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

run_two_label_prompts() { # <home> <locale> <out1> <err1> <out2> <err2> [shim-dir] [race-mode]
  local home="$1" locale_name="$2" out1="$3" err1="$4" out2="$5" err2="$6"
  local shim_dir="${7:-}" race_mode="${8:-}" shim_prefix="" pid1 pid2 ticks=0 status1=0 status2=0
  [[ -n "$shim_dir" ]] && shim_prefix="$shim_dir:"
  : > "$out1"
  : > "$err1"
  : > "$out2"
  : > "$err2"
  PATH="$shim_prefix$PATH" ROCKY_LABEL_RACE_MODE="$race_mode" \
    ROCKY_LABEL_RACE_PATH="$home/labels" ROCKY_LABEL_RACE_MARKER="$LABEL_RACE_MARKER" \
    ROCKY_LABEL_RACE_DIR="$LABEL_RACE_DIR" ROCKY_LABEL_REAL_STAT="$LABEL_REAL_STAT" \
    ROCKY_LABEL_REAL_MV="$LABEL_REAL_MV" ROCKY_LABEL_REAL_CAT="$LABEL_REAL_CAT" \
    ROCKY_LABEL_REAL_MKDIR="$LABEL_REAL_MKDIR" \
    LC_ALL="$locale_name" ROCKY_HOME="$home" ROCKY_BIN="$LABEL_PROBE" \
    bash --noprofile --norc -i -c '
      source "$ROCKY_HOME/rocky-hook.bash"
      __rocky_last_cmd=""
      __rocky_precmd
    ' >"$out1" 2>"$err1" &
  pid1=$!
  PATH="$shim_prefix$PATH" ROCKY_LABEL_RACE_MODE="$race_mode" \
    ROCKY_LABEL_RACE_PATH="$home/labels" ROCKY_LABEL_RACE_MARKER="$LABEL_RACE_MARKER" \
    ROCKY_LABEL_RACE_DIR="$LABEL_RACE_DIR" ROCKY_LABEL_REAL_STAT="$LABEL_REAL_STAT" \
    ROCKY_LABEL_REAL_MV="$LABEL_REAL_MV" ROCKY_LABEL_REAL_CAT="$LABEL_REAL_CAT" \
    ROCKY_LABEL_REAL_MKDIR="$LABEL_REAL_MKDIR" \
    LC_ALL="$locale_name" ROCKY_HOME="$home" ROCKY_BIN="$LABEL_PROBE" \
    bash --noprofile --norc -i -c '
      source "$ROCKY_HOME/rocky-hook.bash"
      __rocky_last_cmd=""
      __rocky_precmd
    ' >"$out2" 2>"$err2" &
  pid2=$!
  while kill -0 "$pid1" >/dev/null 2>&1 || kill -0 "$pid2" >/dev/null 2>&1; do
    if [[ "$ticks" -ge 60 ]]; then
      kill -KILL "$pid1" "$pid2" >/dev/null 2>&1 || true
      wait "$pid1" >/dev/null 2>&1 || true
      wait "$pid2" >/dev/null 2>&1 || true
      echo "FAIL  - simultaneous label prompts timed out"
      FAIL=1
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid1" || status1=$?
  wait "$pid2" || status2=$?
  if [[ "$status1" -ne 0 || "$status2" -ne 0 ]]; then
    echo "FAIL  - simultaneous label prompts exited $status1/$status2"
    FAIL=1
    return 1
  fi
  return 0
}

# Deterministic race shims: stat observes the opened claim descriptor, then
# swaps the public pathname or kills the drain at selected commit points. The
# prompt helper kills a stuck child after five seconds, so regressions remain
# bounded.
LABEL_RACE_BIN="$TMP/label-race-bin"
mkdir -p "$LABEL_RACE_BIN"
LABEL_RACE_MARKER="$TMP/label-race-marker"
LABEL_RACE_DIR="$TMP/label-race-dir"
mkdir -p "$LABEL_RACE_DIR"
LABEL_REAL_STAT="$(command -v stat || true)"
LABEL_REAL_MV="$(command -v mv || true)"
LABEL_REAL_CAT="$(command -v cat || true)"
LABEL_REAL_MKDIR="$(command -v mkdir || true)"
LABEL_ESCAPE="$TMP/label-escape"
mkdir -p "$LABEL_ESCAPE"
cat > "$LABEL_RACE_BIN/mkdir" <<'MKDIR'
#!/usr/bin/env bash
if [[ "$ROCKY_LABEL_RACE_MODE" == "invalid-marker-fail" &&
      "${1:-}" == "$ROCKY_HOME"/.labels.claim.*/*.invalid ]]; then
  : > "$ROCKY_LABEL_RACE_DIR/invalid-marker-attempt"
  exit 1
fi
exec "$ROCKY_LABEL_REAL_MKDIR" "$@"
MKDIR
chmod +x "$LABEL_RACE_BIN/mkdir"
cat > "$LABEL_RACE_BIN/stat" <<'STAT'
#!/usr/bin/env bash
"$ROCKY_LABEL_REAL_STAT" "$@" || exit $?
if [[ ! -e "$ROCKY_LABEL_RACE_MARKER" && \
      ( ( "$1" == "-c" && "$2" == "%s" && "$3" == "$ROCKY_LABEL_RACE_PATH" ) ||
        ( "$1" == "-Lc" && "$2" == "%s" && "$3" == "/dev/fd/9" ) ||
        ( "$1" == "-f" && "$2" == "%z" && "$3" == "/dev/fd/9" ) ) ]]; then
  : > "$ROCKY_LABEL_RACE_MARKER"
  case "$ROCKY_LABEL_RACE_MODE" in
    fifo)
      rm -f "$ROCKY_LABEL_RACE_PATH"
      mkfifo "$ROCKY_LABEL_RACE_PATH"
      ;;
    symlink-fifo)
      rm -f "$ROCKY_LABEL_RACE_PATH"
      mkfifo "$ROCKY_LABEL_RACE_PATH.target"
      ln -s "$ROCKY_LABEL_RACE_PATH.target" "$ROCKY_LABEL_RACE_PATH"
      ;;
    destination-swap)
      rm -f "$ROCKY_LABEL_RACE_PATH"
      ln -s "$ROCKY_LABEL_ESCAPE" "$ROCKY_LABEL_RACE_PATH"
      ;;
    destination-fifo)
      rm -f "$ROCKY_LABEL_RACE_PATH"
      mkfifo "$ROCKY_LABEL_RACE_PATH"
      ;;
  esac
fi
STAT
chmod +x "$LABEL_RACE_BIN/stat"
cat > "$LABEL_RACE_BIN/mv" <<'MV'
#!/usr/bin/env bash
if [[ "$ROCKY_LABEL_RACE_MODE" == "atomic-rename-boundary" &&
      "${1:-}" == "$ROCKY_HOME"/.labels.claim.* &&
      "${2:-}" == "$ROCKY_HOME"/.labels.claim.*.work.* ]]; then
  : > "$ROCKY_LABEL_RACE_DIR/rename-entrant.$BASHPID"
  __rocky_race_ticks=0
  while [[ ! -e "$ROCKY_LABEL_RACE_DIR/release" && "$__rocky_race_ticks" -lt 100 ]]; do
    if [[ "$(find "$ROCKY_LABEL_RACE_DIR" -maxdepth 1 -name 'rename-entrant.*' -type f -print | wc -l)" -ge 2 ]]; then
      : > "$ROCKY_LABEL_RACE_DIR/rename-boundary"
      : > "$ROCKY_LABEL_RACE_DIR/release"
    fi
    sleep 0.01
    __rocky_race_ticks=$((__rocky_race_ticks + 1))
  done
elif [[ "$ROCKY_LABEL_RACE_MODE" == "crash-after-owner-rename" &&
        "${1:-}" == "$ROCKY_HOME"/.labels.claim.* &&
        "${2:-}" == "$ROCKY_HOME"/.labels.claim.*.work.* ]]; then
  "$ROCKY_LABEL_REAL_MV" "$@"
  status=$?
  if [[ "$status" -eq 0 ]]; then
    : > "$ROCKY_LABEL_RACE_DIR/owner-rename-boundary"
    : > "$ROCKY_LABEL_RACE_MARKER"
    kill -KILL "$PPID" >/dev/null 2>&1 || true
  fi
  exit "$status"
elif [[ "$ROCKY_LABEL_RACE_MODE" == "crash-after-claim" && "${1:-}" == "$ROCKY_LABEL_RACE_PATH" ]]; then
  "$ROCKY_LABEL_REAL_MV" "$@"
  status=$?
  if [[ "$status" -eq 0 ]]; then
    : > "$ROCKY_LABEL_RACE_MARKER"
    kill -KILL "$PPID" >/dev/null 2>&1 || true
  fi
  exit "$status"
elif [[ "$ROCKY_LABEL_RACE_MODE" == "late-producer" && "${1:-}" == "$ROCKY_LABEL_RACE_PATH" ]]; then
  "$ROCKY_LABEL_REAL_MV" "$@"
  status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'late producer label\n' > "$ROCKY_LABEL_RACE_PATH"
  fi
  exit "$status"
fi
exec "$ROCKY_LABEL_REAL_MV" "$@"
MV
chmod +x "$LABEL_RACE_BIN/mv"
cat > "$LABEL_RACE_BIN/cat" <<'CAT'
#!/usr/bin/env bash
"$ROCKY_LABEL_REAL_CAT" "$@"
status=$?
if [[ "$ROCKY_LABEL_RACE_MODE" == "crash-after-remainder" && "$status" -eq 0 ]]; then
  : > "$ROCKY_LABEL_RACE_MARKER"
  kill -KILL "$PPID" >/dev/null 2>&1 || true
fi
exit "$status"
CAT
chmod +x "$LABEL_RACE_BIN/cat"

# The old implementation reopens labels after this stat check. Both swaps
# therefore block its read, while a claim-first implementation must return.
rm -f "$LABEL_RACE_MARKER" "$LABEL_HOME/labels.target" "$LABEL_HOME/labels"
printf 'fifo race label\n' > "$LABEL_HOME/labels"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" fifo "$LABEL_HOME/labels" || RACE_STATUS=$?
check "FIFO reopen race stays bounded" test "$RACE_STATUS" -eq 0
check "FIFO race swaps after descriptor claim" test -e "$LABEL_RACE_MARKER"

rm -f "$LABEL_RACE_MARKER" "$LABEL_HOME/labels.target" "$LABEL_HOME/labels"
printf 'symlink FIFO race label\n' > "$LABEL_HOME/labels"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" symlink-fifo "$LABEL_HOME/labels" || RACE_STATUS=$?
check "symlink-to-FIFO reopen race stays bounded" test "$RACE_STATUS" -eq 0
check "symlink FIFO race swaps after descriptor claim" test -e "$LABEL_RACE_MARKER"

# A crash after atomic claim must leave a private queue that the next prompt
# can retry, without duplicating or losing the first line. The shim kills the
# drain subshell; the outer interactive shell still fails open with status 0.
rm -f "$LABEL_RACE_MARKER" "$LABEL_HOME/labels.target" "$LABEL_HOME/labels"
printf 'crash retry label\n' > "$LABEL_HOME/labels"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" crash-after-claim "$LABEL_HOME/labels"
check "claim crash is bounded" test "$RACE_STATUS" -eq 0
check "claim crash leaves marker" test -e "$LABEL_RACE_MARKER"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "crashed claim retries once" grep -qF '[Rocky] crash retry label' "$LABEL_STDERR"
check "crashed claim is cleaned" test -z "$(find "$LABEL_HOME" -maxdepth 1 -name '.labels.claim.*' -print -quit)"

# Atomic ownership is a directory rename boundary, not a marker publication.
# Both contenders must reach that real rename before the shim releases them;
# the committed lock protocol never reaches this barrier, so the assertion is
# intentionally observable rather than a shim-only success check.
CONCURRENT_OUT1="$TMP/concurrent-1.stdout"
CONCURRENT_ERR1="$TMP/concurrent-1.stderr"
CONCURRENT_OUT2="$TMP/concurrent-2.stdout"
CONCURRENT_ERR2="$TMP/concurrent-2.stderr"
rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_RACE_DIR"
mkdir -p "$LABEL_RACE_DIR" "$LABEL_HOME/.labels.claim.010-rename-boundary"
printf 'atomic retained head\n' > "$LABEL_HOME/.labels.claim.010-rename-boundary/remainder.next.1"
run_two_label_prompts "$LABEL_HOME" C "$CONCURRENT_OUT1" "$CONCURRENT_ERR1" \
  "$CONCURRENT_OUT2" "$CONCURRENT_ERR2" "$LABEL_RACE_BIN" atomic-rename-boundary
ATOMIC_HEAD_COUNT="$(cat "$CONCURRENT_ERR1" "$CONCURRENT_ERR2" | grep -a -cF '[Rocky] atomic retained head' || true)"
check "ownership rename race barrier fires" test -e "$LABEL_RACE_DIR/rename-boundary"
check "ownership rename race prints once" test "$ATOMIC_HEAD_COUNT" -eq 1
check "ownership rename race leaves no source" \
  test -z "$(find "$LABEL_HOME" -maxdepth 2 -type f -name 'remainder.next.*' -print -quit)"

# A crash immediately after the ownership rename leaves an owner-qualified
# private directory. The next prompt must reclaim it and deliver the head.
rm -f "$LABEL_RACE_MARKER"
rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_RACE_DIR"
mkdir -p "$LABEL_RACE_DIR" "$LABEL_HOME/.labels.claim.020-owner-crash"
printf 'owner rename crash retry\n' > "$LABEL_HOME/.labels.claim.020-owner-crash/remainder.next.1"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" \
  crash-after-owner-rename "$LABEL_HOME/.labels.claim.020-owner-crash" || RACE_STATUS=$?
check "owner rename crash is bounded" test "$RACE_STATUS" -eq 0
check "owner rename crash reaches rename boundary" test -e "$LABEL_RACE_DIR/owner-rename-boundary"
check "owner rename crash prints nothing before retry" \
  test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
check "owner rename crash retains renamed claim" \
  test -n "$(find "$LABEL_HOME" -maxdepth 1 -type d -name '.labels.claim.*.work.*' -print -quit)"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "owner rename crash retries head once" grep -qF '[Rocky] owner rename crash retry' "$LABEL_STDERR"
check "owner rename crash claim is cleaned" \
  test -z "$(find "$LABEL_HOME" -maxdepth 1 -name '.labels.claim.*' -print -quit)"

proc_start_time() { # <pid>; Linux/WSL /proc stat field 22 via final ") "
  local __proc_pid="$1" __proc_line="" __proc_rest=""
  IFS= read -r __proc_line 2>/dev/null < "/proc/$__proc_pid/stat" || return 1
  __proc_rest="${__proc_line##*) }"
  [[ "$__proc_rest" != "$__proc_line" ]] || return 1
  set -- $__proc_rest
  [[ "$#" -ge 20 ]] || return 1
  printf '%s\n' "${20}"
}
sleep 10 &
LIVE_OWNER_PID=$!
LIVE_OWNER_START="$(proc_start_time "$LIVE_OWNER_PID" || true)"
if [[ "$LIVE_OWNER_START" =~ ^[1-9][0-9]*$ ]]; then
  # Exact live PID + start time remains an owner and blocks younger public data.
  rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_RACE_DIR"
  mkdir -p "$LABEL_RACE_DIR" "$LABEL_HOME/.labels.claim.030-live-owner.work.$LIVE_OWNER_PID.$LIVE_OWNER_START.301"
  printf 'live owner head\n' > "$LABEL_HOME/.labels.claim.030-live-owner.work.$LIVE_OWNER_PID.$LIVE_OWNER_START.301/remainder.next.1"
  printf 'younger public label\n' > "$LABEL_HOME/labels"
  run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
  check "exact live owner blocks younger claim" \
    test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
  check_file_contains "exact live owner retains head" 'live owner head' \
    "$LABEL_HOME/.labels.claim.030-live-owner.work.$LIVE_OWNER_PID.$LIVE_OWNER_START.301/remainder.next.1"
  check "exact live owner retains public queue" grep -qF 'younger public label' "$LABEL_HOME/labels"
  rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_HOME/labels"

  # A reused PID with a deliberately mismatched start time is reclaimable.
  MISMATCHED_START=$((LIVE_OWNER_START + 1))
  rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_RACE_DIR"
  mkdir -p "$LABEL_RACE_DIR" "$LABEL_HOME/.labels.claim.040-reused-owner.work.$$.$MISMATCHED_START.401"
  printf 'reused PID reclaimed\n' > "$LABEL_HOME/.labels.claim.040-reused-owner.work.$$.$MISMATCHED_START.401/remainder.next.1"
  run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
  check "mismatched live PID start is reclaimed" grep -qF '[Rocky] reused PID reclaimed' "$LABEL_STDERR"
  check "mismatched owner claim is cleaned" \
    test -z "$(find "$LABEL_HOME" -maxdepth 1 -name '.labels.claim.*' -print -quit)"
  rm -rf "$LABEL_HOME"/.labels.claim.*

  # A dead owner PID must be reclaimed without bash leaking the failed /proc
  # open ("No such file or directory") onto the terminal — that leak fired on
  # every prompt during 2026-08-24 dogfooding.
  bash -c ':' &
  DEAD_OWNER_PID=$!
  wait "$DEAD_OWNER_PID" >/dev/null 2>&1 || true
  if [[ ! -e "/proc/$DEAD_OWNER_PID" ]]; then
    rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_RACE_DIR"
    mkdir -p "$LABEL_RACE_DIR" "$LABEL_HOME/.labels.claim.050-dead-owner.work.$DEAD_OWNER_PID.12345.501"
    printf 'dead owner reclaimed\n' > "$LABEL_HOME/.labels.claim.050-dead-owner.work.$DEAD_OWNER_PID.12345.501/remainder.next.1"
    run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
    check "dead owner claim is reclaimed" grep -qF '[Rocky] dead owner reclaimed' "$LABEL_STDERR"
    check "dead owner probe leaks no bash error" \
      test "$(grep -a -c 'No such file' "$LABEL_STDERR" || true)" -eq 0
    rm -rf "$LABEL_HOME"/.labels.claim.*
  else
    echo "ok    - dead owner reclaim check skipped (pid still present)"
  fi
else
  echo "ok    - /proc owner identity checks skipped"
fi
kill "$LIVE_OWNER_PID" >/dev/null 2>&1 || true
wait "$LIVE_OWNER_PID" >/dev/null 2>&1 || true

# A permanently invalid retained claim must not stop later valid retained or
# public labels. Invalid data stays inside the private claim namespace.
rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_RACE_DIR"
mkdir -p "$LABEL_HOME/.labels.claim.010-invalid" "$LABEL_HOME/.labels.claim.020-valid"
head -c 65537 /dev/zero > "$LABEL_HOME/.labels.claim.010-invalid/remainder.next.bad"
printf 'valid after invalid\n' > "$LABEL_HOME/.labels.claim.020-valid/remainder.next.good"
printf 'public after retained\n' > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "invalid retained claim does not starve valid retained" \
  grep -qF '[Rocky] valid after invalid' "$LABEL_STDERR"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "invalid retained claim does not starve public queue" \
  grep -qF '[Rocky] public after retained' "$LABEL_STDERR"
check "invalid retained claim remains private" \
  test -n "$(find "$LABEL_HOME" -type f -name 'remainder.next.bad' -print -quit)"
rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_RACE_DIR"

# If invalid-marker publication fails, the bad bytes stay private and are
# skipped locally for this drain. Later retained/public labels still advance;
# the shim marker proves the failure path actually ran.
rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_RACE_DIR"
mkdir -p "$LABEL_RACE_DIR" "$LABEL_HOME/.labels.claim.010-invalid-marker-fail" \
  "$LABEL_HOME/.labels.claim.020-valid-after-marker-fail"
head -c 65537 /dev/zero > "$LABEL_HOME/.labels.claim.010-invalid-marker-fail/remainder.next.bad"
printf 'valid after marker failure\n' > "$LABEL_HOME/.labels.claim.020-valid-after-marker-fail/remainder.next.good"
printf 'public after marker failure\n' > "$LABEL_HOME/labels"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" \
  invalid-marker-fail "$LABEL_HOME/.labels.claim.010-invalid-marker-fail/remainder.next.bad" || RACE_STATUS=$?
check "invalid-marker failure prompt stays bounded" test "$RACE_STATUS" -eq 0
check "invalid-marker failure is exercised" test -e "$LABEL_RACE_DIR/invalid-marker-attempt"
check "invalid-marker failure does not starve valid retained" \
  grep -qF '[Rocky] valid after marker failure' "$LABEL_STDERR"
check "invalid-marker failure keeps bytes private" \
  test -n "$(find "$LABEL_HOME" -type f -name 'remainder.next.bad' -print -quit)"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" \
  invalid-marker-fail "$LABEL_HOME/.labels.claim.010-invalid-marker-fail/remainder.next.bad"
check "invalid-marker failure does not starve public queue" \
  grep -qF '[Rocky] public after marker failure' "$LABEL_STDERR"
rm -rf "$LABEL_HOME"/.labels.claim.* "$LABEL_HOME/labels" "$LABEL_RACE_DIR"

# A crash after private remainder persistence but before display must retry the
# original queue head first; otherwise persisted remainder could overtake it.
rm -f "$LABEL_RACE_MARKER" "$LABEL_HOME/labels.target" "$LABEL_HOME/labels"
printf 'persist crash first\npersist crash second\n' > "$LABEL_HOME/labels"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" crash-after-remainder "$LABEL_HOME/labels"
check "persisted remainder crash is bounded" test "$RACE_STATUS" -eq 0
check "persisted remainder crash leaves marker" test -e "$LABEL_RACE_MARKER"
check "persisted remainder crash prints nothing early" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "persisted remainder retries original head first" grep -qF '[Rocky] persist crash first' "$LABEL_STDERR"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "persisted remainder prints second after head" grep -qF '[Rocky] persist crash second' "$LABEL_STDERR"
check "persisted remainder crash claim is cleaned" test -z "$(find "$LABEL_HOME" -maxdepth 1 -name '.labels.claim.*' -print -quit)"

# A public-path swap is injected after descriptor validation. The hardened path
# never opens that path for remainder publication, so it must stay bounded and
# leave the outside target untouched.
rm -f "$LABEL_RACE_MARKER" "$LABEL_HOME/labels.target" "$LABEL_HOME/labels"
printf 'destination race first\ndestination race second\n' > "$LABEL_HOME/labels"
mkdir -p "$LABEL_ESCAPE"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" destination-swap "$LABEL_HOME/labels" || RACE_STATUS=$?
check "destination swap prompt stays bounded" test "$RACE_STATUS" -eq 0
check "destination collision is injected at descriptor boundary" test -e "$LABEL_RACE_MARKER"
check "destination swap still prints claimed head" grep -qF '[Rocky] destination race first' "$LABEL_STDERR"
check "destination swap does not write outside Rocky home" test -z "$(find "$LABEL_ESCAPE" -mindepth 1 -maxdepth 1 -type f -print -quit)"
check "destination swap leaves symlink collision visible" test -L "$LABEL_HOME/labels"
rm -f "$LABEL_HOME/labels"
rm -rf "$LABEL_HOME"/.labels.claim.*

# A FIFO inserted at the public path must not matter: remainder retention is
# private, so the prompt never attempts a blocking open of this destination.
rm -f "$LABEL_RACE_MARKER" "$LABEL_HOME/labels.target" "$LABEL_HOME/labels"
printf 'destination fifo first\ndestination fifo second\n' > "$LABEL_HOME/labels"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" destination-fifo "$LABEL_HOME/labels" || RACE_STATUS=$?
check "destination FIFO collision stays bounded" test "$RACE_STATUS" -eq 0
check "destination FIFO collision is injected at descriptor boundary" test -e "$LABEL_RACE_MARKER"
check "destination FIFO collision remains visible" test -p "$LABEL_HOME/labels"
check "destination FIFO collision still prints claimed head" grep -qF '[Rocky] destination fifo first' "$LABEL_STDERR"
rm -f "$LABEL_HOME/labels"
rm -rf "$LABEL_HOME"/.labels.claim.*

# A late producer can win the public destination after the claim is read.
# The claimed remainder must stay in a private recoverable path, then be
# prioritized before this late public label on the next prompt.
rm -f "$LABEL_RACE_MARKER" "$LABEL_HOME/labels.target" "$LABEL_HOME/labels"
printf 'old before late\nold after late\n' > "$LABEL_HOME/labels"
RACE_STATUS=0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR" "" "$LABEL_RACE_BIN" late-producer "$LABEL_HOME/labels" || RACE_STATUS=$?
check "late producer prompt stays bounded" test "$RACE_STATUS" -eq 0
check "late producer keeps first old label" grep -qF '[Rocky] old before late' "$LABEL_STDERR"
check "late producer publishes newer public label" grep -qF 'late producer label' "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "retained remainder is retried" grep -qF '[Rocky] old after late' "$LABEL_STDERR"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "late label follows retained remainder" grep -qF '[Rocky] late producer label' "$LABEL_STDERR"

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
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "sanitized label still dequeues first line" grep -qF '[Rocky] second safe label' "$LABEL_STDERR"
check "sanitized label drain removes private claim" test -z "$(find "$LABEL_HOME" -maxdepth 1 -name '.labels.claim.*' -print -quit)"

# An empty first line is claimed without display, so it cannot block FIFO order.
printf '\nlast after empty\n' > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "empty label line is silent" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "label after empty line prints" grep -qF '[Rocky] last after empty' "$LABEL_STDERR"
check "empty-first-line claim drains" test -z "$(find "$LABEL_HOME" -maxdepth 1 -name '.labels.claim.*' -print -quit)"

# Keep the shell boundary aligned with agent-hook.ts: invisible/bidi controls
# outside the original subset must be inert in both byte and UTF-8 locales.
LABEL_VALUE="before safe"
LABEL_VALUE="${LABEL_VALUE}"$'\330\234\342\200\213\342\200\220\342\201\240\342\201\245\342\201\252\342\201\257\357\273\277'
LABEL_VALUE="${LABEL_VALUE} after safe"
printf '%s\n' "$LABEL_VALUE" > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "C locale missing bidi controls leave benign text" grep -qF '[Rocky] before safe' "$LABEL_STDERR"
check "C locale strips U+061C" bash -c '! LC_ALL=C grep -a -q "$(printf "\\330\\234")" "$1"' bash "$LABEL_STDERR"
check "C locale strips U+200B" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\200\\213")" "$1"' bash "$LABEL_STDERR"
check "C locale strips U+2060" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\201\\240")" "$1"' bash "$LABEL_STDERR"
check "C locale strips U+2065" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\201\\245")" "$1"' bash "$LABEL_STDERR"
check "C locale strips U+206A" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\201\\252")" "$1"' bash "$LABEL_STDERR"
check "C locale strips U+206F" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\201\\257")" "$1"' bash "$LABEL_STDERR"
check "C locale strips U+FEFF" bash -c '! LC_ALL=C grep -a -q "$(printf "\\357\\273\\277")" "$1"' bash "$LABEL_STDERR"
check "C locale missing bidi controls leave trailing text" grep -qF 'after safe' "$LABEL_STDERR"

# A precreated fixed-temp symlink remains untouched; claim/remainder paths are
# unique and private, and publication never targets this legacy pathname.
LABEL_FIXED_TARGET="$TMP/fixed-temp-target"
printf protected > "$LABEL_FIXED_TARGET"
ln -s "$LABEL_FIXED_TARGET" "$LABEL_HOME/labels.tmp"
printf 'unique temp label\n' > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "unique temp label prints" grep -qF '[Rocky] unique temp label' "$LABEL_STDERR"
check "fixed labels.tmp symlink remains untouched" test -L "$LABEL_HOME/labels.tmp"
check "fixed temp symlink target remains untouched" test "$(cat "$LABEL_FIXED_TARGET")" = protected

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
  UNREADABLE_CLAIM="$(find "$LABEL_HOME" -maxdepth 2 -type f -path "$LABEL_HOME/.labels.claim.*/queue" -print -quit)"
  check "unreadable labels queue remains recoverable" test -n "$UNREADABLE_CLAIM"
  check "unreadable claim retains bytes" test "$(stat -c %s "$UNREADABLE_CLAIM" 2>/dev/null || stat -f %z "$UNREADABLE_CLAIM" 2>/dev/null)" -eq 10
fi
rm -rf "$LABEL_HOME"/.labels.claim.*
chmod 600 "$LABEL_HOME/labels" 2>/dev/null || true
head -c 65537 /dev/zero > "$LABEL_HOME/labels"
run_label_prompt "$LABEL_HOME" C "$LABEL_STDOUT" "$LABEL_STDERR"
check "oversized labels queue is silent" test "$(grep -a -cF '[Rocky]' "$LABEL_STDERR" || true)" -eq 0
OVERSIZED_CLAIM="$(find "$LABEL_HOME" -maxdepth 2 -type f -path "$LABEL_HOME/.labels.claim.*/queue" -print -quit)"
check "oversized labels claim stays recoverable" test -n "$OVERSIZED_CLAIM"
check "oversized claim stays untouched" test "$(stat -c %s "$OVERSIZED_CLAIM" 2>/dev/null || stat -f %z "$OVERSIZED_CLAIM" 2>/dev/null)" -eq 65537
rm -rf "$LABEL_HOME"/.labels.claim.*

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
  LABEL_VALUE="before safe"
  LABEL_VALUE="${LABEL_VALUE}"$'\330\234\342\200\213\342\200\220\342\201\240\342\201\245\342\201\252\342\201\257\357\273\277'
  LABEL_VALUE="${LABEL_VALUE} after safe"
  printf '%s\n' "$LABEL_VALUE" > "$LABEL_HOME/labels"
  run_label_prompt "$LABEL_HOME" "$UTF8_LOCALE" "$LABEL_STDOUT" "$LABEL_STDERR"
  check "UTF-8 locale missing bidi controls leave benign text" grep -qF '[Rocky] before safe' "$LABEL_STDERR"
  check "UTF-8 locale strips U+061C" bash -c '! LC_ALL=C grep -a -q "$(printf "\\330\\234")" "$1"' bash "$LABEL_STDERR"
  check "UTF-8 locale strips U+200B" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\200\\213")" "$1"' bash "$LABEL_STDERR"
  check "UTF-8 locale strips U+2060" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\201\\240")" "$1"' bash "$LABEL_STDERR"
  check "UTF-8 locale strips U+2065" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\201\\245")" "$1"' bash "$LABEL_STDERR"
  check "UTF-8 locale strips U+206A" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\201\\252")" "$1"' bash "$LABEL_STDERR"
  check "UTF-8 locale strips U+206F" bash -c '! LC_ALL=C grep -a -q "$(printf "\\342\\201\\257")" "$1"' bash "$LABEL_STDERR"
  check "UTF-8 locale strips U+FEFF" bash -c '! LC_ALL=C grep -a -q "$(printf "\\357\\273\\277")" "$1"' bash "$LABEL_STDERR"
  check "UTF-8 locale missing bidi controls leave trailing text" grep -qF 'after safe' "$LABEL_STDERR"
else
  echo "ok    - UTF-8 locale label check skipped"
fi

# --- hook speech: a failing command's speech file is printed and removed ----
# Spec §6 (Ruling 2): a failing command produces a speech file, the next
# prompt prints it and removes it, and a name absent from the session array
# is left untouched. Fixtures use a separate real home, mirroring the label
# fixtures above.
SPEECH_HOME="$TMP/speech-home"
SPEECH_DIR="$SPEECH_HOME/hook-speech"
mkdir -p "$SPEECH_DIR"
cp "$ROCKY_HOME/rocky-hook.bash" "$SPEECH_HOME/rocky-hook.bash"
cp "$ROCKY_HOME/bash-preexec.sh" "$SPEECH_HOME/bash-preexec.sh"
SPEECH_PROBE="$TMP/rocky-speech-probe"
cat > "$SPEECH_PROBE" <<'WRAP'
#!/bin/sh
# The real handler buffers and publishes via flushHookSpeech (ui/rocky.ts);
# this shim stands in for it and writes the speech file directly, the same
# final on-disk shape the drain reads.
printf '[Rocky] smoke speech, question\n' > "$ROCKY_HOOK_SPEECH_FILE"
WRAP
chmod +x "$SPEECH_PROBE"
SPEECH_OUT2="$TMP/speech-2.stdout"
SPEECH_ERR2="$TMP/speech-2.stderr"
export SPEECH_SNAPSHOT="$TMP/speech-seen.txt"

# One live shell session, two prompts. Prompt 1: the failing command claims
# a name before the spawn and hands the handler a speech file to write.
# Prompt 2, the next prompt in the SAME session, drains it -- prints the
# message and removes the file. Both must share one process: the claim list
# is per-process state (session affinity, Finding 1), so a fresh bash would
# have an empty __rocky_speech_ids and its drain would return immediately.
# The detached shim writes asynchronously, so a bounded wait sits between
# the two precmd calls. The claimed name is reported on stdout as the last
# line.
ROCKY_HOME="$SPEECH_HOME" ROCKY_BIN="$SPEECH_PROBE" \
  bash --noprofile --norc -i -c '
    source "$ROCKY_HOME/rocky-hook.bash"
    __rocky_last_cmd="smoke failing cmd"
    false
    __rocky_precmd
    SPEECH_TICKS=0
    while [[ ! -f "$__rocky_speech_file" && "$SPEECH_TICKS" -lt 50 ]]; do
      sleep 0.1
      SPEECH_TICKS=$((SPEECH_TICKS + 1))
    done
    # Snapshot the claimed file before the drain removes it, so the message
    # content can be asserted after the session ends.
    if [[ -f "$__rocky_speech_file" ]]; then
      cp "$__rocky_speech_file" "$SPEECH_SNAPSHOT"
    fi
    # An unclaimed name in the shared directory is not ours to speak: it may
    # belong to another live session and must survive this drain untouched.
    printf "[Rocky] foreign speech, question\n" > "$ROCKY_HOME/hook-speech/foreign.txt"
    __rocky_last_cmd=""
    __rocky_precmd
    printf "%s\n" "${__rocky_speech_file:-}"
  ' >"$SPEECH_OUT2" 2>"$SPEECH_ERR2"
SPEECH_CLAIMED="$(tail -n 1 "$SPEECH_OUT2")"
check "failing command claims a speech file" test -n "$SPEECH_CLAIMED"
check_file_contains "failing command's speech file appears with its message" \
  '[Rocky] smoke speech, question' "$SPEECH_SNAPSHOT"

SPEECH_FOREIGN="$SPEECH_DIR/foreign.txt"
check "next prompt prints the speech message" \
  grep -qF '[Rocky] smoke speech, question' "$SPEECH_ERR2"
check "printed speech file is removed" test ! -e "$SPEECH_CLAIMED"
check "unclaimed speech file is left untouched" test -f "$SPEECH_FOREIGN"
check "unclaimed speech file is never printed" \
  bash -c '! grep -qF "foreign speech" "$1"' bash "$SPEECH_ERR2"

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
test -f "$TMP/fix-ready"
sleep 1
test -f "$TMP/fix-ready"
sleep 1
touch "$TMP/fix-ready"
sleep 1
test -f "$TMP/fix-ready"
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
