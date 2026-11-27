# Rocky Eval Harness

Sandboxed A/B harness for running Claude Code against isolated Rocky installations (`none`, `before`, and `after` arms) without inheriting host agent config, Rocky state, or ancestor instruction files.

See [`docs/attempt-memory-eval-preregistration.md`](../../docs/attempt-memory-eval-preregistration.md) for the frozen pre-registration protocol, task table, metric definitions, and decision rules.

## How to run

Run all commands from the `rocky/` package root. Choose a `--root` directory with no `CLAUDE.md`, `AGENTS.md`, or `.claude` in the root or any ancestor (for example `"C:\rocky-eval\sbx"` on Windows or `"/tmp/rocky-eval/sbx"` on POSIX), and `--out` / `--cache` directories outside this repository and its enclosing workspace.

Set `ROCKY_EVAL_OAUTH_TOKEN` in the current shell environment before running token-authenticated capture or batches (`runner.mjs` accepts `--auth token` only; `--auth copy-credentials` is disabled for batches).

### Prerequisite: build this checkout

Install dependencies and build this checkout before running capture, smoke, full batches, or offline scoring. The evaluator and history helper use this checkout's compiled `dist/core/fingerprint.js`, which is not tracked in git:

```powershell
npm ci
npm run build
```

### 1. Capture

`capture.mjs` runs `npm test` twice in an inline failing repo and asks the agent to print only the seven reported environment variables (`HOME`, `CLAUDE_CONFIG_DIR`, `ROCKY_HOME`, `ROCKY_TEST_SEAMS`, `ROCKY_ATTEMPT_ARM`, `ROCKY_AGENT_SESSION`, `PATH`), never the full environment. The harness also redacts the token value from all saved artifacts and output as a second layer.

Token auth (passes `ROCKY_EVAL_OAUTH_TOKEN` into the sandbox as `CLAUDE_CODE_OAUTH_TOKEN` only):

```powershell
node scripts/eval/capture.mjs `
  --root "C:\rocky-eval\sbx" `
  --arm after `
  --commit origin/main `
  --auth token `
  --out "C:\rocky-eval\capture-after"
```

Copy-credentials auth (capture/sandbox debugging only; copies only `.credentials.json` into the sandbox config dir):

```powershell
node scripts/eval/capture.mjs `
  --root "C:\rocky-eval\sbx" `
  --arm none `
  --auth copy-credentials `
  --from "C:\Users\<you>\.claude\.credentials.json" `
  --out "C:\rocky-eval\capture-none"
```

### 2. Smoke batch

Verify the end-to-end runner, sandbox isolation, and owner guard on the excluded `SMOKE` task before launching a full batch:

```powershell
node scripts/eval/runner.mjs `
  --set v1 `
  --out "C:\rocky-eval\smoke" `
  --root "C:\rocky-eval\sbx" `
  --before "31128bc" `
  --after "<after-sha>" `
  --auth token `
  --only SMOKE `
  --k 1 `
  --concurrency 1
```

### 3. Full batch

Runs the 20 frozen non-smoke tasks across all three arms with default `k = 5`, `seed = 20261123`, and `concurrency = 2` (300 runs total):

```powershell
node scripts/eval/runner.mjs `
  --set v1 `
  --out "C:\rocky-eval\run1" `
  --root "C:\rocky-eval\sbx" `
  --before "31128bc" `
  --after "<after-sha>" `
  --auth token
```

To retry existing runs marked `api_error` or `harness_crash` (up to 2 retries per run) using the same provenance:

```powershell
node scripts/eval/runner.mjs `
  --set v1 `
  --out "C:\rocky-eval\run1" `
  --root "C:\rocky-eval\sbx" `
  --before "31128bc" `
  --after "<after-sha>" `
  --auth token `
  --retry-invalid
```

### 4. Evaluate

Score every run in `<out>/runs/` offline and write `<out>/metrics.json`:

```powershell
node scripts/eval/evaluate.mjs --out "C:\rocky-eval\run1"
```

### 5. Report

Render the markdown evaluation report from `<out>/metrics.json` and `<out>/batch.json` (`--seed` and `--resamples` overrides are disallowed for `run1` and `run2`, and `run1`/`run2` also require a finished batch with `batch.json.completedAt` written on normal runner completion):

```powershell
node scripts/eval/report.mjs `
  --out "C:\rocky-eval\run1" `
  --label run1 `
  --dest "C:\rocky-eval\run1\report-run1.md"
