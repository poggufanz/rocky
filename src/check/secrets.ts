import type { AddedLine } from "./diff.js";

export interface SecretHit {
  file: string;
  line: number;
  kind: string;
}

/**
 * Deliberately small and strict: an added-lines checker, not a gitleaks
 * replacement. False positives escape via `git push --no-verify`.
 * Order matters: "anthropic key" must precede "openai key". First match per
 * line wins.
 */
const PATTERNS: ReadonlyArray<readonly [kind: string, re: RegExp]> = [
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["github token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["openai key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["password assignment", /\b(?:password|secret)\s*=\s*(['"])([^'"]{4,})\1/i],
];

const EXAMPLE_PASSWORD = /\b(?:test|example|dummy|placeholder|changeme)\b/i;
const SECRET_PREFIX = /^(?:AKIA|github_pat_|gh[opurs]_|xox[baprs]-|sk-ant-|sk-|npm_)/;

function isPlaceholderToken(match: string): boolean {
  const body = match.replace(SECRET_PREFIX, "");
  return /^([A-Za-z0-9])\1+$/.test(body);
}

function shouldIgnore(kind: string, match: string): boolean {
  if (kind === "password assignment") return EXAMPLE_PASSWORD.test(match);
  return isPlaceholderToken(match);
}

export function scanSecrets(lines: AddedLine[]): SecretHit[] {
  const hits: SecretHit[] = [];

  for (const line of lines) {
    for (const [kind, re] of PATTERNS) {
      const match = re.exec(line.text);
      if (match === null || shouldIgnore(kind, match[0])) continue;
      hits.push({ file: line.file, line: line.line, kind });
      break;
    }
  }

  return hits;
}
