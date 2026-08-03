# rocky-hook.bash — Rocky's ears. Sourced from ~/.bashrc via the managed block.
#
# Contract: this file must NEVER break the shell. Every path fails silent and
# returns 0, except an explicit guard cancel (return 1 under extdebug).
# Hot path is pure bash; node is spawned only in the background, and only when
# a command fails or a fix-link attempt is worth it (pending flag exists).

# interactive shells only — scripts and CI never touched
[[ $- == *i* ]] || return 0

ROCKY_HOOK_VERSION="0.2.0"
__rocky_home="${ROCKY_HOME:-$HOME/.rocky}"
__rocky_bin="${ROCKY_BIN:-rocky}"
__rocky_disabled=""
__rocky_warned=""
__rocky_last_cmd=""

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
      if read -r -p "[Rocky] you sure, question (y/n) " ans </dev/tty 2>/dev/null; then
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
  if ! __rocky_guard "$1"; then
    __rocky_last_cmd=""
    return 1
  fi
  return 0
}

__rocky_precmd() {
  local exit_code=$?   # must be first line: the hooked command's exit code
  [[ -n "$__rocky_disabled" || -n "${ROCKY_OFF:-}" ]] && return 0
  [[ -n "$__rocky_last_cmd" ]] || return 0
  local cmd="$__rocky_last_cmd"
  __rocky_last_cmd=""
  if ! command -v "$__rocky_bin" >/dev/null 2>&1; then
    if [[ -z "$__rocky_warned" ]]; then
      printf '[Rocky] rocky binary gone. my ears sleep now.\n' >&2
      __rocky_warned=1
      __rocky_disabled=1
    fi
    return 0
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    { "$__rocky_bin" _hookfail "$cmd" "$exit_code" "$PWD" >/dev/null 2>&1 & disown; } 2>/dev/null
  elif [[ -f "$__rocky_home/pending" ]]; then
    { "$__rocky_bin" _hooksuccess "$cmd" "$PWD" >/dev/null 2>&1 & disown; } 2>/dev/null
  fi
  return 0
}

preexec_functions+=(__rocky_preexec)
precmd_functions+=(__rocky_precmd)
