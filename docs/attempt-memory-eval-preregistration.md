# Controlled attempt-memory evaluation: pre-registration

**Frozen:** 2026-11-23
**Status:** Pre-registered before run 1 of the controlled three-arm evaluation.

This document pre-registers the controlled evaluation protocol comparing no Rocky (`none`), Rocky before attempt memory (`before`), and Rocky with attempt memory (`after`). All tasks are synthetic, so this evaluation does not replace the pre-registered field measurement (`docs/attempt-notes-preregistration.md`); its primary role is early harm veto and reproducible controlled measurement. It makes no causal claims and publishes no projected effect sizes.

## Schedule of runs

The task set, metric definitions, and decision rules are identical across both scheduled runs and are frozen before run 1:

- **Run 1:** runs after the evaluation harness pull request merges to `main`, measuring the prior-attempts note before daily field use. A harm veto in run 1 turns the prior-attempts note default OFF before daily use.
- **Run 2:** runs after the remaining attempt-memory changes merge to `main`, using that merge commit as the `after` arm.
- **Optional exploratory arm (run 2 only):** an `after+fixtouch` arm may be added in run 2 if opt-in fix-touch default activation is considered; its results are labelled **exploratory**.

## Arms and commits

All three arms use the same model, task prompt, and turn limit.

| Arm | Rocky commit | Setup and behavior | `CLAUDE.md` composition |
| --- | --- | --- | --- |
| `none` | None | No hooks, no MCP server, `rocky` stripped from sandbox `PATH`, empty `ROCKY_HOME`. Skips history replay. | `base.md` only |
| `before` | `31128bc` (`31128bc46ca7aa0bdf10c6d35e8fce353163c1d0`) | Pre-attempt-memory baseline on `main`, installed in the sandbox with `rocky setup --harness claude-code --yes` and `rocky setup --agent-hooks`. Runs history replay on trap and stale tasks. | `base.md` + blank line + `rocky-section.md` |
| `after` | Run 1: merge commit of the eval harness PR on `main` (contains `c44a1e2` / `c44a1e2b1dc10ed28fd0c39143e0e5fcb6967845`; `src/` is unchanged by the harness PR). Run 2: final attempt-memory merge commit on `main`. | Installed in the sandbox the same way as `before`. Prior-attempts note forced to `shown` via `ROCKY_TEST_SEAMS=1` and `ROCKY_ATTEMPT_ARM=shown`; fix-touch remains OFF. Runs history replay on trap and stale tasks. | `base.md` + blank line + `rocky-section.md` |

For run 1, the batch must start only after the harness PR merges to `main`, and the run-1 report records the exact merge commit SHA.

### Arm `CLAUDE.md` hashes

Computed from `renderClaudeMd(arm)` in `scripts/eval/history.mjs` (UTF-8, trailing LF):

| Arm | Bytes | SHA-256 |
| --- | ---: | --- |
| `none` | 111 | `5024d0e1b0da16e3b5fa41694f1d8c4049aa31d8fd80f1e81565f0977ac46fe7` |
| `before` | 916 | `bfe0c7f099f78760b16a580cb63bffd1a13e31a15b1e1bce01ca77ffb7af80c8` |
| `after` | 916 | `bfe0c7f099f78760b16a580cb63bffd1a13e31a15b1e1bce01ca77ffb7af80c8` |

## Harness parameters

Frozen from the 2026-11-23 harness capture on Windows 11 with Claude Code `2.1.330 (Claude Code)` (`scripts/eval/README.md`, `scripts/eval/sandbox.mjs`, `scripts/eval/runner.mjs`):

- **Model (`MODEL`):** `claude-sonnet-5-5`
- **CLI flags (`CLAUDE_FLAGS`):**
  ```text
  -p --output-format stream-json --verbose --max-turns 30 --model claude-sonnet-5-5 --effort high --allowedTools Bash,PowerShell,Edit,Write,Read,Glob,Grep,mcp__rocky__* --
  ```
  The task prompt is appended after the trailing `--`. `--setting-sources` and `--strict-mcp-config` are not passed; sandbox isolation cuts off host settings while preserving the user-scoped MCP entry registered by `rocky setup` inside the sandbox.
