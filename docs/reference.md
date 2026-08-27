# Rocky behavior and safety reference

This is the detailed contract behind the shorter [project README](../README.md). It records command boundaries, evidence rules, setup transactions, recovery behavior, and platform limits.

Rocky is a terminal companion who keeps track of what you and your AI have already been through, so the second time an error appears, the answer comes from your own history — not from twenty minutes of googling.

**Teaching modes exist inside individual agents. Rocky is the layer that remembers what you learned — passive, cross-tool, and permanent.** Plan 01 of the v0.5 Nervous System and the Plan 02 dictionary/teaching surfaces ship in v0.5.0. The longer-term mission is simple: make users not forget the fundamentals.

He is also, unapologetically, a pet.

## Why

Developers run around five search sessions a day just looking things up (Sadowski et al., FSE 2015), and debugging lookups are among the most frequent and most difficult of them (Xia et al., EMSE 2017). A lot of that time is spent *re-finding* solutions we already had once. Human memory drops them. Nothing in the toolchain catches them.

Eridians have photographic memory. Rocky catches them.

Code nobody understands has a measured price as well. GitClear's 2025 analysis found the share of changed lines associated with refactoring falling from 25% in 2021 to under 10% in 2024 — the first year on record in which copy/pasted lines outnumbered moved ones — and its 2026 follow-up reports duplicated blocks up 81%, constructs that mask errors up 47%, and changes touching code older than a year down 74% since 2023. Those are measurements of code, not of comprehension, and neither those reports nor this project attributes the debt to any particular group of developers.

Rocky is *built to* attack that cost: fewer agent runs wasted on ambiguous direction, fewer misunderstanding loops, less debugging déjà vu. That is stated design intent for planned work, not a measured result — this project publishes no saving percentage it has not measured.

The longer arc of this project is what we call the comprehension guardian: in an era where AI generates code faster than anyone reads it, Rocky's job is to make sure the human still understands what got built. See [scientific grounding](scientific-grounding.md) for the research this is built on.

## The Good Trade

**The Good Trade.** You get smarter, so your AI gets more effective. Better AI work gives you better material to learn from, so you get smarter again. Rocky exists to keep that loop spinning—because the opposite loop is a risk worth resisting.

This is Rocky's v0.5 product hypothesis, not an established outcome. "More effective" means that a better-informed user can provide sharper direction, context, choices, and verification; it does not mean the model weights change. Rocky's impact on understanding still has to be tested through dogfooding and user research.

Two loops run in opposite directions:

- **The loop worth resisting** — the AI gets more capable, more of the thinking gets handed over, understanding and vigilance erode, intent and verification get worse, and the results get harder to judge at all.
- **The Good Trade** — you understand more, your intent and decisions get sharper, the AI's work in your hands gets more useful, and that work becomes the material you learn from next.

The arrow that usually breaks is *AI output → you learn from it*. Each arrow maps to one mechanism rather than to a slogan. As of v0.5.0, Plan 01 and the dictionary/teaching surfaces of Plan 02 are implemented:

| Arrow kept alive | Mechanism | Role | Boundary |
|---|---|---|---|
| AI output → your understanding | Nervous system | Shows the concrete mechanism behind your intent and the agent's change | Plan 01 implemented |
| AI output → your understanding | Intent→mechanism dictionary | Shows the concrete mechanism behind your intent and the agent's change | Plan 02 implemented |
| Your understanding → next intent | Reverse lookup (mechanism→intent) | Returns the intent you actually stored, with its change ID and time | Plan 02 implemented |
| Your intent → AI output | Ambiguity surfacing | Shows the several mechanisms one of your own words has already produced, and lets you pick | Plan 02 implemented |
| Your articulation → memory | The curious blind friend | One curious question turns a one-line answer into a journal entry and a dictionary entry | Plan 02 implemented |
| Memory → next decision | Recall | Carries a cross-session lesson into a new decision | Plan 01 implemented/current |
| Memory → next decision | Digest | Carries a cross-session lesson into a seven-day summary | Plan 02 implemented |
| Memory → next decision | Memory circuit breaker | Flags repeated approaches as planned negative knowledge | Plan 02 deferred |

The claim stops there: better direction from you, never a smarter model.

> "You teach, I remember. I remind, you understand. This is good trade."

That companion line is an original Rocky project tagline, not a quotation from an external source.

## Install

```bash
npm install -g @poggufanz/rocky-cli
```

Current release: `@poggufanz/rocky-cli@0.7.6`. One install includes the `rocky` CLI and its read-only MCP server. The unrelated unscoped `rocky-cli` package is not this project and Rocky never installs, upgrades, or removes it. The binary name remains `rocky`, so npm reports any local binary-name conflict through its normal install behavior.

Repository layout: a fresh clone of the canonical upstream repository (`https://github.com/poggufanz/rocky.git`) is the package root; run `npm install`, `npm test`, and `npm pack` there. In this outer workspace, that same package root is the `rocky/` directory. Canonical developer branch is `main`; `iq` is a remediation branch, not a second release line.

Requires Node 18+.

Set an absolute `ROCKY_HOME` to move Rocky's own state directory. Paths below shown under `~/.rocky` follow that override; `.bashrc`, host configuration, voice-skill backups, and setup recovery artifacts do not.

