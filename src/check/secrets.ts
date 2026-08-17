import type { AddedLine } from "./diff.js";
import { detectSecretKind } from "../core/redact.js";

export interface SecretHit {
  file: string;
  line: number;
  kind: string;
}

export function scanSecrets(lines: AddedLine[]): SecretHit[] {
  const hits: SecretHit[] = [];

  for (const line of lines) {
    const kind = detectSecretKind(line.text);
    if (kind !== undefined) hits.push({ file: line.file, line: line.line, kind });
  }

  return hits;
}
