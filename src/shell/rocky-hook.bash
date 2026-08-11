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
    $'\342\200\216' $'\342\200\217' $'\342\200\252' $'\342\200\253' $'\342\200\254' $'\342\200\255' $'\342\200\256' \
    $'\342\201\246' $'\342\201\247' $'\342\201\250' $'\342\201\251'; do
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
  local __rocky_tmp=""
  local __rocky_size=""

  # Queue files are private state.  Refuse links and special files before any
  # read, so a FIFO (or a retargeted path) cannot block the prompt.
  [[ -d "$__rocky_home" && ! -L "$__rocky_home" ]] || return 0
  [[ -s "$__rocky_labels" && -f "$__rocky_labels" && ! -L "$__rocky_labels" ]] || return 0
  if ! __rocky_size=$(command stat -c %s "$__rocky_labels" 2>/dev/null); then
    __rocky_size=$(command stat -f %z "$__rocky_labels" 2>/dev/null) || return 0
  fi
  __rocky_size="${__rocky_size//[[:space:]]/}"
  [[ "$__rocky_size" =~ ^[0-9]+$ && "$__rocky_size" -le 65536 ]] || return 0

  # A final line need not end in a newline; retain it when read reports EOF.
  if IFS= read -r __rocky_label < "$__rocky_labels" 2>/dev/null; then
    :
  else
    # EOF without a newline is valid when read retained a nonempty final line;
    # a failed open/read with no data stays untouched and fails open.
    [[ -n "$__rocky_label" ]] || return 0
  fi
  if [[ -z "$__rocky_label" && ! -s "$__rocky_labels" ]]; then
    return 0
  fi
  __rocky_sanitize_label "$__rocky_label"

  # mktemp is exclusive and same-directory; umask is isolated in this
  # subshell, and every failure leaves the original queue untouched.
  umask 077
  __rocky_tmp=$(command mktemp "$__rocky_home/.labels.XXXXXX" 2>/dev/null) || return 0
  case "$__rocky_tmp" in
    "$__rocky_home"/.labels.*) ;;
    *) return 0 ;;
  esac
  [[ -n "$__rocky_tmp" && -f "$__rocky_tmp" && ! -L "$__rocky_tmp" ]] || {
    command rm -f "$__rocky_tmp" >/dev/null 2>&1
    return 0
  }

  [[ -s "$__rocky_labels" && -f "$__rocky_labels" && ! -L "$__rocky_labels" ]] || {
    command rm -f "$__rocky_tmp" >/dev/null 2>&1
    return 0
  }
  if ! command tail -n +2 "$__rocky_labels" > "$__rocky_tmp" 2>/dev/null; then
    command rm -f "$__rocky_tmp" >/dev/null 2>&1
    return 0
  fi
  [[ -f "$__rocky_tmp" && ! -L "$__rocky_tmp" ]] || {
    command rm -f "$__rocky_tmp" >/dev/null 2>&1
    return 0
  }
  [[ -f "$__rocky_labels" && ! -L "$__rocky_labels" ]] || {
    command rm -f "$__rocky_tmp" >/dev/null 2>&1
    return 0
  }

  # Claim the first line before displaying it.  A failed rename leaves it for
  # a later prompt, while a successful rename cannot print the same line twice.
  if ! command mv "$__rocky_tmp" "$__rocky_labels" 2>/dev/null; then
    command rm -f "$__rocky_tmp" >/dev/null 2>&1
    return 0
  fi
  [[ -n "$__rocky_safe_label" ]] && printf '[Rocky] %s\n' "$__rocky_safe_label" >&2
  return 0
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
