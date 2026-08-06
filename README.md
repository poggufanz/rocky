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

**Teaching modes exist inside individual agents. Rocky is the layer that remembers what you learned — passive, cross-tool, and permanent.** That learning layer is planned v0.5 work; current v0.2.1 remembers failure/fix evidence across supported hosts. The longer-term mission is simple: make user not forget about fundamentals.

He is also, unapologetically, a pet.

## Why

Developers run around five search sessions a day just looking things up (Sadowski et al., FSE 2015), and debugging lookups are among the most frequent and most difficult of them (Xia et al., EMSE 2017). A lot of that time is spent *re-finding* solutions we already had once. Human memory drops them. Nothing in the toolchain catches them.

Eridians have photographic memory. Rocky catches them.

The longer arc of this project is what we call the comprehension guardian: in an era where AI generates code faster than anyone reads it, Rocky's job is to make sure the human still understands what got built. See [docs/scientific-grounding.md](docs/scientific-grounding.md) for the research this is built on.

## The Good Trade

**The Good Trade.** You get smarter, so your AI gets more effective. Better AI work gives you better material to learn from, so you get smarter again. Rocky exists to keep that loop spinning—because the opposite loop is a risk worth resisting.

This is Rocky's v0.5 product hypothesis, not an established outcome. “More effective” means that a better-informed user can provide sharper direction, context, choices, and verification; it does not mean the model weights change. Rocky's impact on understanding still has to be tested through dogfooding and user research.

> “You teach, I remember. I remind, you understand. This is good trade.”

That companion line is an original Rocky project tagline inspired by the lore, not a quotation from *Project Hail Mary*.

## Install

```bash
npm install -g @poggufanz/rocky-cli
```

Current beta: `@poggufanz/rocky-cli@0.2.1-beta.0`. One install includes the `rocky` CLI and its read-only MCP server. The unrelated unscoped `rocky-cli` package is not this project and Rocky never installs, upgrades, or removes it. The binary name remains `rocky`, so npm reports any local binary-name conflict through its normal install behavior.

Requires Node 18+.

Register Rocky with detected MCP hosts after installation:

```bash
rocky setup
rocky setup --voice-skill   # also install the managed Rocky voice skill
```

`rocky setup` configures detected hosts with sanitized MCP exposure after consent. By itself it never edits `.bashrc`, installs a voice skill, installs or pulls an Ollama model, or enables local AI. Voice-skill work requires the explicit `--voice-skill` flag. Shell integration is a separate `rocky hook install` step.

Codex registration is capability-gated, not a name-only mutation: Rocky proves the existing Rocky entry originates from the base user config layer through Codex's official app-server config protocol, then writes with a version-checked compare-and-swap. Whenever provenance, capability, or version cannot be proven, Rocky falls back to manual instructions.

Claude Code registration goes through a private stage. Rocky clones the effective `.claude.json` into a private copy, proves the surrounding policy is unchanged, runs the official Claude CLI only against that copy, audits that only the Rocky entry changed, then publishes the audited bytes through a recoverable transaction.

That staged path does not activate in this beta. Rocky ships no complete Claude Code policy manifest, so any `rocky setup` run that still has to write reports `claude-code: failed` with `Claude Code policy-equivalent automation is unavailable; use manual registration` and exits 1. Rocky prints the exact CLI argv to paste; run it yourself. Once the entry exists, later runs report `claude-code: already-configured`.

`--voice-skill` only targets detected Codex and Claude Code hosts. Claude Desktop never receives the voice skill, and its own MCP result stays independent. When zero hosts are eligible, Rocky prints `voice-skill: unavailable` and exits 1 instead of inventing a result.

## Usage (v0.2.1 — distribution bridge)

Run anything failure-prone through Rocky:

```bash
rocky run "npm run build"
rocky run "docker compose up"
rocky run "python manage.py migrate"
```

What happens:

- **The command runs exactly as normal.** Output streams through untouched; the exit code is preserved. Rocky only speaks after your tool is done.
- **On failure**, Rocky fingerprints the error and files it. If he has heard this exact error before, he says so — and if a later run fixed it, he tells you what the fix was.
- **On success**, if the same program failed recently in this directory, Rocky records this run as the fix. That link is the whole product.

Ask his memory directly:

```bash
rocky recall "connection refused"
rocky recall "sharp"
rocky recall --ai "connection refused"   # optional configured loopback Ollama
rocky stats
rocky mcp                                # local read-only stdio server
```

Memory lives in `~/.rocky/memory.jsonl`. It is a text file you can read, grep, back up, and delete. Rocky records explicit terminal commands and errors plus the operational metadata needed to link them: working directory, time, exit code, fingerprints, origin, record IDs, and fix links. Rocky does not keylog and does not capture the screen.

