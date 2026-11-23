# Attempt Memory Eval Report — run1 (Rescore)

> **Rescore note:**
> - **Evaluator version:** Re-scored offline from the existing `run1` transcripts using `scripts/eval/evaluate.mjs` at this commit (which recognises target command pipelines preceded or followed by other shell statements across `;`, `&&`, and newline/heredoc boundaries). The `Evaluator commit` row in Provenance below reflects the original `batch.json` capture timestamp (`653780f2df98f9196cde7090db2e050f281dc19b`).
> - **Pre-registered verdict:** The pre-registered verdict stays the one recorded in the original report ([`2026-11-23-attempt-memory-ab-run1.md`](./2026-11-23-attempt-memory-ab-run1.md)): **Not vetoed — harm thresholds not exceeded** (`batchValid: true`, `vetoed: false`). All veto inputs (`solved` and `numTurns` for every run; `solvedDrop = 0.000`, `medianTurnRise = 1`) are unchanged.
> - **Metrics that moved:**
>   - `no_attempt` dropped from **43** (all in arm `none` across 16 tasks) to **0** across all 180 runs (`0` in every task and arm).
>   - `Mean repeatFailures` in arm `none` moved from `n/a` to `0.000` on 13 tasks (`T02`, `T03`, `T04`, `T06`, `T07`, `T09`, `C03`, `C04`, `C06`, `S01`, `S02`, `S04`) and remained `0.000` (now over all 3/3 valid runs instead of 1/3 or 2/3) on `T08`, `T10`, `C02`, `C05`, and `S03`.
>   - Paired trap tasks (`Paired` in Comparisons) moved from **4** to **10** for `afterVsNone (after - none)` and `beforeVsNone (before - none)` (`Mean diff = 0.000`, `n (eff) = 0`, `p = 1.0000`, `90% CI = [0.000, 0.000]`).
>   - `turnsToPass` became non-null on **36** additional runs (17 in `none`, 10 in `before`, 9 in `after`), moving per-task `Median turnsToPass` in:
>     - `none`: `T03` (`n/a` → `4`), `T04` (`n/a` → `4`), `T06` (`n/a` → `3`), `T09` (`n/a` → `5`), `C02` (`n/a` → `4`), `C03` (`n/a` → `3`), `C04` (`n/a` → `4`), `S02` (`n/a` → `3`), `S04` (`n/a` → `4`). (`T02`, `T07`, `C06`, and `S01` remain `n/a` in `none` because all 3 blocks piped the passing target run into `tail` or `Select-Object -Last`, which is classified as `unknown` under the pipe rule.)
>     - `before`: `T04` (`4.5` → `4`), `T07` (`n/a` → `4`), `T09` (`n/a` → `4`), `S04` (`n/a` → `4`).
>     - `after`: `S04` (`6` → `5`) (plus single-block `turnsToPass` recovery in `C03`, `C04`, `S01`, `T07`, and `T09` with unchanged task medians).
>   - All other metrics (`solved`, `numTurns`, `wallMs`, `noteBytes`, `noteDelivered`, `staleRepeat`, `leak`) are identical across all 180 runs.

## Provenance

| Field | Value |
|---|---|
| Label | run1 |
| Started at | 2026-11-23T07:53:02.922Z |
| Completed at | 2026-11-23T13:06:36.501Z |
| Model | claude-sonnet-5-5 |
| Claude version | 2.1.330 (Claude Code) |
| Claude flags | `-p --output-format stream-json --verbose --max-turns 30 --model claude-sonnet-5-5 --effort high --allowedTools Bash,PowerShell,Edit,Write,Read,Glob,Grep,mcp__rocky__* --` |
| Before commit | `31128bc46ca7aa0bdf10c6d35e8fce353163c1d0` (31128bc) |
| After commit | `653780f2df98f9196cde7090db2e050f281dc19b` (653780f) |
| Evaluator commit | `653780f2df98f9196cde7090db2e050f281dc19b` |
| Task set sha256 | `3bf31ff00c6337c38646b83112576e37e545a2298f6302ddcadd7d4cf0e2d62a` |
| CLAUDE.md sha256 | none=`5024d0e1b0da16e3b5fa41694f1d8c4049aa31d8fd80f1e81565f0977ac46fe7`, before=`bfe0c7f099f78760b16a580cb63bffd1a13e31a15b1e1bce01ca77ffb7af80c8`, after=`bfe0c7f099f78760b16a580cb63bffd1a13e31a15b1e1bce01ca77ffb7af80c8` |
| Seed | 20261123 |
| Blocks (k) | 3 |
| Concurrency | 2 |
| Auth mode | token |
| Tasks scheduled | T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, C01, C02, C03, C04, C05, C06, S01, S02, S03, S04 |
| Scheduled runs | 180 |
| Bootstrap | 10000 resamples, 90% two-stage CI (seed 20261123) |