Register Rocky with detected MCP hosts after installation:

```bash
rocky setup
rocky setup --voice-skill   # also install the managed Rocky voice skill
rocky setup --agent-hooks
rocky setup --uninstall-agent-hooks
rocky setup --status
```

`rocky setup` configures detected hosts with sanitized MCP exposure after consent. By itself it never edits `.bashrc`, installs a voice skill, installs or pulls an Ollama model, or enables local AI. Voice-skill work requires the explicit `--voice-skill` flag. Shell integration is a separate `rocky hook install` step.

Codex registration is capability-gated, not a name-only mutation: Rocky proves the existing Rocky entry originates from the base user config layer through Codex's official app-server config protocol, then writes with a version-checked compare-and-swap. Whenever provenance, capability, or version cannot be proven, Rocky falls back to manual instructions.

Proving that runs a real `codex app-server` process against your live `$CODEX_HOME`: a plain `rocky setup` starts two (one to inspect for consent, one to configure), `rocky setup --check` starts one, and app-server startup can create Codex-local state independent of `~/.rocky/`. Any destructive Codex change (a replace or a `--remove`) first writes a private recovery copy of the entry it is about to change under `$HOME/.rocky-setup-recovery/`. A successful replace deletes that copy once the new entry is verified; a successful `--remove` does not — the copy stays as your manual undo, and Rocky prints its exact path in the result.

Claude Code registration goes through a private stage. Rocky clones the effective `.claude.json` into a private copy, proves the surrounding policy is unchanged, runs the official Claude CLI only against that copy, audits that only the Rocky entry changed, then publishes the audited bytes through a recoverable transaction.

That staged path does not activate in this release. Rocky ships no complete Claude Code policy manifest, so any `rocky setup` run that still has to write reports `claude-code: failed` with `Claude Code policy-equivalent automation is unavailable; use manual registration` and exits 1. Rocky prints the exact CLI argv to paste; run it yourself. Once the entry exists, later runs report `claude-code: already-configured`.

`--voice-skill` only targets detected Codex and Claude Code hosts. Claude Desktop never receives the voice skill, and its own MCP result stays independent. When zero hosts are eligible, Rocky prints `voice-skill: unavailable` and exits 1 instead of inventing a result.

## Nervous System (v0.5.0)

Plan 01 ships in v0.5.0. Rocky captures the user prompt, every unique edited path within a documented 64-event adapter cap and 8-file durable triple cap, small capped excerpts, and the agent's stated rationale. Path identity trims whitespace, uses `/` separators, collapses duplicate separators and `.` segments, and is case-insensitive on a known Windows origin (case-sensitive on a known POSIX origin); `..` is never resolved. Durable triples carry origin platform and cwd for identity, preserve case when origin is unknown, and carry exact `truncatedFiles` counts only when coverage is proven, with a `coverageStatus` (`complete`, `truncated`, or `unknown`) plus per-file provenance (`tool-observed`, `git-diff-inferred`, or `unknown`); turn baselines make pre-existing dirty state and commit-before-Stop explicit. Events pass through a transient private spool before Rocky redacts secrets and writes one durable `triple` record to local `~/.rocky/memory.jsonl`; Rocky state stays private, with `0600` files where the platform supports those modes. `rocky why` and MCP `why_file` disclose incomplete coverage separately from response-byte truncation when a requested path may have been omitted.

This feature adds no new egress and no daemon. Rocky does not capture screens or keystrokes, and never rewrites, injects, or submits a prompt. With Ollama disabled or unavailable, deterministic degraded annotation still records the evidence. An optional configured loopback Ollama may compact only rationale, tags, and the passive label; it never changes the captured intent, path, or excerpt evidence. Rationale is quoted, untrusted hearsay — never fact and never hidden chain-of-thought.

Claude Code setup via `rocky setup --agent-hooks` asks for explicit consent before changing settings. Use a pre-created private `~/.claude` parent (mode `0700` where supported); Rocky fails closed when that parent is missing. Codex setup prints a manual Codex TOML block and writes no Codex config; review and trust the command through Codex `/hooks` before pasting it. `rocky setup --uninstall-agent-hooks` removes Rocky's Claude hooks only and never edits Codex `config.toml`.

Claude Code capture requires hook payload field `prompt_id`; without `prompt_id`, Rocky records nothing and never merges turns. `rocky setup --agent-hooks` and `rocky setup --status` print this capability boundary alongside their setup/status output. Setup status scope is host/MCP registration via rocky setup --check and agent-hook state/capability; spool and Ollama/model health are not checked.

Plan 02 dictionary and teaching surfaces ship in v0.5.0. The commands read remembered triples and comprehension notes and keep original evidence intact:

```text
rocky what "move button down"
rocky what --ai "move button down"   # optional local Ollama ranking; deterministic fallback
rocky how "move button down"
rocky how --diff "move button down"  # show correlated git diff for latest mechanism
rocky why src/button.css
rocky why --diff src/button.css      # show correlated git diff alongside rationale
rocky digest
rocky quiz
```

