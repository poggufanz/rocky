# Changelog

Notable changes per release. Dates are the release date.

## 0.8.0 — 27 August 2026

A major release introducing a local browser GUI to replace the terminal dashboard, teach mode with deterministic evidence ladders and witness record capture, and bounded secret scrubbing:

- **Local browser GUI replaces terminal dashboard.** `rocky` and `rocky dash` open a local web page on `127.0.0.1` in your default browser. Both commands share one loopback server with `Main` and `Dash` tabs. Default port is `7777` with automatic port fallback and `--no-open`/`--port` options. Security controls enforce random 128-bit launch tokens in `X-Rocky-Token` headers, `Host` header verification against DNS rebinding, and path confinement to the launch repository.
- **Visual teach cards and repository filtering.** Selecting code in the Dash pane displays a `Why, question` action to open an inline evidence popup. The Dash file tree groups files by repository root and supports search with exclusion patterns (`!pattern`). The comparison view supports side-by-side diffs, single-side swaps, and strict line or loose file matching.
- **Optional BYOK model provider (beta).** Settings configures an optional OpenAI-compatible or Anthropic endpoint, key, and model. Keys are stored in `~/.rocky/gui.json` with `0600` permissions. Model responses are marked `Model Guess (Beta)` in grey with prompt redaction and concurrency limits. Models.dev catalog integration caches validated options weekly.
- **Teach mode (`rocky teach`).** Inspects why specific code exists: `rocky teach <file>[:<line>] [--ladder] [--stdin] [--quiet]`. Authoring agents record rationale into append-only `explain` records (`--explain-code` and `--explain-business`). PostToolUse hooks spool written hunks, and notify hooks link them into memory.
- **Deterministic why-ladder on cache miss.** When no witness record exists, Rocky walks local evidence (AST constructs, enclosing functions, callee definitions, adjacent comments, test references, git log commit history, and PSR-4 PHP `use` statements) up to five hops without disk writes.
- **Eighth MCP tool (`teach_lookup`).** Bounded read-only sanitized MCP tool returning witness cards or assembled ladders.
- **Path hygiene.** The `--files` parser discards shell fragments, operators, and invalid paths before saving records.

## 0.7.6 — 22 August 2026

A minor release adding a full terminal dashboard surface and a retrieval bug fix:
- **`rocky dash` grows a real surface line.** Home, browse, and compare now share one renderer core built on a pure cell buffer (wide-glyph/emoji-aware, SGR run collapse), a single-axis flex solver, and a keymap registry with layer resolution. Bare `rocky` on an interactive terminal opens the home surface directly; dash, repl, and compare all route through it.
- **Compare surface**: mark-then-pick timeline with per-side diffs, a file index, and a git-diff correlation ladder that resolves the change nearest a chosen moment. `rocky dash` opens compare directly; the separate compare CLI alias is dropped.
- **Rendering honesty**: why-card reason text is redacted at the render boundary, golden frames cover every surface at three sizes, mouse wheel scrolling and ascii-mode border degradation are in, and `ROCKY_TUI_MOTION=off` freezes motion for accessibility and deterministic tests.
- **`recall` and the dashboard's list filter stop surfacing agent transcript envelopes as rationale.** A triple's intent text was sometimes a whole captured `<task-notification>` envelope rather than the user's stated reason; a document containing everything matched every query. Envelope text is now excluded from the retrieval token bag and the list label, read-side only — stored evidence and `memory.jsonl` are untouched.
- Public attribution notes (README, docs) no longer name the specific work Rocky's character is inspired by; the non-affiliation and originality framing stays, the title doesn't.

## 0.7.5 — 21 August 2026

A patch release from the first day of dashboard dogfood:
- **`rocky dash` now shows the reason text it was hiding.** Rows labeled bare `rationale`/`triple` and an empty Rationale tab were a display bug, not missing data: rationale records keep their text in `excerpt`, and triples nest `intent`/`rationale` as `{ text }` objects — field shapes the dashboard never read. Rows now label from the real text, and the Rationale tab renders the intent plus the stated why.
- **The rationale gate's own retry instruction now works.** Comply with `run: rocky hook agent-event claude-code --rationale ... --files ...` after a deny, and the gate recognizes that evidence: it reads memory for a fresh, file-linked rationale before denying a first-touched file, instead of relying purely on deny-once-then-fail-open. `--files` is now actually stored — it was parsed and silently dropped before.
- **Any harness can now grow a why-trail with Rocky, not just Claude Code.** `rocky check` speaks one non-blocking line before a push naming changed files with no fresh stated reason and the exact command to record one — universal because `git push` is universal, and silent in repos with no recent agent activity. A harness that can block its own tool calls may opt into the same deny-once gate Claude Code uses via `rocky hook gate-event generic`. Fixed alongside: the notify command could hang forever when stdin was an interactive terminal instead of a vendor payload pipe.

