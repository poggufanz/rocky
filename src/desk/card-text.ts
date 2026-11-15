/** Prompt classification used to derive card titles for display. */
export type PromptKind =
  | { kind: "plain" }
  | { kind: "task_notification" }
  | { kind: "cross_session" }
  | { kind: "slash_command"; name: string; args: string };

const STATIC_LABEL_CHIPS: Readonly<Record<string, string>> = {
  params_changed: "parameters changed",
  return_type_changed: "return type changed",
  guard_added: "new guard",
  condition_changed: "condition changed",
  branch_added: "new branch",
  branch_removed: "branch removed",
  error_handling_added: "error handling added",
  error_handling_removed: "error handling removed",
  loop_added: "new loop",
  loop_removed: "loop removed",
  return_changed: "return changed",
  await_changed: "await changed",
  body_changed: "body changed",
  value_changed: "value changed",
  config_changed: "config changed",
  dep_added: "new dependency",
  dep_removed: "dependency removed",
  dep_version: "dependency version",
  import_added: "new import",
  import_removed: "import removed",
  test_added: "new test",
  test_removed: "test removed",
  test_skipped: "test skipped",
  test_only: "test .only",
  file_new: "new file",
  file_deleted: "file deleted",
  file_renamed: "file renamed",
  format_only: "format only",
  rewrite: "rewritten",
  lockfile_changed: "lockfile changed",
  lines_changed: "lines changed",
  too_large: "too large",
  not_captured: "not captured",
};

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
      return STATIC_LABEL_CHIPS[label.id] ?? label.id;
  }
}
