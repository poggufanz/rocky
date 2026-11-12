# Security policy

Rocky edits files people care about. It writes a managed block into `~/.bashrc`, registers itself in AI host configurations, and keeps a memory file of your command failures. That makes a few classes of bug more serious here than the size of the project suggests.

## Reporting a vulnerability

Report privately through a [GitHub security advisory](https://github.com/poggufanz/rocky/security/advisories/new). Only repository maintainers can read the draft report.

Please don't open a public issue for anything that could be exploited before there's a fix.

Include what you did, what happened, and what you expected. A short reproduction beats a long description. If the bug involves a specific host version, say which one, since the Codex and Claude Code adapters gate on exact versions and behave differently across them.

This is a one-person side project, not a funded product. Expect a first reply within about a week, and please don't expect a bounty. Credit in the advisory and the release notes is yours if you want it.

## Supported versions

| Version | Supported |
| --- | --- |
| 2.0.0 | Yes |
| 1.1.0 | No |
| 1.0.1 | No |
| 1.0.0 | No |
| 0.8.0 | No |
| 0.7.6 | No |
| 0.7.5 | No |
| 0.7.4 | No |
| 0.7.3 | No |
| 0.7.2 | No |
| 0.7.1 | No |
| 0.7.0 | No |
| 0.6.0 | No |
| 0.5.5 | No |
| 0.5.4 | No |
| 0.5.3 | No |
| 0.5.2 | No |
| 0.5.1 | No |
| 0.5.0 | No |
| 0.3.0 | No |
| 0.2.1-beta.1 | No |
| 0.2.1-beta.0 | No |
| earlier | No |

Only the current release gets fixes. Anything published before it is superseded.

Note that `@poggufanz/rocky-cli` is the only package this project publishes. The unscoped `rocky-cli` on npm belongs to someone else and has nothing to do with this project.

## What Rocky touches

Knowing the blast radius helps you judge whether something you found matters.

Rocky's local state lives under `ROCKY_HOME`, or `~/.rocky` by default. It can include `memory.jsonl`, config, watch logs, a transient agent spool, labels, hook assets, and guard rules. `memory.jsonl` is append-only, private where the platform supports POSIX modes, and not encrypted. Rocky does not make an automatic backup of it; use `rocky export` or your normal backup tooling if you need another copy.

`rocky hook install` and a consented `rocky setup --auto` are the only setup routes that add a managed block to `~/.bashrc`; plain `rocky setup` never edits shell configuration. A `.bashrc` write keeps the previous bytes, when they exist, in a sibling transaction directory under your home directory. Completed transactions prune older completed copies, while pending or ambiguous recovery artifacts are retained. `rocky hook status` does not edit the managed block, but it can settle an interrupted transaction and restore `.bashrc`.

Host recovery behavior is deliberately host-specific:

- Codex replacement or removal saves the prior Rocky MCP entry, not the full TOML file, under `~/.rocky-setup-recovery/`. A verified replacement removes that copy; a successful removal retains it as a manual undo. An initial add has no prior entry to save.
- Claude Desktop keeps a full timestamped sibling backup of an existing config and also uses a conditional-write transaction. Those timestamped backups are not automatically pruned.
- Claude Code MCP automation in the interactive setup flow is inactive in this release and normally returns manual instructions before publishing a config change; `rocky setup --auto` writes Claude Code's MCP config only under the consent record.
- Claude Code hook setup keeps a full copy of the `settings.json` it replaced in `.settings.json.transaction-*/displaced`, inside the Claude config directory (`$CLAUDE_CONFIG_DIR`, or `~/.claude` when that variable is unset). Only the latest completed copy is kept. The copy can include secrets the settings file held, such as credentials under `env`. Setup reports the copy only when its bytes differ from what setup read, so a normal install or uninstall leaves it without a notice.
- Removing a legacy managed voice skill with `rocky setup --remove` moves the old directory into that host's `.rocky/backups/voice-skills/` area. Those backups are not automatically pruned.

`rocky setup --auto` writes only after a recorded consent, and only to the targets it names on each run:

- Claude Code's `settings.json` and `.claude.json`, one pair per config directory the harness was found at.
- The MCP config of opencode, gemini-cli, copilot-cli, and Codex (`config.toml`).
- The Bash rc file, each PowerShell profile the hook installer edits, and the hook assets it installs under `ROCKY_HOME`.
- `<ROCKY_HOME>/setup/consent.json` and `<ROCKY_HOME>/setup/expected.json`.

Any bare `rocky` or `rocky setup`, including `--auto`, records the CLI location in `<ROCKY_HOME>/bin/cli.json` when it runs from a package install whose entry ends in `node_modules/@poggufanz/rocky-cli/dist/index.js`; that record is not consent-gated.

It never creates a config directory: a target whose parent directory is missing is reported and left alone. A config location taken from the environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG`, `GEMINI_SETTINGS`, `COPILOT_HOME`) or from an earlier run's record is revalidated before every write: it must be a canonical absolute path, its own real path (no symlink), strictly inside your home directory, and still hold a harness file. A value that fails is reported as `refused` and nothing is written there. It never runs a harness executable; the registration is written into the config file, not applied by the harness. `rocky setup --auto remove --json` removes Rocky's entries from every target and deletes the recovery copies Rocky retained beside the files it edited, so a completed removal leaves no Rocky block and no retained previous-bytes copy behind.

The desktop app's Settings can switch each harness and the shell hook off or on, reinstall, change a repo's capture decision, and remove Rocky. "Remove Rocky" asks twice. The desk then removes its own autostart entry and runs `rocky setup --auto remove --json`, which records `removed` consent and removes every Rocky entry from the harness configs and shell profiles. It prunes the recovery copies Rocky retained, except the copy beside a path it refused to touch; that copy stays for manual recovery. It then shows the Rocky home path and the `npm uninstall -g @poggufanz/rocky-cli` command, and quits. It keeps everything under `<ROCKY_HOME>` (memory, journal, Listening data, settings); delete that directory yourself to erase it. The desk itself writes only its autostart entry and `<ROCKY_HOME>/desk/notified.json`, a list of the notices it already showed; every agent config and shell profile change goes through Node.

The desktop app's background process can repair Rocky's own entries after you approve the consent record (`state` `approved` in `<ROCKY_HOME>/setup/consent.json`). Without that approval it starts no repair and no config-directory discovery; a request you make from the desk still runs Node, which applies its own consent check. One Node run is not gated on consent: once the CLI record points at a Node and an entry that exist, the process runs `node <entry> setup --auto repo status <root> --json` once per daemon run for each repo root a session started in, to read that repo's capture decision. That run writes nothing. When it finds an entry missing, it runs `node <entry> setup --auto … --json`, taking `node` and `entry` from `<ROCKY_HOME>/bin/cli.json`, as separate arguments, with no shell, and with no console window on Windows. The process reads the guarded files only to look for Rocky's bytes; it parses and writes no agent config itself. Node repairs only entries Node already owns, under the same checks as any `rocky setup --auto` run. Its log lines name the kind of job and give counts; a failure line adds a fixed error text or a Node exit code. They never carry paths or config text.

While consent is approved, the background process also restores Rocky entries that something else removed, including `rocky hook uninstall` and `rocky setup --remove`. The durable way to remove them is `rocky setup --auto remove --json`, which records `removed` consent before it removes anything. The background process runs exactly the `node` and entry named in `<ROCKY_HOME>/bin/cli.json`, which the CLI writes; anyone who can write the Rocky home can change what it runs.

The same background process also captures Listening history, but only for repos you consented to. While a repo has a recorded grant, or a session runs in a linked worktree of such a repo, it runs `node <entry> listen collect --stdio`, taking `node` and `entry` from `<ROCKY_HOME>/bin/cli.json`, as separate arguments, with no shell, with no console window on Windows, and with stderr discarded. With no consented repo and no such session it runs nothing. It talks to that process in JSON lines over stdin and stdout, and neither side opens a network connection. From `<ROCKY_HOME>/listening/` it reads only `repo-consents.json`; Node alone writes the Listening store and the collector lease. It watches each repo it captures (the consented repos and any allowed session root, not the targets of symlinks) for change events, ignoring `.git/` and its own Rocky home, only to know when to ask for a reconcile; it reads no file content itself. Its log lines name events and give counts. They never carry a repo path, a Node note, or error text from the capture process. Capture keeps the store format, redaction, and disk budget that `rocky dash` capture has.

The shell hooks pass the values of five named variables to `rocky-hook shell-env` and nothing else: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG`, `GEMINI_SETTINGS`, and `COPILOT_HOME`. The hook writes them into a spool record under `<ROCKY_HOME>/desk/spool/` once per shell, only for variables that are set, non-empty, and at most 4096 bytes. The Claude Code desk hook also records `CLAUDE_CONFIG_DIR` with each event. A reported location is a claim, not proof: Node revalidates it (canonical, no symlink, inside your home directory, still holding a harness file) before it records or writes anything there.

On Windows x64 and Linux x64, when a desktop session exists and the optional platform package is installed, a bare `rocky` also copies `rockyd`, `rocky-desk`, and `rocky-hook` from that package into `<ROCKY_HOME>/bin/`. Headless sessions and other platforms copy nothing. That copy is not consent-gated either. Rocky's binaries open no network connection: the desk and its daemon speak over a pipe or socket owned by your user.

These artifacts can contain sensitive host configuration and are not encrypted. Changing `ROCKY_HOME` does not relocate `.bashrc`, host configuration, or their recovery artifacts.

Rocky's own code contains no telemetry. Its non-loopback network traffic is narrow and named. `rocky check` looks up eligible package names at registry.npmjs.org: package names only, no versions or paths, after consent, with no redirects, and fail-open on every result except a definitive 404. The GUI model picker asks models.dev for its model catalogue: a plain GET of https://models.dev/api.json, cached on disk for 24 hours, plus one logo GET whose path names the provider you configured. It sends no prompt, key, memory, or code, has no consent prompt, and fails open, so an unreachable models.dev means an empty model list, never an error. The GUI Main chat adds one more path, and only when a BYOK model is configured: a code question sends the redacted, capped question, carved excerpts, and memory evidence to that model, while a memory-only question sends nothing. MCP runs over local stdio, exposes read-only tools, and projects sanitized memory by default. Raw exposure is an explicit opt-in. A host you launch or configure may apply its own network and data policy, so review that host before sharing raw fields.

Git diff correlation (`rocky why --diff`, `rocky how --diff`, and MCP `why_file`) executes local read-only `git` subprocesses. Subprocesses are invoked with `shell: false`, bounded by a strict 5-second timeout, and capped at a maximum 32 KB buffer. Diff output passes through automatic secret and credential scrubbing (`redactSecretsAtBoundary`) before being displayed or exposed over MCP, and falls back safely when git is unavailable.

Optional AI features talk only to an Ollama service you run yourself, over loopback at `127.0.0.1`. Rocky never installs, starts, stops, or pulls a model.

## What counts as a vulnerability here

Anything that makes Rocky write outside the paths above, or mutate a host configuration without the consent it claims to require.

Anything that makes Rocky report success it hasn't proved, or print a path it hasn't verified. Rocky's guards are built so that when it can't prove something it refuses and says so. A message that overstates what happened is a real bug in this project, not a cosmetic one, because people act on those messages.

Anything that leaks file contents, credentials, or environment values into Rocky's output, its memory file, git diff projections, or a message shown to a host.

Anything that gets a substituted file accepted as the original, including same-path replacement, a same-bytes file at a different inode, symlink or hard-link tricks, or a race between when Rocky checks a file and when it uses it.

Anything that makes the sanitized MCP projection reveal fields that raw exposure was supposed to gate, or allows unscrubbed credentials to pass through git diff outputs.

## What doesn't count

Rocky refusing to act and telling you to do something manually is the designed behavior when it can't prove a state is safe. Claude Code MCP automation currently ends that way, and other host adapters can do the same when provenance or file state is uncertain.

The documented recovery artifacts are working as designed. If you think the design is wrong, that's a worthwhile discussion for a public issue rather than a private advisory.

Findings that require an attacker who already has write access to your home directory are usually out of scope, since at that point they don't need Rocky. If you have a specific escalation in mind, report it anyway and explain the path.

## Fixes

Security fixes go out as a new patch version, with an advisory describing what was wrong and what an affected user should check. If a fix requires you to inspect or remove something on disk, the advisory will name the exact path.