`what` is intent→mechanism lookup. `what --ai` can rank deterministic hits through configured loopback Ollama, then falls back to the same evidence when the model sleeps. `how` is a mechanism reminder. `why` quotes the agent's stated rationale for one file. `--diff` can be passed to `why` or `how` to correlate and display the relevant git diff for the touched file using a three-tier strategy (head commit SHA, $\pm 60$s time window, or uncommitted changes), with secret scrubbing and bounded 5s execution. `digest` reports the last-seven-day intent pattern. `quiz` is explicit opt-in retrieval practice. Rocky never rewrites, injects, or submits the user prompt.

Quiz uses newest eligible triples and comprehension notes, deterministic newest-first with stable id tie-breaks. Unchanged memory repeats same candidates; Rocky asks, reveals, and never grades. Useful deterministic lines sound like `you say "move button down". it is margin-top. I think. check, question` and `last time you say "move button down", it become margin-top. maybe you mean margin-top, question`. Rocky hears remembered evidence; he does not turn a guess into a fact.

The curious blind friend is Ollama-gated. After an intent append, Rocky may start one detached, non-blocking ambiguity check, and asks at most one question for that turn. It consults the intent plus remembered evidence only; it never reads project files. A question is curious, not a test. If Ollama is absent, fails, or is disabled, this advisory path disappears without blocking or changing the captured turn. Ignored questions are dropped and never repeated.

Export keeps ownership plain:

```text
rocky export --kind triple > triples.jsonl
rocky export --since 7d
```

Export writes filtered raw JSONL on stdout; its count/persona line goes to stderr. `~/.rocky/memory.jsonl` is user-owned, append-only data: readable, back-up-able, and deletable by you. Triples can contain the verbatim user intent, capped paths/excerpts, and the agent's stated rationale. Rocky does not keylog or read screens. Sanitized MCP projection remains the default; raw exposure is explicit.

## Rationale capture and the gate (v0.7.0)

v0.7 adds a fourth evidence kind, `rationale`, alongside the triples above: Rocky now also remembers *why*, not just *what* and *how*. Evidence arrives through four lanes, ranked by how much of the agent's own words survive:

| Lane | Source | Fidelity |
| --- | --- | --- |
| `log-thinking` | Claude Code or DSH session logs, when a thinking block exists | raw |
| `log-response` | Claude Code session logs' response text, when no thinking block exists | summary |
| `notify` | Any agent calling `rocky hook agent-event <adapter> --rationale "<text>"` | summary |
| `human` | You, via `rocky why --add "<text>"` | summary |

`rocky concepts` lists concepts a deterministic lexicon and matcher have heard across memory, with counts and any aliases you have taught it; `rocky concept <id>` shows newest-first evidence for one concept, and `rocky concept alias ["--retract"] "<phrase>" <id>` teaches or retracts one phrase. `rocky sessions [n]` lists work derived from memory at read time, grouped by directory and split on a 30-minute gap; `rocky sessions <index>` shows one session's evidence chronologically. `rocky repl [--ai]` keeps that lookup family — recall/what/why/how/concepts/sessions — in one loop instead of paying a fresh process start per call.

The Claude Code and DSH adapters read session logs Rocky did not write, at a bounded per-file offset, and never execute or trust their contents. The DSH adapter needs Node 22.15 or newer at runtime for built-in zstd support; on an older Node, Rocky feature-detects the gap and skips DSH logs rather than guessing. Codex and Gemini log adapters remain deferred: Codex's local session format has drifted to a SQLite hybrid, and Gemini persists no thoughts to read, so neither has a `log-thinking` lane yet — both still reach Rocky through the universal `notify` lane.

A PreToolUse hook, installed by default with `rocky setup --agent-hooks` and dispatched through `rocky hook gate-event claude-code`, nudges an editing agent to state a rationale before an `Edit`/`Write`/`MultiEdit` tool call: it denies once per session per file when no rationale evidence exists yet for that file, then fails open on every later call for that same file. Opt out at install with `--no-rationale-gate`, or at runtime with `ROCKY_RATIONALE_GATE=off`. Codex and other non-Claude-Code agents have no built-in deny hook — they reach the `notify` lane by default, and Rocky never invents enforcement it cannot perform. A harness that can block its own tool calls (a plugin with a pre-execution hook) may opt in by sending the same JSON payload shape to `rocky hook gate-event generic`; the deny instruction then points at `rocky hook agent-event generic`. An unlinked file has no rationale evidence yet; that is a first-class honest state Rocky discloses, not a gap it papers over. Resolution lines no longer claim Rocky remembers the fix method itself — only that a fix command later succeeded; the mechanism stays the agent's own unread history.

## Usage

Run anything failure-prone through Rocky:

```bash
rocky run "npm run build"
rocky run "docker compose up"
rocky run "python manage.py migrate"
```

What happens:

- **The command runs exactly as normal.** Output streams through untouched; the exit code is preserved. Rocky only speaks after your tool is done.

