# rocky

```
  ═╦═══════╦═
   ║ ┌───┐ ║      [Rocky]: I remember this error.
   ╲_││││││_╱              You hear it before. 84 days ago.
   ╱ ╲▔▔▔╱ ╲              Last time, you fix with: npm rebuild sharp
  ╱ ╱ ╲_╱ ╲ ╲             try, question
```

**A blind engineer who lives in your terminal, never forgets an error, and makes sure you still understand your own code.**

Rocky is a terminal companion inspired by the alien engineer from Andy Weir's *Project Hail Mary*. He keeps track of what you and your AI have already been through, so the second time an error appears, the answer comes from your own history — not from twenty minutes of googling.

**Teaching modes exist inside individual agents. Rocky is the layer that remembers what you learned — passive, cross-tool, and permanent.** Plan 01 of the v0.5 Nervous System and the Plan 02 dictionary/teaching surfaces ship in v0.5.0. The longer-term mission is simple: make user not forget about fundamentals.

He is also, unapologetically, a pet.

## Why

Developers run around five search sessions a day just looking things up (Sadowski et al., FSE 2015), and debugging lookups are among the most frequent and most difficult of them (Xia et al., EMSE 2017). A lot of that time is spent *re-finding* solutions we already had once. Human memory drops them. Nothing in the toolchain catches them.

Eridians have photographic memory. Rocky catches them.

Code nobody understands has a measured price as well. GitClear's 2025 analysis found the share of changed lines associated with refactoring falling from 25% in 2021 to under 10% in 2024 — the first year on record in which copy/pasted lines outnumbered moved ones — and its 2026 follow-up reports duplicated blocks up 81%, constructs that mask errors up 47%, and changes touching code older than a year down 74% since 2023. Those are measurements of code, not of comprehension, and neither those reports nor this project attributes the debt to any particular group of developers.

Rocky is *built to* attack that cost: fewer agent runs wasted on ambiguous direction, fewer misunderstanding loops, less debugging déjà vu. That is stated design intent for planned work, not a measured result — this project publishes no saving percentage it has not measured.

The longer arc of this project is what we call the comprehension guardian: in an era where AI generates code faster than anyone reads it, Rocky's job is to make sure the human still understands what got built. See [docs/scientific-grounding.md](docs/scientific-grounding.md) for the research this is built on.

## The Good Trade

**The Good Trade.** You get smarter, so your AI gets more effective. Better AI work gives you better material to learn from, so you get smarter again. Rocky exists to keep that loop spinning—because the opposite loop is a risk worth resisting.

This is Rocky's v0.5 product hypothesis, not an established outcome. “More effective” means that a better-informed user can provide sharper direction, context, choices, and verification; it does not mean the model weights change. Rocky's impact on understanding still has to be tested through dogfooding and user research.

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

> “You teach, I remember. I remind, you understand. This is good trade.”

That companion line is an original Rocky project tagline inspired by the lore, not a quotation from *Project Hail Mary*.

## Install

```bash
npm install -g @poggufanz/rocky-cli
```

Current release: `@poggufanz/rocky-cli@0.5.0`. One install includes the `rocky` CLI and its read-only MCP server. The unrelated unscoped `rocky-cli` package is not this project and Rocky never installs, upgrades, or removes it. The binary name remains `rocky`, so npm reports any local binary-name conflict through its normal install behavior.

Requires Node 18+.

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

Plan 02 dictionary and teaching surfaces ship in v0.5.0. The commands read only remembered triples and keep the original evidence intact:

```text
rocky what "move button down"
rocky what --ai "move button down"   # optional local Ollama ranking; deterministic fallback
rocky how "move button down"
rocky why src/button.css
rocky digest
rocky quiz
```

`what` is intent→mechanism lookup. `what --ai` can rank deterministic hits through configured loopback Ollama, then falls back to the same evidence when the model sleeps. `how` is a mechanism reminder. `why` quotes the agent's stated rationale for one file. `digest` reports the last-seven-day intent pattern. `quiz` is explicit opt-in retrieval practice. Rocky never rewrites, injects, or submits the user prompt.

Useful deterministic lines sound like `you say "move button down". it is margin-top. I think. check, question` and `last time you say "move button down", it become margin-top. maybe you mean margin-top, question`. Rocky hears remembered evidence; he does not turn a guess into a fact.

