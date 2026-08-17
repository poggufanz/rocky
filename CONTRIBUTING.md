# Contributing to Rocky

Thanks for looking. Rocky is a small CLI with an unusually paranoid core, so this file spends most of its length on the parts where a reasonable-looking change can quietly break something important. Read the section on load-bearing code before you touch `src/setup/` or `src/mcp/`.

[Code of Conduct](CODE_OF_CONDUCT.md) | [Security](SECURITY.md) | [Issue tracker](https://github.com/poggufanz/rocky/issues) | [Changelog](CHANGELOG.md) | [License](LICENSE)

Use a public issue for reproducible bugs and feature proposals. Send exploitable findings through a [private security advisory](https://github.com/poggufanz/rocky/security/advisories/new), not the issue tracker.

## Getting set up

You need Node 18 or newer. Rocky ships with zero runtime dependencies and only two dev dependencies, so install is quick.

```bash
git clone https://github.com/poggufanz/rocky.git
cd rocky
npm install
npm run build
npm test
```

`npm test` is the real gate. It builds, compiles the tests, runs the whole `node:test` suite, and on Linux also runs a Bash smoke test against the shell hook. It should be green before you open a pull request and green again after you take review feedback.

While iterating, run one suite instead of all of them:

```bash
node scripts/test.mjs setup-codex
node scripts/test.mjs file-transaction hook-block
```

The filter matches test filenames, so `mcp-server`, `setup-claude-code`, `documentation`, and the rest all work. Run the full `npm test` before you push regardless.

One warning that will save you an hour: never pipe a test command into `head`, `grep | head`, or anything else that exits early. The runner deletes `.test-dist` in a `finally` block, so SIGPIPE kills it mid-run and every later run reports `MODULE_NOT_FOUND` and failures that aren't real. Redirect to a log file and read the log.

To try a change by hand:

```bash
node dist/index.js run "some-failing-command"
node dist/index.js recall "query"
node dist/index.js stats
```

## Load-bearing code

Some of this codebase looks more complicated than it needs to be. In a few places that's true and you should simplify it. In the places below it isn't, and simplifying them has caused real data loss before.

`src/setup/file-transaction.ts` is the byte-level transaction engine behind every file Rocky writes, including the user's `.bashrc` and host MCP configs. Its guards check inode identity, link counts, file modes, and path topology, and they refuse rather than guess. During one hardening cycle a single defect class here survived six rounds of fixes: twice it destroyed data, and once it printed advice that would have made the user delete their own shell config. What finally fixed it was deleting a capability rather than proving it safe. If you find yourself relaxing a refusal so a test passes, stop. The test is probably right and the fixture is probably wrong.

The recovery path has two rules worth stating outright. Every user-facing message must be entailed by evidence proved at the moment it prints, and no message may tell a user to remove something that holds the only copy of their content. A path existing is not evidence that a copy exists.

`src/setup/claude-code.ts` and `src/setup/codex.ts` register Rocky with AI hosts. Both prove provenance before they mutate anything: Codex checks that an existing entry came from the base user config layer and writes with a version-checked compare-and-swap, and Claude Code clones config into a private stage, runs the official CLI only against that copy, audits what changed, then publishes the audited bytes. Neither will touch a config layer it cannot prove it owns. When they can't prove it, they fail closed and tell the user to register manually, which is the correct outcome and not a bug to fix.

`src/mcp/server.ts` keeps a JSON-RPC request ID reserved from the moment a request is accepted until its response send settles, including a rejected write. Dropping that reservation early lets a duplicate ID run a tool twice.

`src/commands/setup.ts` gates every voice-skill mutation behind consent. Consent means an explicit `--yes` or a prompt the user actually answered. "No adapter needed a prompt" and "the user declined" are different states and the code keeps them separate on purpose.

## Tests

Write the test first and watch it fail. A test that has never been red has never been shown to test anything.

For anything in the areas above, go further: prove the test catches the mutation you care about. Copy the tree somewhere disposable, break the production line on purpose, confirm the suite goes red, then restore. Several guards in this repo were once protected only by a reviewer's throwaway probe rather than a shipped test, and a mutation check is what caught that.

Use deterministic injected faults for failure paths. Sleeps and timing races produce tests that pass on your machine and fail in CI.

Don't weaken an existing assertion to make room for a change. If an assertion is genuinely wrong, say so in the pull request and explain why.

## Platform notes

CI runs Ubuntu current, Ubuntu Node 18, macOS, and Windows. Two traps have already cost real debugging time.

On macOS, `os.tmpdir()` sits under a symlink, because `/var` links to `/private/var`. Rocky's topology guard correctly refuses a config path with a symlinked ancestor, so test fixtures need to resolve the real path or the adapter will refuse and the failure will look like a product bug.

On Windows there are no POSIX mode bits and no stable inode, so scenarios built on those cannot be expressed. Some tests skip there with a stated reason. Skipping with a reason is fine. Loosening a shared assertion so Windows passes is not, because it removes the protection on Linux too, where it works.

## House rules

No runtime dependencies. Node 18 built-ins only. TypeScript stays strict, and ESM relative imports end in `.js`.

Everything Rocky says to a user follows his voice, and these rules are structural rather than decorative. Questions end with `, question` instead of a question mark. Emphasis comes from repetition, as in `good good good`. Sentences are short and present tense and drop articles. He is blind, so he never sees anything: he hears, remembers, and checks. His output goes to stderr so it never pollutes the stdout of a command he wraps. No emoji, ever, since he can't see them.

README, CLI output, and package documentation under `docs/` are written in English. Internal design documents in the outer workspace are in Indonesian and stay that way.

## What would help most

The shell hook ships for Bash. Ports for zsh and fish would widen it a lot.

Fingerprinting is deliberately simple, and toolchain-specific improvements for pytest, cargo, or gradle would make recall much better at matching failures that look different but mean the same thing.

More of Rocky's dialogue is welcome, in character.

## Pull requests

Keep the change focused, explain what you observed rather than what you intended, and include the test that would have caught the bug. If you touched anything in the load-bearing section, say in the description which guard you touched and how you convinced yourself it still refuses what it used to refuse.

Open pull requests against `main`. Before requesting review, run `npm test`, update public documentation when behavior changed, and add a changelog entry for a user-visible fix or feature. Maintainers own version bumps, tags, and npm publication.

Rocky is MIT licensed. By contributing you agree your work ships under the same license.
