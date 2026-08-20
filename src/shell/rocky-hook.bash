# rocky-hook.bash — Rocky's ears. Sourced from ~/.bashrc via the managed block.
#
# Contract: this file must NEVER break the shell. Every path fails silent and
# returns 0, except an explicit guard cancel (return 1 under extdebug).
# Hot path is pure bash; node is spawned only in the background, and only when
# a command fails or a fix-link attempt is worth it (pending flag exists).

# interactive shells only — scripts and CI never touched
[[ $- == *i* ]] || return 0

ROCKY_HOOK_VERSION="0.4.0"
__rocky_home="${ROCKY_HOME:-$HOME/.rocky}"
__rocky_bin="${ROCKY_BIN:-rocky}"
__rocky_disabled=""
__rocky_warned=""
__rocky_last_cmd=""
__rocky_last_cwd=""
__rocky_speech_seq=0
__rocky_speech_ids=()
__rocky_speech_file=""

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
  local __rocky_owner_pid=""
  local __rocky_owner_start=""
  local __rocky_owner_token=""
  local __rocky_owner_identity=""
  local __rocky_claim_status=1
  local __rocky_proc_pid=""
  local __rocky_proc_start=""
  local -a __rocky_skipped_sources
  __rocky_skipped_sources=()
  local __rocky_claim_blocked=0
  local __rocky_candidate=""
  local __rocky_pending=""
  local __rocky_next=""
  local __rocky_probe=""
  local __rocky_size=""
  local __rocky_has_remainder=0
  local __rocky_attempt=0

  [[ -d "$__rocky_home" && ! -L "$__rocky_home" ]] || return 0

  __rocky_read_proc_identity() {
    local __rocky_proc_target="$1"
    local __rocky_proc_line=""
    local __rocky_proc_rest=""
    __rocky_proc_pid=""
    __rocky_proc_start=""
    [[ "$__rocky_proc_target" == "self" || "$__rocky_proc_target" =~ ^[1-9][0-9]*$ ]] || return 1
    IFS= read -r __rocky_proc_line < "/proc/$__rocky_proc_target/stat" 2>/dev/null || return 1
    __rocky_proc_pid="${__rocky_proc_line%% *}"
    # comm can contain spaces and ')'; strip through the final ") " so the
    # remaining fields start at state and field 22 is the twentieth token.
    __rocky_proc_rest="${__rocky_proc_line##*) }"
    [[ "$__rocky_proc_rest" != "$__rocky_proc_line" ]] || return 1
    set -- $__rocky_proc_rest
    [[ "$#" -ge 20 ]] || return 1
    __rocky_proc_start="${20}"
    [[ "$__rocky_proc_pid" =~ ^[1-9][0-9]*$ && "$__rocky_proc_start" =~ ^[1-9][0-9]*$ ]]
  }

  __rocky_get_owner_identity() {
    [[ -n "$__rocky_owner_identity" ]] && return 0
    __rocky_read_proc_identity self || return 1
    __rocky_owner_pid="$__rocky_proc_pid"
    __rocky_owner_start="$__rocky_proc_start"
    __rocky_owner_token="${RANDOM:-0}${RANDOM:-0}"
    __rocky_owner_identity="$__rocky_owner_pid.$__rocky_owner_start.$__rocky_owner_token"
    [[ "$__rocky_owner_identity" =~ ^[1-9][0-9]*\.[1-9][0-9]*\.[0-9]+$ ]]
  }

  __rocky_acquire_claim_dir() {
    local __rocky_original="$1"
    local __rocky_base="$1"
    local __rocky_existing_pid=""
    local __rocky_existing_start=""
    local __rocky_existing_token=""
    local __rocky_destination=""
    __rocky_claim_status=1
    __rocky_get_owner_identity || return 1

    if [[ "$__rocky_original" =~ ^(.+)\.work\.([1-9][0-9]*)\.([1-9][0-9]*)\.([0-9]+)$ ]]; then
      __rocky_base="${BASH_REMATCH[1]}"
      __rocky_existing_pid="${BASH_REMATCH[2]}"
      __rocky_existing_start="${BASH_REMATCH[3]}"
      __rocky_existing_token="${BASH_REMATCH[4]}"
      if [[ "$__rocky_existing_pid.$__rocky_existing_start.$__rocky_existing_token" == "$__rocky_owner_identity" ]]; then
        __rocky_claim_dir="$__rocky_original"
        __rocky_claim_status=0
        return 0
      fi
      if __rocky_read_proc_identity "$__rocky_existing_pid" &&
         [[ "$__rocky_proc_pid" == "$__rocky_existing_pid" && "$__rocky_proc_start" == "$__rocky_existing_start" ]]; then
        __rocky_claim_status=2
        return 1
      fi
    fi

    __rocky_destination="$__rocky_base.work.$__rocky_owner_identity"
    case "$__rocky_destination" in
      "$__rocky_home"/.labels.claim.*.work.*) ;;
      *) return 1 ;;
    esac
    [[ ! -e "$__rocky_destination" && ! -L "$__rocky_destination" ]] || return 1
    # Rename the whole private claim to publish one owner-qualified directory;
    # no queue or remainder is opened before this atomic ownership boundary.
    if command mv "$__rocky_original" "$__rocky_destination" 2>/dev/null &&
       [[ -d "$__rocky_destination" && ! -L "$__rocky_destination" ]]; then
      __rocky_claim_dir="$__rocky_destination"
      __rocky_claim_status=0
      return 0
    fi
    __rocky_claim_status=2
    return 1
  }

  __rocky_source_is_skipped() {
    local __rocky_skipped=""
    for __rocky_skipped in "${__rocky_skipped_sources[@]}"; do
      [[ "$__rocky_skipped" == "$1" ]] && return 0
    done
    return 1
  }

  __rocky_find_claim_source() {
    local __rocky_search_dir="$1"
    local __rocky_search_path=""
    __rocky_source=""
    __rocky_search_path="$__rocky_search_dir/queue"
    if [[ -f "$__rocky_search_path" && ! -L "$__rocky_search_path" &&
          ! -e "$__rocky_search_path.invalid" && ! -L "$__rocky_search_path.invalid" ]] &&
       ! __rocky_source_is_skipped "$__rocky_search_path"; then
      __rocky_source="$__rocky_search_path"
      return 0
    fi
    for __rocky_search_path in "$__rocky_search_dir"/remainder.next.* "$__rocky_search_dir"/remainder; do
      if [[ -f "$__rocky_search_path" && ! -L "$__rocky_search_path" &&
            ! -e "$__rocky_search_path.invalid" && ! -L "$__rocky_search_path.invalid" ]] &&
         ! __rocky_source_is_skipped "$__rocky_search_path"; then
        __rocky_source="$__rocky_search_path"
        return 0
      fi
    done
    return 1
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
    __rocky_claim_blocked=0

    # Retained claims are older than a new public queue. An unfinished
    # original queue wins over its persisted remainder after a crash, keeping
    # the head ahead of tail. A live owner blocks this whole claim, preserving
    # old-before-late ordering while another prompt finishes it.
    for __rocky_candidate in "$__rocky_home"/.labels.claim.*; do
      [[ -d "$__rocky_candidate" && ! -L "$__rocky_candidate" ]] || continue
      __rocky_find_claim_source "$__rocky_candidate" || continue
      __rocky_source=""
      if __rocky_acquire_claim_dir "$__rocky_candidate"; then
        if ! __rocky_find_claim_source "$__rocky_claim_dir"; then
          __rocky_claim_blocked=1
        fi
        break
      fi
      [[ "$__rocky_claim_status" -eq 2 ]] && __rocky_claim_blocked=1
      break
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
      __rocky_candidate="$__rocky_claim_dir"
      if ! __rocky_acquire_claim_dir "$__rocky_candidate"; then
        return 0
      fi
      __rocky_source="$__rocky_claim_dir/queue"
    }

    # Reject a claimed special file before opening. The read/write open keeps
    # a same-UID swap to a FIFO nonblocking on Bash/Linux/WSL; the descriptor
    # type check below is authoritative before any read.
    if [[ ! -f "$__rocky_source" || -L "$__rocky_source" ]]; then
      return 0
    fi
    if ! { exec 9<> "$__rocky_source"; } 2>/dev/null; then
      return 0
    fi
    if [[ ! -f /dev/fd/9 ]]; then
      exec 9>&-
      return 0
    fi

    # Validate the opened descriptor, not the old public pathname. GNU stat's
    # -L form is used on Linux/WSL; BSD stat's -f form is the portable fallback.
    if ! __rocky_size=$(command stat -Lc %s /dev/fd/9 2>/dev/null); then
      __rocky_size=$(command stat -f %z /dev/fd/9 2>/dev/null) || {
        exec 9>&-
        return 0
      }
    fi
    __rocky_size="${__rocky_size//[[:space:]]/}"
    if ! [[ "$__rocky_size" =~ ^[0-9]+$ ]]; then
      exec 9>&-
      return 0
    fi
    if [[ "$__rocky_size" -eq 0 || "$__rocky_size" -gt 65536 ]]; then
      exec 9>&-
      __rocky_skipped_sources+=("$__rocky_source")
      __rocky_mark_invalid_source "$__rocky_source"
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
        return 0
      fi
      command rm -f "$__rocky_source" >/dev/null 2>&1
      for __rocky_pending in "$__rocky_claim_dir"/queue "$__rocky_claim_dir"/remainder "$__rocky_claim_dir"/remainder.next.*; do
        [[ -f "$__rocky_pending" && ! -L "$__rocky_pending" ]] && command rm -f "$__rocky_pending" >/dev/null 2>&1
      done
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
      return 0
    }
    if ! printf '%s' "$__rocky_probe" >&7 || ! command cat <&9 >&7 2>/dev/null; then
      exec 9>&-
      exec 7>&-
      set +C
      command rm -f "$__rocky_next" >/dev/null 2>&1
      return 0
    fi
    exec 9>&-
    exec 7>&-
    set +C
    # Print before removing the owned source. If output or the shell fails
    # here, the original queue remains and is retried before persisted
    # remainder; duplicates are preferable to losing a label.
    if [[ -n "$__rocky_safe_label" ]] && ! printf '[Rocky] %s\n' "$__rocky_safe_label" >&2; then
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
    command rmdir "$__rocky_claim_dir" >/dev/null 2>&1
    return 0
  done
)

