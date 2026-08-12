# rocky-hook.bash — Rocky's ears. Sourced from ~/.bashrc via the managed block.
#
# Contract: this file must NEVER break the shell. Every path fails silent and
# returns 0, except an explicit guard cancel (return 1 under extdebug).
# Hot path is pure bash; node is spawned only in the background, and only when
# a command fails or a fix-link attempt is worth it (pending flag exists).

# interactive shells only — scripts and CI never touched
[[ $- == *i* ]] || return 0

ROCKY_HOOK_VERSION="0.3.0"
__rocky_home="${ROCKY_HOME:-$HOME/.rocky}"
__rocky_bin="${ROCKY_BIN:-rocky}"
__rocky_disabled=""
__rocky_warned=""
__rocky_last_cmd=""
__rocky_last_cwd=""

# bash-preexec gives us preexec/precmd (DEBUG trap + PROMPT_COMMAND, battle-tested)
if [[ -r "$__rocky_home/bash-preexec.sh" ]]; then
  # shellcheck source=/dev/null
  source "$__rocky_home/bash-preexec.sh"
else
  return 0
fi

# extdebug: preexec function returning non-zero cancels the command
shopt -s extdebug

__rocky_guard() {
  local cmd="$1" regex msg ans
  [[ -r "$__rocky_home/guard.rules" ]] || return 0
  while IFS=$'\t' read -r regex msg; do
    [[ -z "$regex" || "${regex:0:1}" == "#" ]] && continue
    if [[ "$cmd" =~ $regex ]]; then
      printf '[Rocky] %s\n' "${msg:-dangerous command}" >&2
      ans=""
      printf '[Rocky] you sure, question (y/n) ' >&2
      if read -r ans </dev/tty 2>/dev/null; then
        [[ "$ans" == "y" || "$ans" == "Y" ]] && return 0
        printf '[Rocky] good. command not run.\n' >&2
        return 1
      fi
      # no usable tty: warn only, never block (CI safety)
      return 0
    fi
  done < "$__rocky_home/guard.rules"
  return 0
}

__rocky_preexec() {
  [[ -n "$__rocky_disabled" || -n "${ROCKY_OFF:-}" ]] && return 0
  __rocky_last_cmd="$1"
  __rocky_last_cwd="$PWD"
  if ! __rocky_guard "$1"; then
    __rocky_last_cmd=""
    __rocky_last_cwd=""
    return 1
  fi
  return 0
}

