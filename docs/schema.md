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

Shell record:

```json
{"v":1,"harness":"shell","recv_ms":1794000000789,"kind":"shell_env","env":{"CLAUDE_CONFIG_DIR":"/home/u/work/.claude"}}
```

`rocky-hook shell-env` writes it once per shell, when the shell hook loads. It
reads no stdin. `env` holds only the variables of this list that are set,
non-empty, and at most 4096 bytes: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`OPENCODE_CONFIG`, `GEMINI_SETTINGS`, and `COPILOT_HOME`. When none qualifies,
no record is written. The daemon maps each name to its harness (`claude-code`,
`codex`, `opencode`, `gemini-cli`, `copilot-cli`) and hands the value to the
setup guard as a config location to record.

Any record may carry `config_dir`, the config directory the hook saw for that
event. `rocky-hook desk-hook claude-code` sets it to the value of
`CLAUDE_CONFIG_DIR` when that is set, non-empty, and at most 4096 bytes, and
leaves the field out otherwise. Other harnesses never carry it. The value is
what the shell held, not a checked path: setup validates a reported location
before it records or writes anything there.

### Version rule

`v` starts at 1. Additive fields keep `v`. `v` rises only for breaking
changes. Readers must tolerate unknown fields and unknown `kind` values. The
`shell_env` kind and the `config_dir` field are additive within `v` 1.

### Allowlist

Only these fields are kept from a hook payload: `session_id`, `cwd`,
`hook_event_name`, `agent_id`, `agent_type`, `tool_name`, `tool_use_id`,
`transcript_path`, `agent_transcript_path`, `notification_type`,
`tool_input.file_path` / `tool_input.notebook_path` (merged into
`target_path`), `tool_input.command` / `tool_input.description` (kept as
`command` and `description`: cut to scan cap, redacted, then controls mapped to
spaces, ≤200 chars, absent when `desk/tool-text-off` exists), `exit_code` and
`error_head` (only on `PostToolUseFailure` from `Bash` or `PowerShell`, when
`is_interrupt` is not `true` and `error` is a string: `error` is scanned up to
`16 KiB` at a char boundary while `tool_response` and all other lines are
dropped; `exit_code` is a signed 32-bit integer parsed from a leading
`Exit code <N>` line and is still captured when `desk/tool-text-off` exists;
`error_head` picks the first remaining non-empty line matching
`(?i)error|exception|fail|fatal|cannot|unable|not found|missing|denied|refused|invalid|unexpected|undefined|panic|traceback`
or falls back to the last non-empty line, then is redacted like `command`, maps
controls to spaces, caps at 200 chars, and is absent when `desk/tool-text-off`
exists), and `prompt`
(only when `hook_event_name` is `UserPromptSubmit` and the value is a string,
absent when `desk/cards-off` exists: cut to `16 KiB` at a char boundary,
redacted with prefix-fragment scrubbing when cut, then controls `<= 0x1f` and
`0x7f..=0x9f` other than `\n` and `\t` mapped to spaces, then ≤1,000 Unicode
scalar chars). Ids and names cap at 256 bytes, paths at 4 KiB; truncation cuts
at a char boundary (or char limit on `prompt`) and sets `truncated: true`.
When ingesting a spool record while `cards` is on, the daemon extracts `prompt`
for live in-memory `AgentStatus` and card building, and removes it from the
event before writing `desk/history/` (so `AgentStatus.prompt` is never written
to `desk/history/` or restored from history replay, though its source text
passes through the spool file and may be stored in a change card). While
`cards` is off, the daemon drops incoming and already-spooled `prompt` values
on ingest too, and removes `prompt` before writing `desk/history/`.

A `shell_env` record keeps only the five variable names listed under Record
shapes, and `config_dir` only the value of `CLAUDE_CONFIG_DIR`. No other
environment value is read.

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
 "cards":true,"notify_needs_you":true,"notify_failed":true,
 "notify_done":true,"lang":"auto","autostart_asked":false}
```

`lang` is `auto`, `en`, or `id`. `v` is the file version and is not settable.

A missing file means defaults and is not an error. A file that cannot be
read, does not parse, has a field of the wrong type, or carries a `v` other
than 1 gives defaults in memory and sets `health.settings_unreadable`; the
file is left byte-identical until a later `set` succeeds.

`set` accepts the eight boolean names and `lang` (a JSON bool, or one of the
three strings). It replies with `ack`: `ok: false` plus `error` `unknown
setting` (a name that is not settable, including `v`), `invalid value`
(a wrong JSON type, or a `lang` string other than the three), or `save
failed` (the file write failed). A successful `set` saves the file,
broadcasts a full `settings` message, clears `settings_unreadable`, and
pushes fresh `status` rows when `tool_text` or `cards` changed. When the save succeeds
and `tool_text` or `cards` changed, it also syncs `desk/tool-text-off` and
`desk/cards-off`. It also broadcasts `health` when it changed, which the
first successful `set` after an unreadable file does.

The marker `desk/tool-text-off` is present while `tool_text` is off and
absent while it is on; `desk/cards-off` follows `cards` the same way. At start
the daemon syncs both markers from the settings it loaded (defaults when the
file is missing or unreadable), and a `set` of `tool_text` or `cards` syncs
them again, so they match the settings in use. Turning `tool_text` off also
drops the command text and subagent descriptions from agents already in
memory, clears the text of timeline entries that came from a tool input
(a command, or a subagent description), and drops `command`, `description`, and
`error_head` on ingest and replay while keeping `exit_code` (numbers only). Path
text stays. Every `settings`
broadcast makes the desk re-request its open timelines, so cleared text
disappears there too. Turning `cards` off creates `desk/cards-off` so the hook
stops recording new `prompt` values, clears every `AgentStatus.prompt` held in
daemon memory (and pushes fresh `status` rows so connected desks stop showing
them), drops any incoming or already-spooled prompts on ingest, and disables
new change card building in the daemon (resetting card-engine turn tracking):
while switched off, no prompt is kept or shown. Existing card files stay on
disk until purged or removed.

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
  they age out or history is turned off. Replay drops `command`, `description`,
  and `error_head` (keeping `exit_code`) when `tool_text` is off, so tool text
  never returns to memory, statuses, or timelines.
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
  Task Manager's Startup apps page turns the entry off by writing a binary
  `rocky-desk` value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`
  whose first byte is odd. The desk reads that as off too. Turning autostart
  on or off from the desk deletes that value, so the desk's choice wins.
  The desk reads both values when the settings view opens and after each
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
  `kind: error` line per process for the eight once-only kinds, and a
  `panic:` entry with its backtrace on every panic. The kinds are `panic`,
  `set_icon`, `set_tooltip`, `refresh_menu`, `close_veto`, `autostart`,
  `aumid`, `toast`, and `tray_close`.

