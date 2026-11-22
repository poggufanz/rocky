# Rocky Eval Harness

Sandboxed A/B harness for running Claude Code against isolated Rocky installations (`none`, `before`, and `after` arms) without inheriting host agent config, Rocky state, or ancestor instruction files.

## Running capture

Choose a `--root` directory with no `CLAUDE.md`, `AGENTS.md`, or `.claude` in the root or any ancestor (for example `C:\rocky-eval` on Windows or `/tmp/rocky-eval` on POSIX), and an `--out` directory outside this repository.

Token auth (reads `ROCKY_EVAL_OAUTH_TOKEN` from the current environment and passes it into the sandbox as `CLAUDE_CODE_OAUTH_TOKEN` only):

```bash
node scripts/eval/capture.mjs \
  --root C:\rocky-eval \
  --arm after \
  --commit origin/main \
  --auth token \
  --out C:\rocky-eval\capture-after
```

Copy-credentials auth (copies only `.credentials.json` into the sandbox config dir):

```bash
node scripts/eval/capture.mjs \
  --root C:\rocky-eval \
  --arm none \
  --auth copy-credentials \
  --from C:\Users\<you>\.claude\.credentials.json \
  --out C:\rocky-eval\capture-none
```

## Harness facts (captured <date>)

Pending: capture not yet run.
