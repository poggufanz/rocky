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
| 0.7.1 | Yes |
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

`rocky hook install` is the only setup command that adds a managed block to `~/.bashrc`; plain `rocky setup` never edits shell configuration. A `.bashrc` write keeps the previous bytes, when they exist, in a sibling transaction directory under your home directory. Completed transactions prune older completed copies, while pending or ambiguous recovery artifacts are retained. `rocky hook status` does not edit the managed block, but it can settle an interrupted transaction and restore `.bashrc`.

Host recovery behavior is deliberately host-specific:

- Codex replacement or removal saves the prior Rocky MCP entry, not the full TOML file, under `~/.rocky-setup-recovery/`. A verified replacement removes that copy; a successful removal retains it as a manual undo. An initial add has no prior entry to save.
- Claude Desktop keeps a full timestamped sibling backup of an existing config and also uses a conditional-write transaction. Those timestamped backups are not automatically pruned.
- Claude Code MCP automation is inactive in this release and normally returns manual instructions before publishing a config change.
- Replacing or removing a managed voice skill moves the old directory into that host's `.rocky/backups/voice-skills/` area. Those backups are not automatically pruned.

These artifacts can contain sensitive host configuration and are not encrypted. Changing `ROCKY_HOME` does not relocate `.bashrc`, host configuration, or their recovery artifacts.

Rocky's own code contains no telemetry. Its only non-loopback network traffic is `rocky check` looking up eligible package names at registry.npmjs.org: package names only, no versions or paths, after consent, with no redirects, and fail-open on every result except a definitive 404. MCP runs over local stdio, exposes read-only tools, and projects sanitized memory by default. Raw exposure is an explicit opt-in. A host you launch or configure may apply its own network and data policy, so review that host before sharing raw fields.

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
