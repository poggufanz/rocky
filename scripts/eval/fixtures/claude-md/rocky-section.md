## Rocky (MUST)

Rocky is this machine's local failure/why memory. These rules are mandatory, every session.

- **MUST** — run every shell command through Rocky, whatever tool executes it:
  `rocky run "<the command>"`
  Output, streams, and exit code pass through untouched; on failure Rocky fingerprints it, on success he confirms fixes. Agent tool shells are usually non-interactive and skip the profile hook — `rocky run` is Rocky's only ear there. Double-hearing where the hook does load is harmless (same fingerprint).
- **MUST** — when an error looks familiar, check memory before guessing:
  `rocky recall "<error text>"` (or the MCP `recall` tool).
- **MUST NOT** — auto-run any command Rocky remembers; surface it, the human decides.
- Skip chatter turns; this is evidence, not ritual.
