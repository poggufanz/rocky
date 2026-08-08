# Security policy

Rocky edits files people care about. It writes a managed block into `~/.bashrc`, registers itself in AI host configurations, and keeps a memory file of your command failures. That makes a few classes of bug more serious here than the size of the project suggests.

## Reporting a vulnerability

Report privately through GitHub: open the [Security tab](https://github.com/poggufanz/rocky/security/advisories) on this repository and choose "Report a vulnerability". That opens a private advisory only maintainers can read.

Please don't open a public issue for anything that could be exploited before there's a fix.

Include what you did, what happened, and what you expected. A short reproduction beats a long description. If the bug involves a specific host version, say which one, since the Codex and Claude Code adapters gate on exact versions and behave differently across them.

This is a one-person side project, not a funded product. Expect a first reply within about a week, and please don't expect a bounty. Credit in the advisory and the release notes is yours if you want it.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.2.1-beta.1 | Yes |
| 0.2.1-beta.0 | No |
| earlier | No |

Only the current beta gets fixes. Anything published before it is superseded.

Note that `@poggufanz/rocky-cli` is the only package this project publishes. The unscoped `rocky-cli` on npm belongs to someone else and has nothing to do with this project.

## What Rocky touches

Knowing the blast radius helps you judge whether something you found matters.

Rocky writes to `~/.rocky/`, which holds the memory file, and only after you run `rocky hook install` does it add a marked block to `~/.bashrc`. Plain `rocky setup` never edits your shell config. With your consent it registers an MCP entry in a host configuration, which means `$CODEX_HOME/config.toml` for Codex, `~/.claude.json` or `$CLAUDE_CONFIG_DIR/.claude.json` for Claude Code, and the platform config path for Claude Desktop.

Before Rocky changes any of those files it keeps a recovery copy of the original next to the target, in a directory named after the file. **That copy contains the file's full contents, including anything sensitive that was in it, and it is not encrypted.** Rocky keeps the most recent one and prunes older ones. This is deliberate, since it's what lets an interrupted write be recovered, but you should know those copies exist and that removing them is your call.

The core CLI and the MCP server make no network requests and send no telemetry. MCP runs over local stdio, exposes read-only tools, and projects sanitized memory by default. Raw exposure is an explicit opt-in. A cloud host you've configured may forward whatever Rocky projects to it under that host's own policy, which is a good reason to think before choosing raw.

Optional AI features talk only to an Ollama service you run yourself, over loopback at `127.0.0.1`. Rocky never installs, starts, stops, or pulls a model.

## What counts as a vulnerability here

Anything that makes Rocky write outside the paths above, or mutate a host configuration without the consent it claims to require.

Anything that makes Rocky report success it hasn't proved, or print a path it hasn't verified. Rocky's guards are built so that when it can't prove something it refuses and says so. A message that overstates what happened is a real bug in this project, not a cosmetic one, because people act on those messages.

Anything that leaks file contents, credentials, or environment values into Rocky's output, its memory file, or a message shown to a host.

Anything that gets a substituted file accepted as the original, including same-path replacement, a same-bytes file at a different inode, symlink or hard-link tricks, or a race between when Rocky checks a file and when it uses it.

Anything that makes the sanitized MCP projection reveal fields that raw exposure was supposed to gate.

## What doesn't count

Rocky refusing to act and telling you to do something manually is the designed behavior when it can't prove a state is safe. Codex registration removal and Claude Code automation both currently end that way, which is documented and intentional in this beta.

The recovery copies described above are working as designed. If you think the design is wrong, that's a worthwhile discussion for a public issue rather than a private advisory.

Findings that require an attacker who already has write access to your home directory are usually out of scope, since at that point they don't need Rocky. If you have a specific escalation in mind, report it anyway and explain the path.

## Fixes

Security fixes go out as a new patch version, with an advisory describing what was wrong and what an affected user should check. If a fix requires you to inspect or remove something on disk, the advisory will name the exact path.