## Desk OS registrations (Linux)

The daemon and the desk share a unix socket and two lock files. They live in
`$XDG_RUNTIME_DIR` when that variable is a non-empty absolute path, else in
`<ROCKY_HOME>/desk`. `<hash>` is a 16-hex-digit hash of the normalized Rocky
home path. The desk asks the desktop to start it at login with this file at
`$XDG_CONFIG_HOME/autostart/rocky-desk.desktop`, or
`$HOME/.config/autostart/rocky-desk.desktop` when `XDG_CONFIG_HOME` is unset,
empty, or relative:

```ini
[Desktop Entry]
Type=Application
Name=rocky
Exec="<exe path>" --tray
X-GNOME-Autostart-enabled=true
```

- **Socket and locks.** The socket is
  `$XDG_RUNTIME_DIR/rocky-desk-<hash>.sock`, or
  `<ROCKY_HOME>/desk/rockyd.sock` when the runtime directory cannot be used.
  `rockyd-<hash>.lock` and `rocky-desk-<hash>.lock` sit beside it. Both locks
  are created 0600, locked with `flock(LOCK_EX | LOCK_NB)`, and held for the
  process lifetime. The socket file is born 0600 because the bind runs under
  `umask(0o177)`, and the previous mask returns right after. The daemon and
  the desk both keep `<ROCKY_HOME>/desk` at 0700.
- **Single instance.** A second desk launch asks the running desk to show
  itself and exits 0. A second daemon exits 3 before it serves or ingests
  anything; before taking the lock it only creates the desk and spool
  directories, opens the log, and reads the history directory.
- **Socket path limit.** The kernel's `sun_path` is 108 bytes including the
  NUL, so a socket path longer than 107 bytes cannot bind; the daemon logs
  `socket path too long` and exits 1 before it opens the lock or touches the
  socket file. A daemon killed outright can leave its socket file behind;
  after taking the freed lock, the next daemon unlinks the stale file and
  binds again.
- **Peer check.** On Linux the daemon reads the peer uid with `SO_PEERCRED`
  and drops a connection from another user without a reply. On other unix
  systems the peer uid is unknown, so the check fails closed. The desk checks
  the daemon's uid after connecting and refuses a server owned by another
  user before it sends anything.
- **Sign-in autostart.** A missing file reads as off, as do `Hidden=true`,
  `X-GNOME-Autostart-enabled=false`, and an `Exec` value that names another
  exe or arguments. Enabling rewrites the whole file, which drops a
  `Hidden=true` left behind, and disabling deletes it. The `Exec` line quotes
  the exe path and escapes per the Desktop Entry spec: inside the quotes `"`,
  `` ` ``, and `$` take one backslash, `%` doubles, and a backslash takes
  four.
- **Icon file.** `<ROCKY_HOME>/desk/rocky.png` is written from the icon
  compiled into the exe whenever the file is missing or holds other bytes,
  and is the icon the notifications carry.
- **Notifications.** Sent with `org.freedesktop.Notifications.Notify` on the
  session bus from a worker thread that opens the bus on the first notice and
  reconnects after a failure. The app name is `rocky`, and each notice
  replaces the previous notice from the same session through `replaces_id`.
  Actions and hints are empty, and the expire timeout is -1. The body escapes
  `&`, `<`, and `>`, so a repo or branch name shows literally; the title is
  sent as plain text. A click does nothing. One call gives up after 25
  seconds, so a server that never replies is reported as an error and the
  desk keeps running.
- **Tray start.** `--tray` opens the window minimized. A window manager
  that starts after the desk, as at login, can drop that request, so the
  desk sends it again 1, 3, and 8 seconds after start unless the window was
  opened from the tray or by a second launch in the meantime.
- **Error log.** `<ROCKY_HOME>/desk/rocky-desk.log` keeps the same once-only
  kinds as Windows, plus a `panic:` entry with its backtrace on every panic.
  On Linux, a notification setup or send error is logged under `toast`, and a
  tray that cannot be built is logged under `tray` while the desk keeps
  running without one; the Windows-only `aumid` kind is not used.

## Setup records v1

`rocky setup --auto` keeps its consent and the bytes it wrote under
`<ROCKY_HOME>/setup/`. Both files are written by a sibling temporary file
renamed over the target. A missing, unparsable, or wrongly shaped store
reads as empty, so the next write replaces it.

`rockyd` reads `consent.json`, `expected.json`, `bin/cli.json`, and
`bin/binaries.json` and writes none of them. It looks for each snippet of
`expected.json` as a byte substring of its file. A file it cannot read, or one
that lacks a snippet, counts as missing, and the repair runs through Node, not
through code in the daemon. What the daemon reports about it is under Setup
guard messages.

### Consent record

`<ROCKY_HOME>/setup/consent.json`:

```json
{"v":1,"scope":1,"state":"approved","at":1794000000123,
 "harness_off":["opencode"],"shell_hook":true,
 "config_dirs":{"claude-code":[{"location":"/home/u/.claude","last_seen":1794000000123}]}}
```

`v` is the file version and `scope` the version of what the answer covers;
both must be 1. `state` is `approved`, `later`, or `removed`. `at` is epoch
milliseconds. `harness_off` names the MCP harnesses the answer leaves out,
and `shell_hook` says whether the shell hook is in scope.

`config_dirs` holds the locations a harness was found at, each with the
epoch-millisecond `last_seen` of the last sighting. An entry is a directory
for claude-code, codex, and copilot-cli, and the config file itself for
opencode and gemini-cli. A location absent for seven days is forgotten.
Every recorded location, like a config directory named by the environment, is
revalidated before each inspect, apply, and remove: it must stay canonical,
must not be a symlink, must remain inside the user's home, and must still hold
its harness file. A location that fails is reported as `refused` and nothing
is written there.

### Result fields

Every `rocky setup --auto <action> --json` result carries `harness_off`
(string array, the harness ids the consent record leaves out) and
`shell_hook` (boolean, whether the shell hook is in scope). Without a valid
consent record they are `[]` and `true`.

The actions beyond `plan`, `apply`, `remove`, `consent`, and `harness`:

| Action | Effect |
|---|---|
| `shell on` / `shell off` | Sets `shell_hook` in the consent record, but only a valid record takes the flag. `off` removes the shell block in any consent state and stops its repair. `on` installs the shell block only under `approved` consent. |
| `repo list` | Lists every repo with a recorded capture decision. Only this action adds `repos`. |

`repos` is an array of `{key, main, name, decision, bytes, worktrees[]}`:
`decision` is `allowed` or `declined`, `bytes` is the size of the repo's
Listening store, and each worktree is `{root, bytes, exists}`.

`remove` keeps the recovery copy that sits beside a path reported as
`refused` (an MCP config, a Claude Code settings file, or a shell profile),
and prunes every other retained recovery copy. It settles a pending MCP
transaction before it checks the target.

### Expected record

`<ROCKY_HOME>/setup/expected.json`:

```json
{"v":1,
 "files":[{"path":"/home/u/.claude/settings.json","snippets":["rocky hook"]}],
 "history":{"/home/u/.codex/config.toml":["[mcp_servers.rocky]\ncommand = \"node\""]}}
