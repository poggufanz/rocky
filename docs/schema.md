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
| `guard` | `memory.jsonl` | v1.0 | active | `cwd, cmd, rule, outcome (cancelled\|proceeded)` — hook guard triggers; drained from `guard.pending` TSV (`ts, outcome, rule, cwd, cmd`) |
| `rationale` | `memory.jsonl` | v0.7 | active | `cwd, agent, rationale_fidelity (raw\|summary\|none), source (log-thinking\|log-response\|notify\|human), excerpt, pointer?{logPath,sessionId,turnRef}, links?{tripleId,fixId,failureId}, files?[]` (bounded paths from notify `--files` (v0.7.5+) or `rocky why --add --files`, which writes the same field, max 8 entries of 512 chars; the PreToolUse gate reads them as file-linked evidence. `why --add` with `--files` writes no `links`; without it, `links` may name the newest failure or fix heard in that directory within 8 hours) |
| `alias` | `memory.jsonl` | v0.7 | active | `alias, concept, action (add\|retract)` |
| `explain` | `memory.jsonl` | v0.7.x teach | active | `cwd, path (bounded 512 chars), source (agent:<harness>), code (bounded excerpt: why this code shape), business (bounded excerpt: business concern), snippet? (written hunk, ≤2048 bytes, redacted), contentHash? (sha256/32 of normalized snippet). Witness testimony from the writing AI, captured at edit time via PostToolUse pending-snippet + notify join. Hearsay, never ground truth. Ladder/assembled answers are NEVER stored as this kind. |

## Adapter priority

`rationale` evidence with `source: "log-thinking"` or `"log-response"` comes from log adapters, tried in this order: `claude-code`, then `dsh`. Codex and Gemini log adapters are deferred — Codex's local session format has drifted to a SQLite hybrid, and Gemini persists no thoughts to read — so neither is read yet; both still reach `rationale` evidence only through the universal `notify` lane (`rocky hook agent-event <adapter> --rationale`).

## MCP `fixCommand`

`fixCommand`, as returned by the MCP tools, is the command whose success resolved a failure — it is not the fix method itself, and MCP never presents it as one. Re-running it is not proof it still fixes anything.

## teach `explain` projection (`provenance`)

`teach_lookup` projects a `provenance` field shaped `{ commit, author, date, subject }` (7-char commit, git author name, commit date, redacted subject). It is `undefined` on witness hits and when provenance is exhausted (all git tiers missed). Git author names are light personal data exposed by `teach_lookup` on all surfaces per owner decision 2026-09-10.

## Pointer rule

Code references are stored as pointers `{commit, path, lines}` and
reconstructed via git when needed. Stored verbatim: user notes, commit
messages. Stored with secrets redacted: stderr excerpts of at most 4 lines
(the first error line plus the last three, or the last four when the
error line is already among them).

## Derived data

Aggregates, rankings, and any recomputed views are never written back into
evidence files. Raw history is the asset; intelligence is a replaceable
layer.

## Spool v1

Spool files live in `<ROCKY_HOME>/desk/spool/`, one record per file. Name:
`<recv_ms 13 digit>-<pid>[-n].json` (`-n` disambiguates retries within the
same millisecond). Writers use `<name>.json.tmp` while writing, then rename
to `<name>.json` so readers only see complete files.

### Record shapes

Event record:

```json
{"v":1,"harness":"claude-code","recv_ms":1794000000123,"kind":"event","event":{"hook_event_name":"PreToolUse","session_id":"...","tool_name":"Edit","tool_use_id":"...","target_path":"C:\\...\\a.ts","cwd":"C:\\..."}}
```

Dropped record:

```json
{"v":1,"harness":"claude-code","recv_ms":1794000000456,"kind":"dropped","reason":"oversize","bytes":9437184}
```

`reason` is `oversize` (stdin exceeded 8 MiB) or `parse` (payload was not a
valid hook object). `bytes` is the rejected input size.

### Version rule

`v` starts at 1. Additive fields keep `v`. `v` rises only for breaking
changes. Readers must tolerate unknown fields and unknown `kind` values.

### Allowlist

Only these fields are kept from a hook payload: `session_id`, `cwd`,
`hook_event_name`, `agent_id`, `agent_type`, `tool_name`, `tool_use_id`,
`transcript_path`, `agent_transcript_path`, `notification_type`,
`tool_input.file_path` / `tool_input.notebook_path` (merged into
`target_path`), and `tool_input.command` / `tool_input.description` (kept as
`command` and `description`: redacted, then controls mapped to spaces, ≤200
chars, absent when `desk/tool-text-off` exists). Ids and names cap at 256
bytes, paths at 4 KiB; truncation cuts at a char boundary and sets
`truncated: true`.

Redaction counts Unicode scalar values where the reference counts UTF-16 code
units, so a secret value built from characters outside the Basic Multilingual
Plane can stay unredacted here.

## Desk settings v1

`rockyd` stores desk settings in `<ROCKY_HOME>/desk/settings.json` and is the
only writer. It writes a sibling `settings.json.tmp` and renames it over the
file, creating `desk/` on first save. Missing keys take their defaults.

Defaults:

```json
{"v":1,"subagent_tree":true,"history":true,"tool_text":true,
 "notify_needs_you":true,"notify_failed":true,"notify_done":true,
 "lang":"auto","autostart_asked":false}
