# Phase 3 Task 5 — Multi-host setup command

## Status

Complete. Implemented and verified on base commit `0968e4b9ca96f99489d2bcfd3cca5fcbe66ffc6e` in the `v021-distribution-bridge` worktree. Phase 4 was not started.

## Outcome

Rocky now exposes an idempotent `rocky setup` command that can configure, inspect, health-check, and remove owned registrations for Codex, Claude Code, and Claude Desktop. The implementation preserves foreign registrations, requires ordinary consent for mutation, uses the exact owned stored registration for health checks, and keeps all setup output on stderr.

The production path now:

- parses and rejects invalid arguments before constructing platform services or probing any host filesystem;
- honors `process.env.ROCKY_HOME`, including relative paths resolved by the canonical registration resolver;
- dispatches every detected host and applies the specified aggregate exit tables;
- prints the projected-memory disclosure, with the additional raw-exposure warning;
- reports a missing Bash hook as the explicit next step without installing it;
- returns safe manual/skipped results for missing or ambiguous WSL bridge inputs.

## Implementation details

### Command orchestration

- Added configure, `--check`, and `--remove` dispatch with `--yes`, `--replace`, and `--mcp-exposure sanitized|raw` support.
- Added non-TTY-safe confirmation and exact rerun guidance.
- Wired setup into the CLI help and dispatcher.
- Kept production dependency construction lazy and after successful argument parsing.

### Registration ownership and health

- Extended adapter results with an exact `healthRegistration`.
- Codex, Claude Code, and Claude Desktop checks parse their stored representation and expose health only for an owned Rocky identity.
- Raw and sanitized stored exposure remain owned when command, argv, and Rocky home match; foreign command/argv/home remain protected.
- WSL Desktop maps only the stored Windows `wsl.exe` command to its verified mounted executable for local health while preserving stored argv and environment exactly.

### Protocol probe

- Added bounded interactive stdio sessions with direct argv (`shell: false`), merged environment, bounded stdout queue/line bytes, bounded stderr, and handled stdin errors.
- Added a monotonic total deadline with modern discovery/list first and a fresh-child legacy initialize/initialized/ping/list fallback.
- Modern lock-in recognizes successful version semantics and JSON-RPC `-32022`; wrong-version success remains modern-unhealthy.
- Responses require a valid JSON-RPC 2.0 envelope with exactly one of `result` or object-valued `error`.
- Health requires all four Rocky tools without invoking a tool or reading memory.
- Cleanup is bounded through hard-kill escalation of the exact child only; legacy never opens while the modern child is unreaped.
- A healthy result additionally requires clean child shutdown.

### WSL production discovery

- Added a narrow directory-listing seam.
- Production enumerates actual profile directory names beneath `/mnt/c/Users`, rejects unsafe components, constructs only the fixed Claude Desktop config suffix, and filters to existing files.
- An explicit `ROCKY_WSL_CLAUDE_CONFIG` is merged and deduplicated as an additional candidate.
- Exactly one config, mounted `wsl.exe`, and `wslpath` candidate is required; zero or ambiguity yields manual/skipped behavior without conversion or mutation.

## Files changed

Primary Task 5 files:

- `src/commands/setup.ts` — setup orchestration, consent, production adapters, exit tables, disclosures.
- `src/setup/health.ts` — bounded modern/legacy MCP health probe.
- `src/test/setup-command.test.ts` — command, exit-table, consent, environment, and lazy-discovery coverage.
- `src/test/setup-health.test.ts` — protocol, deadline, cleanup, envelope, and clean-exit coverage.
- `src/index.ts` — setup command dispatch and help.

Necessary integration files beyond the primary list:

