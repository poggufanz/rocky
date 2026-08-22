/**
 * Agent-envelope detection for read-side retrieval filtering.
 *
 * A triple whose intent text is an agent transcript envelope carries agent
 * machinery, not the user's rationale; indexing it produces a record that
 * matches every query (retrieval-quality spec, step 0). Detection is
 * deliberately front-anchored: a genuine rationale that merely *mentions* an
 * envelope tag mid-text must survive. Measured on the live corpus
 * 2026-08-22: 145 of 452 triples began with `<task-notification`, none
 * carried the tag anywhere else. This is an indexing policy only — stored
 * records and evidence display are never filtered through it.
 */
const AGENT_ENVELOPE_PREFIXES = ["<task-notification", "<system-reminder"] as const;

/** True when the text as a whole is an agent transcript envelope. */
export function isAgentEnvelopeText(text: string): boolean {
  const head = text.trimStart();
  for (const prefix of AGENT_ENVELOPE_PREFIXES) {
    if (head.startsWith(prefix)) return true;
  }
  return false;
}