On native Windows, `rocky run` and `rocky watch` use `shell: true`, so `cmd.exe`'s practical command-line ceiling is around 8,191 characters (quoting and expansion can change the exact boundary). Rocky's audited boundary is a 7,111-character command that reaches the child successfully; a 9,111-character command may fail before normal child execution. A shell that starts and then reports an error is still a started child result, so its exit code 127 remains a real failure. Use a response file, configuration file, or script when a command is near this boundary. Rocky does not silently rewrite the command, change quoting, or switch its shell.
- **On failure**, Rocky fingerprints the error and files it. If he has heard this exact error before, he says so — and if a later run fixed it, he tells you what the fix was.
- **On success**, Rocky confirms a fix only for the same reliable command identity that failed in this directory within eight hours. A same-program-only match is kept separately as a possible association; it never resolves the failure. When a later run repeats an unresolved failure and no confirmed fix exists, Rocky shows the newest such association as one hedged candidate — never more than one, and never in place of a confirmed fix.

Ask his memory directly:

```bash
rocky recall "connection refused"
rocky recall "sharp"
rocky recall --ai "connection refused"   # optional configured loopback Ollama
rocky stats
rocky mcp                                # local read-only stdio server
```

Memory lives in `~/.rocky/memory.jsonl`. It is a text file you can read, grep, back up, and delete. Rocky records explicit terminal commands and errors plus the operational metadata needed to link them: working directory, time, exit code, fingerprints, origin, record IDs, and fix links. Rocky does not keylog and does not capture the screen.

The CLI contains no telemetry and runs no daemon. Its only external network egress is `rocky check`'s package-existence lookup against registry.npmjs.org — consent-gated, package names only, fail-open when offline. Everything else, including the local MCP server, reaches no external host at all. MCP uses local stdio, exposes read-only tools, and projects sanitized memory by default. A configured cloud host may forward selected projected content under that host's own policy, so review the host and choose raw exposure only when you intend to share those fields. Optional AI calls only a separately managed Ollama service over loopback (`127.0.0.1`).

## Read-only MCP knowledge tools

`rocky mcp` serves eight bounded, read-only tools in deterministic order: `recall`, `recent_failures`, `stats`, `recall_with_ai`, `search_knowledge`, `fetch_record`, `why_file`, and `teach_lookup`. Search first, then fetch: `search_knowledge` returns light metadata and bounded hits, including record id/timestamp, agent/source, covered files, and truncation status for triples; `fetch_record` retrieves one full record by the returned id. `why_file` returns remembered triples that touched one path, with an optional `diff?: boolean` parameter to include the correlated, secret-redacted git diff. `teach_lookup` returns a read-only teach card for a path and optional line or snippet: a remembered witness explanation when one matches, else an assembled evidence ladder from local syntax, comments, tests, and git history. `stats` retains legacy counters and adds confirmed fixes, possible fixes, triples, notes, and total remembered items. Limits stay bounded, and sanitized projection is the default; raw fields require an explicit opt-in.

For example, a host can call `search_knowledge` with `{ "query": "move button down" }`, pass a returned id to `fetch_record`, call `why_file` with `{ "path": "src/button.css", "diff": true }`, or call `teach_lookup` with `{ "path": "src/button.css", "line": 12 }`. Reasons are hearsay Rocky heard, not verified facts. Rationale is quoted and untrusted; MCP never presents it as fact or executes a remembered command.

## `rocky` and `rocky dash` (local GUI, implemented)

Both open the same local page in your browser. There is one link and one route; the two commands differ only in which segment starts active.

```bash
rocky           # opens on Main
rocky dash      # opens on Dash
rocky --no-open # print the URL, do not launch a browser
rocky --port=8123
```

Rocky starts an HTTP server on `127.0.0.1`, prints the URL on stderr, and tries to open your browser. If the browser cannot be launched, the printed URL is enough. The process stays in the foreground; Ctrl-C stops it. There is no daemon, no port file, and nothing left running afterwards.

The default port is `7777`. If that port is busy, Rocky takes any free port rather than failing.

In a pipe or a script there is no human to look at a browser, so bare `rocky` prints usage help and `rocky dash` prints the `rocky stats` summary instead.

### Segments

- **Main** — what Rocky holds: record counts by kind, the last 24 hours, most heard files, and the recent stream. The coverage line says how much of memory was actually read.
- **Dash** — the working surface. A file picker on the left, and a pane with three modes:
  - **Lines** — the file's own text. Select lines with the mouse and a `Why, question` button appears; the answer opens as a small panel at the selection.
  - **History** — every record Rocky holds for that file, newest first, each with its diff.
  - **Compare** — two moments side by side. Each column header opens a moment picker with a search box and a `strict · same lines` / `loose · whole file` toggle.

A witness card is coloured; an assembled card is grey. That is the whole colour system: warm means Rocky heard it, and nothing else on the page is allowed to borrow that colour.

### Security

