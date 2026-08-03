/**
 * Default rules for Rocky's dangerous-command guard.
 *
 * Patterns are bash EREs, matched by `[[ "$cmd" =~ $regex ]]` inside
 * rocky-hook.bash — NOT JavaScript RegExp. Keep them POSIX-ERE-safe:
 * [[:space:]] classes, no lookarounds, no \b, no literal tabs.
 * Deliberately few and narrow: guard is coarse net against catastrophe,
 * not linter. Messages follow Rocky's voice rules.
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
    message: "this rm eat everything under target. bad bad.",
  },
  {
    // --force / -f but not --force-with-lease; flag may be first arg after
    // push or later, so the space before it is alternated, not required twice
    pattern:
      "git[[:space:]]+push([[:space:]]+.*[[:space:]]|[[:space:]]+)(--force|-f)([[:space:]]|$)",
    message: "force push rewrite shared history. others lose work.",
  },
  {
    pattern:
      "(curl|wget)[[:space:]][^|]*\\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da)?sh([[:space:]]|$)",
    message: "unknown script straight into shell. I not hear this script before.",
  },
  {
    pattern: "chmod[[:space:]]+-R[[:space:]]+777[[:space:]]+/([[:space:]]|$)",
    message: "all permission for all. hull breach.",
  },
  {
    pattern: "dd[[:space:]]+.*of=/dev/(sd|nvme|hd)",
    message: "this write raw disk. very permanent.",
  },
  {
    pattern: "git[[:space:]]+(checkout[[:space:]]+\\.|reset[[:space:]]+--hard)([[:space:]]|$)",
    message: "uncommitted work vanish. no memory bring it back.",
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
    "# rocky guard rules. one rule per line: ERE<TAB>message.",
    "# edit freely — rocky never overwrites edited file. delete file to disable guard.",
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