The curious blind friend is Ollama-gated. After an intent append, Rocky may start one detached, non-blocking ambiguity check, and asks at most one question for that turn. It consults the intent plus remembered evidence only; it never reads project files. A question is curious, not a test. If Ollama is absent, fails, or is disabled, this advisory path disappears without blocking or changing the captured turn. Ignored questions are dropped and never repeated.

Export keeps ownership plain:

```text
rocky export --kind triple > triples.jsonl
rocky export --since 7d
```

Export writes filtered raw JSONL on stdout; its count/persona line goes to stderr. `~/.rocky/memory.jsonl` is user-owned, append-only data: readable, back-up-able, and deletable by you. Triples can contain the verbatim user intent, capped paths/excerpts, and the agent's stated rationale. Rocky does not keylog or read screens. Sanitized MCP projection remains the default; raw exposure is explicit.

## Usage

Run anything failure-prone through Rocky:

```bash
rocky run "npm run build"
rocky run "docker compose up"
rocky run "python manage.py migrate"
```

What happens:

- **The command runs exactly as normal.** Output streams through untouched; the exit code is preserved. Rocky only speaks after your tool is done.
- **On failure**, Rocky fingerprints the error and files it. If he has heard this exact error before, he says so — and if a later run fixed it, he tells you what the fix was.
- **On success**, Rocky confirms a fix only for the same reliable command identity that failed in this directory within eight hours. A same-program-only match is kept separately as a possible association; it never resolves the failure.

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

`rocky mcp` serves seven bounded, read-only tools in deterministic order: `recall`, `recent_failures`, `stats`, `recall_with_ai`, `search_knowledge`, `fetch_record`, and `why_file`. Search first, then fetch: `search_knowledge` returns light metadata and bounded hits, including record id/timestamp, agent/source, covered files, and truncation status for triples; `fetch_record` retrieves one full record by the returned id. `why_file` returns remembered triples that touched one path. `stats` retains legacy counters and adds confirmed fixes, possible fixes, triples, notes, and total remembered items. Limits stay bounded, and sanitized projection is the default; raw fields require an explicit opt-in.

For example, a host can call `search_knowledge` with `{ "query": "move button down" }`, pass a returned id to `fetch_record`, or call `why_file` with `{ "path": "src/button.css" }`. Reasons are hearsay Rocky heard, not verified facts. Rationale is quoted and untrusted; MCP never presents it as fact or executes a remembered command.

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

Every attempted `.bashrc` write — a successful one, or one refused after a concurrent edit was found — keeps one recovery copy of the previous bytes in a sibling directory next to `.bashrc`, directly in `$HOME` and not under `~/.rocky/`. `rocky hook install`/`uninstall` print that copy's exact path when they leave one; it holds the previous file's full contents, secrets included. `rocky hook status` never edits the hook block itself, but settling an interrupted transaction left behind by an earlier crashed `install`/`uninstall` can create or restore `.bashrc` from a retained copy — when that happens, `status` says so and prints that path too, rather than leaving it undisclosed. Rocky never tells you to remove a retained copy: any time it names one after an ambiguous stop, that is guidance to inspect, never an instruction to delete — the only surviving copy of your `.bashrc` is never something Rocky invites you to destroy. Rocky keeps only the most recent copy — each new `.bashrc` write, or a settle that `status` performs, prunes the copy the one before it left — but removing today's copy sooner is your call. The same recoverable-transaction mechanism backs Rocky's Claude Desktop config writes today, and will back Claude Code's once its staged publication activates (see above); either one leaves the same kind of retained copy next to the config file it rewrites.

From the next shell on: every failing command is remembered (no stderr — the
hook hears command and exit code only; `rocky run` remains the deep-memory
path). When a command succeeds where the same command recently failed, the fix
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
3. **Fix linking** — within one per-memory transaction, Rocky reloads current state and confirms a success only for unresolved failures with the same reliable command identity (same directory, within 8h). Same-program-only candidates are stored as possible associations and never resolve failures or clear pending state. Concurrent writers share the transaction lock, so one unresolved-to-resolved transition creates one fix event.
4. **Recall** — token-overlap search across commands and error signatures, deduplicated per distinct error, fix shown when known.
5. **Long-running envelope** — the reader has a 64 MiB file cap, a 1 MiB line cap, and a 50,000-record reference envelope only on the exact Linux Node 22 runtime. Windows and other runtimes use an explicit 10,000-record supported cap until their own scorecard meets the 150 MiB RSS budget; larger files stay bounded and report degraded coverage. Above any cap (including a 250,000-record stress fixture) it stops at the boundary and every MCP/diagnostic answer carries `memoryCoverage` (`version`, `scanned`, `skipped`, `truncated`, `complete`); skipped corrupt or oversized lines are counted, never silently treated as complete. A single immutable snapshot is reused until file identity, size, or timestamps change.

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