- Binds `127.0.0.1` only. There is no flag to widen it.
- Every launch mints a fresh 128-bit token, carried in the URL fragment so it never reaches a server log or a `Referer` header. The page sends it back as `X-Rocky-Token` on every API call; a request without it gets `403`.
- Any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` gets `403`. This is what stops DNS rebinding.
- File paths are confined to the repository Rocky was launched in. A path that escapes gets `403`.
- No CORS headers at all, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- The page loads nothing from outside `127.0.0.1`: no CDN, no web font, no external script.

### Settings and BYOK (beta)

The `Settings` button in the header stores an optional model provider: a segmented `OpenAI | Anthropic` choice, an endpoint, an API key, and a model.

This is the one place Rocky's local surface reaches a host that is not your machine, and it is off until you fill it in. What it changes: a `Ask Model` control appears on a why card, and its answer is rendered grey and labelled `Model Guess (Beta)`. A guess never borrows the colour that means Rocky heard something.

- The key is stored in `~/.rocky/gui.json` at mode `0600`, never in the browser. The page is told only whether a key exists.
- Saving the endpoint or model without retyping the key leaves the stored key alone. An empty key is an explicit erase (`Forget Key`).
- Prompts are passed through the same secret redaction Rocky uses everywhere else before they leave the machine, capped in length, and limited to two in flight.
- The endpoint is editable, so any OpenAI-compatible host works: Ollama, LiteLLM, OpenRouter, and opencode's `https://opencode.ai/zen/go/v1/chat/completions` all answer the same shape.

Rocky's memory is evidence. A model answer is not, and the surface says so every time.

## `rocky teach` (v0.7.x, implemented)

Ask why one selection of code exists, from a witness or from assembled local evidence:

```bash
rocky teach src/core/memory.ts:307   # line 307 plus the three lines around it
rocky teach src/core/memory.ts       # whole file, witness lookup only
printf 'const rows = await loadRows();' | rocky teach --stdin src/core/memory.ts
rocky teach src/core/memory.ts:307 --ladder   # also print every hop, expanded
```

`rocky teach <file>:<line>` reads the file once, slices the selection (the line plus three lines on each side, clamped to the file), and asks memory for an `explain` record whose written hunk matches the selection — exact content hash first, token similarity second. A match renders the witness card: the writing agent's own `code` paragraph (why this code shape) and `business` paragraph (what concern it serves), quoted as hearsay with source and age. When the witness `code` paragraph shares no token with the selection's hop-1 construct finding, the card appends one labeled `form` rung (catalog or ast) so witness text and assembly never blend. On a miss, Rocky assembles a deterministic why-ladder from the file itself — construct catalog, enclosing function, callee definition, nearest comment, tests and first `git log -L` commit — and renders the summary card with one compact evidence line naming the sources used; `--ladder` also prints the full hop-by-hop view. `rocky teach <file>` is witness-only (newest explain for the file, no ladder), and `rocky teach --stdin <file>` matches the piped snippet (bounded read, same 2 MB cap as the gate-event stdin reader) against the file. No witness and no ladder rungs is a first-class honest state: Rocky has not heard why yet. Ladder output is rendered, never written to memory, and assembled answers never masquerade as witness testimony. Every flow outcome exits 0.

## `rocky watch` (v0.3, implemented)

For the commands you walk away from — a long build, a migration, a big download:

```bash
rocky watch "npm run build"
rocky watch "docker compose up" --quiet
```

`rocky watch` runs `cmd` exactly like `rocky run` does — same streaming, same fingerprinting, same fix-linking, same cross-directory fix admission — plus:

- **An idle line** every 10 minutes of stderr silence, so a quiet terminal still tells you Rocky's still there.
- **A notification** when it finishes: a desktop notification (`notify-send` on Linux, `osascript` on macOS) or a terminal bell where neither exists. Best-effort only, never a source of truth, and never blocks the wrapped command's exit code.
- **A saved stderr tail** on failure, under `~/.rocky/watch/`, alongside the same kind of memory record `rocky run` writes (`origin: "watch"`).
- **`--quiet`**, which keeps the recording but drops every persona line, every idle line, and the notification — stderr gets plain facts only: duration, exit code, and the log path.
- **Passive dictionary labels**, queued locally after annotation. The next shell prompt shows at most one label, and non-quiet `rocky watch` also shows it while the command runs. Watch reads labels without dequeuing them and shows each line at most once per watch session. Labels never enter agent context. `watch --quiet` stays plain-facts mode and does not poll persona labels. The deterministic fallback is typically:

  ```text
  you say "move button down". it is margin-top. I think. check, question
  ```

Ctrl-C (or an external `SIGTERM`) passes its exit code straight through — no memory record, no log, no notification. Notifications can be turned off in `~/.rocky/config.json` with `"watch": { "notify": false }`; a missing, invalid, or unreadable config always defaults to notifications on and never blocks the run.

## `rocky check` (v0.4, implemented)

The hull check, for the moment right before code leaves your machine:

```bash
rocky check                  # check what you are about to push
rocky check --install-hook   # run it automatically as a git pre-push hook
rocky check --offline        # skip the registry lookup for this run
rocky check --quiet          # plain facts, no persona, no question
```

Rocky looks only at the commits you are about to push, and runs three checks. The secret scan and the risk question read the **added** lines of that range; the package check reads whole committed files — each changed `package.json` at both ends of the range, plus your `.npmrc` and the committed `package-lock.json` — because deciding whether a dependency is new, and whether it is even checkable, is not something a diff line can answer.

