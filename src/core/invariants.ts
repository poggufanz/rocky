export interface InvariantNote {
  invariant: string;
  guardedBy: string[];
  why?: string;
}

export interface InvariantParseResult {
  notes: InvariantNote[];
  errors: string[];
}

const REGEX_SPECIALS = new Set(["\\", "^", "$", ".", "|", "+", "(", ")", "[", "]", "{", "}"]);

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        const followedBySlash = normalized[index + 2] === "/";
        source += followedBySlash ? "(?:[^/]+/)*" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (REGEX_SPECIALS.has(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesGlob(pattern: string, relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(pattern).test(path);
}

export function parseInvariants(text: string): InvariantParseResult {
  const notes: InvariantNote[] = [];
  const errors: string[] = [];
  let current: { invariant: string; guardedBy: string[]; why?: string } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    if (current.invariant.length > 0 && current.guardedBy.length > 0) {
      notes.push({
        invariant: current.invariant,
        guardedBy: current.guardedBy,
        ...(current.why === undefined ? {} : { why: current.why }),
      });
    } else {
      errors.push(`block "${current.invariant.length === 0 ? "(empty)" : current.invariant}" misses ${current.guardedBy.length === 0 ? "Guarded by" : "Invariant"}`);
    }
    current = undefined;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const invariantMatch = /^Invariant:\s*(.+)$/.exec(line);
    if (invariantMatch !== null) {
      flush();
      current = { invariant: invariantMatch[1].trim(), guardedBy: [] };
      continue;
    }
    if (current === undefined) continue;
    const guardedMatch = /^Guarded by:\s*(.+)$/.exec(line);
    if (guardedMatch !== null) {
      current.guardedBy = guardedMatch[1]
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      continue;
    }
    const whyMatch = /^Why:\s*(.+)$/.exec(line);
    if (whyMatch !== null) {
      current.why = whyMatch[1].trim();
      continue;
    }
    // Tolerant parser: unknown lines inside and around blocks are ignored.
  }
  flush();
  return { notes, errors };
}
