import type { AddedLine } from "./diff.js";
import { SECRET_PATTERNS } from "../core/redact.js";

export interface SecretHit {
  file: string;
  line: number;
  kind: string;
}

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
    for (const [kind, re] of SECRET_PATTERNS) {
      const match = re.exec(line.text);
      if (match === null || shouldIgnore(kind, match[0])) continue;
      hits.push({ file: line.file, line: line.line, kind });
      break;
    }
  }

  return hits;
}