- **Secrets, offline.** AWS keys, private-key headers, GitHub/Slack/OpenAI/Anthropic/npm tokens, and literal `password=`/`secret=` assignments. A hit names `file:line` and blocks the push.
- **Hallucinated packages.** Dependencies newly added to a `package.json` are checked for existence against registry.npmjs.org. A package the registry has never heard of blocks the push — `this package not exist. AI dream it, question`. Dependencies using `workspace:`/`file:`/`link:`/`portal:`, scopes your `.npmrc` points elsewhere, and names already resolved in the committed lockfile are skipped, because those are where false accusations come from.
- **One comprehension question.** Rocky scores the added lines for risk (eval/exec, destructive fs, network, auth handling), picks the riskiest one, and asks what it does. He asks because he is curious, not to test you. **It never blocks a push** — ignore it, answer `busy`, run without a terminal, or set `ROCKY_NO_QUIZ=1`, and the push proceeds. A real answer is kept in your memory file as your own note.

The registry lookup is consent-gated: the first time it would run, Rocky states exactly what leaves the machine — package names, to registry.npmjs.org, no telemetry — and asks once. Answer no and he never asks again. With no answer stored and no terminal to ask on (CI, a non-interactive hook), the lookup is skipped silently rather than hanging.

Only a secret or a missing package ever holds a push. Registry unreachable, a git command that fails, a Rocky bug — during a push all of it fails open with one plain line, because a broken Rocky must never be the reason you cannot ship. `git push --no-verify` remains git's own escape hatch.

Run by hand there is no push to protect, so the exit code says plainly what happened:

| Mode and result | Exit |
|---|---:|
| Manual, Git scope established and no finding (including a valid empty diff) | 0 |
| Manual, finding | 1 |
| Manual, no Git repository or incomplete/uninspected workspace | 2 |
| Pre-push, finding | 3 |
| Pre-push, clean or incomplete/uninspected (fail-open) | 0 |

A valid Git empty diff is checked-clean and exits 0. With no Git repository, a manual run exits 2; it never reports a clean 0 when no workspace was inspected. In pre-push mode an incomplete or uninspected workspace remains fail-open at exit 0, but stderr contains the stable `INCOMPLETE: no clean result` diagnostic. Only exit 3 holds a push; the managed hook maps that one finding code to a blocked push and lets every other result through.

## The ears (v0.2, implemented)

On Bash, including Bash under WSL, skip the wrapper entirely and let Rocky listen to the shell session:

```bash
rocky hook install    # adds one managed block to ~/.bashrc
```

The hook installer is separate from `rocky setup`; MCP setup never edits `.bashrc`. Other shells and platforms can still write full failure memory through `rocky run`.

Every `.bashrc` write goes through a recoverable, conditional transaction. Unrelated bytes and the file's permissions are preserved exactly. Rocky refuses to touch a symlinked, non-regular, multiply-linked, or unreadable file. A corrupt, orphaned, reversed, or duplicated Rocky marker block is left untouched. `rocky hook status` reports it and exits nonzero instead of claiming installed; repair stays manual.

When `.bashrc` already exists, a write transaction keeps a recovery copy of the previous bytes in a sibling directory, directly in `$HOME` and not under `~/.rocky/`. `rocky hook install` and `uninstall` print the exact path when they leave one; it contains the file's full contents, secrets included. `rocky hook status` never edits the hook block itself, but settling an interrupted transaction can create or restore `.bashrc` from a retained copy. When that happens, `status` says so and prints the path. Rocky never tells you to remove a retained copy. Completed transactions keep only the most recent completed copy; pending or ambiguous recovery directories are retained and can accumulate. Removing a copy after you have verified it is redundant is your call.

Claude Desktop uses the same conditional-transaction mechanism and also creates a full timestamped sibling backup before changing an existing valid config. Those timestamped backups are not automatically pruned. Claude Code MCP automation is inactive in this release, so it normally makes no config write or backup.

From the next shell on: every failing command is remembered (no stderr — the
hook hears command and exit code only; `rocky run` remains the deep-memory
path). Deep-memory suggestion stays quiet when shell reports command not found —
misspelling, not error worth wrapping. When a command succeeds
where the same command recently failed, the fix
is linked automatically; weaker same-program evidence stays only a possible
association. And when a command looks catastrophic — `rm -rf` at a
strange target, a force push, `curl | bash` — Rocky holds it:

```
[Rocky] this rm eat everything under target. bad bad.
[Rocky] you sure, question (y/n)
```

Answer anything but `y` and the command never runs. Rules live in
`~/.rocky/guard.rules` — plain text, edit freely, Rocky never overwrites an
edited file. `ROCKY_OFF=1` makes him deaf for a session;
`rocky hook uninstall` removes the block and keeps the memory.

## How the memory works

