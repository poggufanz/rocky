# Changelog

Notable changes per release. Dates are the release date.

## 0.5.0 — Unreleased

### Added

- Plan 01 Nervous System schema and private bounded event spool for Claude Code and Codex hooks.
- Claude Code prompt, edit-path, capped-excerpt, and stated-rationale capture; Codex modern and notify hook adapters.
- Redacted intent → rationale → mechanism triple annotation with deterministic degraded fallback, optional loopback Ollama compaction, and one passive label.
- Consent-gated Claude Code agent-hook setup, printed manual Codex TOML with `/hooks` trust guidance, and Claude-only uninstall/status commands.
- Plan 02 dictionary surfaces: `what`, `how`, `why`, `digest`, `quiz`, and filtered JSONL `export`, with deterministic lookup and optional local-Ollama ranking for `what --ai`.
- Ollama-gated ambiguity advice after an intent append, detached and non-blocking, plus passive labels at the next shell prompt and in non-quiet `rocky watch`.
- Three bounded read-only MCP knowledge tools: `search_knowledge`, `fetch_record`, and `why_file`, alongside the existing four memory tools.

This remains an unreleased 0.5.0 branch. BYOK annotation, `brief`, `attest`, and the memory circuit breaker are outside this release; no version bump or publish is implied.

## 0.4.0 — 9 August 2026

### Added

- **`rocky check`, the pre-push hull check.** Reads the commits you are about to push and runs three checks: a secret scan over added lines, an existence check for newly added dependencies, and one comprehension question about the riskiest added line. `rocky check --install-hook` installs it as a git `pre-push` hook.
- **The project's first external network egress**, and its only one: a package-existence lookup against `registry.npmjs.org`. Package names only — no versions, no paths, no telemetry. It is gated behind a one-time consent prompt that states exactly that before the first lookup, stored in `~/.rocky/config.json`, and it fails open: an unreachable registry, a redirect, a timeout, a 429 or a 5xx all warn and let the push through. Redirects are not followed, so the request cannot be steered to another host. `--offline` skips it for a run.
- **`note` records** in `memory.jsonl`, holding an answer you gave to a comprehension question. Written in 0.4.0; nothing reads them back yet.

### Fixed

- **Sanitized MCP output leaked credentials.** In the default `sanitized` exposure, any character other than whitespace or `;` in front of a key name defeated redaction — `user:_authToken=…` in an npm config line, `(api_key=…)` in a log — and a bare `password=` or `token=` never matched at all. The entropy fallback could not catch what the key rule missed, because it excluded tokens preceded by `=`, which is exactly where a credential sits. **This affects 0.3.0 and earlier; upgrade if you expose Rocky's memory over MCP.**
- **Silent failures collapsed onto one fingerprint.** A failure whose stderr carried no recognisable error line hashed to the same value as every other such failure, in any project, so Rocky could offer an unrelated command's fix as "I remember this error". Those failures now fall back to a command fingerprint. Existing records keep the fingerprint they were written with, so a previously linked fix stops matching until it is seen again under the new scheme.
- **Ctrl-C was recorded as a failure.** `rocky watch` already skipped exit 130 and 143; `rocky run` and the shell hook did not, so cancelled sessions were filed as unresolved failures. The exit code still passes through untouched.
- **`rocky run <cmd>` reduced to `rocky`** when grading fix links, which could tie a success to an unrelated program's failure.

### Changed

- **Exit codes for `rocky check` say what happened.** Run by hand: `0` nothing found, `1` something found, `2` Rocky could not check — git failed, or the diff was too large to read, so the range went uninspected. Under `--pre-push` a finding exits `3` and only that holds the push; everything else exits `0`, because a broken Rocky must never be the reason you cannot ship.
- `rocky check --help` prints usage instead of running a check, and an unrecognised flag now refuses with exit `2` rather than silently running with it ignored.
- The build restores the executable bit on `dist/index.js`, so a rebuild no longer breaks an already-linked global `rocky`.

## 0.3.0 — 9 August 2026

- `rocky watch` for long-running commands: idle lines, a desktop notification on completion, and a saved stderr tail on failure.
- Memory hardening: config persistence, bounded fix records, recall performance, and honest link-basis reporting.

## 0.2.1 — 8 August 2026

- Scoped npm distribution as `@poggufanz/rocky-cli`, read-only MCP server, consent-based host setup, an optional managed voice skill, and optional loopback Ollama interpretation for recall.

## 0.2.0 — earlier

- Bash/WSL shell hook with wrapper-free failure memory, plus a local guard for dangerous commands.

## 0.1.0 — earlier

- `rocky run` and `rocky recall`: fingerprint a failure, remember what fixed it.
