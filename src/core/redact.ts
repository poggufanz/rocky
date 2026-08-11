/**
 * Deliberately small and strict: an added-lines checker, not a gitleaks
 * replacement. False positives escape via `git push --no-verify`.
 * Order matters: "anthropic key" must precede "openai key". First match per
 * line wins.
 */
export const SECRET_PATTERNS: ReadonlyArray<readonly [kind: string, re: RegExp]> = [
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["github token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["openai key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["password assignment", /\b(?:password|secret)\s*=\s*(['"])([^'"]{4,})\1/i],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [kind, re] of SECRET_PATTERNS) {
    out = out.replace(
      new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"),
      `[redacted ${kind}]`,
    );
  }
  return out;
}