```

`files[].snippets` are byte substrings a reader checks for presence, not a
diff. A snippet is listed only after it was found in the file, so every
write Rocky reports is followed by a read that found its bytes. A target
that reports success while an expected snippet is missing is reported as an
error instead.

`history` is keyed by the target path and capped at 20 values per path,
newest last, with older duplicates dropped. A value is a `registrationKey`
string for a JSON MCP config — the JSON object `{command,args,env}`, with
the `env` keys sorted — and the exact block text for the Codex TOML. Both
forms name what Rocky wrote, so a later run recognizes its own entry after
the value it would write has moved.

### CLI record

`<ROCKY_HOME>/bin/cli.json`:

```json
{"v":1,"node":"C:\\Program Files\\nodejs\\node.exe",
 "entry":"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@poggufanz\\rocky-cli\\dist\\index.js",
 "version":"2.0.0"}
```

`node` and `entry` are absolute paths and `version` is the package version.
Bare `rocky` and `rocky setup` write it; no other command does. The write is
skipped unless the last five path segments of `entry` are `node_modules`,
`@poggufanz`, `rocky-cli`, `dist`, and `index.js` (compared
case-insensitively on Windows), so a repository checkout or a shim records
nothing. That rule matches only those five segments, so an install whose
entry ends the same way is recorded too, including an npx cache copy under
`_npx` and a project-local `node_modules` copy. An identical record is left
byte-identical.

### Binaries

When the optional platform package is installed, `<ROCKY_HOME>/bin/` holds the
desktop app, its background process, and the hook binary: `rockyd`,
`rocky-desk`, and `rocky-hook`, with `.exe` on Windows. Beside them,
`<ROCKY_HOME>/bin/binaries.json` records the version that put them there:

```json
{"v":1,"version":"2.0.0"}
```

Bare `rocky` writes that record last, after all three binaries are in place.
A missing, unparsable, or mismatched record, or a missing binary, means the
next bare `rocky` copies all three again. Windows swaps each binary by
renaming the old one aside; POSIX uses an atomic rename. A leftover
`<name>.<pid>.new` or `<name>.old` file from an interrupted swap is swept on
the next run.

### Repo capture consent

`<ROCKY_HOME>/listening/repo-consents.json` maps a canonical repo root to a
boolean. `true` is a grant. `false` is a remembered decline, kept so that an
answer about another repository cannot erase it. Readers count only `true`:
a missing store, an unreadable one, or a value that is not a boolean is no
consent. A linked Git worktree has no decision of its own; it inherits its
main repository's grant, and a revoke clears both that root and the root
that owns the decision.

### Collector lease

`<ROCKY_HOME>/listening/repos/<hash>/collector.json` holds one lease per
consented repo: `{proc, pid, token, expires}`. The holder is the only process
that writes that repo's history. `proc` is `gui` (`rocky dash`) or `daemon`
(the capture process the desktop app's background process runs). Readers also
accept the reserved value `mcp`, which no current process writes: the MCP server
is read-only and never holds a lease. `expires` is epoch milliseconds. A lease lasts 30 s and its
holder renews it every 10 s. Another process takes the repo only when the lease is missing,
expired, or held by a process that no longer exists.

`rocky dash` skips a repo whose `daemon` lease is live. After `rocky dash`
releases a repo, the daemon's capture process takes it within one lease tick.
Node is the only writer of the lease; the daemon never reads `collector.json`.

## Desk notified record v1

`<ROCKY_HOME>/desk/notified.json` records which once-only setup notices the
desk already showed, so a restart does not repeat them:

```json
{"v":1,"repos":["/home/u/work/app"],"harnesses":["claude-code"],"seeded":true}
```

`repos` holds the repo keys announced as waiting for a capture decision, and
`harnesses` the harness ids announced after the first approval. `seeded` is
true once the first approved plan has been recorded without announcing the
harnesses it already held. The desk writes the file by a sibling temporary
file renamed over the target. A missing file is a first run; an unparsable one
reads as empty.

## Capture process v1

`rocky listen collect --stdio` is the hidden command the desktop app's
background process runs to capture consented repos. It is not listed in help,
runs the collector with no GUI, and opens no network connection. Both
directions are UTF-8 JSON lines, one object per line, and every object carries
`v: 1`. stderr carries human text and is discarded by the daemon.

stdin takes one request per line:

```json
{"v":1,"root":"<absolute path>"}
```

A request asks for a reconcile of that repo now. When capture is allowed for
the root, which includes a linked worktree of a consented repo, the process
also starts tracking it. A line over 64 KiB, a line that is not JSON, a line
with another `v`, a `root` that is not an absolute path, and a request for a
root that capture is not allowed for are ignored. Nothing is answered to an
ignored line.

stdout carries only these two kinds:

```json
{"v":1,"kind":"roots","roots":[{"root":"<path>","owner":true}]}
{"v":1,"kind":"result","root":"<path>","coverage":"complete","gaps":0,"reason":null,"at_ms":1767225600000}
```

- `roots` lists every repo the process tracks, sorted by path: the consented
  repos plus requested roots that capture is allowed for. It is written again
  only when the list or an `owner` value changes. `owner` is true when this
  process holds the repo's lease, and false when another process does.
- `result` reports one reconcile. `coverage` is `complete`, `partial`, or
  `unknown`. `gaps` counts the gaps the pass recorded. `reason` is
  `null`, or one of `root-unusable`, `repo-consent-required`, `git-unreadable`,
  or `capture-failed`. `at_ms` is epoch milliseconds. `reason` is set only
  with `coverage: "unknown"`.
- The process reconciles each repo it owns every 60 s and on request.

The process exits 0 when stdin ends or its stdout closes, after it releases its
leases. It exits 1 when the collector fails and 2 on any other arguments.

## Change card v1

### Storage layout and rotation

Change cards are append-only UTF-8 JSONL stored under
`<ROCKY_HOME>/desk/cards/`: `<repo_id>.jsonl` when a session starts in a Git
repository and `_none.jsonl` when `repo_id` is empty or `"_none"` (sessions
outside any Git repository). A linked Git worktree stores cards under its own
worktree `repo_id`, while `main_root` points to the main repository. Edits
outside the card's session root are stored with absolute or `~/…` (relative to the OS user home, not the Rocky home) block paths
inside that session's log file. On Unix,
`desk/cards/` is created with mode `0700` and card files with `0600`; opens
refuse symlinks (`O_NOFOLLOW`) and Windows reparse points on directories,
card files, and temporary files.

`rockyd` is the only writer. Updates to a turn append a full `Card` object
with the same `card_id` and a higher `rev`. Readers keep the latest revision
per `card_id` (highest `rev`; equal `rev` prefers the later line in a file,
and across logs keeps the later log read). CLI and MCP readers inspect up to
the trailing `16 MiB` of a card file (advancing to the next line boundary when a
cut lands mid-line) and skip lines larger than `1 MiB`. When querying one target
file, readers inspect the target repo's log (and sibling worktree/repo logs
under the same main repository) plus `_none.jsonl` and other `*.jsonl` card logs
for matching absolute or `~/…` (OS user home) block paths (ignoring foreign-repo relative
paths), bounded at `64` extra logs and `64 MiB` total bytes read across all card
logs (`16 MiB` per file).

When an append leaves a card file larger than `8 MiB`, `rockyd` compacts it
via a sibling `.tmp` file and atomic rename: it keeps only the latest
revision per `card_id`, sorts newest-first (`ended_ms ?? started_ms`
descending, file line index descending, `card_id` ascending), retains entries
from newest downward until the next would exceed `6 MiB` (always keeping at
least the single newest card), and writes the kept entries in original file
order.

Purging a repo's capture (`rocky setup --repo <path> --purge-capture`) deletes
that repo's own card log and then scrubs every other `*.jsonl` card log
(`_none.jsonl` included): blocks whose path lies inside the purged repo are
removed, and a card left with no blocks is dropped. In a card that loses at
least one block, flow steps that only refer to those blocks or name the repo's
path are also removed. The prompt and quotes of surviving blocks are not edited.
A card with no block inside the repo is kept unchanged, so its prompt or flow
step text can still mention the repo's path. Lines the scrub cannot parse or validate are
kept verbatim, a log with nothing to remove stays byte-identical, and a log
left empty is deleted. Blocks under a nested repo or linked worktree inside the
purged folder keep their cards: a directory below the purged folder counts as a
nested repo when it holds a `.git` file or folder, or when it is the `root` or
`main_root` of a card in any log. Other logs are scrubbed only for a path Rocky
knew as a repo (a stored consent decision, its own card log or Listening store,
or a `.git` entry now) that is not a filesystem, drive or share root and does
not equal or contain the home folder or the Rocky home; otherwise they are left
alone and the CLI says so. A log larger than `64 MiB`, a symbolic link, a log
that keeps changing, a log where purged blocks come back after the scrub, or a
log with an unreadable line that contains the repo's path is reported as
incomplete (the unreadable line is not edited); the purge still succeeds and can
be run again.

### Card record

One JSON object per line:

| Field | Type | Notes |
| --- | --- | --- |
| `v` | integer | Schema version (`1`). |
| `card_id` | string | First 32 lowercase hex chars of `SHA-256(session_id \|\| \0 \|\| agent_id \|\| \0 \|\| started_ms)`. |
| `rev` | integer | Revision counter within `card_id`. |
| `repo_id` | string | Repository id, or `"_none"` outside Git. |
| `root` | string | Workspace or worktree root path (`""` outside Git). |
| `main_root` | string \| null | Main repository root (equal to `root` in the main checkout, different in a linked worktree), or `null` only when it cannot be resolved (such as outside Git). |
| `branch` | string \| null | Branch name, or `null`. |
| `session_id` | string | Session identifier. |
| `agent_id` | string | Subagent identifier (`""` for the main agent). |
| `agent_type` | string | Agent type string (`""` if omitted). |
| `parent_card_id` | string \| null | Parent turn `card_id` for subagent cards; else `null`. |
| `started_ms` | integer | Turn start timestamp in epoch milliseconds. |
| `ended_ms` | integer \| null | Turn end timestamp in epoch milliseconds, or `null` while open. |
| `status` | string | `"open"`, `"done"`, or `"failed"`. |
| `prompt` | string | Main agent prompt from `UserPromptSubmit`, or subagent's first user message (≤1,000 chars); stored raw. |
| `prompt_truncated` | boolean | `true` if `prompt` was cut at scan or character bounds. |
| `importance` | string | Maximum block importance across all attributed blocks for the turn (computed before the `30`-block truncation, so omitted overflow blocks count): `"none"`, `"low"`, `"medium"`, or `"high"`. |
| `blocks` | `Block[]` | Attributed file/symbol changes, capped at `30` entries per card. |
| `more_count` | integer | Number of overflow blocks omitted beyond `30` (`#[serde(default)]`). |
| `flow` | `FlowStep[]` | Chronological command (`Bash`/`PowerShell`) and edit steps, capped at `100` entries per card. |
| `flow_more` | integer | Number of overflow steps omitted beyond `100` (`#[serde(default)]`). |
| `outside_count` | integer | Observed repo edits during the turn not attributed to agent tools. |
| `coverage` | `Coverage` | Capture and attribution completeness summary. |