__rocky_sanitize_label() {
  local __rocky_input="$1"
  local __rocky_output=""
  local __rocky_char=""
  local __rocky_next=""
  local __rocky_control=""
  local __rocky_i=0
  local __rocky_output_len=0
  local __rocky_len=${#__rocky_input}

  # Remove UTF-8 encoded C1 and bidi controls before the byte/character walk;
  # these substitutions stay exact under both UTF-8 and C locales.
  for __rocky_control in \
    $'\302\200' $'\302\201' $'\302\202' $'\302\203' $'\302\204' $'\302\205' $'\302\206' $'\302\207' \
    $'\302\210' $'\302\211' $'\302\212' $'\302\213' $'\302\214' $'\302\215' $'\302\216' $'\302\217' \
    $'\302\220' $'\302\221' $'\302\222' $'\302\223' $'\302\224' $'\302\225' $'\302\226' $'\302\227' \
    $'\302\230' $'\302\231' $'\302\232' $'\302\233' $'\302\234' $'\302\235' $'\302\236' $'\302\237' \
    $'\330\234' \
    $'\342\200\213' $'\342\200\214' $'\342\200\215' $'\342\200\216' $'\342\200\217' \
    $'\342\200\252' $'\342\200\253' $'\342\200\254' $'\342\200\255' $'\342\200\256' \
    $'\342\201\240' $'\342\201\241' $'\342\201\242' $'\342\201\243' $'\342\201\244' $'\342\201\245' \
    $'\342\201\246' $'\342\201\247' $'\342\201\250' $'\342\201\251' $'\342\201\252' $'\342\201\253' $'\342\201\254' $'\342\201\255' $'\342\201\256' $'\342\201\257' \
    $'\357\273\277'; do
    __rocky_input="${__rocky_input//"$__rocky_control"/}"
  done
  __rocky_len=${#__rocky_input}

  # Walk the label as data.  This strips ANSI CSI/OSC sequences, terminal
  # controls, and bidi overrides without ever evaluating its contents.
  while (( __rocky_i < __rocky_len )); do
    __rocky_char="${__rocky_input:__rocky_i:1}"
    (( __rocky_i += 1 ))
    case "$__rocky_char" in
      $'\033')
        if (( __rocky_i < __rocky_len )); then
          __rocky_next="${__rocky_input:__rocky_i:1}"
          case "$__rocky_next" in
            '[')
              (( __rocky_i += 1 ))
              while (( __rocky_i < __rocky_len )); do
                __rocky_char="${__rocky_input:__rocky_i:1}"
                (( __rocky_i += 1 ))
                case "$__rocky_char" in
                  [@-~]) break ;;
                esac
              done
              ;;
            ']')
              (( __rocky_i += 1 ))
              while (( __rocky_i < __rocky_len )); do
                __rocky_char="${__rocky_input:__rocky_i:1}"
                if [[ "$__rocky_char" == $'\007' ]]; then
                  (( __rocky_i += 1 ))
                  break
                fi
                if [[ "$__rocky_char" == $'\033' && "${__rocky_input:__rocky_i+1:1}" == "\\" ]]; then
                  (( __rocky_i += 2 ))
                  break
                fi
                (( __rocky_i += 1 ))
              done
              ;;
          esac
        fi
        ;;
      $'\001'|$'\002'|$'\003'|$'\004'|$'\005'|$'\006'|$'\007'|$'\010'|$'\011'|$'\012'|$'\013'|$'\014'|$'\015'|$'\016'|$'\017'|$'\020'|$'\021'|$'\022'|$'\023'|$'\024'|$'\025'|$'\026'|$'\027'|$'\030'|$'\031'|$'\032'|$'\033'|$'\034'|$'\035'|$'\036'|$'\037'|$'\177'|$'\200'|$'\201'|$'\202'|$'\203'|$'\204'|$'\205'|$'\206'|$'\207'|$'\210'|$'\211'|$'\212'|$'\213'|$'\214'|$'\215'|$'\216'|$'\217'|$'\220'|$'\221'|$'\222'|$'\223'|$'\224'|$'\225'|$'\226'|$'\227'|$'\230'|$'\231'|$'\232'|$'\233'|$'\234'|$'\235'|$'\236'|$'\237')
        ;;
      *)
        if (( __rocky_output_len < 400 )); then
          __rocky_output="${__rocky_output}${__rocky_char}"
          (( __rocky_output_len += 1 ))
        fi
        ;;
    esac
  done
  __rocky_safe_label="$__rocky_output"
}

