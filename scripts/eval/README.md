# Rocky Eval Harness

Sandboxed A/B harness for running Claude Code against isolated Rocky installations (`none`, `before`, and `after` arms) without inheriting host agent config, Rocky state, or ancestor instruction files.

## Running capture

Choose a `--root` directory with no `CLAUDE.md`, `AGENTS.md`, or `.claude` in the root or any ancestor (for example `C:\rocky-eval` on Windows or `/tmp/rocky-eval` on POSIX), and an `--out` directory outside this repository and its enclosing workspace.

`capture.mjs` runs `npm test` twice in an inline failing repo and asks the agent to print only the seven reported environment variables (`HOME`, `CLAUDE_CONFIG_DIR`, `ROCKY_HOME`, `ROCKY_TEST_SEAMS`, `ROCKY_ATTEMPT_ARM`, `ROCKY_AGENT_SESSION`, `PATH`), never the full environment. The harness also redacts the token value from all saved artifacts and output as a second layer.

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

## Harness facts (captured 2026-11-23)

Captured on Windows 11 with Claude Code `2.1.330 (Claude Code)`.

1. **Token auth:** Passing `CLAUDE_CODE_OAUTH_TOKEN` in the sandbox environment works headless in a fresh, empty `CLAUDE_CONFIG_DIR`; no onboarding state is needed in `.claude.json` (arm `none` ran against an empty config directory, exited 0, and succeeded). Copy-credentials mode was not tested because token auth works directly; `runner.mjs` disables `--auth copy-credentials` for batches (exit 2), while `sandbox.mjs` and `capture.mjs` retain it.
2. **Permission flags:** `--allowedTools Bash,PowerShell,Edit,Write,Read,Glob,Grep,mcp__rocky__*` followed by `--` before the prompt. Without the trailing `--`, Claude Code `2.1.330` reads the prompt as a value of the variadic `--allowedTools` option and exits 1 with an error about missing stdin/prompt input. Init reports `permissionMode: default`. A probe run exercised `Write`, `Edit`, `Read`, `Glob`, `Grep`, `ToolSearch`, `mcp__rocky__stats`, `PowerShell`, and `Bash` with `permission_denials: []` (MCP tools are deferred and loaded via `ToolSearch`, which needed no separate allow entry). Frozen `CLAUDE_FLAGS`: `-p --output-format stream-json --verbose --max-turns 30 --model claude-sonnet-5-5 --effort high --allowedTools Bash,PowerShell,Edit,Write,Read,Glob,Grep,mcp__rocky__* --`, with the prompt appended after `--`.
3. **MCP:** Init reports `mcp_servers: [{"name":"rocky","status":"connected"}]` and 14 `mcp__rocky__*` tools for both `before` (`31128bc`) and `after` (`c44a1e2`). Arm `none` reports `mcp_servers: []` and no `mcp__rocky__*` tools. On a fresh sandbox, the first `rocky setup --harness claude-code --yes` can fail its cold-start `claude mcp list` health probe with exit 1 even though registration succeeds; a single idempotent rerun reports `already-configured` (exit 0) and `connected`.
4. **Hooks:**
   - `after`: stream-json carries `system/hook_started` and `system/hook_response` for `SessionStart` (output `{}`). Inside the agent shell, `printenv` shows `ROCKY_AGENT_SESSION=<session uuid>`, `ROCKY_TEST_SEAMS=1`, and `ROCKY_ATTEMPT_ARM=shown`. Because of the `CLAUDE.md` fixture, the agent wrapped commands as `rocky run "npm test"`. On the second failure, `advisories.jsonl` recorded `{"lane":"run","kind":"note","arm":"shown","delivered":true,"bytes":148,...}` (wrapped commands also logged `{"lane":"tool-result","kind":"skip","reason":"wrapped"}`), and the lane-1 note appeared in the tool result: `rocky: Same error recorded 1 time before in this directory (first 2026-11-22). Rocky records order, not cause. More: rocky attempts 7a1ea5d68eb244a9`.
   - `before`: no hook events in stream-json and no `ROCKY_AGENT_SESSION` (no `SessionStart` hook at `31128bc`); tool results showed only `rocky: Same error as before, first recorded just now.` and `rocky: No fix recorded yet.`, with no `advisories.jsonl` rows.
   - `none`: no Rocky lines, `ROCKY_HOME` remained empty, `PowerShell` tool only.
5. **Lane-2 `additionalContext` visibility:** Running an unwrapped `npm test` in an `after` sandbox with existing history writes `{"lane":"tool-result","kind":"note","arm":"shown","delivered":true,"bytes":148}` to `advisories.jsonl`, but the note text does not appear in stream-json (there is no `PostToolUseFailure` `hook_response` event and no `additionalContext` anywhere in the transcript). Ruling: positive-control delivery checks match either the note text in a tool result (lane 1) or a `delivered: true` note row in the run's `rocky-home/advisories.jsonl` (lane 2), and the eval report documents this deviation. Accordingly, the evaluator includes the conditional `noteDelivered reads the advisories row when the transcript has no note` test.
6. **CLI version and model:** `claude --version` is `2.1.330 (Claude Code)`; init echoes model `claude-sonnet-5-5`; `--effort high` is accepted.

### Other observations

- On `win32`, the agent's shell tool is `PowerShell` (`Bash` is also available). Failing tool results carry `Exit code 1` and `is_error: true`.
- `rocky setup --agent-hooks` requires a TTY for consent (`--yes` does not bypass it); the harness passes a one-shot `--require` preload marking stdin as a TTY to that setup child only and pipes `y`.
- The default sandbox root under `os.tmpdir()` is refused on this machine because `C:\Users\<owner>\.claude` is an ancestor; runs use `--root C:\rocky-eval\sbx`.
