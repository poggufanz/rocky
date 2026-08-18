# Changelog

Notable changes per release. Dates are the release date.

## 0.5.3 — 18 August 2026

Release: [v0.5.3](https://github.com/poggufanz/rocky/releases/tag/v0.5.3)

A patch release: hand verification of 0.5.2 on a real Windows console, rather than through the automated suite, found three defects that the automated suite and seven prior reviews had missed. All three are fixed here.

### Fixed

- **`rocky hook install` failed outright on Windows PowerShell whenever `$PROFILE`'s parent directory did not exist** — the default state for anyone who never customized that profile, so the hook could not be installed at all on the primary dogfood shell. The failure message also blamed disk space or permissions, sending a user to check the wrong thing. `hook install` now creates that parent directory before writing, and a genuine write failure now gets its own message distinct from a missing directory.
- **The detached hook child's console write could collide with your prompt or your own typing.** Because the child that speaks Rocky's line runs detached from the shell, its write to the console had no guaranteed order against the next prompt being drawn: the line could land after the prompt, get truncated mid-sentence, or interleave with text you were actively typing. The child now buffers its speech instead of writing the console directly, and `prompt` drains and prints it, correctly ordered, on the next command — one prompt cycle behind, same as before. Hardening followed: per-session ownership, so a buffered message can never resurface misattributed to an unrelated later session; sanitization on read, so another same-user process cannot inject terminal control sequences into what Rocky "says"; a real encoding fix, since Windows PowerShell 5.1 read the buffered UTF-8 file as the system ANSI codepage and corrupted non-ASCII text; a second, independent encoding fix on the write side for redirected or piped stderr; a symmetric restore of the console's output codepage, so fixing this does not leave a side effect of its own; and pruning of stale buffered files.
- **Records the hook wrote were nearly unfindable through `rocky recall`.** Paths are masked in the stored fingerprint, and hook-origin records carry no stderr, so the searchable surface collapsed to little more than the program name — Rocky could have just spoken about a failure and `recall` would still say nothing matches the words you'd actually type. `recall` now also matches tokens pulled from the raw command text, bypassing path masking for that pass alone while still masking hex, UUIDs, digests, and timestamps, and bounding how many raw tokens a single record can contribute. This is a read-path fix only; nothing about what gets written or fingerprinted changed.

### Known limitations

The `recall` fix above caps raw-command tokens at 12 net-new per record, collected from the end of the command backward. Three narrower, non-regressive gaps were found during review and accepted into this release rather than chased further:

- A command with two distinct paths, like `cp <source> <destination>`, can let the trailing path consume the whole token budget and starve out a distinctive fragment near the front. Neither path was findable before this fix, so this is a partial win, not a loss — but the benefit skews toward commands with the distinctive part near the end.
- The 12-token cap counts matches, not insertions — one raw match can still contribute more than 12 net-new entries once it is split on `-`/`_`/`.`, so the ceiling is a soft bound rather than the firm one it was meant to be.
- Raw-command tokens feed the same rareness accounting recall already uses elsewhere, which could in principle dilute another candidate's protection under the rare-token floor. This was reasoned through and not reproduced.

Full detail, including how each was found, is in `docs/superpowers/validation/2026-08-18-powershell-manual-checklist-findings.md`.

### Not in this release

- The write side of loosening fix-link candidates — the `sequence` basis, dropping the same-base-program requirement from candidate selection, and the 5-link cap that goes with it — still is not shipped. `sequence` has been readable since 0.5.2; no version writes it yet.
- `scripts/release-check.mjs`'s `RELEASE_TAG`/`RELEASE_COMMIT` still point at v0.5.2. They are re-pinned to v0.5.3 in a separate commit once the tag exists, so this branch's own CI does not go red before the tag is cut.

## 0.5.2 — 17 August 2026

Release: [v0.5.2](https://github.com/poggufanz/rocky/releases/tag/v0.5.2)

A patch release: it repairs a read path already promised by 0.5.1's memory model and by the README, and it lands the PowerShell hook. No new record shape is written by this release.

### Added

- **PowerShell hook.** `rocky hook install`/`uninstall`/`status` now cover PowerShell 5.1 and 7.x, alongside the existing Bash/WSL hook. It installs one idempotent managed block into `$PROFILE`, overriding `prompt` to observe a command's result right after it finishes — the same failure/fix memory the Bash hook keeps, without a wrapper. It cannot ask for confirmation before a dangerous command the way the Bash hook does, because `prompt` never sees a command before it runs. Because `prompt` fires after a command's own stderr is already gone, PowerShell-hook failures are fingerprinted from the command text alone (the same fallback the CLI has used since 0.4.0) and are recorded without stderr, so evidence from this surface reads weaker than evidence from `rocky run`. `$LASTEXITCODE` and `$?` always reflect your own command; the one disclosed side effect is a suppressed synthetic entry Rocky pushes onto `$Error[0]`, documented in the README and in `rocky hook status`.
- The lock-fairness change already sitting on `main` since before this branch, now included in a release for the first time: waiters queue by ticket, and the `busy` deadline bounds time without progress rather than total time spent waiting in the queue.

### Fixed

- **Association evidence Rocky already wrote now actually reaches you.** `resolveFixOnSuccess` has written weak-evidence `AssociationRecord`s since 0.3.0, but nothing read them back: `run` and `watch` printed `no fix in memory yet` and `recall` skipped them entirely, even when memory held a candidate. A new `possibleFixesForFailure` read (`src/core/memory-query.ts`) surfaces the newest such candidate as one explicitly hedged line — `no confirmed fix. but after error, you run this: ...` — across `run`, `watch`, and `recall`. It never overrides or duplicates a confirmed fix, and never shows more than one candidate at a time.
- **A `FixLink` with an unrecognized `basis` no longer loses its record.** The memory reader and both MCP fix-link readers now treat any `basis` outside the currently known set as the weakest possible evidence — readable, never `confirmed`, and never dropped. Previously an unfamiliar `basis` value caused the whole record to be discarded, which meant a reader on this version would have lost data the moment a newer Rocky started writing a `basis` value it didn't recognize yet.
- Native Windows hook speech (`sayTty`/`detailTty`) wrote to `/dev/tty`, which does not exist on native Windows, so every hook-handler line Rocky spoke there was silently swallowed. Now routed through `\\.\CON`.

### Not in this release

- The write side of loosening fix-link candidates — a new `sequence` basis, dropping the same-base-program requirement from candidate selection, and the 5-link cap that goes with it — is **not** shipped in 0.5.2. It waits for the tolerant reader above to circulate first: writing looser links before that would let a reader still on 0.5.0 or 0.5.1 silently drop the very records this release exists to protect. That writer lands in a later release once the tolerant reader has had time to spread.
- `scripts/release-check.mjs`'s `RELEASE_TAG`/`RELEASE_COMMIT` still point at v0.5.1. They are re-pinned to v0.5.2 in a separate commit once the tag exists, so this branch's own CI does not go red before the tag is cut.

## 0.5.1 — 17 August 2026

Release: [v0.5.1](https://github.com/poggufanz/rocky/releases/tag/v0.5.1)

### Fixed

- Hull checks now distinguish a verified clean result from an uninspected workspace, preserve findings from completed ranges when a later range fails, and reject malformed Git evidence instead of treating it as clean.
- Bounded Git patch, numstat, and name-only framing validation now covers ordinary text, binary, rename/copy, mode/type, symlink, submodule, quoted-path, and SHA-1/SHA-256 output without blocking the event loop or trusting unsupported extraction.
- Memory, MCP, teaching, and model surfaces now keep bounded evidence, privacy, deadlines, and incomplete coverage explicit across concurrent and degraded paths.
- Setup health/removal and package smoke paths now report actual cross-platform process and host state, including native Windows executable seams.

### Changed

- Release metadata, documentation, and security support policy now identify 0.5.1 as the current package line. Runtime dependencies remain at zero.

## 0.5.0 — 14 August 2026

Release: [v0.5.0](https://github.com/poggufanz/rocky/releases/tag/v0.5.0)

### Added

- Plan 01 Nervous System schema and private bounded event spool for Claude Code and Codex hooks.
- Claude Code prompt, edit-path, capped-excerpt, and stated-rationale capture; Codex modern and notify hook adapters.
- Redacted intent → rationale → mechanism triple annotation with deterministic degraded fallback, optional loopback Ollama compaction, and one passive label.
- Consent-gated Claude Code agent-hook setup, printed manual Codex TOML with `/hooks` trust guidance, and Claude-only uninstall/status commands.
- Plan 02 dictionary surfaces: `what`, `how`, `why`, `digest`, `quiz`, and filtered JSONL `export`, with deterministic lookup and optional local-Ollama ranking for `what --ai`.
- Ollama-gated ambiguity advice after an intent append, detached and non-blocking, plus passive labels at the next shell prompt and in non-quiet `rocky watch`.
- Three bounded read-only MCP knowledge tools: `search_knowledge`, `fetch_record`, and `why_file`, alongside the existing four memory tools.

BYOK annotation, `brief`, `attest`, and the memory circuit breaker did not ship in 0.5.0. They remain deferred unless a later release says otherwise.

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
