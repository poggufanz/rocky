import type { StoredBlock, StoredCard } from "./cards-record.js";

/** Prompt classification used to derive card titles for display. */
export type PromptKind =
  | { kind: "plain" }
  | { kind: "task_notification" }
  | { kind: "cross_session" }
  | { kind: "slash_command"; name: string; args: string };

const SEQUENCE_CMD_MAX_CHARS = 80;
const CONTROL_OR_LINE_SEP_RE = /\r\n|[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

const STATIC_LABEL_CHIPS: ReadonlyMap<string, string> = new Map<string, string>([
  ["params_changed", "parameters changed"],
  ["return_type_changed", "return type changed"],
  ["guard_added", "new guard"],
  ["condition_changed", "condition changed"],
  ["branch_added", "new branch"],
  ["branch_removed", "branch removed"],
  ["error_handling_added", "error handling added"],
  ["error_handling_removed", "error handling removed"],
  ["loop_added", "new loop"],
  ["loop_removed", "loop removed"],
  ["return_changed", "return changed"],
  ["await_changed", "await changed"],
  ["body_changed", "body changed"],
  ["value_changed", "value changed"],
  ["config_changed", "config changed"],
  ["dep_added", "new dependency"],
  ["dep_removed", "dependency removed"],
  ["dep_version", "dependency version"],
  ["import_added", "new import"],
  ["import_removed", "import removed"],
  ["test_added", "new test"],
  ["test_removed", "test removed"],
  ["test_skipped", "test skipped"],
  ["test_only", "test .only"],
  ["file_new", "new file"],
  ["file_deleted", "file deleted"],
  ["file_renamed", "file renamed"],
  ["format_only", "format only"],
  ["rewrite", "rewritten"],
  ["lockfile_changed", "lockfile changed"],
  ["lines_changed", "lines changed"],
  ["too_large", "too large"],
  ["not_captured", "not captured"],
]);

function extractTag(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  const rest = text.slice(start + open.length);
  const end = rest.indexOf(close);
  if (end === -1) return undefined;
  return rest.slice(0, end).trim();
}

function kindWord(kind: string | null): string {
  return kind && kind.length > 0 ? kind : "file";
}

/** Classify a stored prompt string into plain text, notices, or slash command. */
export function classifyPrompt(prompt: string): PromptKind {
  const trimmed = prompt.trimStart();
  if (trimmed.startsWith("<cross-session-message")) {
    return { kind: "cross_session" };
  }
  if (trimmed.startsWith("<task-notification>")) {
    return { kind: "task_notification" };
  }
  if (trimmed.startsWith("<command-name>") || trimmed.startsWith("<command-message>")) {
    const rawName = extractTag(trimmed, "<command-name>", "</command-name>");
    if (!rawName) return { kind: "plain" };
    const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
    const args = extractTag(trimmed, "<command-args>", "</command-args>") ?? "";
    return { kind: "slash_command", name, args };
  }
  return { kind: "plain" };
}

/** Produce a single-line card title from a stored prompt. */
export function promptTitle(prompt: string): string {
  const classified = classifyPrompt(prompt);
  switch (classified.kind) {
    case "task_notification":
      return "Background task notice";
    case "cross_session":
      return "Message from another session";
    case "slash_command":
      return `${classified.name} ${classified.args}`.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
    case "plain": {
      const firstLine = prompt
        .split(/[\r\n\u2028\u2029]/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return firstLine ?? "";
    }
  }
}

/** Format an English label chip for a stored block label and optional symbol kind. */
export function labelChip(label: { id: string; args?: Record<string, unknown> }, kind: string | null): string {
  switch (label.id) {
    case "symbol_removed":
      return `${kindWord(kind)} removed`;
    case "symbol_added":
      return `new ${kindWord(kind)}`;
    case "symbol_renamed":
      return `${kindWord(kind)} renamed`;
    case "call_added": {
      const name = label.args?.name;
      return typeof name === "string" ? `calls ${name}` : label.id;
    }
    case "call_removed": {
      const name = label.args?.name;
      return typeof name === "string" ? `no longer calls ${name}` : label.id;
    }
    default:
      return STATIC_LABEL_CHIPS.get(label.id) ?? label.id;
  }
}

function sanitizeSingleLine(value: string): string {
  return value.replace(CONTROL_OR_LINE_SEP_RE, " ");
}

function cutToLimit(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}\u2026`;
}

function normalizeAndCutCommand(command: string): string {
  const clean = sanitizeSingleLine(command);
  const normalized = clean.trim().split(/\s+/u).filter((part) => part.length > 0).join(" ");
  return cutToLimit(normalized, SEQUENCE_CMD_MAX_CHARS);
}

function formatSequenceSymbol(symbol: StoredBlock["symbol"]): string | undefined {
  if (!symbol) return undefined;
  const name = sanitizeSingleLine(symbol.name);
  if (name.length === 0) return undefined;
  if ((symbol.kind === "function" || symbol.kind === "method") && !name.endsWith("()")) {
    return `${name}()`;
  }
  return name;
}

function blockHead(block: StoredBlock): string {
  const path = sanitizeSingleLine(block.path);
  const symbol = formatSequenceSymbol(block.symbol);
  return symbol !== undefined ? `${path} \u203a ${symbol}` : path;
}

/** Render the English order-only sentence for a card's sequence pattern, if resolvable. */
export function sequenceSentence(card: StoredCard): string | undefined {
  const seq = card.sequence;
  if (!seq || seq.pattern !== "fix_after_fail") return undefined;
  const cmd = normalizeAndCutCommand(seq.command);
  if (cmd.length === 0) return undefined;

  const blockBySeq = new Map<number, StoredBlock>();
  for (const block of card.blocks) {
    blockBySeq.set(block.seq, block);
  }

  const seen = new Set<number>();
  const resolved: StoredBlock[] = [];
  for (const editSeq of seq.edit_seqs) {
    if (seen.has(editSeq)) continue;
    seen.add(editSeq);
    const block = blockBySeq.get(editSeq);
    if (block !== undefined) resolved.push(block);
  }

  const firstBlock = resolved[0];
  if (firstBlock === undefined) return undefined;
  const firstHead = blockHead(firstBlock);
  if (firstHead.length === 0) return undefined;

  const more = resolved.length - 1;
  const edits = more > 0 ? `${firstHead} and ${more} more` : firstHead;
  const errName = typeof seq.error_names === "string"
    ? sanitizeSingleLine(seq.error_names).trim()
    : "";
  const errClause = errName.length > 0 ? ` The error names ${errName}.` : "";
  return `\`${cmd}\` failed (exit ${seq.exit_code}).${errClause} Edited ${edits}. \`${cmd}\` passed.`;
}
