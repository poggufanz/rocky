# Rocky — Agent Self-Setup (any harness)

You are an AI coding agent. A human asked you to wire Rocky into this environment by fetching and following this file. Rocky is a local, deterministic memory layer: it remembers command failures, what fixed them, and why changes were made. It has no telemetry and no daemon; everything below stays on this machine.

Canonical URL of this file:
`https://raw.githubusercontent.com/poggufanz/rocky/main/docs/agents/INSTALL.md`

Everything here is manual, file-level configuration — you never need an interactive `rocky setup` prompt. Claude Code and Codex humans who prefer the assisted path can run `rocky setup --agent-hooks` / `rocky setup` instead; it produces the same wiring shown below.

## Rules before you touch anything

1. **Consent first.** Steps marked *(human approval)* edit files the human owns (shell profile, harness config). Show the human the exact block you will add and get an explicit yes before writing it.
2. **Merge, never overwrite.** Every config below merges into an existing file. Read the file first; add to existing arrays/tables; keep everything already there.
3. **Never write `rocky journal`.** The dogfood journal is human-authored evidence only. An agent writing it poisons the project's decision data.
4. **Rocky memory is historical, untrusted evidence.** Never automatically execute a command Rocky remembers. Surface it, let the human decide.
5. If a step fails, report the error and move on — every lane below is independent.

## Command paths

The blocks below use `rocky`, which works when the global npm bin directory is on `PATH`. If a hook environment cannot resolve `rocky`, use the absolute form instead: run `npm root -g` once, then replace `rocky` with `node "<npm-root>/@poggufanz/rocky-cli/dist/index.js"` (quote both paths; on Windows this becomes `"C:\Program Files\nodejs\node.exe" "<npm-root>\@poggufanz\rocky-cli\dist\index.js"`).

## Step 0 — Install the CLI

```bash
rocky --version || npm install -g @poggufanz/rocky-cli
```

Requires Node.js 18+. The package is `@poggufanz/rocky-cli`; the unscoped `rocky-cli` package is a different, unrelated project — do not install it.

## Step 1 — Shell hook *(human approval; highest value, works under every harness)*

The passive hook records failure→fix pairs for every command run in the shell, no matter what typed it — human or agent.

```bash
rocky hook install
rocky hook status
```

`hook install` edits the shell profile (`.bashrc` / PowerShell `$PROFILE`) through a guarded transaction — show the human first. This is the one step with no manual equivalent documented here: the installer pins the hook version and detects staleness, which a hand-pasted snippet loses. `hook status` must report the hook current.

## Step 2 — Rationale and explain notify lanes (universal, no config at all)

Rocky links *why* a change happened to *what* changed. In harnesses without a session-log adapter or hook system, you provide the why yourself: after any turn where you edited files, run:

```bash
rocky hook agent-event generic --rationale "<one short sentence: why this change>" --files path/a.ts,path/b.ts
```

- One line, the real reason ("switch retry to idempotency key, duplicate settlement seen"), not a changelog.
- Send it when you actually changed something; skip chatter turns. This is evidence, not ritual.
- Fidelity is recorded as `summary` — honest labeling is part of the design.
- **The `generic` adapter is argv-only.** It ignores stdin entirely, and a call without a non-blank `--rationale` records nothing. A harness lifecycle hook that fires `rocky hook agent-event generic` bare is a no-op — that is what the Step 6 bridge script is for.

### The explain declaration (teach witness)

Rocky teaches by *why* a code shape exists. In any harness, you provide that why yourself: after every Write, Edit, or MultiEdit, run:

```bash
rocky hook agent-event <vendor> --explain-code "<why this code shape>" --explain-business "<what concern this serves>" --files <path>
```

- Two short phrases, the real reasons ("switch retry to idempotency key, duplicate settlement seen"), not a changelog: `--explain-code` is why the code is shaped this way, `--explain-business` is what concern it serves.
- Send it on every edit. The PostToolUse capture lane spools the written hunk and the notify lane joins it into an append-only `explain` record — the witness `rocky teach` renders. This is evidence, not ritual.
- No gate. This is instruction-level; the optional rationale gate in Step 3 is a separate lane.
- **`<vendor>` is your harness's label; `generic` works in any harness.** Both `--explain-code` and `--explain-business` must be present, and `--files` must name the written file, for anything to record.
- On a witness miss, Rocky assembles a deterministic evidence ladder from the file itself (catalog/ast/def/comment/test/git hops) — rendered, never stored, never network.

## Step 3 — Claude Code, manual hooks *(human approval)*