#### `Block`

| Field | Type | Notes |
| --- | --- | --- |
| `seq` | integer | Block sequence number within the card. |
| `path` | string | Changed file path (repo-relative when inside the card's session root; absolute or `~/…` relative to the OS user home when outside). |
| `symbol` | `BlockSymbol \| null` | `{ kind, name, container: string \| null, exported: bool, nth?: u32 }`; `nth` is omitted when `0`. `kind` is one of `function`, `method`, `class`, `struct`, `enum`, `trait`, `interface`, `type`, `const`, `test`, `key`. |
| `labels` | `Label[]` | Up to `12` structured labels `{ "id": string, "args": object }`, sorted by importance descending then catalog order. |
| `importance` | string | `"none"`, `"low"`, `"medium"`, or `"high"`. |
| `via` | string | Attribution channel string (typically `"edit"` or `"bash"`; readers accept any string and project over MCP as `"edit"`, `"bash"`, or `"other"`). |
| `tool_use_ids` | string[] | Matching tool call ids. |
| `bash` | `BashInfo \| null` | `{ cmd: string, candidates: u32 }` when `via` is `"bash"`. |
| `before` | string \| null | Listening object SHA-256 hash before the change, or `null`. Source bytes stay in Listening storage, not in card files. |
| `after` | string \| null | Listening object SHA-256 hash after the change, or `null`. |
| `recorded` | boolean | `true` when Listening captured the repo versions; `false` when only paths/tools were observed. |
| `line` | integer \| null | 1-based start line in `after` (see line/diff semantics below). |
| `added` | integer \| null | Added line count attributed to this block. |
| `removed` | integer \| null | Removed line count attributed to this block. |
| `quote` | `Quote \| null` | `{ text: string, shared: bool }` — redacted agent transcript excerpt (≤500 chars); `shared` records quote provenance (`false` when taken from the assistant message that issued the tool call, `true` when falling back to earlier assistant text, regardless of how many tool calls use that text). |

#### `line`, `added`, and `removed` semantics

Inputs use `\r\n`→`\n` normalized lines and Myers line diffing up to `10,000`
lines per side (files over `1 MiB` receive `too_large` instead).

- **Parsed syntax blocks (`ts`, `tsx`, `js`, `rs`)**: `line` is the 1-based
  start line of the symbol in `after` (`null` when the symbol was removed);
  `added` and `removed` count inserted/deleted lines mapped to the innermost
  containing `after`/`before` symbol region (`null` if either side exceeds
  `10,000` lines). For unattributed changes outside symbol regions, `line` is
  the first inserted line outside all symbols (`null` if none).
- **Whole-file cases**: `file_new` sets `line` to `1` when non-empty (`null`
  when empty), `added` to the line count, and `removed` to `0`. `file_deleted`
  sets `line` to `null`, `added` to `0`, and `removed` to the prior line count.
- **Unresolved or non-line cases**: `line`, `added`, and `removed` are all
  `null` for `format_only`, `too_large`, `not_captured`, unrecorded edits
  (`recorded: false`), and multi-change JSON/TOML config files (`changes > 1`;
  single-change config, lockfiles, and fallback `lines_changed` populate them
  from the file line diff).
- **Grouped `via: "bash"` blocks**: when multiple files or changes collapse
  into one bash block (`symbol: null`), `line` is `null` while `added` and
  `removed` sum the underlying counts (or become `null` if any underlying count
  is `null`).

#### `FlowStep`

`{ "kind": "cmd" \| "edit", "text": string, "ok": bool, "dur_ms": u64, "seqs": u32[], "exit_code"?: i32, "error"?: string }`

`exit_code` (integer, may be negative) and `error` (bounded, redacted single error
line) are optional and omitted when absent. Only failed command (`kind: "cmd"`)
steps carry them, with `error` absent when `desk/tool-text-off` suppressed
`error_head` or no non-empty error line remained.

#### `Coverage`

`{ "state": "full" \| "partial", "reasons": CoverageReason[] }` where each
reason is one of `"daemon_gap"`, `"capture_late"`, `"capture_off"`,
`"too_large"`, `"transcript_unreadable"`, or `"turn_unclosed"`.

### Prompt kinds

Stored `Card.prompt` strings remain raw on disk. Display readers trim leading
whitespace and classify prompts purely at presentation time:

| Stored prefix (after leading trim) | Classification | Presentation title |
| --- | --- | --- |
| `<cross-session-message` | `cross_session` | `Message from another session` |
| `<task-notification>` | `task_notification` | `Background task notice` |
| `<command-name>` or `<command-message>` (with non-empty `<command-name>…</command-name>`) | `slash_command` | `<name> <args>` (`/`-prefixed `name` plus optional `<command-args>`, single line trimmed; falls back to `plain` if `<command-name>` is empty or absent) |
| Anything else | `plain` | First non-empty trimmed line (for list/why headings) |

### Label catalog

Labels sort by `importance` descending (`high` > `medium` > `low` > `none`),
breaking ties by the catalog declaration order below, and cap at `12` per
change. On `params_changed`, `return_type_changed`, and `symbol_removed`,
`importance` is `high` when `symbol.exported` is `true` and `medium` when
`false`. On `symbol_removed`, `symbol_added`, and `symbol_renamed`, `<kind>`
is `symbol.kind` (or `"file"` when `symbol` is `null`).

| # | `id` | `args` | `importance` | English chip text |
| --- | --- | --- | --- | --- |
| 1 | `params_changed` | `{"added":u32,"removed":u32,"changed":u32}` | `high` (exported) / `medium` | `parameters changed` |
| 2 | `return_type_changed` | `{}` | `high` (exported) / `medium` | `return type changed` |
| 3 | `symbol_removed` | `{}` | `high` (exported) / `medium` | `<kind> removed` |
| 4 | `symbol_added` | `{}` | `medium` | `new <kind>` |
| 5 | `symbol_renamed` | `{"from":string}` | `medium` | `<kind> renamed` |
| 6 | `guard_added` | `{}` | `medium` | `new guard` |
| 7 | `condition_changed` | `{}` | `medium` | `condition changed` |
| 8 | `branch_added` | `{}` | `medium` | `new branch` |
| 9 | `branch_removed` | `{}` | `medium` | `branch removed` |
| 10 | `error_handling_added` | `{}` | `medium` | `error handling added` |
| 11 | `error_handling_removed` | `{}` | `high` | `error handling removed` |
| 12 | `loop_added` | `{}` | `medium` | `new loop` |
| 13 | `loop_removed` | `{}` | `medium` | `loop removed` |
| 14 | `return_changed` | `{}` | `medium` | `return changed` |
| 15 | `call_added` | `{"name":string}` | `low` | `calls <name>` |
| 16 | `call_removed` | `{"name":string}` | `low` | `no longer calls <name>` |
| 17 | `await_changed` | `{"added":u32,"removed":u32}` | `low` | `await changed` |
| 18 | `body_changed` | `{}` | `low` | `body changed` |
| 19 | `value_changed` | `{"name":string,"before":string,"after":string}` | `medium` | `value changed` |
| 20 | `config_changed` | `{"key":string,"before":string\|null,"after":string\|null}` | `medium` | `config changed` |
| 21 | `dep_added` | `{"name":string,"version":string}` | `high` | `new dependency` |
| 22 | `dep_removed` | `{"name":string}` | `high` | `dependency removed` |
| 23 | `dep_version` | `{"name":string,"before":string,"after":string}` | `high` | `dependency version` |
| 24 | `import_added` | `{"module":string}` | `low` | `new import` |
| 25 | `import_removed` | `{"module":string}` | `low` | `import removed` |
| 26 | `test_added` | `{"name":string}` | `low` | `new test` |
| 27 | `test_removed` | `{"name":string}` | `high` | `test removed` |
| 28 | `test_skipped` | `{"name":string}` | `high` | `test skipped` |
| 29 | `test_only` | `{"name":string}` | `high` | `test .only` |
| 30 | `file_new` | `{}` | `medium` | `new file` |
| 31 | `file_deleted` | `{}` | `medium` | `file deleted` |
| 32 | `file_renamed` | `{"from":string}` | `medium` | `file renamed` |
| 33 | `format_only` | `{}` | `none` | `format only` |
| 34 | `rewrite` | `{"pct":u32}` | `low` | `rewritten` |
| 35 | `lockfile_changed` | `{}` | `low` | `lockfile changed` |
| 36 | `lines_changed` | `{"added":u32,"removed":u32}` | `low` | `lines changed` |
| 37 | `too_large` | `{}` | `low` | `too large` |
| 38 | `not_captured` | `{}` | `low` | `not captured` |

### MCP `why_file` projection

MCP `why_file` projects up to `limit` newest matching cards (default `5`, capped
at `10`) with a separate `cardsCoverage` read-completeness object
(`{ complete, reason?, skipped }`):

- **Card fields**: `card_id` (`32` lowercase hex chars pass through under
  `sanitized` exposure; other card IDs are projected), `started_ms`, `ended_ms`,
  `repo` (basename of `main_root ?? root`), `prompt` (first line or classified
  title clipped to `200` code points), `prompt_kind`, `agent_type`, up to `10`
  matching `blocks`, and optional `more_blocks`.
- **Slash commands**: under both `sanitized` and `raw` exposure, a slash
  command name matching `^/[A-Za-z0-9:_.-]{1,64}$` passes through unchanged in
  `prompt_kind.name` and as the leading token of `card.prompt`, while command
  `args` continue through `projectText` at the active exposure; invalid or
  control-bearing names stay projected.
- **Block projection & `more_blocks`**: `blocks[].via` maps `"edit"` to `"edit"`,
  `"bash"` to `"bash"`, and any other string to `"other"`; `blocks[].quote` is
  clipped to `500` code points. When valid matching blocks exceed `10`,
  `more_blocks` records the number of dropped matching blocks (omitted when
  `0`) and `truncated` is `true`. Stored hashes (`before`, `after`),
  `tool_use_ids`, `flow`, `symbol.exported`, and `symbol.nth` are never
  returned.
- **Label `args` allowlist**: `labels[].args` is projected through a strict
  per-label allowlist aligned with the catalog above. Literal `before`, `after`,
  and `version` label values (and any unknown label keys or un-allowlisted
  args) are **never** returned under either `sanitized` or `raw` exposure (for
  example, `config_changed`, `value_changed`, `dep_version`, and `dep_added`
  return only `key` or `name`; allowlisted strings use `projectText`, and
  allowlisted counters require safe non-negative integers).

## Pipe v3

> Superseded by [Pipe v4](#pipe-v4) below; peers sending another major version receive one `error` (`code: "version"`) and the connection closes.

One JSON object per line over the daemon pipe. Every message carries `v`
(major) first and `type`. Historically this build spoke v3; a peer that sends another
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
| daemon → desk | `snapshot` | `agents[]`, `aggregate`, `health`, `settings`, `repo_pending[]` |
| daemon → desk | `status` | `op: "upsert" \| "remove"`, `agent` |
| daemon → desk | `health` | `spool_pending`, `spool_dropped`, `dropped_events`, `bad_files`, `late_events`, `hook_newer_than_daemon`, `gaps[]`, `settings_unreadable`, `setup`, `capture[]` |
| daemon → desk | `settings` | full settings object, broadcast after every successful `set` |
| desk → daemon | `set` | `id`, `name`, `value` |
| desk → daemon | `timeline` | `id`, `key` |
| daemon → desk | `timeline` | `id`, `key`, `entries[]` |
| desk → daemon | `cmd` | `name: "stop" \| "show" \| "quit"`, `id` |
| daemon → desk | `show` | — (broadcast to every desk after a `cmd` `show`) |
| daemon → desk | `quit` | — (broadcast to every desk after a `cmd` `quit`) |
| daemon → desk | `ack` | `id`, `ok`, `error?` |
| desk → daemon | `setup` | `id`, `action` (an object tagged by `name`) |
| desk → daemon | `repo_decision` | `id`, `root`, `allow` |
| daemon → desk | `consent_plan` | `id`, `consent`, `targets[]`, `harness_off[]`, `shell_hook` |
| daemon → desk | `repo_list` | `id`, `repos[]` |
| daemon → desk | `repo_pending` | `repos[]` (broadcast when the pending list changes) |

`agent` carries `key` (`session_id`, `agent_id`; empty `agent_id` means the
main agent), `agent_type?`, `status` (`idle` | `working` | `needs_you` |
`done` | `failed` | `ended`), `action?` (`tool_name`, `target_path?`,
`tool_use_id?`, `command?`), `summary?`, `description?`, `failures`,
`last_event_ms`, `quiet_10m`, and `repo` (`root?`, `name`, `branch?`). `repo`
is the repo of the session's start. A `SessionStart` event that carries a
`cwd` always sets it, so a session resumed or cleared in another directory
moves. Any other event sets it only while the session has no repo yet or holds
the placeholder a session has before any `cwd` is known, and an event without
a `cwd` leaves the placeholder. A prompt from another directory does not move
the session.

`description` is the task text from the main agent's one unpaired `Agent` or
`Task` tool call, attached to the child that starts next. It stays absent
when zero or several calls are open, or when tool text is off.
`action.command` is the redacted command text, absent when tool text is off.

`health.gaps` holds at most 100 gaps whose `to_ms` is within the last 24 h.
`snapshot.health.gaps` carries the same list; there is no top-level `gaps`
field. A gap is `{from_ms, to_ms, count, reason}`; `reason` is `spool_full`
(dropped spool files), `history_full` (dropped history segments),
`hook_dropped` (a `dropped` spool record), `bad_file` (a quarantined spool
file), or `hooks_restored` (the setup guard put Rocky's desk hook entries back
after they went missing; `from_ms` is when the daemon saw them missing, `to_ms`
when the repair finished, and `count` is 0, because the daemon cannot count
hook events it never received).

`snapshot` is sent once after `subscribe`, and once at daemon startup for
desks that connected while it was replaying. `snapshot.repo_pending` lists the
repos that wait for a capture decision, as under Setup guard messages.

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
true`. `cmd` with `name: "quit"` is broadcast as `quit` to every desk, the
sender included, before the sender gets `ack` with `ok: true`; the daemon
then exits.

### Capture health

`health.capture` is a list with one row per repo the daemon's capture process
tracks: `{root, state, last_reconcile_ms, error}`. It is empty while no repo is
consented and no allowed session root exists, because the daemon
then runs no capture process. `snapshot.health.capture` carries the same list.
`root` is the repo path. `last_reconcile_ms` is when the last reconcile of that
repo finished, epoch milliseconds, or `null` before the first one. `error` is a
fixed sentence for a `failed` or `polling` row and `null` otherwise; it never
quotes a Node note or a path.

`state` is one of:

| `state` | Meaning |
|---|---|
| `starting` | The process has not reported a reconcile for this repo yet. |
| `ok` | The last reconcile covered the repo completely. |
| `partial` | The last reconcile skipped something, such as an oversized, binary, or unreadable file, or it stopped at the path cap. |
| `elsewhere` | Another process holds the repo's lease, as when `rocky dash` runs. The daemon does not capture it and does not count that as a fault. |
| `polling` | The daemon could not watch the repo's files, so a change waits for the 60 s reconcile instead of a wake-up. The repo is still captured. |
| `failed` | The reconcile reported `coverage: "unknown"`, or the capture process cannot run: the CLI record is missing, the process failed to start, or the start limit was reached. `error` says which. |

The daemon starts the capture process when a repo is consented or an allowed
linked worktree has a session, and stops it, with stdin closed first, when
neither holds. It starts it at most 3 times in 5 minutes, counted as a sliding
window; past that every row is `failed` until the window clears. It watches each
repo it owns, ignoring `.git/` and access events, waits 300 ms after the first
change before it asks for a reconcile (later changes do not move that wait), and
sends at most one watcher-driven request per repo every 2 s (a root with no
consent key is also sent once per child start). The daemon reads only `<ROCKY_HOME>/listening/repo-consents.json`
from that directory.

`capture` is additive within protocol 3. A `health` or `snapshot` frame without
it decodes to an empty list, and `PROTOCOL_VERSION` stays 3.

### Setup guard messages

The daemon guards Rocky's entries in agent config files. It reads the setup
records and checks the guarded files by bytes. It never parses or writes an
agent config. A repair or a client request runs the Node CLI named by
`<ROCKY_HOME>/bin/cli.json` (`rocky setup --auto`), one job at a time. Without a
`consent.json` in state `approved`, the daemon starts no repair and no
config-directory run; `setup` and `repo_decision` requests still run, because
Node enforces consent itself. One more run is not gated on consent: once
`cli.json` points at a `node` and an `entry` that exist, the daemon runs
`repo status <root>` once per daemon run for each repo root a session started
in, to read that repo's capture decision. That run writes nothing.

`health.setup` is `{consent_state, cli_found, cli_missing, version_mismatch,
targets[]}`. A frame without `setup` reads as the default: no consent, no CLI,
no targets.

- `consent_state` is `none` (no `consent.json`), `approved`, `later`,
  `removed`, or `invalid` (unreadable, another version, or a state Node never
  writes).
- `cli_found` is true when both the `node` and `entry` paths of `cli.json` are
  regular files. When one is not, `cli_missing` names the first such path.
  Otherwise `cli_missing` is `null`, which includes the case of no `cli.json`
  (`cli_found` is then false).
- `version_mismatch` is true when the `version` in `cli.json` differs from the
  one in `binaries.json`. It is false when either file is missing or
  unreadable.
- `targets` is empty unless `consent_state` is `approved`. A target is
  `{harness, kind, path, state, last_repair_ms, fights_10m, error}`; unset
  `last_repair_ms` and `error` are `null`.
  `harness` is a harness id or `shell`; `kind` is `agent-hooks`, `desk-hooks`,
  `mcp`, or `shell-hook`. A path that is missing but belongs to no stored
  target appears with empty `harness` and `kind`.
- `last_repair_ms` is when the daemon last saw a repair of that path stick.
  `fights_10m` counts the losses in the last 10 minutes that came within 30 s
  of a repair. More than 5 of them, or a failed last attempt, hold the next
  repair until 60 s after the last attempt. `error` is the latest repair error
  for a missing path, or Node's detail for a `foreign`, `refused`, or `error`
  target.

`state` is one of:

| `state` | Meaning |
|---|---|
| `ok` | The entry is present and current. |
| `missing` | The entry is gone. A path the daemon still finds without Rocky's entry shows `missing` even when Node reported `ok` or `written`. |
| `stale` | Rocky's entry is present but not current, or the desk binary it points at is not installed. |
| `written` | The run wrote the entry. |
| `changed` | The file changed while the run was writing it, so the run backed off. The daemon retries after 2, 4, 8, 16, and 30 s, then stops retrying for this reason. |
| `foreign` | The slot holds an entry Rocky does not own. It is left alone. |
| `refused` | The location failed validation, so nothing was written there. |
| `not_consented` | No approved consent covers the target. |
| `error` | The run failed for this target. |

Client `setup` is `{"v":3,"type":"setup","id":7,"action":{"name":"plan"}}`.
`action` is tagged by `name`:

| `name` | Extra field | Node command |
|---|---|---|
| `plan` | — | `plan`, an inspection that writes nothing |
| `apply` | — | `apply`, which writes every in-scope entry under approved consent |
| `remove` | — | `remove`, which takes out everything Rocky wrote |
| `consent_approve` | — | `consent approve` |
| `consent_later` | — | `consent later` |
| `harness_on` | `harness` | `harness <id> on` |
| `harness_off` | `harness` | `harness <id> off` |
| `shell_on` | — | `shell on` |
| `shell_off` | — | `shell off` |
| `repo_list` | — | `repo list` |
| `repo_purge` | `root` | `repo purge <root>` |

`plan` is answered with `consent_plan`, `{id, consent, targets[], harness_off[],
shell_hook}`: `consent` is a consent state, and each target is `{harness,
kind, path, state, detail?}` with a `state` from the table above; `detail` is
absent when Node gave none. `harness_off` and `shell_hook` mirror the consent
record; a frame without them decodes to `[]` and `true`. `repo_list` is
answered with `repo_list`, `{id, repos[]}`, where each repo is `{key, main,
name, decision, bytes, worktrees[]}` as in the setup result. Every other
action is answered with `ack`. A failed run of any
action, `plan` included, is answered with `ack` and `ok: false`, and an
`error` that names the cause, such as a missing CLI record, a Node run that
timed out, or `daemon stopping`. A `setup` request for an unknown harness id
is refused without a Node run.

Client `repo_decision` is `{"v":3,"type":"repo_decision","id":8,"root":"<repo
root>","allow":true}`. Node records the capture decision for that repo
(`allow` true grants it, false records a decline), and the daemon answers with
`ack`.

`repo_pending` is `{repos[]}`, and `snapshot.repo_pending` carries the same
list. A repo is `{key, main, name}`: `key` is the normalized consent key, `main`
the path of the repo's main working tree, and `name` the last segment of
`main`. A repo is listed once it is the root of a session and has no recorded
capture decision. It leaves the list when `repo_decision` records a decision.
The daemon reads decisions through Node and never edits
`repo-consents.json`.

These messages, `health.setup`, `snapshot.repo_pending`, and the
`hooks_restored` gap reason are additive within protocol 3. `PROTOCOL_VERSION`
stays 3, and a `health` or `snapshot` frame without the new fields decodes to
their defaults: no setup status and an empty `repo_pending`.

Example:

```json
{"v":3,"type":"subscribe"}
```

## Pipe v4

Current wire protocol between `rockyd` and `rocky-desk`. Shares v3's newline-delimited JSON framing, `1024`-message outbound queue per client, and `"version"` error close behavior. `LINE_CAP` (`64 KiB`) bounds client-to-daemon lines (the server disconnects on a longer client line); card replies (`cards`, `card_detail`, `block_diff`) and live `card` pushes apply their own `64 KiB` shrinking, drop, or `too_large` rules, while `rocky-desk` accepts general daemon-to-desk lines (such as large `snapshot` messages) up to `16 MiB` (`SERVER_LINE_CAP`). Changes from v3:

### Version and additive fields

- Every frame uses `"v": 4`.
- `AgentStatus.prompt` (optional, omitted when unset): `{"text": string, "truncated": bool}` carrying the main agent's live `UserPromptSubmit` prompt in daemon memory. Never written to `desk/history/` or persisted status files (and unset after a daemon restart until a new prompt arrives), though its source text passes through `<ROCKY_HOME>/desk/spool/` when recorded by the hook and may be stored on disk in a change card while change cards are on. Switching `cards` off stops new prompt recording by the hook (`desk/cards-off`), clears every `AgentStatus.prompt` held in memory (broadcasting fresh `status` rows), drops incoming or already-spooled prompts on ingest, and stops new card building: while switched off, no prompt is kept or shown.
- `TimelineEntry.dur_ms` (optional, omitted when pending): unsigned millisecond duration filled when the matching tool outcome arrives.
- `RepoInfo.main_root` (optional, omitted when unset): main repository root path for any resolved Git repository (equal to `root` in the main checkout, different in a linked Git worktree); omitted only when it cannot be resolved (such as outside Git).
- `Ack.cleanup_errors` (`u32`, defaults to `0`): count of cleanup errors during `setup` removal.

### New card query and push messages

Client → Daemon:

- `cards`: `{"v":4,"type":"cards","id":u64,"query":string?,"before":string?,"limit":u32}` — lists newest-first change cards; `limit` caps at `20`, `query` matches file or repo, and `before` passes the opaque pagination cursor `"<key_ms>:<card_id>"`.
- `card_detail`: `{"v":4,"type":"card_detail","id":u64,"card_id":string}` — requests full card metadata and inline code snippets.
- `block_diff`: `{"v":4,"type":"block_diff","id":u64,"card_id":string,"seq":u32,"page":u32}` — requests a 0-based page of the unified diff for one block.

Daemon → Client:

- `cards`: `{"v":4,"type":"cards","id":u64,"items":Card[],"next":string?}` — page of list cards (block `quote.text` capped to `200` Unicode scalar chars; no code snippets). When more cards may follow, `next` holds `"<key_ms>:<card_id>"` where `key_ms` is `ended_ms ?? started_ms`.
- `card`: `{"v":4,"type":"card","item":Card}` — live broadcast when a card is created or revised (uses the same `200`-char quote cap; dropped rather than overflowing `64 KiB` if shrinking cannot fit it).
- `card_detail`: `{"v":4,"type":"card_detail","id":u64,"card":Card,"snippets":BlockSnippet[]}` — `BlockSnippet` is `{"seq":u32,"lines":SnippetLine[]}` with `"t"`-tagged lines: `"context"|"added"|"removed"` (`{"t":..., "text":string}`) and `"fold"|"more"` (`{"t":..., "lines":u32}`). Code snippets are assembled only for recorded blocks in capture-consented repos (`card.root` in owned roots), capped at `20` codable blocks; unowned repos or missing/oversized objects omit snippets and add `capture_off` / `too_large` coverage reasons.
- `block_diff`: `{"v":4,"type":"block_diff","id":u64,"lines":DiffLine[],"page":u32,"pages":u32,"missing":bool}` — `DiffLine` is `{"kind":"context"|"added"|"removed","text":string}`, paginated to at most `48 KiB` of serialized lines per page. Missing/evicted Listening objects, unrecorded blocks, or unowned repo cards return `missing: true` with `lines: []`, `pages: 0`.

### Frame shrinking and card query errors

`cards`, `card`, and `card_detail` progressively trim optional detail (flow steps, overflow blocks/snippets, and list prompts) to fit within `64 KiB`. When a card or block `seq` is missing, or a detail/diff reply still exceeds `64 KiB` after shrinking, `rockyd` responds with `ack` (`ok: false`):

| `error` | Meaning |
| --- | --- |
| `not_found` | Unknown `card_id`, or unknown block `seq` in `block_diff`. |
| `too_large` | Shrunk `card_detail` or serialized `block_diff` frame still exceeds `64 KiB`. |
| `internal` | Card query worker panicked while handling the request. |
| `query worker unavailable` | Card query worker channel is closed. |

Example (`cards` request):

```json
{"v":4,"type":"cards","id":1,"limit":20}
```
