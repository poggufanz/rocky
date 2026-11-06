/**
 * Default rules for rocky's dangerous-command guard.
 *
 * Patterns are bash EREs, matched by `[[ "$cmd" =~ $regex ]]` inside
 * rocky-hook.bash — NOT JavaScript RegExp. Keep them POSIX-ERE-safe:
 * [[:space:]] classes, no lookarounds, no \b, no literal tabs.
 * Deliberately few and narrow: the guard is a coarse net against catastrophe,
 * not a linter. Messages follow docs/output-principles.md: one plain
 * sentence each, stating what the command does.
 */

import { createHash } from "node:crypto";

export interface GuardRule {
  pattern: string; // bash ERE
  message: string;
}

export const DEFAULT_RULES: GuardRule[] = [
  {
    // rm -rf (any flag order/bundling) aimed at /, ~, ., .., or bare *
    pattern:
      "rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)[[:space:]]+(\\.\\.?|/|~/?|\\*)([[:space:]]|$)",
    message: "This rm deletes everything under its target.",
  },
  {
    // --force / -f but not --force-with-lease; flag may be first arg after
    // push or later, so the space before it is alternated, not required twice
    pattern:
      "git[[:space:]]+push([[:space:]]+.*[[:space:]]|[[:space:]]+)(--force|-f)([[:space:]]|$)",
    message: "A force push rewrites shared history. Other people can lose work.",
  },
  {
    pattern:
      "(curl|wget)[[:space:]][^|]*\\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da)?sh([[:space:]]|$)",
    message: "This pipes an unknown script straight into a shell.",
  },
  {
    pattern: "chmod[[:space:]]+-R[[:space:]]+777[[:space:]]+/([[:space:]]|$)",
    message: "This gives every user full permissions on everything under /.",
  },
  {
    pattern: "dd[[:space:]]+.*of=/dev/(sd|nvme|hd)",
    message: "This writes directly to a disk device. The change is permanent.",
  },
  {
    pattern: "git[[:space:]]+(checkout[[:space:]]+\\.|reset[[:space:]]+--hard)([[:space:]]|$)",
    message: "Uncommitted work is discarded, and rocky's memory cannot bring it back.",
  },
];

function body(rules: GuardRule[]): string {
  return rules.map((r) => `${r.pattern}\t${r.message}`).join("\n") + "\n";
}

function hashBody(b: string): string {
  return createHash("sha256").update(b).digest("hex");
}

export function renderGuardRules(rules: GuardRule[] = DEFAULT_RULES): string {
  const b = body(rules);
  return [
    "# Guard rules for rocky. One rule per line: ERE<TAB>message.",
    "# Edit freely; an edited file is never overwritten. Delete the file to disable the guard.",
    `# sha256:${hashBody(b)}`,
    b,
  ].join("\n");
}

/** True when the non-comment body still matches the embedded hash. */
export function rulesFileIsPristine(content: string): boolean {
  const m = content.match(/^# sha256:([0-9a-f]{64})$/m);
  if (!m) return false;
  const b =
    content
      .split("\n")
      .filter((l) => !l.startsWith("#") && l.trim().length > 0)
      .join("\n") + "\n";
  return hashBody(b) === m[1];
}