## Excluded Runs

| Arm | Total runs | Valid runs | Excluded runs | Reasons |
|---|---:|---:|---:|---|
| none | 60 | 60 | 0 | none |
| before | 60 | 60 | 0 | none |
| after | 60 | 60 | 0 | none |

## Leak Results

| Arm | Leaking runs | Arm valid |
|---|---:|---|
| none | 0 | valid |
| before | 0 | valid |
| after | 0 | valid |

- Owner check: leak=false, appendedUnderEvalRoot=0, settingsChanged=0.
- Overall batch validity: **valid**.

## Positive Control

Positive-control source: note text in a tool result or a delivered note row in the run's advisories.jsonl.

- `not_delivered` over all `after` trap runs (governs batch validity; includes 0 invalid run(s), 0 undelivered): 0/30 (0.0%)
- `not_delivered` over valid `after` trap runs only (metric-eligible subset): 0/30 (0.0%)
- Positive-control status: PASS (<= 20% threshold)

## Per-Task Metrics

| Task | Kind | Arm | Mean repeatFailures | no_attempt | Mean solved | Median turnsToPass | Median wallMs | Mean noteBytes |
|---|---|---|---:|---:|---:|---:|---:|---:|
| T01 | trap | none | 0.000 | 0 | 1.000 | 4 | 13635 | 0.0 |
| T01 | trap | before | 0.000 | 0 | 1.000 | 4 | 14289 | 295.0 |
| T01 | trap | after | 0.000 | 0 | 1.000 | 4 | 14351 | 630.0 |
| T02 | trap | none | 0.000 | 0 | 1.000 | n/a | 14657 | 0.0 |
| T02 | trap | before | 0.000 | 0 | 1.000 | 4 | 16535 | 295.0 |
| T02 | trap | after | 0.000 | 0 | 1.000 | 4 | 16995 | 647.0 |
| T03 | trap | none | 0.000 | 0 | 1.000 | 4 | 14469 | 0.0 |
| T03 | trap | before | 0.000 | 0 | 1.000 | 5 | 17016 | 308.3 |
| T03 | trap | after | 0.000 | 0 | 1.000 | 4 | 17644 | 660.7 |
| T04 | trap | none | 0.000 | 0 | 1.000 | 4 | 12852 | 0.0 |
| T04 | trap | before | 0.000 | 0 | 1.000 | 4 | 15280 | 308.3 |
| T04 | trap | after | 0.000 | 0 | 1.000 | 3 | 14228 | 645.0 |
| T05 | trap | none | 0.000 | 0 | 1.000 | 3 | 12884 | 0.0 |
| T05 | trap | before | 0.000 | 0 | 1.000 | 3 | 15476 | 308.3 |
| T05 | trap | after | 0.000 | 0 | 1.000 | 3 | 15829 | 661.3 |
| T06 | trap | none | 0.000 | 0 | 1.000 | 3 | 13864 | 0.0 |
| T06 | trap | before | 0.000 | 0 | 1.000 | 4 | 14601 | 321.7 |
| T06 | trap | after | 0.000 | 0 | 1.000 | 3 | 14943 | 635.0 |
| T07 | trap | none | 0.000 | 0 | 1.000 | n/a | 15355 | 0.0 |
| T07 | trap | before | 0.000 | 0 | 1.000 | 4 | 14970 | 295.0 |
| T07 | trap | after | 0.000 | 0 | 1.000 | 4 | 15689 | 641.0 |
| T08 | trap | none | 0.000 | 0 | 1.000 | 3 | 12069 | 0.0 |
| T08 | trap | before | 0.000 | 0 | 1.000 | 4 | 15518 | 335.0 |
| T08 | trap | after | 0.000 | 0 | 1.000 | 3 | 14602 | 652.0 |
| T09 | trap | none | 0.000 | 0 | 1.000 | 5 | 18213 | 0.0 |
| T09 | trap | before | 0.000 | 0 | 1.000 | 4 | 18970 | 264.0 |
| T09 | trap | after | 0.000 | 0 | 1.000 | 6 | 24941 | 655.3 |
| T10 | trap | none | 0.000 | 0 | 1.000 | 3 | 11614 | 0.0 |
| T10 | trap | before | 0.000 | 0 | 1.000 | 4 | 13881 | 295.0 |
| T10 | trap | after | 0.000 | 0 | 1.000 | 3 | 13774 | 658.3 |
| C01 | control | none | 0.000 | 0 | 1.000 | 3 | 12939 | 0.0 |
| C01 | control | before | 0.000 | 0 | 1.000 | 5 | 16684 | 183.3 |
| C01 | control | after | 0.000 | 0 | 1.000 | 4 | 15140 | 159.7 |
| C02 | control | none | 0.000 | 0 | 1.000 | 4 | 14502 | 0.0 |
| C02 | control | before | 0.000 | 0 | 1.000 | 4 | 15608 | 133.0 |
| C02 | control | after | 0.000 | 0 | 1.000 | 4 | 17246 | 133.0 |
| C03 | control | none | 0.000 | 0 | 1.000 | 3 | 13863 | 0.0 |
| C03 | control | before | 0.000 | 0 | 1.000 | 4 | 15732 | 133.0 |
| C03 | control | after | 0.000 | 0 | 1.000 | 4 | 15906 | 133.0 |
| C04 | control | none | 0.000 | 0 | 1.000 | 4 | 14912 | 0.0 |
| C04 | control | before | 0.000 | 0 | 1.000 | 4 | 16579 | 133.0 |
| C04 | control | after | 0.000 | 0 | 1.000 | 4 | 15582 | 133.0 |
| C05 | control | none | 0.000 | 0 | 1.000 | 3 | 12554 | 0.0 |
| C05 | control | before | 0.000 | 0 | 1.000 | 4 | 14729 | 159.7 |
| C05 | control | after | 0.000 | 0 | 1.000 | 4 | 16264 | 159.7 |
| C06 | control | none | 0.000 | 0 | 1.000 | n/a | 13278 | 0.0 |
| C06 | control | before | 0.000 | 0 | 1.000 | 5 | 18333 | 173.0 |
| C06 | control | after | 0.000 | 0 | 1.000 | 5 | 19006 | 173.0 |
| S01 | stale | none | 0.000 | 0 | 1.000 | n/a | 13087 | 0.0 |
| S01 | stale | before | 0.000 | 0 | 1.000 | 4 | 15385 | 295.0 |
| S01 | stale | after | 0.000 | 0 | 1.000 | 4 | 16125 | 616.0 |
| S02 | stale | none | 0.000 | 0 | 1.000 | 3 | 12351 | 0.0 |
| S02 | stale | before | 0.000 | 0 | 1.000 | 4 | 15696 | 295.0 |
| S02 | stale | after | 0.000 | 0 | 1.000 | 4 | 16396 | 634.0 |
| S03 | stale | none | 0.000 | 0 | 1.000 | 3 | 13452 | 0.0 |
| S03 | stale | before | 0.000 | 0 | 1.000 | 5 | 18016 | 321.7 |
| S03 | stale | after | 0.000 | 0 | 1.000 | 5 | 21887 | 705.3 |
| S04 | stale | none | 0.000 | 0 | 1.000 | 4 | 16986 | 0.0 |
| S04 | stale | before | 0.000 | 0 | 1.000 | 4 | 17615 | 295.0 |
| S04 | stale | after | 0.000 | 0 | 1.000 | 5 | 21051 | 668.7 |