```

`lang` is `auto`, `en`, or `id`. `v` is the file version and is not settable.

A missing file means defaults and is not an error. A file that cannot be
read, does not parse, has a field of the wrong type, or carries a `v` other
than 1 gives defaults in memory and sets `health.settings_unreadable`; the
file is left byte-identical until a later `set` succeeds.

`set` accepts the seven boolean names and `lang` (a JSON bool, or one of the
three strings). It replies with `ack`: `ok: false` plus `error` `unknown
setting` (a name that is not settable, including `v`), `invalid value`
(a wrong JSON type, or a `lang` string other than the three), or `save
failed` (the file write failed). A successful `set` saves the file,
broadcasts a full `settings` message, clears `settings_unreadable`, and
pushes fresh `status` rows when `tool_text` changed. When the save succeeds
and `tool_text` changed, it also syncs the `desk/tool-text-off` marker. It
also broadcasts `health` when it changed, which the first successful `set`
after an unreadable file does.

The marker `desk/tool-text-off` is present while `tool_text` is off and
absent while it is on. At start the daemon syncs it from the settings it
loaded (defaults when the file is missing or unreadable), and a `set` of
`tool_text` syncs it again, so it matches the settings in use. Turning
`tool_text` off also drops the command text and subagent descriptions from
agents already in memory, and clears the text of timeline entries that came
from a tool input (a command, or a subagent description). Path text stays.
Every `settings` broadcast makes the desk re-request its open timelines, so
cleared text disappears there too.

## Desk history v1

`rockyd` keeps a replay log under `<ROCKY_HOME>/desk/history/`, one JSON
object per line. Segments are named `<UTC yyyyMMddHH>.jsonl` (for example
`2026110814.jsonl`) and hold one UTC hour each. Only files with exactly that
name are replayed, counted toward the cap, or deleted; other files (a
`.tmp`, `notes.txt`, a subdirectory) are left alone.

Every line carries `v` (currently 1), a `kind`, and an optional `src` (the
spool file name the line came from).

Event line, written for each consumed spool file. The event is the same
allowlisted shape the spool stores:

```json
{"v":1,"kind":"event","harness":"claude-code","recv_ms":1794000000123,"event":{"hook_event_name":"PreToolUse","session_id":"s1","cwd":"C:\\work\\app","tool_name":"Bash","tool_use_id":"toolu_1","command":"npm test"},"src":"1794000000123-4242.json"}
```

Gap line, written whenever consumed coverage is lost. Its `reason` is one of:

- `hook_dropped` — a `dropped` spool record; the time range comes from the
  record and `src` is the spool file name.
- `bad_file` — a quarantined bad spool file; the time comes from the spool
  file name and `src` is that name.
- `spool_full` — startup spool pruning deleted files; the time range covers
  the deleted file names (or the startup time when none parse) and there is
  no `src`.
- `history_full` — the history cap deleted segments; the time range covers
  the deleted segment hours and there is no `src`.

A `hook_dropped` line:

```json
{"v":1,"kind":"gap","from_ms":1794000000456,"to_ms":1794000000456,"count":1,"reason":"hook_dropped","src":"1794000000456-4242.json"}
```

Rules:

- **Keep.** At start and on each minute tick, a segment whose last hour ended
  at or before `now - 24 h` is deleted.
- **Cap.** Accepted segments total at most 64 MiB. When an append pushes the
  total over, the oldest other segments are deleted, oldest first, and one
  `history_full` gap line for the lost range and line count is appended to
  the current segment. The cap is not strict: the gap line is written after
  the prune, and the current segment is never trimmed, so the total can stay
  above 64 MiB.
- **Torn line.** A hard kill can leave a partial last line. The next append
  writes a newline first, and replay skips lines it cannot parse.
- **Replay.** At start the daemon rebuilds agents, statuses, timelines, and
  `health.gaps` from the segments, then seeds the ingestor with every `src`
  seen so those spool files are deleted without being applied again.
- **Tool text.** Segments written while tool text was on keep that text until
  they age out or history is turned off. Replay drops it when `tool_text` is
  off, so it never returns to memory, statuses, or timelines.
- **Off.** When the daemon starts with `history` off, and whenever the
  setting changes to off, every accepted segment is deleted. While off,
  nothing is appended.

## Desk OS registrations (Windows)

The desk writes these registry keys outside `<ROCKY_HOME>`, and two files
under `<ROCKY_HOME>\desk`.

- **Sign-in autostart.** Key
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `rocky-desk`,
  data `"<exe path>" --tray` for the desk's own exe. Only the desk's
  autostart toggle and a Yes answer to the sign-in question write or remove
  it. A value that points elsewhere reads as off, and enabling rewrites it.
  The desk reads the value when the settings view opens and after each
  toggle.
- **Toast identity.** Key
  `HKCU\Software\Classes\AppUserModelId\Rocky.Desk`, string values
  `DisplayName` = `rocky` and `IconUri` = `<ROCKY_HOME>\desk\rocky.ico`. The
  desk writes it once per process, on the first `snapshot` or `settings`
  message where any notify toggle is on. It also sets the same id as the
  process's AppUserModelId at start, so toasts and the taskbar group under
  it.
- **Icon file.** `<ROCKY_HOME>\desk\rocky.ico` is written from the icon
  compiled into the exe whenever the file is missing or holds other bytes.
- **Error log.** `<ROCKY_HOME>\desk\rocky-desk.log` gets at most one
  `kind: error` line per process for the seven once-only kinds, and a
  `panic:` entry with its backtrace on every panic. The kinds are `panic`,
  `set_icon`, `set_tooltip`, `refresh_menu`, `close_veto`, `autostart`,
  `aumid`, and `toast`.

## Pipe v2

One JSON object per line over the daemon pipe. Every message carries `v`
(major) first and `type`. This build speaks v2; a peer that sends another
major version gets one `error` with `code: "version"` and the connection
closes. Minor additions are additive; readers must ignore unknown fields. A
client line longer than 64 KiB gets the client disconnected. Each client has
a bounded outbound queue of 1024 messages; when full the client is
disconnected, reconnects, and receives a fresh snapshot.

### Messages

| Direction | `type` | Fields |
|---|---|---|
| desk → daemon | `hello` | `client`, `version` |
| daemon → desk | `hello` | `daemon_version`, `pid` |
| daemon → desk | `error` | `code: "version"`, then the connection closes when the major differs |
| desk → daemon | `subscribe` | — |
| daemon → desk | `snapshot` | `agents[]`, `aggregate`, `health`, `settings` |
| daemon → desk | `status` | `op: "upsert" \| "remove"`, `agent` |
| daemon → desk | `health` | `spool_pending`, `spool_dropped`, `dropped_events`, `bad_files`, `late_events`, `hook_newer_than_daemon`, `gaps[]`, `settings_unreadable` |
| daemon → desk | `settings` | full settings object, broadcast after every successful `set` |
| desk → daemon | `set` | `id`, `name`, `value` |
| desk → daemon | `timeline` | `id`, `key` |
| daemon → desk | `timeline` | `id`, `key`, `entries[]` |
| desk → daemon | `cmd` | `name: "stop" \| "show"`, `id` |
| daemon → desk | `show` | — (broadcast to every desk after a `cmd` `show`) |
| daemon → desk | `ack` | `id`, `ok`, `error?` |

`agent` carries `key` (`session_id`, `agent_id`; empty `agent_id` means the
main agent), `agent_type?`, `status` (`idle` | `working` | `needs_you` |
`done` | `failed` | `ended`), `action?` (`tool_name`, `target_path?`,
`tool_use_id?`, `command?`), `summary?`, `description?`, `failures`,
`last_event_ms`, `quiet_10m`, and `repo` (`root?`, `name`, `branch?`).

`description` is the task text from the main agent's one unpaired `Agent` or
`Task` tool call, attached to the child that starts next. It stays absent
when zero or several calls are open, or when tool text is off.
`action.command` is the redacted command text, absent when tool text is off.

`health.gaps` holds at most 100 gaps whose `to_ms` is within the last 24 h.
`snapshot.health.gaps` carries the same list; there is no top-level `gaps`
field. A gap is `{from_ms, to_ms, count, reason}`; `reason` is `spool_full`
(dropped spool files), `history_full` (dropped history segments),
`hook_dropped` (a `dropped` spool record), or `bad_file` (a quarantined
spool file).

`snapshot` is sent once after `subscribe`, and once at daemon startup for
desks that connected while it was replaying.

`timeline` replies with up to the last 50 entries for `key`, oldest first;
an unknown key gives an empty `entries`. Entries are `{ms, kind, tool_name?,
text?, outcome?}`. `kind` is one of `session_start`, `turn_start`, `tool`,
`needs_you`, `subagent_start`, `subagent_stop`, `turn_done`, `turn_failed`,
`session_end`, `gap`. `outcome` is `pending`, `ok`, or `failed` and appears
on `tool` entries. Tool text is a path made relative to the repo root, the
full path when it does not sit under that root, or the redacted command; a
`gap` entry carries the reason in `text`. Timelines are not part of
`snapshot`; a desk asks for them per agent.

`set` errors are the strings documented under Desk settings v1. `cmd` with
`name: "stop"` acks and the daemon exits. `cmd` with `name: "show"` is
broadcast as `show` to every desk, then the sender gets `ack` with `ok:
true`.

Example:

```json
{"v":2,"type":"subscribe"}
```