__rocky_drain_label() (
  local __rocky_labels="$__rocky_home/labels"
  local __rocky_label=""
  local __rocky_safe_label=""
  local __rocky_claim_dir=""
  local __rocky_source=""
  local __rocky_lock=""
  local __rocky_lock_status=1
  local __rocky_owner_pid=""
  local __rocky_owner_token=""
  local __rocky_claim_blocked=0
  local __rocky_candidate=""
  local __rocky_pending=""
  local __rocky_next=""
  local __rocky_probe=""
  local __rocky_size=""
  local __rocky_has_remainder=0
  local __rocky_attempt=0

  [[ -d "$__rocky_home" && ! -L "$__rocky_home" ]] || return 0

  # A retained source gets an atomic lock directory before it is opened. A
  # second prompt either sees a live owner and leaves the old source alone, or
  # reclaims a stale lock after a crashed owner. Resolve owner identity lazily,
  # only after a queue is found, so an empty prompt remains pure shell. Bash 3
  # lacks BASHPID; /proc/self/stat is a Bash-builtin read on Linux/WSL and gives
  # the actual subshell PID without spawning a helper process.
  __rocky_get_owner_identity() {
    local __rocky_proc_rest=""
    [[ "$__rocky_owner_pid" =~ ^[1-9][0-9]*$ && -n "$__rocky_owner_token" ]] && return 0
    if [[ -r /proc/self/stat ]]; then
      IFS=' ' read -r __rocky_owner_pid __rocky_proc_rest < /proc/self/stat 2>/dev/null || __rocky_owner_pid=""
    fi
    [[ "$__rocky_owner_pid" =~ ^[1-9][0-9]*$ ]] || __rocky_owner_pid="${BASHPID:-}"
    [[ "$__rocky_owner_pid" =~ ^[1-9][0-9]*$ ]] || __rocky_owner_pid="$$"
    __rocky_owner_token="${RANDOM:-0}.$$.$__rocky_owner_pid"
    return 0
  }

  __rocky_acquire_source_lock() {
    local __rocky_lock_path="${1}.active"
    local __rocky_lock_owner=""
    local __rocky_lock_pid=""
    local __rocky_lock_attempt=0
    local __rocky_lock_wait=0
    __rocky_lock_status=1
    __rocky_get_owner_identity
    while (( __rocky_lock_attempt < 2 )); do
      (( __rocky_lock_attempt += 1 ))
      if command mkdir "$__rocky_lock_path" >/dev/null 2>&1; then
        set -C
        if [[ ! -e "$__rocky_lock_path/pid" && ! -L "$__rocky_lock_path/pid" ]] &&
           { exec 8> "$__rocky_lock_path/pid"; } 2>/dev/null &&
           printf '%s:%s\n' "$__rocky_owner_pid" "$__rocky_owner_token" >&8 2>/dev/null; then
          exec 8>&-
          set +C
          __rocky_lock_status=0
          return 0
        fi
        exec 8>&-
        set +C
        command rm -f "$__rocky_lock_path/pid" >/dev/null 2>&1
        command rmdir "$__rocky_lock_path" >/dev/null 2>&1
        return 1
      fi
      # A symlink is never followed or cleaned through; remove only the link
      # itself and retry the private lock path.
      if [[ -L "$__rocky_lock_path" ]]; then
        command rm -f "$__rocky_lock_path" >/dev/null 2>&1
        continue
      fi
      [[ -d "$__rocky_lock_path" ]] || return 1
      # The owner creates the PID marker immediately after mkdir. Give that
      # tiny publication window a bounded handoff before treating an empty
      # lock as stale; this prevents a live owner from being double-claimed.
      __rocky_lock_wait=0
      while [[ ! -e "$__rocky_lock_path/pid" && ! -L "$__rocky_lock_path/pid" &&
                "$__rocky_lock_wait" -lt 10 ]]; do
        sleep 0.01
        (( __rocky_lock_wait += 1 ))
      done
      # Missing/empty marker means another owner is still initializing. Do not
      # steal its directory: an owner killed in this tiny window is safer as a
      # retained, manually recoverable claim than a duplicate read.
      if [[ ! -f "$__rocky_lock_path/pid" || -L "$__rocky_lock_path/pid" ]]; then
        return 1
      fi
      if [[ ! -s "$__rocky_lock_path/pid" ]]; then
        return 1
      fi
      __rocky_lock_pid=""
      IFS= read -r __rocky_lock_owner < "$__rocky_lock_path/pid" 2>/dev/null || __rocky_lock_owner=""
      __rocky_lock_pid="${__rocky_lock_owner%%:*}"
      if [[ "$__rocky_lock_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$__rocky_lock_pid" >/dev/null 2>&1; then
        return 1
      fi
      if [[ -n "$__rocky_lock_owner" ]]; then
        command rm -f "$__rocky_lock_path/pid" >/dev/null 2>&1
      fi
      command rmdir "$__rocky_lock_path" >/dev/null 2>&1 || return 1
    done
    return 1
  }

  __rocky_release_source_lock() {
    local __rocky_lock_path="$1"
    local __rocky_lock_owner=""
    [[ -d "$__rocky_lock_path" && ! -L "$__rocky_lock_path" ]] || return 0
    [[ -f "$__rocky_lock_path/pid" && ! -L "$__rocky_lock_path/pid" ]] || return 0
    IFS= read -r __rocky_lock_owner < "$__rocky_lock_path/pid" 2>/dev/null || return 0
    [[ "$__rocky_lock_owner" == "$__rocky_owner_pid:$__rocky_owner_token" ]] || return 0
    command rm -f "$__rocky_lock_path/pid" >/dev/null 2>&1
    command rmdir "$__rocky_lock_path" >/dev/null 2>&1
    return 0
  }

  __rocky_mark_invalid_source() {
    local __rocky_invalid_marker="${1}.invalid"
    # A marker directory is private, atomic, and does not follow a symlink.
    # The oversized/syntactically invalid source remains available for manual
    # recovery, while later valid claims can proceed.
    [[ -e "$__rocky_invalid_marker" || -L "$__rocky_invalid_marker" ]] ||
      command mkdir "$__rocky_invalid_marker" >/dev/null 2>&1 || :
    return 0
  }

  while :; do
    __rocky_claim_dir=""
    __rocky_source=""
    __rocky_lock=""
    __rocky_claim_blocked=0

    # Retained claims are older than a new public queue. An unfinished
    # original queue wins over its persisted remainder after a crash, keeping
    # the head ahead of tail. A live lock blocks this whole claim, preserving
    # old-before-late ordering while another prompt finishes it.
    for __rocky_candidate in "$__rocky_home"/.labels.claim.*; do
      [[ -d "$__rocky_candidate" && ! -L "$__rocky_candidate" ]] || continue
      if [[ -f "$__rocky_candidate/queue" && ! -L "$__rocky_candidate/queue" &&
            ! -e "$__rocky_candidate/queue.invalid" && ! -L "$__rocky_candidate/queue.invalid" ]]; then
        if __rocky_acquire_source_lock "$__rocky_candidate/queue"; then
          __rocky_claim_dir="$__rocky_candidate"
          __rocky_source="$__rocky_candidate/queue"
          __rocky_lock="$__rocky_source.active"
          break
        fi
        __rocky_claim_blocked=1
        break
      fi
      for __rocky_pending in "$__rocky_candidate"/remainder.next.* "$__rocky_candidate"/remainder; do
        if [[ -f "$__rocky_pending" && ! -L "$__rocky_pending" &&
              ! -e "$__rocky_pending.invalid" && ! -L "$__rocky_pending.invalid" ]]; then
          if __rocky_acquire_source_lock "$__rocky_pending"; then
            __rocky_claim_dir="$__rocky_candidate"
            __rocky_source="$__rocky_pending"
            __rocky_lock="$__rocky_source.active"
            break
          fi
          __rocky_claim_blocked=1
          break
        fi
      done
      [[ -n "$__rocky_source" || "$__rocky_claim_blocked" -eq 1 ]] && break
    done

    [[ -n "$__rocky_source" ]] || {
      # A live owner has an older source. Do not let this prompt overtake it.
      [[ "$__rocky_claim_blocked" -eq 0 ]] || return 0
      # No retained claim: atomically move the public queue into a unique
      # private directory before opening it. A pathname swap can only move a
      # special file into the claim, which is rejected below without a
      # potentially blocking read.
      [[ -s "$__rocky_labels" && -f "$__rocky_labels" && ! -L "$__rocky_labels" ]] || return 0
      umask 077
      __rocky_claim_dir=$(command mktemp -d "$__rocky_home/.labels.claim.XXXXXX" 2>/dev/null) || return 0
      case "$__rocky_claim_dir" in
        "$__rocky_home"/.labels.claim.*) ;;
        *) command rmdir "$__rocky_claim_dir" >/dev/null 2>&1; return 0 ;;
      esac
      [[ -d "$__rocky_claim_dir" && ! -L "$__rocky_claim_dir" ]] || {
        command rmdir "$__rocky_claim_dir" >/dev/null 2>&1
        return 0
      }
      __rocky_source="$__rocky_claim_dir/queue"
      if ! command mv "$__rocky_labels" "$__rocky_source" 2>/dev/null; then
        command rmdir "$__rocky_claim_dir" >/dev/null 2>&1
        return 0
      fi
      if ! __rocky_acquire_source_lock "$__rocky_source"; then
        return 0
      fi
      __rocky_lock="$__rocky_source.active"
    }

    # Reject a claimed special file before opening. The read/write open keeps
    # a same-UID swap to a FIFO nonblocking on Bash/Linux/WSL; the descriptor
    # type check below is authoritative before any read.
    if [[ ! -f "$__rocky_source" || -L "$__rocky_source" ]]; then
      __rocky_release_source_lock "$__rocky_lock"
      return 0
    fi
    if ! { exec 9<> "$__rocky_source"; } 2>/dev/null; then
      __rocky_release_source_lock "$__rocky_lock"
      return 0
    fi
    if [[ ! -f /dev/fd/9 ]]; then
      exec 9>&-
      __rocky_release_source_lock "$__rocky_lock"
      return 0
    fi

    # Validate the opened descriptor, not the old public pathname. GNU stat's
    # -L form is used on Linux/WSL; BSD stat's -f form is the portable fallback.
    if ! __rocky_size=$(command stat -Lc %s /dev/fd/9 2>/dev/null); then
      __rocky_size=$(command stat -f %z /dev/fd/9 2>/dev/null) || {
        exec 9>&-
        __rocky_release_source_lock "$__rocky_lock"
        return 0
      }
    fi
    __rocky_size="${__rocky_size//[[:space:]]/}"
    if ! [[ "$__rocky_size" =~ ^[0-9]+$ ]]; then
      exec 9>&-
      __rocky_release_source_lock "$__rocky_lock"
      return 0
    fi
    if [[ "$__rocky_size" -eq 0 || "$__rocky_size" -gt 65536 ]]; then
      exec 9>&-
      __rocky_mark_invalid_source "$__rocky_source"
      __rocky_release_source_lock "$__rocky_lock"
      # Continue scanning: one bad retained claim must not starve later data.
      continue
    fi

    # A final line need not end in newline. Read one additional byte exactly so
    # an empty next line remains queued; this byte is copied before the rest.
    if IFS= read -r __rocky_label <&9 2>/dev/null; then
      :
    else
      [[ -n "$__rocky_label" ]] || {
        exec 9>&-
        __rocky_release_source_lock "$__rocky_lock"
        return 0
      }
    fi
    __rocky_sanitize_label "$__rocky_label"
    # Bash 3 has read -n but not read -N. In the C locale -n 1 gives an empty
    # value for a delimiter byte; restore that byte so remainder copy is exact.
    if LC_ALL=C IFS= read -r -n 1 __rocky_probe <&9 2>/dev/null; then
      [[ -n "$__rocky_probe" ]] || __rocky_probe=$'\n'
      __rocky_has_remainder=1
    else
      __rocky_has_remainder=0
    fi

    # Empty remainder: remove private claim and do not publish an empty queue.
    if [[ "$__rocky_has_remainder" -eq 0 ]]; then
      exec 9>&-
      # Keep source until display succeeds; an interrupted print may retry the
      # same head, but it cannot lose it.
      if [[ -n "$__rocky_safe_label" ]] && ! printf '[Rocky] %s\n' "$__rocky_safe_label" >&2; then
        __rocky_release_source_lock "$__rocky_lock"
        return 0
      fi
      command rm -f "$__rocky_source" >/dev/null 2>&1
      for __rocky_pending in "$__rocky_claim_dir"/queue "$__rocky_claim_dir"/remainder "$__rocky_claim_dir"/remainder.next.*; do
        [[ -f "$__rocky_pending" && ! -L "$__rocky_pending" ]] && command rm -f "$__rocky_pending" >/dev/null 2>&1
      done
      __rocky_release_source_lock "$__rocky_lock"
      command rmdir "$__rocky_claim_dir" >/dev/null 2>&1
      return 0
    fi

    # Persist unread remainder only inside the already-private claim directory.
    # Never republish it to the public queue: producers can create a fresh
    # labels path independently, while claim scanning preserves old-before-late
    # order. Pick an unpredictable private name, then create it through a
    # noclobber descriptor. mktemp would close a path before reopening it,
    # reintroducing a symlink/FIFO TOCTOU.
    umask 077
    set -C
    while (( __rocky_attempt < 16 )); do
      (( __rocky_attempt += 1 ))
      __rocky_next="$__rocky_claim_dir/remainder.next.${RANDOM}.${__rocky_attempt}"
      [[ ! -e "$__rocky_next" && ! -L "$__rocky_next" ]] || continue
      if { exec 7> "$__rocky_next"; } 2>/dev/null; then
        break
      fi
      __rocky_next=""
    done
    [[ -n "$__rocky_next" && -f /dev/fd/7 ]] || {
      exec 9>&-
      exec 7>&-
      set +C
      __rocky_release_source_lock "$__rocky_lock"
      return 0
    }
    if ! printf '%s' "$__rocky_probe" >&7 || ! command cat <&9 >&7 2>/dev/null; then
      exec 9>&-
      exec 7>&-
      set +C
      command rm -f "$__rocky_next" >/dev/null 2>&1
      __rocky_release_source_lock "$__rocky_lock"
      return 0
    fi
    exec 9>&-
    exec 7>&-
    set +C
    # Print before removing the owned source. If output or the shell fails
    # here, the original queue remains and is retried before persisted
    # remainder; duplicates are preferable to losing a label.
    if [[ -n "$__rocky_safe_label" ]] && ! printf '[Rocky] %s\n' "$__rocky_safe_label" >&2; then
      __rocky_release_source_lock "$__rocky_lock"
      return 0
    fi
    command rm -f "$__rocky_source" >/dev/null 2>&1
    # Keep exact persisted remainder for the next prompt; stale siblings from a
    # crash can be removed only after this head was printed successfully.
    for __rocky_pending in "$__rocky_claim_dir"/queue "$__rocky_claim_dir"/remainder "$__rocky_claim_dir"/remainder.next.*; do
      if [[ "$__rocky_pending" != "$__rocky_next" && -f "$__rocky_pending" && ! -L "$__rocky_pending" ]]; then
        command rm -f "$__rocky_pending" >/dev/null 2>&1
      fi
    done
    __rocky_release_source_lock "$__rocky_lock"
    command rmdir "$__rocky_claim_dir" >/dev/null 2>&1
    return 0
  done
)

