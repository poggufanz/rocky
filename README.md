# rocky

```
  ═╦═══════╦═
   ║ ┌───┐ ║      [Rocky]: I remember this error.
   ╲_││││││_╱              You hear it before. 84 days ago.
   ╱ ╲▔▔▔╱ ╲              Last time, you fix with: npm rebuild sharp
  ╱ ╱ ╲_╱ ╲ ╲             try, question
```

**A blind engineer who lives in your terminal, never forgets an error, and makes sure you still understand your own code.**

Rocky is a terminal companion inspired by the alien engineer from Andy Weir's *Project Hail Mary*. Every AI tool on the market writes code *for* you. Rocky does the opposite job: he keeps track of what you and your AI have already been through, so the second time an error appears, the answer comes from your own history — not from twenty minutes of googling.

He is also, unapologetically, a pet.

## Why

Developers run around five search sessions a day just looking things up (Sadowski et al., FSE 2015), and debugging lookups are among the most frequent and most difficult of them (Xia et al., EMSE 2017). A lot of that time is spent *re-finding* solutions we already had once. Human memory drops them. Nothing in the toolchain catches them.

Eridians have photographic memory. Rocky catches them.

The longer arc of this project is what we call the comprehension guardian: in an era where AI generates code faster than anyone reads it, Rocky's job is to make sure the human still understands what got built. See [docs/scientific-grounding.md](docs/scientific-grounding.md) for the research this is built on.

## Install

```bash
git clone https://github.com/<you>/rocky
cd rocky
npm install      # dev deps only — rocky has zero runtime dependencies
npm run build
npm link         # makes `rocky` available globally
```

Requires Node 18+.

## Usage (v0.1 — the memory MVP)

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
rocky stats
```

Memory lives in `~/.rocky/memory.jsonl`. Local only. Nothing is uploaded, no telemetry, no account. It's a text file you can read, grep, and delete.

## The ears (v0.2)

Skip the wrapper entirely — let Rocky listen to your whole bash session:

```bash
rocky hook install    # adds one managed block to ~/.bashrc
```

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

No LLM anywhere in v0.1. That's deliberate: the memory loop has to be useful with zero setup and zero API keys, or nothing built on top of it will matter.

## Project structure

```
rocky/
├── src/
│   ├── index.ts            # CLI entry: run | recall | stats | help
│   ├── commands/
│   │   ├── run.ts          # command wrapper: stream, fingerprint, remember, link fixes
│   │   └── recall.ts       # search memory, show fixes
│   ├── core/
│   │   ├── fingerprint.ts  # stderr -> stable error signature + token bags
│   │   └── memory.ts       # JSONL store, fingerprint lookup, fuzzy search
│   └── ui/
│       └── rocky.ts        # his face, his voice, relative time
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

## Roadmap

Each phase is one facet of who Rocky is:

- **v0.1 — his memory** (this release): `rocky run`, `rocky recall`, `rocky stats`. The error → fix loop, fully offline.
- **v0.2 — his ears**: bash shell hook — Rocky listens to every command, no `run` wrapper needed — plus the dangerous-command guard: `rm -rf` in strange places, force pushes, `curl | bash` are held until you answer `you sure, question`.
- **v0.3 — his patience**: `rocky watch` — hand him a long build, migration, or download; he waits (he once waited 46 years), notifies you, and holds the logs if it dies.
- **v0.4 — his diligence**: pre-push hull check — verifies that AI-added packages actually exist on the registry (hallucinated-package defense), wraps secret scanning, and asks one comprehension question about the riskiest line in the diff. The only feature that ever touches the network — npm registry only, nothing else, ever.
- **v0.5 — his curiosity**: `rocky explain` + provenance memory — Rocky remembers which lines were written by AI and asks *you* to explain them: the comprehension-debt tracker. Backed by the self-explanation and retrieval-practice literature (see docs).
- **later — his care**: ambient pet mode and the desktop pet window (deferred). He notices you've been at it for four hours, and he has opinions about your sleep.
- **LLM layer (opt-in, BYOK)**: local via Ollama or your own OpenAI/Anthropic/Gemini key. Every feature keeps a useful degraded mode without it.

## Contributing

Fully open source under MIT. Especially welcome: zsh/fish ports of the shell hook (bash ships first in v0.2), better fingerprinting for specific toolchains (pytest, cargo, gradle), and more of Rocky's dialogue — in character, please. He never uses emoji. He can't see them.

---

*rocky is an unofficial fan project inspired by the character Rocky from Andy Weir's novel* Project Hail Mary. *It is not affiliated with Andy Weir, Ballantine Books, or Amazon MGM Studios. No assets from the book or film are used.*