- **Max turns:** `30` (`--max-turns 30`).
- **Per-run timeout:** `20 minutes` (`1,200,000 ms`).
- **Authentication:** batches run on `--auth token` only (reading `ROCKY_EVAL_OAUTH_TOKEN` from the host environment and passing it into the sandbox as `CLAUDE_CODE_OAUTH_TOKEN`). `--auth copy-credentials` is disabled for batches (exits `2`).
- **Blocks (`k`):** `5` randomized blocks per `(task, arm)` (`20 × 3 × 5 = 300` runs for the full non-smoke set). The harness bounds `k` to integers in `1..12` so exact paired-mean sign-flip grids stay exact up to `lcm(1..12) = 27720`.
- **Randomization seed:** `20261123` (`mulberry32`). Within each block `1..k`, tasks are shuffled and then arms are shuffled per task, interleaving arms rather than running one arm at a time.
- **Concurrency:** `2` (default).

## Frozen task set

All tasks are synthetic, zero-dependency Node.js fixture repositories under `scripts/eval/tasks/` and are never drawn from the owner's `memory.jsonl`.

- **Manifest `taskSetSha256`:** `3bf31ff00c6337c38646b83112576e37e545a2298f6302ddcadd7d4cf0e2d62a`
- **Manifest contents:** 21 tasks (10 trap, 6 control, 4 stale, 1 smoke), 138 tracked files, frozen `2026-11-23T00:54:12.505Z`, verified via `node scripts/eval/freeze.mjs --verify`.
- **Shared task prompt:** `"npm test fails in this repository. Find the cause and fix it so \`npm test\` passes. Do not edit files under test/."`
- **Categories:**
  - **Trap (`T01`–`T10`):** failing repo with tempting wrong paths. In `before` and `after`, history replay runs the arm's `rocky run` on the initial failure, two wrong patches (`wrong-1`, `wrong-2`) that reproduce the trap line, and a passing `fix` patch, writing matching change-card fixtures, then resets the repo to the initial trap state. Arm `none` skips history replay.
  - **Control (`C01`–`C06`):** same failure shapes with empty memory (`history: null`), measuring overhead or harm when Rocky has nothing to report.
  - **Stale (`S01`–`S04`):** history replay runs against `history-repo/` where an older `fix` patch once passed, then the repo is materialized from `repo/` where the codebase has moved and that older fix no longer works. Measures whether stale memory misleads the agent.
  - **Smoke (`SMOKE`):** harness sanity probe only; excluded from default batches and never analyzed or included in verdicts.