1. **Fingerprinting** (`src/core/fingerprint.ts`) — stderr is noisy: paths, line numbers, timestamps, and addresses change between runs of the same bug. Rocky extracts the lines that carry meaning, masks the volatile parts (`/home/you/app/src/x.ts:41:7` becomes `<path>:#:#`), and hashes the result. Same bug, same fingerprint, every time.
2. **The failure log** (`src/core/memory.ts`) — append-only JSONL. Failures store the fingerprint, the command, the directory, and a short excerpt for display. Fixes store which failures they resolved.
3. **Fix linking** — within one per-memory transaction, Rocky reloads current state and confirms a success only for unresolved failures with the same reliable command identity (same directory, within 8h). Same-program-only candidates are stored as possible associations and never resolve failures or clear pending state. Concurrent writers share the transaction lock, so one unresolved-to-resolved transition creates one fix event. `run`, `watch`, and `recall` read those associations back through `possibleFixesForFailure` and surface the newest one as a hedged candidate whenever no confirmed fix exists for the repeated failure (v0.5.2).
4. **Recall** — token-overlap search across commands and error signatures, deduplicated per distinct error, fix shown when known.
5. **Long-running envelope** — the reader has a 32 MiB file cap, a 1 MiB line cap, and a 50,000-record reference envelope only on the exact Linux Node 22 runtime. Windows and other runtimes use an explicit 10,000-record supported cap until their own scorecard meets the 150 MiB post-GC RSS budget; larger files stay bounded and report degraded coverage. Above any cap (including a 250,000-record stress fixture) it stops at the boundary and every MCP/diagnostic answer carries `memoryCoverage` (`version`, `scanned`, `skipped`, `truncated`, `complete`); skipped corrupt or oversized lines are counted, never silently treated as complete. A single immutable snapshot is reused only after a full bounded content witness confirms every byte that can affect the bounded answer plus file identity, size, and metadata.

**Fix-link `basis` values.** Every fix or association link records how it was matched, ranked strongest to weakest:

| `basis` | Meaning | Evidence |
|---|---|---|
| `identity` | Same reliable command identity, same directory, within the link window. | confirmed |
| `signature` | Same normalized command shape (`commandSignature`), a stronger textual match than `identity` requires. Reserved in the type system; no shipped code path writes it yet. | confirmed |
| `program` | Same base program, different command identity. | possible |
| `sequence` | Different base program entirely. Readable starting in 0.5.2; no version writes it yet. | possible |

A reader that meets a `basis` value outside this table treats it as weaker than every value listed above: readable, never promoted to `confirmed`, and the record is never dropped for carrying it. That rule, and the meaning of each value above, hold across releases — a future `basis` value only ever adds a new row here, it never redefines one that already shipped.

The deterministic memory loop remains useful with zero AI setup and zero API keys. Rocky can optionally ask a locally running Ollama model to rank or interpret deterministic recall candidates; the model cannot create or change the underlying stored evidence, and invalid output falls back to deterministic recall.

## Optional local AI

Rocky never installs or pulls a model. Install and manage Ollama separately, pull a model yourself, then opt in:

```bash
rocky model status
rocky model use qwen3:0.6b-q4_K_M
rocky recall --ai "sharp build failure"
rocky model off
```

When no model is installed, Rocky suggests a tiny `qwen3:0.6b-q4_K_M` model at about 523 MB or a balanced `qwen3.5:2b-q4_K_M` model at about 1.9 GB. Those are optional quantized download estimates, not Rocky tarball contents or peak-RAM guarantees; runtime, context, KV cache, and platform overhead can use more memory.

Each Rocky generation request sends `keep_alive: 0`, asking Ollama to unload that model after the request. Rocky cannot stop a shared Ollama daemon or unload a model globally on behalf of other clients.

The optional local AI boundary is fixed plain HTTP to `127.0.0.1` with an explicit port. Each generation request is capped at 64 KiB, each response at 256 KiB, and each request at 20 seconds; `rocky model use` shares a 30-second deadline across installed-model discovery and the capability probe. Invalid, unavailable, cancelled, or over-limit model output falls back to deterministic evidence, and configuration is saved only after both discovery and probe succeed.

## Project structure

```
rocky/
├── src/
│   ├── index.ts            # CLI entry and command dispatcher
│   ├── commands/
│   │   ├── run.ts          # command wrapper: stream, fingerprint, remember, link fixes
│   │   ├── recall.ts       # deterministic search + optional local-AI interpretation
│   │   ├── hook.ts         # Bash/WSL/PowerShell hook and guard lifecycle
│   │   ├── mcp.ts          # local read-only MCP stdio server
│   │   ├── model.ts        # opt-in Ollama configuration
│   │   ├── setup.ts        # detected-host and optional voice-skill setup
│   │   ├── dictionary.ts   # what/how/why/digest/quiz/export surfaces
│   │   ├── teach.ts        # witness card and deterministic why-ladder
│   │   ├── gui.ts          # local browser dashboard launcher
│   │   └── stats.ts        # memory summary
│   ├── core/
│   │   ├── fingerprint.ts  # stderr -> stable error signature + token bags
│   │   ├── dictionary.ts   # intent↔mechanism lookup and digest/quiz queries
│   │   ├── teach.ts        # witness lookup and explain records
│   │   ├── teach-ladder.ts # deterministic evidence walker and stop rules
│   │   ├── teach-render.ts # witness and ladder card rendering
│   │   ├── git-diff.ts     # bounded git diff correlation and secret scrubbing
│   │   ├── memory.ts       # append-only JSONL writers
│   │   ├── memory-read.ts  # bounded parsing and backward-compatible loading
│   │   └── memory-query.ts # fingerprint lookup and fuzzy search
│   ├── gui/                # loopback HTTP server, BYOK settings, model catalog
│   ├── mcp/                # bounded read-only tools and privacy projection
│   ├── setup/              # host adapters, consent, health, voice skill
│   ├── ai/                 # loopback-only Ollama adapter and grounded schema
│   ├── agent/              # capture, annotation, explain extract, and gate
│   ├── shell/              # Bash hook assets
│   └── ui/
│       └── rocky.ts        # his face, his voice, relative time
├── assets/
│   ├── gui/                # local web dashboard HTML, CSS, JS
│   ├── teach-agent.md      # Indonesian teach model prompt template
│   └── teach-agent.en.md   # English teach model prompt template
├── skills/rocky-voice/     # optional managed voice skill asset
├── docs/
│   └── scientific-grounding.md
├── package.json            # zero runtime deps
└── tsconfig.json
```

