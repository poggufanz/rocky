# Rocky

![Pixel art of Rocky, a faceless five-limbed mineral engineer, working at a terminal](https://raw.githubusercontent.com/poggufanz/rocky/main/assets/rocky-pixel.webp)

[![CI](https://github.com/poggufanz/rocky/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/poggufanz/rocky/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@poggufanz/rocky-cli?style=flat-square)](https://www.npmjs.com/package/@poggufanz/rocky-cli)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

[Release v0.6.0](https://github.com/poggufanz/rocky/releases/tag/v0.6.0) | [Changelog](CHANGELOG.md) | [License](LICENSE) | [Security](https://github.com/poggufanz/rocky/blob/main/SECURITY.md) | [Contributing](https://github.com/poggufanz/rocky/blob/main/CONTRIBUTING.md)

Rocky is a blind engineer who lives in your terminal. He remembers failed commands and what fixed them, then brings that history back when the same trouble returns. Supported agent hooks can also keep a bounded record of what you asked for, which files changed, and why the agent said it changed them.

The useful part is local and deterministic. Rocky has no daemon, no telemetry, and zero runtime dependencies. Optional AI uses an Ollama instance that you run on loopback.

> You teach, I remember. I remind, you understand. This is good trade.

## Install

```bash
npm install -g @poggufanz/rocky-cli
```

Requires Node.js 18 or newer. The package name is `@poggufanz/rocky-cli`; the unrelated unscoped `rocky-cli` package is not this project.

Current release: `@poggufanz/rocky-cli@0.6.0`. See the [release notes](https://github.com/poggufanz/rocky/releases/tag/v0.6.0) or the full [changelog](CHANGELOG.md).

## Quick start

Run a failure-prone command through Rocky:

```bash
rocky run "npm run build"
```

When it fails, Rocky fingerprints the useful stderr lines and writes a local record. When the same reliable command later succeeds in the same directory, Rocky links that success as the fix.

```bash
rocky recall "build failure"
rocky stats
```

On Bash, WSL, or PowerShell, install the shell hook if you want passive command memory:

```bash
rocky hook install
```

`rocky setup` and `rocky hook install` are separate on purpose. MCP or agent setup never edits `.bashrc` or `$PROFILE`.

On Windows, `rocky hook install` installs into every PowerShell host it finds on the machine — Windows PowerShell and PowerShell 7, both when present, each into its own `$PROFILE` — alongside the Bash hook if `.bashrc` is also in play (Git Bash/WSL). `rocky hook status` reports each host separately.

The PowerShell hook is passive ears only: it overrides `prompt` to see a command's result right after it finishes, so it remembers failures and links fixes the same way Bash does, but — unlike the Bash hook — it cannot ask for confirmation before a dangerous command runs, because `prompt` never sees a command before it executes. Because `prompt` fires after the command's own stderr is already gone, PowerShell-hook failures are fingerprinted from the command text alone, the same command-only fallback the CLI has used since v0.4.0. One disclosed side effect: the only way PowerShell allows restoring `$?` to `False` after Rocky's own bookkeeping runs is a real, suppressed non-terminating error, which pushes one synthetic entry — named so you know it is Rocky's — onto the front of `$Error`, ahead of whatever your last real command actually raised. `$LASTEXITCODE` and `$?`'s value are always exactly what your own command left them; only `$Error[0]`'s position shifts.

## What ships

| Surface | What it does |
| --- | --- |
| Failure memory | Fingerprints errors, remembers later fixes, and searches your own history. |
| `rocky watch` | Waits with a long-running command, saves a failed stderr tail, and notifies when work ends. |
| `rocky check` | Scans a pending push for secrets, checks new npm package names after consent, and asks one non-blocking comprehension question. |
| Nervous System | Supported Claude Code and Codex hooks record bounded intent, path, excerpt, and stated-rationale evidence. |
| Dictionary | `what`, `how`, `why`, `digest`, and `quiz` turn remembered changes back into plain explanations. |
| Read-only MCP | Exposes bounded memory tools over local stdio, with sanitized output by default. |

Rocky preserves wrapped-command stdout, stderr, TTY behavior, and exit status. Persona lines go to stderr, so piped stdout stays clean.

## Command map

| Command | Use |
| --- | --- |
| `rocky run "<cmd>"` | Run a command with deep failure memory. |
| `rocky watch "<cmd>"` | Run a long command with completion notice and failure log. |
| `rocky brief [--since <ref\|24h>] [--quiet] [--ai]` | Hear what changed since last brief: commits, remembered failures/fixes, touched invariant guards. Local git and memory only, no network; `--ai` stays on loopback. |
| `rocky recall [--ai] "<query>"` | Search remembered failures and fixes. |
| `rocky stats` | Show memory totals and coverage. |
| `rocky journal "<note>"` | Write one line to your dogfood journal. Local file only, no network. |
| `rocky invariants` | List remembered invariant notes and hear which globs guard nothing. |
| `rocky check` | Inspect the commits or workspace about to be pushed. |
| `rocky hook install\|status\|uninstall` | Manage the Bash/WSL hook, and on Windows every detected PowerShell host's hook. |
| `rocky what`, `rocky how`, `rocky why` | Look up remembered intent and mechanism evidence. |
| `rocky digest`, `rocky quiz`, `rocky export` | Review or export recent learning records. |
| `rocky setup` | Register detected MCP hosts after consent. |
| `rocky mcp` | Start the local read-only stdio server. |
| `rocky model status\|use\|off` | Configure optional loopback Ollama. |

Setup stays explicit:

```bash
rocky setup
rocky setup --voice-skill
rocky setup --agent-hooks
rocky setup --uninstall-agent-hooks
rocky setup --status
```

For optional local ranking, install and manage Ollama yourself, then opt in:

```bash
rocky model use qwen3:0.6b-q4_K_M
rocky recall --ai "sharp build failure"
rocky model off
```

Rocky never installs or pulls a model, and it does not start or stop the shared Ollama daemon.

## Privacy and local state

Persistent state lives under `ROCKY_HOME`; the default is `~/.rocky`. The main record is append-only JSONL at `memory.jsonl`. Depending on the features you use, that directory can also hold config, watch logs, a transient agent spool, labels, and guard rules.

Memory can contain commands, errors, working directories, prompts, bounded file excerpts, and an agent's stated rationale. Treat it as developer history: read it, back it up, or delete it on your terms.

The CLI contains no telemetry and runs no daemon. Its only external network egress is `rocky check` asking `registry.npmjs.org` whether a newly added package name exists. The lookup is consent-gated, sends package names only, and is fail-open when offline. Everything else stays local; optional AI connects only to `127.0.0.1`. MCP projects sanitized memory by default, and raw exposure is an explicit opt-in. A configured cloud host may forward selected projected content under that host's own policy.

Read the [security policy](https://github.com/poggufanz/rocky/blob/main/SECURITY.md) before enabling raw MCP exposure or installing hooks into a shell or agent host.

## Documentation

- [Behavior and safety reference](https://github.com/poggufanz/rocky/blob/main/docs/reference.md) covers command boundaries, memory linking, setup transactions, MCP, and platform limits.
- [Scientific grounding](https://github.com/poggufanz/rocky/blob/main/docs/scientific-grounding.md) separates product hypotheses from measured research.
- [Security policy](https://github.com/poggufanz/rocky/blob/main/SECURITY.md) explains private reporting, supported versions, sensitive state, and recovery artifacts.
- [Contributing guide](https://github.com/poggufanz/rocky/blob/main/CONTRIBUTING.md) covers the development workflow and load-bearing code.
- [Changelog](CHANGELOG.md) and [GitHub releases](https://github.com/poggufanz/rocky/releases) track shipped changes.

For questions and reproducible bugs, use [GitHub Issues](https://github.com/poggufanz/rocky/issues). Report exploitable findings through a [private security advisory](https://github.com/poggufanz/rocky/security/advisories/new).

## Development

```bash
git clone https://github.com/poggufanz/rocky.git
cd rocky
npm install
npm test
```

Repository layout: a fresh clone of the canonical upstream repository (`https://github.com/poggufanz/rocky.git`) is the package root; run `npm install`, `npm test`, and `npm pack` there. In this outer workspace, that same package root is the `rocky/` directory. Canonical developer branch is `main`; `iq` is a remediation branch, not a second release line.

Read the [contributing guide](https://github.com/poggufanz/rocky/blob/main/CONTRIBUTING.md) before changing setup, MCP, file transactions, or shell hooks. Those paths refuse uncertain state rather than guessing. The full `npm test` run is the release gate.

## Roadmap

- **v0.2.1 - distribution bridge (historical)**: scoped npm package, Bash/WSL hook, read-only MCP, host setup, and optional local AI.
- **v0.3 - his patience (implemented)**: `rocky watch` for long-running work.
- **v0.4 - his diligence (implemented)**: `rocky check` before a push.
- **v0.5 - his curiosity (implemented)**: Nervous System hooks, intent-mechanism dictionary, teaching commands, and bounded MCP knowledge tools.
- **v0.6 - his accountability (current release)**: `rocky brief`, `rocky journal`, `rocky invariants`, extended `rocky stats`, and the schema envelope documentation.

BYOK annotation, `attest`, and the memory circuit breaker remain deferred. The earlier `rocky explain` idea is superseded and is not an active command.

## License and fan-project note

Rocky CLI code, original project documentation, and the repository illustration are available under the [MIT License](LICENSE).

Rocky is an unofficial fan project inspired by the character from Andy Weir's *Project Hail Mary*. It is not affiliated with Andy Weir, Ballantine Books, or Amazon MGM Studios. The illustration above is original fan art made for this repository; no film frame, poster, logo, or other studio asset is distributed here. The MIT license does not grant rights in *Project Hail Mary* or its characters.