- `src/setup/process.ts` — interactive child-process session and bounded transport.
- `src/setup/platform.ts` — shell/hook state, verified WSL candidates, lazy production factory.
- `src/setup/clients.ts` — exact stored health-registration result field.
- `src/setup/codex.ts` — exact owned Codex health registration.
- `src/setup/claude-code.ts` — exact owned Claude Code health registration.
- `src/setup/claude-desktop.ts` — exact owned Desktop health registration and verified local mapping.
- `src/test/setup-registration.test.ts` — process transport, EOF bounds, and real-child EPIPE regressions.
- `src/test/setup-wsl.test.ts` — WSL construction, conversion, discovery, ambiguity, and mapping regressions.
- `src/test/setup-codex.test.ts` — exact stored Codex health behavior.
- `src/test/setup-claude-code.test.ts` — exact stored Claude Code health behavior.
- `src/test/setup-claude-desktop.test.ts` — exact stored native/WSL Desktop health behavior.
- `.superpowers/sdd/2026-08-04-v021-03-host-setup/task-5-report.md` — this required evidence report (force-added because the SDD workspace is ignored).

## TDD evidence

Implementation followed explicit RED to GREEN cycles. Representative failures before fixes:

- Health tests initially failed because `setup/health` and interactive `openSession` did not exist; the modern/legacy lifecycle was then implemented.
- Setup-command tests initially failed because the setup module, dispatcher, platform seam, consent aggregation, and exit tables did not exist.
- The compiled CLI smoke initially reported setup as an unknown command; dispatcher wiring made the same smoke return usage exit 2.
- A wrong-version discovery regression failed 17/18 assertions because it incorrectly continued to list tools; it now locks modern-unhealthy.
- Invalid converted `cmd.exe` escaped the WSL builder (20 pass, 1 fail); the typed manual-configuration exception is now converted to a secret-free skipped adapter.
- A final unterminated 65th queued line bypassed the interactive queue cap (14 pass, 1 fail); EOF now applies the same line/byte bound and leaves no pending reader state.

Independent review produced dedicated RED reproductions:

- Real-child stdin close: 15 pass, 1 uncaught `EPIPE`; an stdin error listener now contains the failure and `writeLine` rejects normally.
- Cleanup: 18 pass, 1 timeout; SIGKILL escalation and post-kill waiting are now bounded by the total deadline, with no fallback for an unreaped child.
- Production environment/help: 27 pass, 2 fail; setup now honors `process.env.ROCKY_HOME` and points usage to `rocky --help`.
- JSON-RPC envelope, clean child exit, and bounded unreaped-child tests failed 3 of 22 health assertions before the protocol cleanup fix.
- WSL discovery: 21 pass, 2 fail; production now enumerates the standard mounted Windows profile root and merges explicit candidates.
- Lazy platform regression: 29 pass, 1 fail; a preload observer proved `/mnt/c/Users` was touched during import/invalid usage. Removing the eager singleton made the same behavior test green.

Final targeted regression set after the seven initial review fixes: 90/90 assertions. Final setup-focused gate after the lazy-discovery fix: 220/220 assertions across 149 top-level tests.

## Independent review

The first read-only review reported 0 Critical, 4 Important, and 3 Minor findings. All seven were fixed with behavior tests:

1. production `ROCKY_HOME` forwarding;
2. interactive stdin `EPIPE` containment;
3. bounded post-kill cleanup and no overlapping fallback;
4. ordinary WSL Desktop config discovery;
5. valid help guidance;
6. strict JSON-RPC response envelopes;
7. clean child shutdown for healthy status.

The first rereview confirmed those seven fixes, then found one new Important eager-discovery regression. That regression was reproduced and fixed by making platform construction lazy. The final scoped rereview approved the change with no Critical, Important, or Minor findings.

## Final verification

- `node scripts/test.mjs setup` — PASS, 220/220 assertions, 149 top-level tests.
- `npm run build` — PASS.
- `npx tsc -p tsconfig.test.json --noEmit` — PASS.
- `node dist/index.js setup --mcp-exposure RAW` — expected exit 2; no host access; guidance points to `rocky --help`.
- `npm test` — PASS, 366/366 assertions, 295 top-level tests; Bash shell smoke `SMOKE: PASS`.
- `git diff --check` — PASS before report/commit finalization.

## Concerns

None open. No runtime dependency was added, no real host configuration was mutated during testing, and no Phase 4 work was started.
