# Rocky evidence schema

Rocky stores raw evidence as append-only JSONL. One record per line. Records
are never rewritten; readers tolerate unknown fields and unknown kinds.

## Envelope

Every record carries:

| Field | Type | Meaning |
|-------|------|---------|
| `kind` | string | Record discriminator. Present since v0.1. (The roadmap's "type" field maps to `kind`; the name is kept for append-only continuity.) |
| `id` | string | Stable unique id (UUID). |
| `ts` | number | Epoch milliseconds. |
| `v` | number | Per-record schema version. New kinds introduced in v0.6+ carry `v: 1`. Legacy kinds (`failure`, `fix`, `association`, `note`) predate `v` and omit it; `triple` uses its original `schemaV: 1`. |

Adding a kind means adding a row here. Never change the meaning of an
existing kind.

## Kinds

| Kind | File | Since | Status | Payload |
|------|------|-------|--------|---------|
| `failure` | `memory.jsonl` | v0.1 | active | `cwd, cmd, exitCode, fingerprint, fingerprintV, signature[], excerpt, origin?, resolvedBy?, commandIdentity?, identityV?, identityReliable?, platform?` |
| `fix` | `memory.jsonl` | v0.1 | active | `cwd, cmd, failureIds[], candidateFailureIds?, links?, commandIdentity?, identityV?, identityReliable?, platform?` |
| `association` | `memory.jsonl` | v0.5 | active | like `fix`, weak-evidence links only |
| `note` | `memory.jsonl` | v0.5 | active | `cwd, cmd, file, line, subject, answer` |
| `triple` | `memory.jsonl` | v0.5 | active | intent/mechanism/rationale triple, `schemaV: 1`, agent-hook origin |
| `journal` | `journal.jsonl` | v0.6 | active | `note` (single line, ≤500 chars) |
| `brief_run` | `memory.jsonl` | v0.6 | active | `cwd, sinceTs, commits, files` |
| `invariant_touch` | `memory.jsonl` | v0.6 | active | `cwd, invariant, path` |
| `guard` | `memory.jsonl` | — | **defined, not yet emitted** | `cwd, cmd, rule` — reserved for hook guard triggers; no writer exists yet |
| `rationale` | `memory.jsonl` | v0.7 | active | `cwd, agent, rationale_fidelity (raw\|summary\|none), source (log-thinking\|log-response\|notify\|human), excerpt, pointer?{logPath,sessionId,turnRef}, links?{tripleId,fixId,failureId}` |
| `alias` | `memory.jsonl` | v0.7 | active | `alias, concept, action (add\|retract)` |

## Adapter priority

`rationale` evidence with `source: "log-thinking"` or `"log-response"` comes from log adapters, tried in this order: `claude-code`, then `dsh`. Codex and Gemini log adapters are deferred — Codex's local session format has drifted to a SQLite hybrid, and Gemini persists no thoughts to read — so neither is read yet; both still reach `rationale` evidence only through the universal `notify` lane (`rocky hook agent-event <adapter> --rationale`).

## MCP `fixCommand`

`fixCommand`, as returned by the MCP tools, is the command whose success resolved a failure — it is not the fix method itself, and MCP never presents it as one. Re-running it is not proof it still fixes anything.

## Pointer rule

Code references are stored as pointers `{commit, path, lines}` and
reconstructed via git when needed. Stored verbatim: stderr excerpts of at
most 4 lines, user notes, commit messages.

## Derived data

Aggregates, rankings, and any recomputed views are never written back into
evidence files. Raw history is the asset; intelligence is a replaceable
layer.