The core CLI and local MCP server contain no telemetry, make no external network requests, and run no daemon. MCP uses local stdio, exposes read-only tools, and projects sanitized memory by default. A configured cloud host may forward selected projected content under that host's own policy, so review the host and choose raw exposure only when you intend to share those fields. Optional AI calls only a separately managed Ollama service over loopback (`127.0.0.1`).

## The ears (v0.2, implemented)

On Bash, including Bash under WSL, skip the wrapper entirely and let Rocky listen to the shell session:

```bash
rocky hook install    # adds one managed block to ~/.bashrc
```

The hook installer is separate from `rocky setup`; MCP setup never edits `.bashrc`. Other shells and platforms can still write full failure memory through `rocky run`.

Every `.bashrc` write goes through a recoverable, conditional transaction. Unrelated bytes and the file's permissions are preserved exactly. Rocky refuses to touch a symlinked, non-regular, multiply-linked, or unreadable file. A corrupt, orphaned, reversed, or duplicated Rocky marker block is left untouched. `rocky hook status` reports it and exits nonzero instead of claiming installed; repair stays manual.

From the next shell on: every failing command is remembered (no stderr — the
hook hears command and exit code only; `rocky run` remains the deep-memory
path). When a command succeeds where its program recently failed, the fix is
linked automatically. And when a command looks catastrophic — `rm -rf` at a
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
3. **Fix linking** — when a command succeeds where its base program recently failed (same directory, within 48h), Rocky links that success to the unresolved failures. No AI involved; it's an honest heuristic, and it's right often enough to be useful.
4. **Recall** — token-overlap search across commands and error signatures, deduplicated per distinct error, fix shown when known.

The deterministic memory loop remains useful with zero AI setup and zero API keys. v0.2.1 can optionally ask a locally running Ollama model to rank or interpret deterministic recall candidates; the model cannot create or change the underlying stored evidence, and invalid output falls back to deterministic recall.

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
│   │   └── stats.ts        # memory summary
│   ├── core/
│   │   ├── fingerprint.ts  # stderr -> stable error signature + token bags
│   │   ├── memory.ts       # append-only JSONL writers
│   │   ├── memory-read.ts  # bounded parsing and backward-compatible loading
│   │   └── memory-query.ts # fingerprint lookup and fuzzy search
│   ├── mcp/                # bounded read-only tools and privacy projection
│   ├── setup/              # host adapters, consent, health, voice skill
│   ├── ai/                 # loopback-only Ollama adapter and grounded schema
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

When things are serious, Rocky is serious. Diagnoses and fixes are printed plainly; the personality lives around the information, never inside it. A `--quiet` mode is planned for people debugging production at 2 a.m.

Rocky asks because he is curious, not because he is testing you; you are always the one who knows. That proactive “Curious Blind Friend” behavior is planned for v0.5 and is not part of v0.2.1.

## Roadmap

Each phase is one facet of who Rocky is:

- **v0.2.1 — distribution bridge** (current beta): the v0.1 memory and implemented v0.2 Bash/WSL ears, plus scoped npm distribution, read-only MCP, consent-based host setup, an optional managed voice skill, and optional loopback Ollama interpretation for recall.
- **v0.3 — his patience**: `rocky watch` — hand him a long build, migration, or download; he waits (he once waited 46 years), notifies you, and holds the logs if it dies.
- **v0.4 — his diligence**: pre-push hull check — verifies that AI-added packages actually exist on the registry (hallucinated-package defense), wraps secret scanning, and asks one comprehension question about the riskiest line in the diff. Its planned registry lookup is external egress; network errors must fail open.
- **v0.5 — his curiosity**: Nervous System agent hooks + the Intent↔Mechanism Dictionary + an opt-in Ollama/BYOK annotation layer. The earlier `rocky explain` concept is superseded, not an active command. These planned mechanisms preserve recorded evidence, surface ambiguity only on explicit lookup, and never rewrite, inject, optimize, or submit a user's prompt.
- **later — his care**: ambient pet mode and the desktop pet window (deferred). He notices you've been at it for four hours, and he has opinions about your sleep.

v0.2.1 does not implement the v0.5 nervous-system hooks, bidirectional intent↔mechanism lookup, ambiguity handling, proactive questions, digest, quiz, or BYOK annotation.

## Contributing

Fully open source under MIT. Especially welcome: zsh/fish ports of the shell hook (Bash shipped first in v0.2), better fingerprinting for specific toolchains (pytest, cargo, gradle), and more of Rocky's dialogue — in character, please. He never uses emoji. He can't see them.

---

*rocky is an unofficial fan project inspired by the character Rocky from Andy Weir's novel* Project Hail Mary. *It is not affiliated with Andy Weir, Ballantine Books, or Amazon MGM Studios. No assets from the book or film are used.*