## Project structure

```
rocky/
├── src/
│   ├── index.ts            # CLI entry and command dispatcher
│   ├── commands/
│   │   ├── run.ts          # command wrapper: stream, fingerprint, remember, link fixes
│   │   ├── recall.ts       # deterministic search + optional local-AI interpretation
│   │   ├── hook.ts         # Bash/WSL hook and guard lifecycle
│   │   ├── mcp.ts          # local read-only MCP stdio server
│   │   ├── model.ts        # opt-in Ollama configuration
│   │   ├── setup.ts        # detected-host and optional voice-skill setup
│   │   ├── dictionary.ts   # what/how/why/digest/quiz/export surfaces
│   │   └── stats.ts        # memory summary
│   ├── core/
│   │   ├── fingerprint.ts  # stderr -> stable error signature + token bags
│   │   ├── dictionary.ts   # intent↔mechanism lookup and digest/quiz queries
│   │   ├── memory.ts       # append-only JSONL writers
│   │   ├── memory-read.ts  # bounded parsing and backward-compatible loading
│   │   └── memory-query.ts # fingerprint lookup and fuzzy search
│   ├── mcp/                # bounded read-only tools and privacy projection
│   ├── setup/              # host adapters, consent, health, voice skill
│   ├── ai/                 # loopback-only Ollama adapter and grounded schema
│   ├── agent/              # capture, annotation, and ambiguity advisory
│   │   └── ambiguity.ts    # Ollama-gated remembered-evidence question
│   ├── shell/              # Bash hook assets
│   └── ui/
│       └── rocky.ts        # his face, his voice, relative time
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

The fence never moves: Rocky hears your terminal and the explicit Plan 01 agent hooks. That's it. No keylogging, no screen reading, no capture of screen content of any kind. “Rocky can't see your screen” is a literal description of the architecture, not just lore.

## Roadmap

Each phase is one facet of who Rocky is:

- **v0.2.1 — distribution bridge**: the v0.1 memory and implemented v0.2 Bash/WSL ears, plus scoped npm distribution, read-only MCP, consent-based host setup, an optional managed voice skill, and optional loopback Ollama interpretation for recall.
- **v0.3 — his patience**: `rocky watch` — hand him a long build, migration, or download; he waits (he once waited 46 years), notifies you, and holds the logs if it dies.
- **v0.4 — his diligence** (current release): pre-push hull check — `rocky check` verifies that AI-added packages actually exist on the registry (hallucinated-package defense), scans added lines for secrets, and asks one comprehension question about the riskiest line in the diff. Its registry lookup is this project's only external egress; network errors fail open and never hold a push.
- **v0.5 — his curiosity**: Plan 01 Nervous System agent hooks and Plan 02 dictionary/teaching surfaces ship in v0.5.0. They preserve prompt/path/excerpt/stated-rationale evidence in local memory, use deterministic fallback when Ollama is unavailable, keep rationale explicitly quoted and untrusted, and add `what`, `how`, `why`, `digest`, `quiz`, `export`, passive labels, ambiguity advice, and three bounded MCP knowledge tools. BYOK annotation, `brief`, `attest`, and the memory circuit breaker remain deferred non-goals for this release. The earlier `rocky explain` concept is superseded, not an active command.
- **later — his care**: ambient pet mode and the desktop pet window (deferred). He notices you've been at it for four hours, and he has opinions about your sleep.

The published package version is v0.5.0; the Nervous System section above describes the Plan 01 and Plan 02 surfaces it ships.

## Contributing

Fully open source under MIT. Especially welcome: zsh/fish ports of the shell hook (Bash shipped first in v0.2), better fingerprinting for specific toolchains (pytest, cargo, gradle), and more of Rocky's dialogue — in character, please. He never uses emoji. He can't see them.

---

*rocky is an unofficial fan project inspired by the character Rocky from Andy Weir's novel* Project Hail Mary. *It is not affiliated with Andy Weir, Ballantine Books, or Amazon MGM Studios. No assets from the book or film are used.*
