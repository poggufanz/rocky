# Rocky subshell telemetry — sourced via $BASH_ENV by non-interactive bash.
# Contract: fail-silent, zero stdout, never break the shell. Telemetry only,
# not enforcement: `env -u BASH_ENV` disables this lane by design.
if [ -n "${__ROCKY_SUBSHELL:-}" ]; then return 0 2>/dev/null || exit 0; fi
__ROCKY_SUBSHELL=1
__rocky_cmd="${ROCKY_SUBSHELL_CMD:-<noninteractive>}"
trap '__rocky_code=$?; [ "$__rocky_code" -ne 0 ] && { command -v rocky >/dev/null 2>&1 && rocky _hookfail "$__rocky_cmd" "$__rocky_code" "$PWD" >/dev/null 2>&1 & }; trap - EXIT' EXIT