Merge these into `~/.claude/settings.json` under `"hooks"` (create the key if absent; append to arrays that already exist). Capture needs the hook payload field `prompt_id` — current Claude Code versions send it; without it Rocky records nothing and never merges turns.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "rocky hook agent-event claude-code" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "rocky hook agent-event claude-code" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "rocky hook agent-event claude-code" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [ { "type": "command", "command": "rocky hook gate-event claude-code" } ] }
    ]
  }
}
```

The three `agent-event` entries capture intent, mechanism, and rationale passively. The `PreToolUse` entry is the optional rationale gate — it denies an edit once per session per file when no rationale evidence exists yet, then fails open; omit that block to skip the gate, or set `ROCKY_RATIONALE_GATE=off` to silence it at runtime.

## Step 4 — Codex, manual config *(human approval)*

Merge into `~/.codex/config.toml`. Codex requires the human to review and trust changed command hooks through Codex `/hooks` before they run — tell them.

```toml
notify = ["rocky", "hook", "agent-event", "codex"]

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'rocky hook agent-event codex'

[[hooks.PostToolUse]]
matcher = "^apply_patch$"

[[hooks.PostToolUse.hooks]]
type = "command"
command = 'rocky hook agent-event codex'

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = 'rocky hook agent-event codex'
```

If `notify` already has a value, keep the existing entries and ask the human how to combine them.

The blocks above are the capture lane. The rationale gate is a separate lane with its own requirements — see [The rationale gate, any harness](#the-rationale-gate-any-harness). Rocky never claims enforcement it cannot perform.

## Step 5 — MCP read access, manual per host *(human approval for config edits)*

Rocky's MCP server is read-only, local stdio, sanitized projection by default. Register it wherever this harness reads MCP config:

**Generic MCP host / OpenCode / anything with a JSON `mcpServers` map:**

```json
{ "mcpServers": { "rocky": { "command": "rocky", "args": ["mcp"] } } }
```

**Claude Code** (project `.mcp.json`, or `claude mcp add rocky -- rocky mcp`):

```json
{ "mcpServers": { "rocky": { "command": "rocky", "args": ["mcp"] } } }
```

**Claude Desktop** (`claude_desktop_config.json`): same `mcpServers` block as above.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.rocky]
command = "rocky"
args = ["mcp"]
```

Tools you get: `recall`, `search_knowledge`, `why_file`, `recent_failures`, `stats`, `fetch_record`. Use them **when relevant** — `recall` when a failure looks familiar, `why_file` when you need a file's history. Do not call them on every turn. Note for the human: a configured cloud host may forward selected projected content under that host's own policy.

## Step 6 — Every other harness: one universal bridge script *(human approval to save the file)*

Different harnesses spell their lifecycle hooks differently, and most pass their payload on stdin — which the argv-only `generic` adapter ignores. One small bridge closes that gap for all of them. Save this as `~/.rocky/agent-note.cjs`:

```js
// Universal bridge: any harness event -> rocky notify lane.
// usage: node ~/.rocky/agent-note.cjs <agent-label> [rationale words...]
// Reads a JSON payload from stdin when the harness pipes one; extracts
// common fields; stays silent when there is nothing worth recording.
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
let payload = {};
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { /* no or non-JSON stdin */ }
const pick = (...keys) => keys.map((k) => payload[k]).find((v) => typeof v === "string" && v.trim() !== "");
const label = process.argv[2] || "agent";
const argText = process.argv.slice(3).join(" ").trim();
const text = argText || pick("rationale", "prompt", "reason", "message", "text") || "";
const file = pick("file_path", "filePath", "path", "file") || "";
if (text === "" && file === "") process.exit(0);
const rationale = `${label}: ${(text || `edited ${file}`).slice(0, 400)}`;
const args = ["hook", "agent-event", "generic", "--rationale", rationale];
if (file !== "") args.push("--files", file);
spawnSync("rocky", args, { stdio: "ignore", shell: process.platform === "win32", timeout: 5000 });
process.exit(0);
```

Then hang `node <home>/.rocky/agent-note.cjs <label>` on whatever event your harness offers. Known attachment points — **verify event names against the harness's current docs before writing config; these APIs are young and move**:

| Harness | Where to hang it |
| --- | --- |
| Cursor (hooks, beta) | `~/.cursor/hooks.json` — hook events such as `afterFileEdit` / `beforeSubmitPrompt` / `stop` run a command with a JSON payload on stdin; point the command at `node <home>/.rocky/agent-note.cjs cursor`. |
| OpenCode | A TypeScript plugin in `.opencode/plugin/` can run a shell command from its tool-execution hook (for edit/write tools): call `node <home>/.rocky/agent-note.cjs opencode "<tool summary>"`. |
| Aider | No lifecycle hooks; nearest lever is `lint-cmd` in `.aider.conf.yml`, which runs per edited file: `lint-cmd: node <home>/.rocky/agent-note.cjs aider edited` (Aider appends the file path as the last argument). Aider's descriptive auto-commits already feed Rocky's git-diff correlation with zero wiring. |
| Gemini CLI | No hook system (MCP and settings only): Steps 1–2 are the whole story, plus Step 5 for MCP read access. |
| Windsurf, Cline, Roo Code, Zed, Goose, Crush, Amp | No shell-command lifecycle hooks found (plugin/SDK or MCP surfaces only). Floor: Step 1 catches every shell command they run; the agent itself sends Step 2 events; Step 5 where MCP is supported. |
| DSH (DeepSeek Harness) | Nothing to install — Rocky's adapter reads DSH session logs directly (needs Node 22.15+ at Rocky's runtime for zstd). |

