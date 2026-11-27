const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const TABLE = new RegExp(String.raw`^\s*(\[\[?)\s*(${KEY})(?:\s*\.\s*${KEY})*\s*(\]\]?)\s*(?:#.*)?$`, "u");
const ROOT_KEY = new RegExp(String.raw`^\s*(${KEY})(?:\s*\.\s*${KEY})*\s*=`, "u");
const TOKENS = /"""|'''|"(?:[^"\\]|\\.)*"|'[^']*'|#.*$|[\[\]{}]/gu;

function isHooksKey(key: string | undefined): boolean {
  return key === "hooks" || key === '"hooks"' || key === "'hooks'";
}

/** Read-only check for a root hooks table, array of tables, or assignment. */
export function detectCodexInlineHooksConflict(configTomlText: string): boolean {
  let multiline: '"""' | "'''" | undefined;
  let depth = 0;
  let inTable = false;
  for (const line of configTomlText.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (!multiline && depth === 0) {
      const table = TABLE.exec(line);
      if (table && table[1].length === table[3].length) {
        if (isHooksKey(table[2])) return true;
        inTable = true;
        continue;
      }
      if (!inTable && isHooksKey(ROOT_KEY.exec(line)?.[1])) return true;
    }

    let offset = 0;
    while (offset < line.length) {
      if (multiline) {
        const end = line.indexOf(multiline, offset);
        if (end === -1) break;
        offset = end + multiline.length;
        if (multiline === '"""' && /(?:^|[^\\])(?:\\\\)*\\$/u.test(line.slice(0, end))) {
          offset = end + 1;
          continue;
        }
        multiline = undefined;
        continue;
      }
      TOKENS.lastIndex = offset;
      const token = TOKENS.exec(line);
      if (!token || token[0].startsWith("#")) break;
      offset = TOKENS.lastIndex;
      switch (token[0]) {
        case '"""':
        case "'''":
          multiline = token[0];
          break;
        case "[":
        case "{":
          depth++;
          break;
        case "]":
        case "}":
          depth = Math.max(0, depth - 1);
          break;
      }
    }
  }
  return false;
}

/** Build the manual notify entry without reading or writing Codex configuration. */
export function codexNotifySnippet(argv: readonly string[]): string {
  return `notify = [${argv.map((arg) => JSON.stringify(arg).replace(/\u007f/gu, "\\u007f")).join(", ")}]`;
}