## 0.7.4 — 21 August 2026

A minor release adding an interactive terminal dashboard, phase 1:
- **`rocky dash`** browses memory (failures, fixes, triples, sessions, invariants) in a two-pane terminal UI: a records list and an inspector with Info, Rationale, Diff, and JSON tabs. Fuzzy search (`/`), a filter cycle (`f`), and a lazygit-style keymap (`j`/`k`, `Ctrl+d`/`Ctrl+u`, `[`/`]`, `?` for help) — read-only, zero runtime dependencies, and built on a pure render loop so every frame is unit-tested.
- **Bare `rocky` on an interactive terminal now opens the dashboard directly** — the same idiom as `claude`, `lazygit`, and `k9s`. Bare `rocky` in a script or CI pipe keeps printing today's usage text unchanged, and `rocky --help` is untouched.
- Non-TTY, Git Bash/MinTTY, and legacy consoles without VT processing all fall back to `rocky stats` with a plain explanation instead of painting garbage or hanging.

## 0.7.3 — 21 August 2026

A patch release closing a gap the 0.7.2 hook fix left open:
- **Hook speech never touches the console device directly anymore.** `speakTty` kept a fallback that wrote straight to `/dev/tty` (POSIX) or `\\.\CON` (Windows) whenever the speech-file environment variable was unset. On Windows that write lands on screen instead of throwing, so any process inheriting the console host — including a test run — could paint Rocky's hook output over whatever else owned the terminal. Both shipped hooks have set the speech-file variable since 0.7.2, so the fallback only ever served stray non-hook invocations; it is gone, and hook speech is silently discarded without a speech file instead.

## 0.7.2 — 20 August 2026

A patch release cleaning up the passive hook lane — the path that runs at every prompt, on every command, without you typing anything:
- **Bash hook no longer writes over your prompt.** The detached handler wrote straight to the console device, racing the shell's prompt draw and your own typing. It now buffers into a per-spawn speech file and prints it at the next prompt, the same mechanism the PowerShell hook has used since 0.5.2. Each session only ever prints speech files it claimed itself, so two open terminals never steal each other's messages.
- **No more deep-memory hint on typos.** Repeating a misspelled command no longer asks you to wrap the misspelling in `rocky run`. Detected by exit 127, the command-not-found code Bash sends natively and that the PowerShell hook now reports for a command PowerShell could not find. Only command-not-found is covered — a missing *file* is indistinguishable from an ordinary failure without stderr, and the passive handler never receives stderr.
- **`rocky hook status` now says when your installed hook is out of date** and names `rocky hook install` as the fix. Hook protocol version moves to 0.4.0. Existing installs keep the old behaviour until reinstalled.

## 0.7.1 — 20 August 2026