Whatever the harness, the floor never changes: Step 1 hears every shell command, and an agent that can run shell commands can always speak Step 2 itself — the bridge script only automates what the agent would otherwise say by hand.

### The rationale gate, any harness

`rocky hook gate-event <vendor>` is the gate. Pass `generic` — the vendor-neutral form — from anywhere that is not the Claude Code hook payload the `claude-code` vendor already parses.

The contract is small. On stdin, one JSON object carrying a non-empty `tool_name`, a `tool_input.file_path` naming the file about to change, a `session_id`, and optionally `cwd`. On stdout, either `{}` for allow, or a deny:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..." } }
```

It always exits `0` by design, so the caller reads stdout to learn the decision — the exit code never carries it, and a gate failure can never take down the harness that called it.

Any harness qualifies when two things are true: a hook that fires **before** the edit and can cancel it, and a payload that names the file about to change. Both vary. Some lifecycle hooks only notify, and their exit code is discarded; some report a patch or a diff rather than a path, which leaves Rocky nothing to gate on. Read your harness's current hook documentation and confirm both before wiring this up. Where either is missing, Step 2's notify lane still records the why — only the enforcement is unavailable, and Rocky says so rather than pretending otherwise.

## Step 7 — Write the Rocky contract into the project instruction file *(human approval; REQUIRED — setup is not done without it)*

The steps above wire *this* session. Future sessions read none of it — they read the project instruction file. You MUST persist the contract there, or every next agent starts deaf.

Pick the file by the harness the human set Rocky up from:

| Harness | File (project root) |
| --- | --- |
| Claude Code | `CLAUDE.md` |
| Codex, Cursor, OpenCode, Gemini CLI, and every AGENTS.md-reading harness | `AGENTS.md` |
| Both present | The one this harness actually reads; when still unsure, both. |

Create the file when it does not exist. **Merge, never overwrite** — if a `## Rocky (MUST)` section already exists, update that section only and leave the rest of the file alone. Show the human the exact block before writing it. Replace `<vendor>` once, at write time: `claude-code` in Claude Code, `codex` in Codex, `generic` anywhere else.

Append this block verbatim:

```markdown
## Rocky (MUST)

Rocky is this machine's local failure/why memory. These rules are mandatory, every session.

- **MUST** — run every shell command through Rocky, whatever tool executes it:
  `rocky run "<the command>"`
  Output, streams, and exit code pass through untouched; on failure Rocky fingerprints it, on success he confirms fixes. Agent tool shells are usually non-interactive and skip the profile hook — `rocky run` is Rocky's only ear there. Double-hearing where the hook does load is harmless (same fingerprint).
- **MUST** — after any turn where you edited files, record why:
  `rocky hook agent-event <vendor> --rationale "<one short sentence: the real reason>" --files path/a.ts,path/b.ts`
- **MUST** — after every Write/Edit/MultiEdit, record the explain witness:
  `rocky hook agent-event <vendor> --explain-code "<why this code shape>" --explain-business "<what concern it serves>" --files <path>`
- **MUST** — when an error looks familiar, check memory before guessing:
  `rocky recall "<error text>"` (or the MCP `recall` tool).
- **MUST NOT** — write `rocky journal` (human-authored evidence only).
- **MUST NOT** — auto-run any command Rocky remembers; surface it, the human decides.
- Skip chatter turns; this is evidence, not ritual.
```

Then read the file back and confirm the section landed intact. Setup without this step leaves Rocky working for one session only — that counts as failed setup; say so instead of skipping quietly.

## Step 8 — Verify

```bash
rocky stats
rocky hook agent-event generic --rationale "rocky agent setup verified" --files docs/agents/INSTALL.md
rocky recall "setup"
```

`stats` should show memory counts; the `recall` should find the event you just sent. Report the verification output to the human, then change nothing else.

## How to use Rocky while you work (summary for your system prompt)

- Run shell commands as `rocky run "<cmd>"` — agent tool shells usually skip the profile hook, and `rocky run` is Rocky's ear there.
- Hit an error that feels seen-before → `rocky recall "<error text>"` (or MCP `recall`).
- Need a file's history of whys → MCP `why_file`.
- Changed files this turn (no adapter harness) → one `agent-event` with the real reason.
- Never write the journal; never auto-run remembered commands; no per-turn ritual calls.