__rocky_precmd() {
  local exit_code=$?
  # First line captures the hooked command's exit code.
  [[ -n "$__rocky_disabled" || -n "${ROCKY_OFF:-}" ]] && return 0
  __rocky_drain_label || :
  [[ -n "$__rocky_last_cmd" ]] || return 0
  local cmd="$__rocky_last_cmd"
  local cwd="${__rocky_last_cwd:-$PWD}"
  __rocky_last_cmd=""
  __rocky_last_cwd=""

  # denylist: shell builtins (cd/pushd/popd/export/alias/source/.) and
  # rocky's own invocations carry no information worth remembering, and a
  # naive hook would double-record `rocky run` failures on top of run.ts's
  # own deep record. Pure first-word case match — no subshells, no external
  # binaries, no node spawn — this runs before every prompt.
  local first_word="${cmd#"${cmd%%[![:space:]]*}"}"
  first_word="${first_word%%[[:space:]]*}"
  case "$first_word" in
    cd|pushd|popd|export|alias|source|.|rocky|*/rocky)
      return 0
      ;;
  esac

  if ! command -v "$__rocky_bin" >/dev/null 2>&1; then
    if [[ -z "$__rocky_warned" ]]; then
      printf '[Rocky] rocky binary gone. my ears sleep now.\n' >&2
      __rocky_warned=1
      __rocky_disabled=1
    fi
    return 0
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    { "$__rocky_bin" _hookfail "$cmd" "$exit_code" "$cwd" >/dev/null 2>&1 & disown; } 2>/dev/null
  elif [[ -f "$__rocky_home/pending" ]]; then
    { "$__rocky_bin" _hooksuccess "$cmd" "$cwd" >/dev/null 2>&1 & disown; } 2>/dev/null
  fi
  return 0
}

preexec_functions+=(__rocky_preexec)
precmd_functions+=(__rocky_precmd)