### Stale Tasks (`staleRepeat` Rate, Descriptive Only)

This metric is descriptive only and feeds no claim or veto.

| Arm | staleRepeat rate |
|---|---:|
| none | 0.333 |
| before | 0.333 |
| after | 0.417 |

## Comparisons

Paired per-task trap comparisons on `repeatFailures` (exact two-sided sign-flip test over non-zero differences; two-stage 90% bootstrap CI over all paired trap tasks).

| Comparison | n (eff) | Paired | Mean diff | p | 90% CI | Direction | solvedOk | Trigger | Claimed | Note |
|---|---:|---:|---:|---:|---|---|---|---|---|---|
| afterVsNone (after - none) | 0 | 10 | 0.000 | 1.0000 | [0.000, 0.000] | flat | yes | no | no | run 1 serves veto and positive control only |
| afterVsBefore (after - before) | 0 | 10 | 0.000 | 1.0000 | [0.000, 0.000] | flat | yes | no | no | run 1 serves veto and positive control only |
| beforeVsNone (before - none) | 0 | 10 | 0.000 | 1.0000 | [0.000, 0.000] | flat | yes | no | no | descriptive only: no claim rule for this comparison |

## Veto and Verdict

Pooled over valid control and stale runs (`none` vs `after`):

| Check | Value | Threshold | Triggered |
|---|---:|---|---|
| solvedDrop (none - after) | 0.000 | >= 0.200 | no |
| medianTurnRise (after - none, numTurns) | 1 | >= 3 | no |

- **Batch valid:** true
- **Vetoed:** false
- **Verdict:** Not vetoed — harm thresholds not exceeded.

## Run-Boundary Rule

Run-1 per-task results serve only for veto and positive control. If the note template, selection logic, or attempts read model is changed after run 1 using run-1 transcripts, a run-2 `after − before` claim requires at least 10 new trap tasks frozen before that change; without a new frozen trap set, that run-2 comparison is descriptive only. Because this harness does not yet verify a held-out trap set frozen before any run-1-informed change, run-2 `after − before` is always reported as descriptive only here.
