# Prior-attempt notes: field measurement pre-registration

**Frozen:** 2026-11-22
**Status:** Pre-registered before activation of the prior-attempts note.

This document specifies the field measurement protocol for the prior-attempts note (`shown` vs `held`) and the schema of its exposure log. It is a measurement protocol only: it makes no causal claims and publishes no projected effect sizes.

## Units of analysis

- **Primary unit:** the first eligible episode per session. An eligible episode is the first failure in session `S` for problem key `K` when `K` already has at least one prior non-`passed` attempt. Each session contributes at most one primary unit, keeping primary units independent across sessions.
- **Secondary analysis:** all eligible episodes across sessions, evaluated with a session-cluster bootstrap confidence interval (resampling sessions as clusters).

## Assignment and arms

Session-scoped assignment is deterministic from the session identifier using the first bit of `sha256(session)`. One session stays in one arm throughout, and analysis is intent-to-treat (ITT) by assigned arm.

| Arm | Condition | Behavior | Analysis role |
| --- | --- | --- | --- |
| `shown` | Session present; first bit of `sha256(session)` is `0` | Renders and emits the prior-attempts note; logs exposure. | Included in ITT comparison. |
| `held` | Session present; first bit of `sha256(session)` is `1` | Computes the note and logs exposure while withholding the new prior-attempts block (command/shell lane 1 still prints the existing `Same error as before ...` line; tool-result hook lane 2 outputs `{}`). | Included in ITT comparison. |
| `unassigned` | No session identifier, running in an agent shell (`CLAUDECODE=1`) | Withholds the note and logs exposure. | Excluded from comparison; counted separately. |
| `human` | No session identifier, not an agent shell (human terminal) | Shows the note and logs exposure. | Excluded from comparison; counted separately. |

Episodes in `unassigned` and `human` (no-session episodes) are excluded from the `shown` vs `held` comparison and their counts are reported alongside the arm counts. Setting `ROCKY_ATTEMPT_ADVISORY=off` suppresses both the note and exposure logging.

## Metrics

- **Primary metric:** `passed_in_session` — binary indicator of whether problem key `K` records a `passed` attempt in session `S` after the eligible moment.
- **Secondary metrics:**
  - `same_failure` count after the eligible moment (guards against a ceiling effect on the binary primary metric);
  - repeat-file-set rate on the subset of episodes with `changes.state = "observed"`, with the observed subset denominator disclosed;
  - `observed` outcomes from recorded expectations (`note_expectation`);
  - lane-2 p95 latency from `latencyMs`;
  - mean note bytes from `bytes`.
- **Episodes that left the tail:** if an episode's anchor failure (`anchorFailureId`) is no longer readable within the memory tail window at analysis time, those episodes are disclosed separately and are not counted as failures.

## Statistical power and peeking policy

- **Power:** at 300 primary units (150 per arm, baseline rate `p ≈ 0.5`), the minimum detectable effect (MDE) is approximately 14 percentage points at α = 0.10 two-sided and 80% power. Smaller effects are likely to end inconclusive, and that outcome is accepted.
- **No peeking:** before a stop rule is met, `rocky stats --attempts` shows only per-arm episode counts and never displays the `shown − held` difference.

## Start, stop, and decision rules

- **Start:** counting begins when the owner's global build contains the prior-attempts note and the first controlled evaluation run (no Rocky vs old Rocky vs new Rocky) has passed without a veto.
- **Stop:** 300 primary units or 120 days from start, whichever comes first.
- **Decision:** apply the owner friction override first, then evaluate the Newcombe 90% confidence interval for the difference `shown − held` on primary units:
  - **Owner friction override:** if an owner friction journal entry is recorded → prior-attempts note turns default **OFF**, regardless of the interval.
  - Otherwise, compute the Newcombe 90% confidence interval for `shown − held`:
    - Lower bound `> 0` → prior-attempts note stays default **ON**.
    - Upper bound `< 0` → prior-attempts note turns default **OFF**.
    - Inconclusive (interval contains `0`) → prior-attempts note turns default **OFF**; the CLI (`rocky attempts`) and MCP surfaces stay.

## Reporting

- Null and inconclusive results are written as-is.
- Any analysis beyond the pre-registered primary and secondary definitions above is labelled **exploratory**.
- Summary output is produced on demand by `rocky stats --attempts [--json]` as a derived report; aggregates are never written to `memory.jsonl`.

## Exposure log schema

The exposure log lives at `~/.rocky/advisories.jsonl` (under `ROCKY_HOME` when set), one JSON object per line.

- **Non-evidence:** `advisories.jsonl` is a derived measurement log and is never written to `memory.jsonl`.
- **Coverage of events:** records `kind: "note"` rows for every eligible moment across all arms (`shown`, `held`, `unassigned`, `human`), plus `kind: "skip"` rows emitted by the tool-result hook lane when an invocation is skipped.
- **Size cap:** capped at 8 MiB (about 20k rows); writing stops at the cap, and `rocky stats --attempts` discloses when the cap is reached.
- **Privacy:** uses `cwdHash` (a 16-hex `sha256` prefix) and never writes a raw directory path.

Each `"note"` row follows this shape:

```json
{"v":1,"ts":1795300000000,"session":"sess-04","lane":"tool-result","kind":"note","arm":"shown","key":"output:3f2a9c1e44d0b7a1:0123456789abcdef","cwdHash":"0123456789abcdef","anchorFailureId":"fail-01","latencyMs":42,"delivered":true,"bytes":312}
```

A `"skip"` row from the tool-result lane carries an extra `reason` field and may have `null` for `session`, `arm`, `key`, and `anchorFailureId` (for example when a tool-result skip occurs before a problem key is available):

```json
{"v":1,"ts":1795300000500,"session":"sess-04","lane":"tool-result","kind":"skip","arm":null,"key":null,"cwdHash":"0123456789abcdef","anchorFailureId":null,"latencyMs":3,"delivered":false,"bytes":0,"reason":"lock_busy"}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `integer` | Schema version (`1`). |
| `ts` | `number` | Epoch milliseconds when the row was recorded. |
| `session` | `string` \| `null` | Session identifier when present; `null` when missing (never omitted). |
| `lane` | `"run"` \| `"watch"` \| `"hookfail"` \| `"tool-result"` | Delivery lane that evaluated the moment. |
| `kind` | `"note"` \| `"skip"` | Row category: `"note"` for an eligible prior-attempts moment, or `"skip"` for a skipped tool-result invocation. |
| `arm` | `"shown"` \| `"held"` \| `"unassigned"` \| `"human"` \| `null` | Assigned arm on `"note"` rows; `null` on a `"skip"` row when skipped before arm assignment. |
| `key` | `string` \| `null` | Problem key identifying the recurring error; `null` when a tool-result `"skip"` occurs before a problem key is available. |
| `cwdHash` | `string` | 16-hex `sha256` prefix of the working directory identity; never a path. |
| `anchorFailureId` | `string` \| `null` | Failure record id anchoring the eligible moment (used to detect episodes that left the memory tail); `null` when unavailable (such as on a `"skip"` row). |
| `latencyMs` | `number` | Elapsed evaluation and render latency in milliseconds (used for lane-2 p95 latency). |
| `delivered` | `boolean` | `true` only when the prior-attempts note was emitted. |
| `bytes` | `number` | Rendered note size in bytes (`0` when not emitted). |
| `reason` | `string` (optional) | Present on `kind: "skip"` rows only, recording why the tool-result hook skipped the invocation; omitted on `kind: "note"` rows. |