## Rocky's voice

Rocky speaks the way he does in the book, and the rules are enforced in code, not vibes:

- Questions end with `, question` — never a question mark.
- Emphasis is repetition: `good good good`, `bad bad`.
- Short sentences, present tense, no articles.
- He is blind. He never "sees" anything — he hears, he remembers, he checks.

When things are serious, Rocky is serious. Diagnoses and fixes are printed plainly; the personality lives around the information, never inside it. `rocky watch --quiet` is plain-facts mode for people debugging production at 2 a.m.

Rocky asks because he is curious, not because he is testing you; you are always the one who knows, never the one being graded. Ignore him and he goes quiet — an ignored question is never repeated — and answering `busy` makes him wait without complaint (he once waited 46 years). Ambiguity questions are optional, Ollama-gated, and never block the captured turn.

The fence never moves: Rocky hears your terminal and the explicit Plan 01 agent hooks. That's it. No keylogging, no screen reading, no capture of screen content of any kind. "Rocky can't see your screen" is a literal description of the architecture, not just lore. The local GUI serves a page to your own browser over loopback and reads nothing the page does not ask for; no global input is hooked.

The one hole in the no-egress rule is the optional BYOK proxy described under `rocky` and `rocky dash`. It stays shut until you enter a key, it sends only the prompt you triggered, and that prompt is redacted before it leaves. Memory, hooks, recall, and MCP still reach no external host.

## Roadmap

Each phase is one facet of who Rocky is:

- **v0.2.1 — distribution bridge (historical)**: the v0.1 memory and implemented v0.2 Bash/WSL ears, plus scoped npm distribution, read-only MCP, consent-based host setup, an optional managed voice skill, and optional loopback Ollama interpretation for recall.
- **v0.3 — his patience (implemented)**: `rocky watch` — hand him a long build, migration, or download; he waits (he once waited 46 years), notifies you, and holds the logs if it dies.
- **v0.4 — his diligence (implemented)**: pre-push hull check — `rocky check` verifies that AI-added packages actually exist on the registry (hallucinated-package defense), scans added lines for secrets, and asks one comprehension question about the riskiest line in the diff. Its registry lookup is this project's only external egress; network errors fail open and never hold a push.
- **v0.5 — his curiosity (implemented)**: Plan 01 Nervous System agent hooks and Plan 02 dictionary/teaching surfaces ship in v0.5.0. They preserve prompt/path/excerpt/stated-rationale evidence in local memory, use deterministic fallback when Ollama is unavailable, keep rationale explicitly quoted and untrusted, and add `what`, `how`, `why`, `digest`, `quiz`, `export`, passive labels, ambiguity advice, and three bounded MCP knowledge tools. The earlier `rocky explain` concept is superseded, not an active command.
- **v0.6 — his accountability (implemented)**: `rocky brief` (loopback-AI-polished summary of what changed since your last check-in: commits, remembered failures/fixes, and touched invariant guards), `rocky journal`, `rocky invariants`, extended `rocky stats`, and the [schema envelope](schema.md) documentation. `brief` shipped in v0.6, no longer deferred; BYOK annotation, `attest`, and the memory circuit breaker remain deferred.
- **v0.7 — his memory of why (implemented)**: a fourth evidence kind, `rationale`, captured across four lanes (`log-thinking`, `log-response`, `notify`, `human`); a deterministic concept lexicon (`rocky concepts`/`concept`/`concept alias`); derived `rocky sessions` and `rocky repl`; PreToolUse rationale gate (`rocky hook gate-event`); and native git diff correlation. Codex and Gemini agent-log adapters remain deferred — see the [rationale capture section](#rationale-capture-and-the-gate-v070) above.
- **v0.8 — his comprehension guardian (current line)**: local browser GUI (`rocky dash`) replacing the terminal dashboard, teach mode (`rocky teach` / `teach_lookup` / `explain` records), and selection-anchored why-cards.
- **later — his care**: ambient pet mode and the desktop pet window (deferred). He notices you've been at it for four hours, and he has opinions about your sleep.

The package version is v0.8.0; the Nervous System, rationale-capture, teach mode, and local GUI sections above describe the surfaces it ships.

## Contributing

See the [contributing guide](../CONTRIBUTING.md) for setup, tests, load-bearing code, and pull-request expectations.