# One speech file per handler spawn, owned by THIS shell session.
#
# Without the speech file the detached handler writes straight to the tty
# device, and that write races the prompt draw and the user's own typing --
# proven on a real console during the PowerShell work, invisible to any
# pipe-based harness. ROCKY_HOOK_SPEECH_FILE makes sayTty/detailTty buffer
# instead, and flushHookSpeech publishes them as one atomic unit that
# __rocky_drain_speech below prints at a moment nothing else is writing.
#
# The name is recorded BEFORE the spawn. That is the whole point: two
# terminals share one $ROCKY_HOME, and a drain that reads any file in the
# directory would print the other window's message. Only names this session
# claimed are ever spoken.
#
# Sets __rocky_speech_file on success. Returns non-zero when no name could
# be claimed, and the caller then spawns without the variable -- the old
# direct-write path, which is worse but never silent.
__rocky_speech_claim() {
  local __rocky_name=""
  __rocky_speech_file=""
  [[ -d "$__rocky_home" && ! -L "$__rocky_home" ]] || return 1
  (( __rocky_speech_seq += 1 ))
  __rocky_name="$$.${RANDOM}.${RANDOM}.${__rocky_speech_seq}.txt"
  [[ -e "$__rocky_home/hook-speech/$__rocky_name" || -L "$__rocky_home/hook-speech/$__rocky_name" ]] && return 1
  __rocky_speech_ids+=("$__rocky_name")
  # Bound the claim list. A handler with nothing to say never writes a file,
  # so names would otherwise accumulate for the life of the shell. Dropping
  # the oldest also removes its file: a message this stale is not worth
  # printing, and leaving the file behind would leak into hook-speech/.
  while (( ${#__rocky_speech_ids[@]} > 32 )); do
    command rm -f "$__rocky_home/hook-speech/${__rocky_speech_ids[0]}" >/dev/null 2>&1
    __rocky_speech_ids=(${__rocky_speech_ids[@]+"${__rocky_speech_ids[@]:1}"})
  done
  __rocky_speech_file="$__rocky_home/hook-speech/$__rocky_name"
  return 0
}

# Print, then remove, every claimed speech file that has appeared. A name
# whose file is not there yet stays claimed for a later prompt: the handler
# is detached, so it may still be running.
__rocky_drain_speech() {
  local __rocky_name="" __rocky_path=""
  local -a __rocky_keep
  __rocky_keep=()
  (( ${#__rocky_speech_ids[@]} )) || return 0
  for __rocky_name in ${__rocky_speech_ids[@]+"${__rocky_speech_ids[@]}"}; do
    __rocky_path="$__rocky_home/hook-speech/$__rocky_name"
    # Regular files only, never a symlink: same rule __rocky_drain_label keeps.
    if [[ -f "$__rocky_path" && ! -L "$__rocky_path" ]]; then
      # Content already passed through safeTerminalLine before it was
      # buffered (ui/rocky.ts), so print the bytes and interpret nothing.
      if command cat "$__rocky_path" >&2 2>/dev/null; then
        command rm -f "$__rocky_path" >/dev/null 2>&1
        continue
      fi
    fi
    __rocky_keep+=("$__rocky_name")
  done
  __rocky_speech_ids=(${__rocky_keep[@]+"${__rocky_keep[@]}"})
  return 0
}

__rocky_precmd() {
  local exit_code=$?
  # First line captures the hooked command's exit code.
  [[ -n "$__rocky_disabled" || -n "${ROCKY_OFF:-}" ]] && return 0
  __rocky_drain_speech || :
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
  # `VAR=value cmd` scopes the variable to this one spawn: no export, and so
  # nothing to restore and nothing that can leak into a command the person
  # types themselves.
  if [[ "$exit_code" -ne 0 ]]; then
    if __rocky_speech_claim; then
      { ROCKY_HOOK_SPEECH_FILE="$__rocky_speech_file" "$__rocky_bin" _hookfail "$cmd" "$exit_code" "$cwd" >/dev/null 2>&1 & disown; } 2>/dev/null
    else
      { "$__rocky_bin" _hookfail "$cmd" "$exit_code" "$cwd" >/dev/null 2>&1 & disown; } 2>/dev/null
    fi
  elif [[ -f "$__rocky_home/pending" ]]; then
    if __rocky_speech_claim; then
      { ROCKY_HOOK_SPEECH_FILE="$__rocky_speech_file" "$__rocky_bin" _hooksuccess "$cmd" "$cwd" >/dev/null 2>&1 & disown; } 2>/dev/null
    else
      { "$__rocky_bin" _hooksuccess "$cmd" "$cwd" >/dev/null 2>&1 & disown; } 2>/dev/null
    fi
  fi
  return 0
}

preexec_functions+=(__rocky_preexec)
precmd_functions+=(__rocky_precmd)