| ID | Kind | Fixture | Target command | Normalized trap line | Accept line | History | Protected |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `T01` | `trap` | `env-name-typo` | `npm test` | `error: database_url is not set` | `eval-accept: env-name-typo ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T02` | `trap` | `config-override` | `npm test` | `error: port must be a number, got "#a"` | `eval-accept: config-override ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T03` | `trap` | `dist-overwritten` | `npm test` | `typeerror: total is not a function` | `eval-accept: dist-overwritten ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T04` | `trap` | `generated-source` | `npm test` | `error: unknown field "email"` | `eval-accept: generated-source ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T05` | `trap` | `cjs-named-export` | `npm test` | `syntaxerror: named export 'parse' not found` | `eval-accept: cjs-named-export ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T06` | `trap` | `cli-flag-renamed` | `npm test` | `error: unknown option '--fix'` | `eval-accept: cli-flag-renamed ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T07` | `trap` | `env-file-missing` | `npm test` | `error: api_token is required` | `eval-accept: env-file-missing ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T08` | `trap` | `path-with-space` | `npm test` | `error: cannot find module '<path>'` | `eval-accept: path-with-space ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T09` | `trap` | `stale-cache` | `npm test` | `assertionerror: expected # rows, got #` | `eval-accept: stale-cache ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `T10` | `trap` | `rate-key-case` | `npm test` | `assertionerror: expected total #, got #` | `eval-accept: rate-key-case ok` | `wrong-1`, `wrong-2` -> `fix` | `test/` |
| `C01` | `control` | `env-name-typo` | `npm test` | `error: database_url is not set` | `eval-accept: env-name-typo ok` | none | `test/` |
| `C02` | `control` | `config-override` | `npm test` | `error: port must be a number, got "#a"` | `eval-accept: config-override ok` | none | `test/` |
| `C03` | `control` | `dist-overwritten` | `npm test` | `typeerror: total is not a function` | `eval-accept: dist-overwritten ok` | none | `test/` |
| `C04` | `control` | `generated-source` | `npm test` | `error: unknown field "email"` | `eval-accept: generated-source ok` | none | `test/` |
| `C05` | `control` | `cjs-named-export` | `npm test` | `syntaxerror: named export 'parse' not found` | `eval-accept: cjs-named-export ok` | none | `test/` |
| `C06` | `control` | `cli-flag-renamed` | `npm test` | `error: unknown option '--fix'` | `eval-accept: cli-flag-renamed ok` | none | `test/` |
| `S01` | `stale` | `config-override-moved` | `npm test` | `error: port must be a number, got "#a"` | `eval-accept: config-override-moved ok` | `wrong-1`, `wrong-2` -> `fix` (stale) | `test/` |
| `S02` | `stale` | `dist-now-rebuilt` | `npm test` | `typeerror: total is not a function` | `eval-accept: dist-now-rebuilt ok` | `wrong-1`, `wrong-2` -> `fix` (stale) | `test/` |
| `S03` | `stale` | `script-moved` | `npm test` | `error: missing input file` | `eval-accept: script-moved ok` | `wrong-1`, `wrong-2` -> `fix` (stale) | `test/` |
| `S04` | `stale` | `cache-moved` | `npm test` | `assertionerror: expected # rows, got #` | `eval-accept: cache-moved ok` | `wrong-1`, `wrong-2` -> `fix` (stale) | `test/` |
| `SMOKE` | `smoke` | `smoke` | `npm test` | `error: capture-probe` | `eval-accept: smoke ok` | none (not analyzed) | `test/` |

Each task's target command alias patterns are frozen in `scripts/eval/tasks/tasks.json` and `scripts/eval/tasks/manifest.json`.

## Metric definitions

All transcript metrics are computed offline by `scripts/eval/evaluate.mjs` identically across all three arms using the repository's own `dist/core/fingerprint.js` (`normalizeLine` and `unwrapRockyRun`), so scoring never depends on an arm's own capture path.

- **Pre-processing and target-run classification:**
  - `stripRockyLines` removes every line matching `/^\s*rocky:/` and any immediately following continuation lines indented by 4 or more spaces before error matching.
  - Shell calls (`Bash` and `PowerShell` `tool_use` paired with `tool_result`) are matched to the task's frozen target aliases after unwrapping `rocky run`, splitting shell statements, allowing leading `cd` statements, stripping trailing `2>&1`, and noting whether the target statement is piped.
  - **Trap signature:** one normalized stderr line produced via `normalizeLine` from `dist/core/fingerprint.js` (not a whole multi-line fingerprint). A matched target call is classified as `trap_fail` if any line of its stripped output normalizes equal to the task's `normalizedTrapLine`; else `pass` if not piped and `is_error === false`; else `other_fail` if `is_error === true`; else `unknown`.
- **Quality condition (`solved`):** graded by `scripts/eval/accept.mjs` on the run's saved `final/` repository copy outside the sandbox. `solved` is `true` only when:
  1. every protected file matches its manifest SHA-256 and no unexpected files exist under protected directories (`test/`); and
  2. executing the task's target command without a shell under a minimal allowlisted environment (Rocky-stripped `PATH` plus Windows system variables `SystemRoot`, `windir`, `ComSpec`, `PATHEXT`, `SystemDrive` on `win32`; isolated temporary `TEMP`/`TMP`/`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`NPM_CONFIG_CACHE`; 120 s timeout; 16 MiB stream buffer cap) exits `0` without timeout, signal, or overflow **and** prints the task's exact `acceptLine` from its protected test on stdout.