Release: [v0.7.1](https://github.com/poggufanz/rocky/releases/tag/v0.7.1)

A patch release adding native Git Diff Correlation to Rocky's memory evidence:
- **`rocky why <file> [--diff]` & `rocky how <query> [--diff]`:** Renders bounded, secret-redacted git patches correlated with remembered rationale and mechanism evidence.
- **Git diff resolution with fail-open guarantee:** Correlates via commit SHA (`diff-tree`), timestamp window (`git log -n 1 --since/--until`), or uncommitted working tree diff (`git diff HEAD`). Fails open with `(git diff unavailable)` when outside a repository, when git is not installed, or upon timeout without throwing.
- **MCP Tool enhancements:** `why_file` accepts optional `diff?: boolean` and includes projected bounded diffs.

## 0.7.0 — 20 August 2026

Release: [v0.7.0](https://github.com/poggufanz/rocky/releases/tag/v0.7.0)

A minor release: Rocky now remembers *why*, not just *what* and *how*. Two new evidence kinds, `rationale` and `alias`, join the schema envelope documented in `docs/schema.md`. Stated-rationale evidence arrives through four lanes ranked by fidelity — `log-thinking` from bounded log adapters (Claude Code session transcripts, and DSH session logs where the runtime has zstd), `log-response` as Claude Code's own fallback when a turn has no thinking block (DSH never emits this lane), `notify` from any agent that calls the generic hook endpoint with `--rationale`, and `human` from `rocky why --add`. A deterministic concept lexicon and matcher build a derived, never-persisted concept index over existing memory, surfaced through `rocky concepts`, `rocky concept <id>`, and `rocky concept alias`. `rocky sessions` and `rocky repl` read that same memory as derived work sessions and a single interactive loop, so recall/what/why/how/concepts stop paying a fresh process start per call. A new PreToolUse gate, dispatched through `rocky hook gate-event claude-code` and installed by default from `rocky setup --agent-hooks`, nudges an editing agent to state a rationale once per session per file before an edit, then fails open; it never blocks twice for the same file, and it can be turned off at install with `--no-rationale-gate` or at runtime with `ROCKY_RATIONALE_GATE=off`. Codex has no deny hook, so it reaches the `notify` lane only. Alongside the new capture surfaces, resolution phrasing across `run`, `watch`, `recall`, and `brief` was corrected: Rocky no longer claims "I remember the fix" or offers a circular "you fix with: `<the same command that just failed>`" — a resolution line now says only that some later command succeeded and that the fix method itself was not heard.

### Added

- **`rationale` and `alias` evidence kinds.** `rationale` carries `cwd, agent, rationale_fidelity (raw|summary|none), source (log-thinking|log-response|notify|human), excerpt`, and optional links back to a triple/fix/failure; `alias` carries `alias, concept, action (add|retract)`. Both are append-only, bounded, and redact secrets the same way triples do. Reclaim tombstones now unlink and sweep leftovers after a successful write instead of leaving orphaned lock artifacts behind.
- **Deterministic concept lexicon and matcher (`rocky concepts`, `rocky concept <id>`, `rocky concept alias`).** A fixed lexicon and bounded phrase matcher fold memory into a derived concept index at read time — counts, active aliases, and newest-first evidence per concept. Nothing here is written back into evidence; the index is a replaceable view, matching the schema's derived-data rule. Alias matching and phrase length are bounded; malformed alias arguments and incomplete memory coverage are disclosed, not silently dropped.
- **Bounded JSONL log scanner with adapter offsets, and a Claude Code transcript adapter.** `src/agent/logs/scan.ts` reads a vendor session log from a stored byte offset, capped per read, and restarts cleanly from zero when a log has been truncated since the last scan. `src/agent/logs/claude-code.ts` reads Claude Code's own transcript for thinking and reply lanes; a robust discovery probe compares cwd rather than trusting a path a vendor could have moved.
- **DSH session log adapter, feature-detected (`src/agent/logs/dsh.ts`).** Reads `~/.dsh/sessions/<project>/<session>/session.jsonl.zstd` when the runtime Node ships built-in zstd (Node 22.15+); on an older Node the adapter reports zero discovered logs instead of failing. Decompression runs under a dedicated budget with a tolerant header and a file-descriptor-stable size cap.
- **Rationale capture pipeline with conservative correlation.** New evidence only links to a triple, fix, or failure when the correlation is structurally sound; a merely plausible time-window match is treated as no link rather than a guessed one. Adapter failures are isolated per adapter and never abort the rest of the capture pass.
- **`rocky why --add "<text>"` and per-record source labels.** Lets you teach Rocky your own stated rationale for a file directly, recorded as `agent: "human"`, `source: "human"`, `rationale_fidelity: "summary"`. `rocky why` now shows each rationale's source (`you said` / `agent said` / log-derived) and id alongside its age.
- **Generic agent notify endpoint (`rocky hook agent-event generic --rationale "<text>" [--files a.ts,b.ts]`).** Any agent, without a vendor-specific log adapter, can hand Rocky one line of stated rationale directly; `claude-code` and `codex` gained the same `--rationale`/`--files` flags on their existing endpoints. The notify write path is decoupled from vendor payload parsing, so a malformed vendor argument never blocks a plain rationale notification.
- **PreToolUse rationale gate (`rocky hook gate-event <vendor>`).** A small, generic check registry reads one hook payload from stdin against bounded per-session state under `~/.rocky/gate-state/`, and always exits 0. The one shipped check denies once per session per file when no rationale evidence exists yet for that file, then fails open for later touches of the same file — deny-once, evidence-shaped enforcement, not a hard block. `rocky setup --agent-hooks` installs it by default; `--no-rationale-gate` at install and `ROCKY_RATIONALE_GATE=off` at runtime both opt out. An unrecognized vendor or tool, or a gate-state directory Rocky cannot write to, allows outright rather than blocking.
- **`rocky sessions [n]` and `rocky sessions <index>`.** Lists work sessions derived from memory at read time, grouped by directory and split on a 30-minute gap, newest-first; interpolated evidence fields shown in the detail view are bounded.
- **`rocky repl [--ai]`.** One deterministic loop over the existing recall/what/why/how/concepts/sessions commands, so an interactive session stops paying a fresh process start per lookup. `--ai` passes through only to `recall`/`what`, matching their own opt-in AI behavior; quote-aware tokenizing keeps multi-word arguments intact.
- **`rocky brief` gained repeated-concept and rationale lines, and `rocky stats` gained rationale/alias counts.** Brief now surfaces concepts that recur across the window and ranks which rationale to show by fidelity. `rocky stats` reports rationale counts by fidelity (`raw`/`summary`/`none`) and a remembered-alias count; both stay CLI-only — the MCP `stats` tool's projection deliberately omits `rationaleByFidelity` and `byKind` for now.

### Changed

- **Resolution phrasing across `run`, `watch`, `recall`, and `brief` no longer overclaims.** Rocky confirms only that some later command succeeded for the same reliable identity; he no longer says he remembers the fix, and no longer echoes the failed command back as if it were the fix itself. The mechanism behind a fix stays the agent's own unread history unless a `rationale` record says otherwise.

### Not in this release

- Codex and Gemini log adapters remain deferred. Codex's local session-log format has drifted to a SQLite hybrid since this project last checked it, and Gemini persists no thoughts to read — neither has a `log-thinking` lane; both still reach Rocky only through the universal `notify` lane.
- BYOK annotation, `attest`, and the memory circuit breaker remain deferred, unchanged from 0.6.0.
- `scripts/release-check.mjs`'s `RELEASE_TAG`/`RELEASE_COMMIT` still point at v0.6.0. They are re-pinned to v0.7.0 in a separate commit once the tag exists, so this branch's own CI does not go red before the tag is cut.

## 0.6.0 — 18 August 2026

Release: [v0.6.0](https://github.com/poggufanz/rocky/releases/tag/v0.6.0)

A minor release: validation and accountability surfaces on top of the v0.5 memory. `rocky brief` reads local git history and remembered failures/fixes since your last look and reports what changed, with optional loopback-Ollama narrative polish. `rocky journal` writes one dogfood note at a time to a local, append-only file. `rocky invariants` parses `.rocky/invariants.md` guard blocks with an in-house glob matcher and discloses any glob that currently matches nothing. `rocky stats` gained per-kind record counts, memory age, and journal count. The record schema envelope is documented in `docs/schema.md`, including the reserved `rationale` and `guard` kinds for future writers.

### Added

- **`rocky brief [--since <ref|24h>] [--quiet] [--ai]`.** Deterministic five-block composition — window state, commit churn, remembered failures/fixes, touched invariant guards, and a closing line — scoped to the current directory and a `--since` window that accepts a git ref or a duration (`90m`, `24h`, `7d`), defaulting to 24 hours since the last brief or first run. `--ai` requires exact line-count parity with the deterministic output before accepting loopback-Ollama polish, and falls back to the deterministic text on any mismatch or when Ollama is unavailable. Reads local git log and memory only; `--ai` stays on loopback.
- **`rocky journal "<note>"`.** Appends one line to a local dogfood journal. Local file write only, no network.
- **`rocky invariants`.** Lists remembered invariant notes parsed from `.rocky/invariants.md` and reports which guard globs match zero files in the current tree, so a stale guard doesn't silently protect nothing. Malformed blocks are never silently dropped.
- **Extended `rocky stats`.** Per-kind record counts, memory age, and journal entry count join the existing totals and coverage summary.
- **Schema envelope documentation.** `docs/schema.md` documents the record envelope discriminated by `kind`, including reserved `rationale` and `guard` kinds for writers that don't exist yet.

### Not in this release

- The reserved `rationale` kind has no writer yet — decided during design, tracked for a later release.
- No recall-hit or guard-trigger counter in `rocky stats` yet: no evidence for either is recorded today (journal covers "Rocky helped" moments manually), so the per-kind block will pick both up automatically once a writer exists.
- `scripts/release-check.mjs`'s `RELEASE_TAG`/`RELEASE_COMMIT` still point at v0.5.5. They are re-pinned to v0.6.0 in a separate commit once the tag exists, so this branch's own CI does not go red before the tag is cut.

## 0.5.5 — 18 August 2026

Release: [v0.5.5](https://github.com/poggufanz/rocky/releases/tag/v0.5.5)

A patch release closing the three findings still open from the 0.5.1 and 0.5.3 stress-test audits (`docs/2026-08-17-stress-test-findings-v0-5-1.md`, `docs/2026-08-18-stress-test-findings-v0-5-3.md` in the repo root): recall dying on the exact recurring-error case it exists for, the PowerShell hook ignoring a sandboxed `USERPROFILE`, and v2 error text outside signal lines being unfindable.

### Fixed

- **`rocky recall` lost results the moment the same error was recorded twice.** `queryRecall` counted a token's document frequency once per stored record, but the rare-token floor for small memories is 1 — so the second occurrence of the *same* failure pushed its own distinctive token (`enospc`, a package name, an error code) past "rare", the score fell to plain Jaccard below the cutoff, and recall said nothing matches. One record worked; the recurrence — Rocky's core case — broke it. Document frequency is now counted once per canonical fingerprint, in both `queryRecall` and `searchKnowledge`, so repeats of one failure no longer dilute their own evidence.
- **`rocky hook install`/`uninstall` could write to, or strip the hook from, the real PowerShell profile while `USERPROFILE`/`HOME` pointed at a sandbox.** The host probe asks `powershell.exe`/`pwsh.exe` for `$PROFILE` directly, and that answer never passed through `homedir()`, so a sandboxed environment (CI, stress harnesses) silently reached the real profile — reproduced for real during the 0.5.1 stress test. Every probed host is now admitted only when its profile resolves under the active home directory; a host outside it is dropped with a one-line disclosure instead of silently vanishing. Setups whose profile legitimately lives outside home (Group-Policy Folder Redirection onto a file share) can opt back in explicitly with `ROCKY_HOOK_ALLOW_PROFILE_OUTSIDE_HOME=1`, which is also disclosed. The `ROCKY_TEST_POWERSHELL_HOSTS` test seam keeps its existing precedence.
- **Error detail outside signal lines was unfindable for current-format records.** A v2 record's excerpt was never indexed as recall evidence, so a line like `npm ERR! No matching version found for left-pad@^99.0.0` — no signal word, so no signature line — left `rocky recall "left-pad"` empty even though the excerpt stored the name. v2 non-hook excerpts now feed retrieval evidence under the same bounded token budget; hook-origin records and unproven legacy v1 excerpts stay excluded, exactly as before.
- **The new containment tests spoke Windows paths to POSIX filesystems.** First CI round after the guard landed was red on ubuntu/macos and green on Windows: a literal `C:\Users\...\OneDrive\...` is a single path segment on POSIX, inverting three fixture expectations. Containment fixtures are now written in each platform's own path dialect; drive-letter and backslash-normalization semantics stay Windows-literal and skip elsewhere.

### Not in this release

- `scripts/release-check.mjs`'s `RELEASE_TAG`/`RELEASE_COMMIT` still point at v0.5.4. They are re-pinned to v0.5.5 in a separate commit once the tag exists, so this branch's own CI does not go red before the tag is cut.

## 0.5.4 — 18 August 2026

Release: [v0.5.4](https://github.com/poggufanz/rocky/releases/tag/v0.5.4)

A patch release. `rocky hook install` could install the Windows-only PowerShell hook into a non-Windows user's shell profile — a defect shipped in both 0.5.2 and 0.5.3. It is fixed here, alongside a test-only flake in the release suite found while verifying the fix.

### Fixed

- **`rocky hook install` could install the Windows-only PowerShell hook on Linux and macOS.** `detectPwshHost()` in `src/commands/hook.ts` probed for a `pwsh` binary with no platform gate, unlike its `detectWindowsPowerShellHost()` sibling. PowerShell 7 (`pwsh`) is a real, cross-platform binary — it ships preinstalled on GitHub's hosted `ubuntu-latest` and `macos-latest` runners and is common on developer machines that use PowerShell as a cross-platform shell — so on any of those hosts, `rocky hook install` would genuinely try to write the Windows-only `$PROFILE` hook. This shipped broken in both 0.5.2 and 0.5.3. The same missing gate also let three real-host PowerShell tests run on Linux and macOS instead of being skipped there, which is how the defect was caught: CI was red on every POSIX job and green only on Windows. `detectPwshHost()` now gates on `process.platform === "win32"` first, matching `detectWindowsPowerShellHost()`.
- **A memory-settling wait in the release test suite could pass one record short.** `readMemoryRecordsSettled` declared a memory file settled as soon as two consecutive polls read identical content, with no notion of how many records the scenario actually expected, so a still-in-flight detached write could read as "done" a record early. Test-only; nothing shipped changed. It now waits for a known record floor before declaring settled. Reproduced under synthetic load at 4 failures in 20 runs before the fix, 20 of 20 passing after.

### Not in this release

- `scripts/release-check.mjs`'s `RELEASE_TAG`/`RELEASE_COMMIT` still point at v0.5.3. They are re-pinned to v0.5.4 in a separate commit once the tag exists, so this branch's own CI does not go red before the tag is cut.

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