```

### 6. Eval tests and manifest verification

Eval harness unit tests run with `node --test "scripts/eval/test/*.test.mjs"` (and `node scripts/eval/freeze.mjs --verify` verifies the frozen task manifest).

## What stays local

Keep all runtime eval outputs outside this repository and its enclosing workspace; never commit them because they can contain host paths or raw sandbox output:

- raw transcripts (`runs/<runId>/transcript.jsonl`) and subprocess stderr logs (`runs/<runId>/stderr.txt`);
- per-run sandboxes under `--root` (deleted after each run) and packed arm tarballs in `--cache`;
- saved final repository copies (`runs/<runId>/final/`) and sandbox Rocky state copies (`runs/<runId>/rocky-home/`);
- batch/run metadata (`batch.json`, `run.json`, `retries.json`) and scored `metrics.json`;
- rendered markdown reports before they are reviewed and copied into `docs/evals/`.

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

## Codex harness facts

Captured on Windows 11 on 2026-11-28 with `codex-cli 0.171.0`. The committed `codex-none.jsonl` and `codex-after.jsonl` fixtures each record one prompt and two executed tests that printed `AssertionError: probe` and returned exit code `1`. The `after` fixture also records an `apply_patch` edit and a successful Rocky `stats` MCP call.

- **Model and flags.** `CODEX_MODEL` is `gpt-6.2-sol`. `CODEX_FLAGS` are `--json -C <taskDir> -s workspace-write --ephemeral -c windows.sandbox=unelevated -m gpt-6.2-sol` after `codex exec` and before the prompt. The `-c windows.sandbox=unelevated` pair is Windows-only. With a fresh `CODEX_HOME`, the CLI accepted `workspace-write` but blocked shell launches until the Windows sandbox was selected. The disposable Windows `AGENTS.md` selected `cmd.exe` for the test calls after the PowerShell launch failed with error 5.
- **Auth.** Prefer passing `CODEX_API_KEY` only to the isolated Codex process from the eval credential (`ROCKY_EVAL_CODEX_API_KEY`, with `ROCKY_EVAL_OPENAI_API_KEY` as a fallback). The key path was unavailable during this capture. Codex authenticated using a throwaway copy of the owner’s `auth.json` in `$CODEX_HOME`. The copies and owner files had identical pre/post hashes for the probe, and the copies were removed. Copied OAuth credentials are limited to this disposable spike while batch refresh-token behavior remains unverified.
- **Rocky setup.** `rocky setup --harness codex --yes` registered a stdio MCP server with both the packed `31128bc` build and `d7ef3c5`. Codex listed `rocky` as enabled and executed its `stats` tool for each build. Both registrations emitted item-level warnings for ignored `mcp_servers.rocky.env_ROCKY_HOME` and `mcp_servers.rocky.env_ROCKY_MCP_EXPOSURE`. This verifies MCP registration and tool execution. The configured environment overrides remain unverified. Under the Windows sandbox used here, both builds returned `spawn EPERM` from `rocky run "npm test"` before npm started. The fixtures use bare tests, and lane-1 note delivery remains unverified on this host.
- **Hooks.** A disposable `$CODEX_HOME/hooks.json` `PostToolUse` command hook fired for the failed shell call with `--dangerously-bypass-hook-trust`. The control without the flag recorded no invocation. The hook reported `tool_name: "Bash"` for the `cmd.exe` call, `tool_input: {"command":"npm test"}`, `tool_response` as a string with command output and no exit code, and `transcript_path: null` under `--ephemeral`. The model echoed a marker returned through `hookSpecificOutput.additionalContext`. An equivalent inline `config.toml` hook fired in a separate probe, where the final answer did not echo its marker. Wave 1 uses `["lane1", "mcp"]`.

Each stdout line is a JSON object with a top-level `type`. Observed event fields are below.

| Event | Fields and values observed |
| --- | --- |
| `thread.started` | `thread_id` |
| `turn.started` | `type` only. One event per prompt across multiple shell, file, and MCP actions. |
| `item.started` / `item.completed`, `item.type: "command_execution"` | `item.id`, `command`, `aggregated_output`, `exit_code`, `status`. Starts carry an empty output, `null` exit code and `in_progress` status. Completions carry combined output and a numeric exit code. A nonzero exit was `failed`. |
| `item.started` / `item.completed`, `item.type: "file_change"` | `item.id`, `changes: [{path, kind}]`, `status`. The `apply_patch` add carried `kind: "add"` and transitioned from `in_progress` to `completed`. |
| `item.started` / `item.completed`, `item.type: "mcp_tool_call"` | `item.id`, `server`, `tool`, `arguments`, `result`, `error`, `status`. The `rocky` / `stats` start carried `arguments: {}`, `result: null`, and `error: null`. Its completion carried `result.content` and `result.structured_content`. |
| `item.completed`, `item.type: "agent_message"` or `"error"` | `item.id` plus `text` for an agent message or `message` for an item-level warning. A warning can precede a successful turn. |
| `turn.completed` | `usage` with `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, and `reasoning_output_tokens`. The runner measures wall time outside the stream. |
| `error` / `turn.failed` | `error` carries `message` directly. `turn.failed` carries `error: {message}`. The unsupported-model probe emitted both and exited `1`. |