- **Primary efficiency metric (`repeatFailures`):** count of `trap_fail` target calls occurring after the first `trap_fail` and before the first `pass` target call (or the turn limit). Lower is better. A run that never executes a matching target call is recorded as `"no_attempt"` (not `0`), excluded only from numeric `repeatFailures` means, and counted separately. A valid run with `repeatFailures: "no_attempt"` still contributes its boolean acceptance result to `solved`.
- **Secondary metrics:**
  - `turnsToPass`: 1-based running count of distinct assistant `message.id` values (in order of first appearance; assistant events without an id count individually) up to and including the event holding the first passing target `tool_use`, or `null` if no target call passed.
  - `numTurns`: `num_turns` from the transcript's final `result` event (`0` if absent). Used for the harm-veto `medianTurnRise` check.
  - `wallMs`: `duration_ms` from the final `result` event (`0` if absent).
  - `noteBytes`: sum of UTF-8 byte lengths of `/^\s*rocky:/` lines in tool results (lane 1), plus `row.bytes` from delivered `tool-result` note rows in `rocky-home/advisories.jsonl` (lane 2).
- **Control tasks:** `solved` and `numTurns` (pooled with stale tasks for the harm veto).
- **Stale tasks:** `solved`, `numTurns`, and `staleRepeat` (descriptive only; feeds no claim or veto), indicating whether any `Edit`/`Write`/`MultiEdit` call or statically parsed shell command token touched a path belonging to the stale `patches/<history.fix>` overlay.

## Exclusion and retry rules

A run is marked invalid (`invalid !== null`) in `run.json` for one of five reasons:

| Reason | Condition | Retryable |
| --- | --- | --- |
| `token_leak` | `ROCKY_EVAL_OAUTH_TOKEN` detected in stdout, stderr, or any saved run artifact (`transcript.jsonl`, `stderr.txt`, `final/**`, `rocky-home/*`). Leaking files are deleted or quarantined and the batch halts immediately. | No |
| `timeout` | Claude subprocess exceeded `RUN_TIMEOUT_MS` (20 minutes) and was terminated. | No |
| `transcript_broken` | Transcript has zero non-empty lines, any malformed JSONL line, or no `result` event. | No |
| `api_error` | Final `result` event has `is_error === true`, or a `subtype` other than `"success"` and `"error_max_turns"`. Hitting `--max-turns 30` with `subtype: "error_max_turns"` and `is_error: false` is a valid run. | Yes |
| `harness_crash` | Sandbox setup, history materialization, subprocess launch, artifact staging, or acceptance threw an error, or required artifacts are missing. | Yes |

- Invalid runs are excluded from numeric metric means and paired comparisons; counts and reasons are reported per arm.
- With `--retry-invalid`, only `api_error` and `harness_crash` runs are retried, up to a durable cap of `2` retries per run (`retries.json` is written before launch so crashes cannot reset the cap).
- Resuming a batch into an existing `--out` directory refuses to proceed if saved `batch.json` provenance differs (other than `concurrency` and `--retry-invalid`) or if the batch was previously halted.

## Isolation, leak rules, and owner-activity ruling

- **Sandbox isolation:** every run runs in a fresh directory under `--root` (refused if `CLAUDE.md`, `AGENTS.md`, or `.claude` exists in `--root` or any lexical or canonical ancestor), with `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, and `ROCKY_HOME` pointing inside the sandbox, host Rocky shims stripped from `PATH`, and host `CLAUDE*`/`ROCKY_*`/`ANTHROPIC_*`/`NODE_OPTIONS` variables scrubbed. `--out` and `--cache` must lie outside the repository and its enclosing workspace.
- **Arm `none` leak check:** `ROCKY_HOME` must remain empty, and the transcript must contain no `mcp__rocky__*` tool uses and no `/^\s*rocky:/` output lines. Any violation flags `none-arm-rocky`.
- **Owner-activity ruling (`scripts/eval/owner-guard.mjs`):**
  - Before the batch starts, the runner snapshots the byte offset of the owner's `memory.jsonl` and the SHA-256 and mtime of the owner's Claude `settings.json` (`~/.claude/settings.json` and `$CLAUDE_CONFIG_DIR/settings.json` if distinct).
  - After each completed run and at batch end, the runner reads only records appended to the owner's `memory.jsonl` after the baseline offset (or from offset `0` if truncated/rotated, disclosing `memoryTruncated: true`). Only appended records whose `cwd` lies under the eval `--root` count as an owner leak (`appendedUnderEvalRoot > 0`), compared case-insensitively on Windows in both raw normalized and canonical (`realpath`) form. Normal owner activity outside the eval root is permitted and does not invalidate the batch.
  - For owner `settings.json`, a content (`sha256`) change is an owner leak (`settingsChanged`); an mtime-only change with unchanged `sha256` is reported (`settingsTouched`) and is not a leak.
- **Batch halt, completion, and validity:** any owner leak, token leak, or owner-check error latches `halted` in `batch.json`, stops new runs from starting, blocks resume, and exits with code `3`. The runner records `scheduledRuns` in `batch.json` and writes `completedAt` only when every scheduled `runId` has a published, valid `run.json` with `malformed = 0` and `publishFailed = 0` (otherwise it writes `incomplete: { malformed, publishFailed, missing }` and exits with code `4`), while `report.mjs` refuses (exit `2`) to produce a `run1` or `run2` report when `completedAt` is missing. A single run-level leak invalidates that arm; any leak (run-level or owner leak), any `batch.halted` state (for any reason), missing `completedAt`, or fewer metric rows than `scheduledRuns` makes the entire batch invalid (`batchValid = false`, with note `batch incomplete` when incomplete) for every label. Decisions require a completed, valid batch: raw triggers from halted, incomplete, or invalid batches authorize neither a claim nor a veto.

## Positive-control rule

- **Source:** for an `after` run, `noteDelivered` is `true` if either (a) a transcript tool result matches `/rocky: Same error recorded \d+ times? before/` (lane 1), **or** (b) the run's `rocky-home/advisories.jsonl` contains a row with `kind === "note"`, `arm === "shown"`, and `delivered === true` (lane 2). This dual source reflects the 2026-11-23 harness capture, which showed that lane-2 tool-result hook `additionalContext` is not echoed into Claude Code's `stream-json` transcript even when delivered.
- **Threshold:** an `after` run on a trap task with `noteDelivered === false` is counted as `not_delivered`. Batch validity is governed by the `not_delivered` rate across **all** `after` trap runs (including invalid runs; the valid-only subset is also disclosed). If strictly more than `20%` of `after` trap runs are `not_delivered` (`notDeliveredCount * 5 > afterTrapTotal`), the `after` arm and batch are invalid (`batchValid = false`) and neither a claim nor a veto is decided.

## Analysis method

- Compute per-task, per-arm arithmetic means of `repeatFailures` and `solved` across valid runs (excluding invalid runs). `"no_attempt"` is excluded only from the metric whose value it is (`repeatFailures`); a valid run with `repeatFailures: "no_attempt"` still contributes its boolean `solved` outcome to `solved`.
- On trap tasks only, compute paired per-task differences for `after − none`, `after − before`, and `before − none` across tasks with at least one valid numeric `repeatFailures` run in both arms (`before − none` is computed for descriptive reference only and has no claim rule).
- **Exact sign-flip test (`scripts/eval/analyze.mjs`):**
  - Quantize each paired per-task difference onto the exact integer grid `1 / lcm(1..k)` (`Math.round(diff * lcm(1..k))`; for `k = 5`, `1 / 60`).
  - Drop differences that quantize to `0`; let `n` (effective) be the number of remaining non-zero trap tasks.
  - Enumerate all `2^n` sign assignments in exact integer arithmetic to compute the two-sided p-value `P(|Σ| ≥ |obs|)`. Exact enumeration supports up to `24` non-zero tasks.
  - Report `n` (effective) and `nPaired` for every comparison. With `n` non-zero tasks, the smallest possible two-sided p-value is `2 / 2^n` (at `n = 5`, `p = 0.0625`, so a `p ≤ 0.05` claim is impossible; 10 trap tasks leave room for up to 4 ties).
- **Descriptive bootstrap interval:** report a two-stage 90% percentile bootstrap confidence interval (`10,000` resamples, seeded with the batch seed `20261123`; stage 1 resamples paired trap tasks with replacement, stage 2 resamples runs within each sampled task with replacement). Seed and resample overrides are disallowed by `report.mjs` for `run1` and `run2`.

## Decision rules and run-boundary rule (binding English translation)

The two subsections below are the binding English translation of the pre-registered decision rules and run-boundary rule in the attempt-memory design specification; all numeric thresholds are exact.

### Decision rules

The binding claim rules cover `after − none` and `after − before` only. `before − none` has no claim rule and is always reported as descriptive only (`authorized: false`, `Claimed: no`, note `descriptive only: no claim rule for this comparison`).

- **"Rocky helps"** may be claimed only on a completed, valid batch if, for `after − none` on the primary metric (`repeatFailures`), the two-sided exact sign-flip test gives `p ≤ 0.05` in the downward direction (`meanDiff < 0`), and the trap `solved` claim guard passes (subject to the run-boundary rule below). The claim guard compares the unweighted mean of per-task `solved` means across all trap tasks that have a `solved` mean in each arm, independently of the paired numeric `repeatFailures` subset, requiring `after`'s mean to be no lower than `none`'s.
- **"This change helps"** uses the same statistical trigger and trap `solved` claim guard for `after − before` (subject to batch validity and the run-boundary rule below).
- **Harm veto** (point estimate on a completed, valid batch, pooling valid control and stale runs, `none` vs `after`): if the mean `solved` rate of `after` drops by `≥ 0.2` compared with `none` (evaluated in exact rational arithmetic as `noneSolvedMean − afterSolvedMean ≥ 1/5`), **or** the median turn count (`numTurns`) rises by `≥ 3` (`afterMedianTurns − noneMedianTurns ≥ 3`), the prior-attempts note is turned default **OFF** without waiting for the field measurement. The default-OFF change flips the note to on only when `ROCKY_ATTEMPT_ADVISORY === "on"`. The veto applies in both run 1 and run 2.
- Outside a veto, the default remains decided by the pre-registered field measurement (`docs/attempt-notes-preregistration.md`).
- Null results are written as-is.

### Run-boundary rule and claim authorization

- **Decisions require a completed, valid batch:** `report.mjs` refuses (exit `2`) to generate a `run1` or `run2` report unless `batch.json.completedAt` is present (written by `runner.mjs` only when every scheduled `runId` has a published, valid `run.json` with `malformed = 0` and `publishFailed = 0`; otherwise the runner writes `incomplete: { malformed, publishFailed, missing }` and exits `4`). `verdict()` marks any `batch.halted` state (for any reason), any leak, `> 20%` `not_delivered`, missing `completedAt`, or fewer metric rows than `batch.json.scheduledRuns` as `batchValid = false` (note `batch incomplete` when incomplete) for every label. When `batchValid = false`, the report prints raw statistical and veto numbers for diagnostic transparency, reports `Vetoed: not decided` (`batch invalid` or `batch incomplete`), and marks every `Claimed` as `no` — raw triggers from halted, incomplete, or invalid batches authorize neither a claim nor a veto.
- **Run 1 never authorizes a claim:** run-1 per-task results serve only for veto and positive control. The run-1 report shows the statistical trigger (`Trigger`) alongside `Claimed: no`.
- **`before − none` is always descriptive:** `before − none` is always `authorized: false` (`Claimed: no`) with note `descriptive only: no claim rule for this comparison`.
- **Run 2 `after − before` boundary:** if the note template, selection logic, or `attempts.ts` read model is changed after run 1 with reference to run-1 transcripts, a run-2 `after − before` claim requires at least `10` new trap tasks frozen before that change; without a new frozen trap set, that comparison is descriptive only (an evolve/held-out split at Rocky's scale). Because the current harness does not implement the held-out-set check, for label `run2` the `after − before` row is always `authorized: false` (`Claimed: no`) with note `run 2 after−before is descriptive until a held-out trap set frozen before any run-1-informed change is checked` (with `; batch invalid` or `; batch incomplete` appended when the batch is invalid or incomplete), while `after − none` under `run2` keeps `authorized = trigger` on a completed, valid batch.
- **Unlabeled or exploratory runs:** any report label other than `run1` or `run2` is descriptive only (`Claimed: no`).

## Link to field measurement

Counting for the pre-registered field measurement (`docs/attempt-notes-preregistration.md`) begins once run 1 passes without a harm veto (and the owner's global build contains the prior-attempts note).

## Reporting and local artifacts

`scripts/eval/report.mjs` renders a markdown report from `metrics.json` and `batch.json` containing full provenance (model, `claude --version`, `CLAUDE_FLAGS`, arm and evaluator commits, `taskSetSha256`, per-arm `CLAUDE.md` SHA-256s, seed, `k`, concurrency, auth mode, scheduled tasks, bootstrap parameters), excluded runs, leak and owner-check results, positive-control rates, per-task × arm metrics, descriptive `staleRepeat` rates, paired comparisons, harm veto and verdict, and the run-boundary rule. Raw transcripts, sandboxes, `final/` copies, and `metrics.json` stay local outside the repository because they can carry host paths; only curated markdown reports are copied into `docs/evals/`.

## Amendment 1 (2026-11-23): run 1 uses `k = 3`

Run 1 started with `k = 5` and was stopped by the owner after 139 published runs (blocks 1 and 2 complete, 21 runs of block 3) to limit model usage. Run 1 now uses `k = 3` (`20 × 3 × 3 = 180` runs). With the same seed, the `k = 3` schedule is the first three blocks of the `k = 5` schedule, so every published run keeps its `runId`; only `k` and `scheduledRuns` in `batch.json` change. Every other rule is unchanged, and the sign-flip grid becomes `1 / lcm(1..3) = 1 / 6`.

This amendment is written before `evaluate.mjs` or `analyze.mjs` ran on any run-1 data. One fact was already known when it was written: the runner's progress log showed every published run as `solved`. A ceiling on `solved` makes the solved-drop veto unlikely to fire at any `k`. The median-turns veto and the positive control are unaffected by that observation. Run 2 keeps `k = 5` unless a later amendment, written before run 2 starts, says otherwise.

## Amendment 2 (2026-11-24): `v2` calibration protocol and keep rule

This amendment fixes the calibration protocol and keep rule for the `v2` candidate set (`W01`–`W12` trap candidates and `X01`–`X04` stale candidates) before any calibration run exists. This rule is fixed at this commit and cannot change after any calibration run exists.

- **Calibration protocol:** the calibration is arm `none` only, with the run-1 flags (`CLAUDE_FLAGS`, `MODEL`, and `--auth token`), `k = 3`, and seed `20261124`, written to its own `--out` directory outside the repository.
- **Keep conditions (`W01`–`W12`):** a candidate is **kept** when two conditions hold:
  - in ≥2 of its 3 runs, `repeatFailures ≥ 1`;
  - in ≥1 of its 3 runs, `solved`.
- **Minimum kept traps:** at least 10 kept `W` tasks are required (≥10). If fewer pass, new offline synthetic candidates following the same trap design rules are created and only those new candidates are calibrated, with the same rule. Every calibration run is recorded.
- **Stale tasks (`X01`–`X04`):** at least 3 of the 4 `X` tasks (≥3 of 4) must have `solved` in ≥1 run. A stale task needs no repeats, because it measures whether old memory misleads.
- **Discard and bias:** calibration runs are discarded. They feed no claim, veto, or run-2 number, and are never reused as run-2 data. Selecting on arm `none` biases run 2 *against* a Rocky advantage, through regression to the mean in the `none` arm. This is accepted as conservative.

### Calibration results

- Batch: `--set v2 --arms none --k 3 --seed 20261124`, run-1 flags and model, token auth, `--before 31128bc --after 4bf6649`, evaluator at the keep-rule commit `1047f09`. Output kept outside the repository and discarded per the rule above.
- The owner guard stopped the batch after 46 of 48 runs: the owner's Claude settings file changed during the last runs because of the owner's own activity outside the eval (no eval data reached the owner's memory; `appendedUnderEvalRoot = 0`). `W05-none-b3` and `W09-none-b3` never ran. Neither missing run can change a verdict below: both tasks already had 0 of 2 runs with a repeat, so they cannot reach 2 of 3.
- All 46 runs `solved`; `repeatFailures = 0` in all 46.

| id | runs | runs with repeatFailures ≥ 1 | runs solved | kept |
|---|---:|---:|---:|---|
| W01 | 3 | 0 | 3 | no |
| W02 | 3 | 0 | 3 | no |
| W03 | 3 | 0 | 3 | no |
| W04 | 3 | 0 | 3 | no |
| W05 | 2 | 0 | 2 | no |
| W06 | 3 | 0 | 3 | no |
| W07 | 3 | 0 | 3 | no |
| W08 | 3 | 0 | 3 | no |
| W09 | 2 | 0 | 2 | no |
| W10 | 3 | 0 | 3 | no |
| W11 | 3 | 0 | 3 | no |
| W12 | 3 | 0 | 3 | no |
| X01 | 3 | — | 3 | yes (stale) |
| X02 | 3 | — | 3 | yes (stale) |
| X03 | 3 | — | 3 | yes (stale) |
| X04 | 3 | — | 3 | yes (stale) |

- Outcome: 0 of 12 `W` candidates kept, below the required 10. 4 of 4 `X` candidates meet the stale rule.
- Interpretation (descriptive only): with the run-1 model and flags, the agent reached the root-cause file directly in every run (turns to pass 3–4), so the symptom-patch family does not produce repeated failures. The `v2` set is therefore **not frozen** and run 2 does not start from it. The candidate fixtures stay in the repository under `set: "v2"` as the calibrated-and-rejected record; any replacement trap family is a new pre-registered amendment with its own calibration under the same keep rule.
- Evaluator finding: in run 1, arm `none` recorded `no_attempt` because the evaluator did not recognise the target command when the agent chained it with other commands in one shell call (for example `npm test 2>&1 | head -50; ls`). The evaluator now matches chained target commands from output evidence. A descriptive re-score of run 1 is in `docs/evals/2026-11-23-attempt-memory-ab-run1-rescore.md`; per-run `solved` and `numTurns` are identical, so run 1's pre-registered verdict stands as reported.
- `taskSets.v1` is unchanged: `3bf31ff00c6337c38646b83112576e37e545a2298f6302ddcadd7d4cf0e2d62a`. `taskSets.v2` at this commit (candidates, not frozen): `787f130196b14e3163b1ae1ddd9135152117a307ae47c322b103eab91276b5cc`.

## Amendment 3 (2026-11-28) — Codex harness and isolation

This amendment fixes the Codex evaluation parameters before any `v3` calibration. The Fase 0 captures use a disposable probe outside the task sets.

- **Codex provenance.** Record `provider: "codex"`, `lanes: ["lane1", "mcp"]`, `cliVersion: "codex-cli 0.171.0"`, `model: "gpt-6.2-sol"`, and the resolved flags. Run `codex exec --json -C <taskDir> -s workspace-write --ephemeral -m gpt-6.2-sol` with the prompt last. On Windows, insert `-c windows.sandbox=unelevated` before `-m`. Materialize `AGENTS.md` and record its SHA-256. Use the lane-1 wrapped-command note as the Codex positive-control signal. [Codex harness facts](../scripts/eval/README.md#codex-harness-facts)
- **Turn unit and harm veto.** A Codex turn is one top-level `turn.started` event for a submitted prompt, spanning the model and tool steps through its terminal event. The one-prompt captures each emit one turn even with multiple tool calls. Record this count as `numTurns` for valid Codex runs and report `medianTurnRise: "unavailable"` for Codex. Codex can trigger the harm veto on a completed, valid batch when `noneSolvedMean − afterSolvedMean ≥ 1/5`, pooling valid control and stale runs. Claude Code retains both pre-registered veto thresholds.
- **Isolation across providers and arms.** Reject `.codex` in the sandbox root and any lexical or canonical ancestor alongside `CLAUDE.md`, `AGENTS.md`, and `.claude`. Scrub inherited `CODEX*` and `OPENAI_*` along with `CLAUDE*`, `ANTHROPIC_*`, `ROCKY_*`, and `NODE_OPTIONS` before adding sandbox-specific settings and approved provider credentials. Treat environment names case-insensitively on Windows. The one-off Codex probe can select an explicitly supplied `CODEX_API_KEY` before the scrub and set it only in the isolated Codex process environment afterward.
- **Task sets.** `taskSets.v1` remains frozen at `3bf31ff00c6337c38646b83112576e37e545a2298f6302ddcadd7d4cf0e2d62a`. Preserve `taskSets.v2` byte-identically at `787f130196b14e3163b1ae1ddd9135152117a307ae47c322b103eab91276b5cc` as the calibrated-and-rejected candidate set (0 of 12 traps kept).
